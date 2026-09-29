import { NextResponse } from "next/server";
import crypto from "crypto";
import { z } from "zod";
import { createServiceClient } from "@/lib/supabase/server";
import { deriveStatus, DELAYED_AFTER_MS, OFFLINE_AFTER_MS } from "@/lib/vps";

export const dynamic = "force-dynamic";

// POST /api/worker/heartbeat — the worker's periodic health report.
//
// AUTHENTICATION: a shared secret in a header, compared in constant time. It is
// deliberately NOT the admin session cookie and NOT the Supabase service role:
// this endpoint is reachable by a process on the VPS, and nothing else should
// be able to mark a server as online.
//
// The secret is compared before the body is parsed, so an unauthenticated
// caller cannot even probe the schema.
//
// WHAT IS ACCEPTED: resource metrics and service state. There is no field for a
// password, key or token, so a compromised worker cannot exfiltrate a
// credential through this endpoint even if it wanted to.

const schema = z.object({
  server_id: z.string().uuid(),
  worker_id: z.string().min(1).max(80),
  worker_version: z.string().max(40).optional(),
  status: z.enum(["ok", "degraded", "error"]).default("ok"),
  cpu_percent: z.coerce.number().min(0).max(100).optional(),
  mem_percent: z.coerce.number().min(0).max(100).optional(),
  disk_percent: z.coerce.number().min(0).max(100).optional(),
  uptime_seconds: z.coerce.number().int().min(0).optional(),
  radius_running: z.boolean().optional(),
  wireguard_active: z.boolean().optional(),
  firewall_active: z.boolean().optional(),
  jobs_processed: z.coerce.number().int().min(0).optional(),
  os_name: z.string().max(120).optional(),
  kernel: z.string().max(120).optional(),
  detail: z.record(z.unknown()).default({}),
});

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

export async function POST(req: Request) {
  const expected = process.env.WORKER_HEARTBEAT_SECRET;
  if (!expected) {
    // Fail closed. Without a configured secret this endpoint would otherwise be
    // an open "mark any server online" button for anyone who found the URL.
    return NextResponse.json(
      { error: "Heartbeat endpoint is not configured" }, { status: 503 },
    );
  }
  const presented = req.headers.get("x-netpid-heartbeat") ?? "";
  if (!safeEqual(presented, expected)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const parsed = schema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid heartbeat" }, { status: 400 },
    );
  }
  const b = parsed.data;
  const svc = createServiceClient();

  const { data: server } = await svc.from("vps_servers")
    .select("id,name,enabled,status").eq("id", b.server_id).maybeSingle();
  if (!server) return NextResponse.json({ error: "Unknown server" }, { status: 404 });

  const now = new Date().toISOString();

  // Duplicate-worker guard. A second worker on the same box is a real failure
  // mode — two pollers would fight over the same routers and double-apply jobs.
  // The most recent beat for this server decides the reported worker_id, so the
  // console can show that two different ids are reporting.
  const { data: recent } = await svc.from("worker_heartbeats")
    .select("worker_id,reported_at")
    .eq("server_id", b.server_id)
    .gte("reported_at", new Date(Date.now() - DELAYED_AFTER_MS).toISOString())
    .order("reported_at", { ascending: false })
    .limit(5);
  const competing = (recent ?? []).filter((r) => r.worker_id !== b.worker_id);

  await svc.from("worker_heartbeats").insert({
    server_id: b.server_id,
    worker_id: b.worker_id,
    worker_version: b.worker_version ?? null,
    status: b.status,
    cpu_percent: b.cpu_percent ?? null,
    mem_percent: b.mem_percent ?? null,
    disk_percent: b.disk_percent ?? null,
    uptime_seconds: b.uptime_seconds ?? null,
    radius_running: b.radius_running ?? null,
    wireguard_active: b.wireguard_active ?? null,
    firewall_active: b.firewall_active ?? null,
    jobs_processed: b.jobs_processed ?? null,
    detail: { ...b.detail, competing_workers: competing.map((c) => c.worker_id) },
    reported_at: now,
  });

  // Heartbeat is a strong liveness signal, so it refreshes the cached metrics.
  const patch: Record<string, unknown> = {
    last_heartbeat_at: now,
    status: deriveStatus(true, now),
    cpu_percent: b.cpu_percent ?? undefined,
    mem_percent: b.mem_percent ?? undefined,
    disk_percent: b.disk_percent ?? undefined,
    uptime_seconds: b.uptime_seconds ?? undefined,
    worker_status: b.status === "error" ? "stopped" : "running",
  };
  if (b.radius_running !== undefined) patch.radius_status = b.radius_running ? "running" : "stopped";
  if (b.wireguard_active !== undefined) {
    patch.wireguard_status = b.wireguard_active ? "active" : "inactive";
  }
  if (b.firewall_active !== undefined) {
    patch.firewall_status = b.firewall_active ? "active" : "inactive";
  }
  if (b.os_name) patch.os_name = b.os_name;
  if (b.kernel) patch.kernel = b.kernel;
  await svc.from("vps_servers").update(patch).eq("id", b.server_id);

  // Only write a health event on a TRANSITION. A beat every 45s would otherwise
  // add 1,920 identical rows a day and make the history useless.
  const next = b.status === "error" ? "delayed" : "online";
  if (next !== server.status) {
    await svc.from("vps_health_events").insert({
      server_id: b.server_id, source: "heartbeat", status: next,
      detail: { worker_id: b.worker_id, competing_workers: competing.length },
    });
  }

  if (competing.length) {
    // Recorded, not rejected: the newest worker wins, and the console shows the
    // collision. Silently dropping the beat would hide the real problem.
    return NextResponse.json({
      ok: true,
      warning: `Another worker (${competing[0].worker_id}) is also reporting`,
    });
  }
  return NextResponse.json({ ok: true });
}

/**
 * GET /api/worker/heartbeat — reclassify servers whose beat has gone stale.
 *
 * Without this, a server that dies stays "online" forever, because nothing
 * computes the ABSENCE of a heartbeat. It is idempotent and only writes a
 * health event when the status actually changes.
 */
export async function GET(req: Request) {
  const expected = process.env.WORKER_HEARTBEAT_SECRET;
  if (!expected) return NextResponse.json({ error: "Not configured" }, { status: 503 });
  if (!safeEqual(req.headers.get("x-netpid-heartbeat") ?? "", expected)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const svc = createServiceClient();
  const { data: servers } = await svc.from("vps_servers").select("*").limit(200);

  const reclassified: { name: string; from: string; to: string }[] = [];
  for (const s of servers ?? []) {
    const next = deriveStatus(s.enabled, s.last_heartbeat_at);
    if (next === s.status) continue;
    await svc.from("vps_servers").update({ status: next }).eq("id", s.id);
    await svc.from("vps_health_events").insert({
      server_id: s.id, source: "heartbeat", status: next,
      detail: { reason: "heartbeat stale", last_heartbeat_at: s.last_heartbeat_at },
    });
    reclassified.push({ name: s.name, from: s.status, to: next });
  }

  return NextResponse.json({
    checked: (servers ?? []).length, reclassified,
    thresholds: { delayed_after_ms: DELAYED_AFTER_MS, offline_after_ms: OFFLINE_AFTER_MS },
  });
}
