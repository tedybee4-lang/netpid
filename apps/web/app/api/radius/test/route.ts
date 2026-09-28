import { NextResponse } from "next/server";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServiceClient } from "@/lib/supabase/server";
import { resolveIsp } from "@/lib/isp";
import { decryptSecret, checkRateLimit } from "@/lib/secrets";
import { z } from "zod";

const run = promisify(execFile);
const testSchema = z.object({
  nas_id: z.string().uuid(),
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(128),
});

// POST /api/radius/test — server-side radtest against the VPS FreeRADIUS.
// Browser NEVER talks to RADIUS. Rate-limited. Passwords never logged.
export async function POST(req: Request) {
  const r = await resolveIsp(req);
  if ("error" in r) return r.error;
  const parsed = testSchema.safeParse(await req.json());
  if (!parsed.success) return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  const svc = createServiceClient();
  const ok = await checkRateLimit(svc, svc, `radius-test:${r.ispId}`, 10, 600);
  if (!ok) return NextResponse.json({ error: "Rate limited. Try again later." }, { status: 429 });

  const { data: nas } = await svc.from("radius_nas")
    .select("id, isp_id, nasname, auth_port").eq("id", parsed.data.nas_id).maybeSingle();
  if (!nas || nas.isp_id !== r.ispId) {
    return NextResponse.json({ error: "NAS not found in your ISP" }, { status: 404 });
  }
  // The username must belong to the caller's tenant too: radtest would otherwise
  // resolve its tenant by username ownership and become a cross-tenant password
  // oracle (rate-limited, but still an oracle).
  const { data: ru } = await svc.from("radius_users")
    .select("id").eq("isp_id", r.ispId).eq("username", parsed.data.username).maybeSingle();
  if (!ru) {
    return NextResponse.json({ error: "Username not found in your ISP" }, { status: 404 });
  }
  const { data: server } = await svc.from("radius_servers")
    .select("id, host, auth_port, status")
    .or(`isp_id.eq.${r.ispId},isp_id.is.null`).order("isp_id", { nullsFirst: false }).limit(1).maybeSingle();
  if (!server) {
    return NextResponse.json({ error: "RADIUS server not connected.", result: "ERROR" }, { status: 422 });
  }
  const { data: sec } = await svc.from("radius_nas_secrets")
    .select("encrypted_secret").eq("nas_id", nas.id).maybeSingle();
  if (!sec) return NextResponse.json({ error: "NAS secret missing." }, { status: 422 });

  const started = Date.now();
  let result = "ERROR", reply = "";
  try {
    const secret = decryptSecret(sec.encrypted_secret as string);
    const { stdout } = await run("radtest", [
      parsed.data.username, parsed.data.password,
      server.host as string, String(server.auth_port ?? 1812), secret,
    ], { timeout: 15000 });
    reply = stdout.slice(0, 2000);
    if (/Access-Accept/i.test(stdout)) result = "SUCCESS";
    else if (/Access-Reject/i.test(stdout)) result = "REJECT";
    else if (/timed out|no response/i.test(stdout)) result = "TIMEOUT";
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    reply = (/timed out|TIMEOUT/i.test(msg) ? "Request timed out. " : "radclient error. ") + "Check server reachability.";
    result = /timed out/i.test(msg) ? "TIMEOUT" : "ERROR";
  }
  await svc.from("radius_logs").insert({
    isp_id: r.ispId, username: parsed.data.username,
    event: result === "SUCCESS" ? "test-accept" : result === "REJECT" ? "test-reject" : result === "TIMEOUT" ? "test-timeout" : "test-error",
    nas_ip: String(nas.nasname), reply,
  });
  await svc.from("radius_health_checks").insert({
    server_id: server.id,
    status: result === "SUCCESS" ? "online" : result === "TIMEOUT" ? "offline" : "degraded",
    latency_ms: Date.now() - started, detail: { test: result },
  });
  return NextResponse.json({ result, latency_ms: Date.now() - started });
}

// GET /api/radius/test — recent test/auth log (no secrets)
export async function GET(req: Request) {
  const r = await resolveIsp(req);
  if ("error" in r) return r.error;
  const { data } = await r.supabase.from("radius_logs").select("username,event,nas_ip,created_at")
    .eq("isp_id", r.ispId).order("created_at", { ascending: false }).limit(50);
  return NextResponse.json({ logs: data ?? [] });
}
