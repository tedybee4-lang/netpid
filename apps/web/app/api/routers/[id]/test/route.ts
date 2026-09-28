import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { resolveIsp } from "@/lib/isp";
import { checkRateLimit } from "@/lib/secrets";

// POST /api/routers/[id]/test — enqueue synchronous-feeling test (poll job status).
// GET lists recent health rows for the router.
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const r = await resolveIsp(req);
  if ("error" in r) return r.error;
  const { data: router } = await r.supabase.from("routers").select("id").eq("id", id).eq("isp_id", r.ispId).maybeSingle();
  if (!router) return NextResponse.json({ error: "Router not found" }, { status: 404 });
  const { data } = await r.supabase.from("router_health").select("*").eq("router_id", id).order("checked_at", { ascending: false }).limit(10);
  return NextResponse.json({ health: data ?? [] });
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const r = await resolveIsp(req);
  if ("error" in r) return r.error;
  const svc = createServiceClient();
  const { data: router } = await svc.from("routers").select("id").eq("id", id).eq("isp_id", r.ispId).maybeSingle();
  if (!router) return NextResponse.json({ error: "Router not found" }, { status: 404 });
  const ok = await checkRateLimit(svc, svc, `router-test:${r.ispId}`, 10, 600);
  if (!ok) return NextResponse.json({ error: "Rate limited." }, { status: 429 });
  const body = await req.json().catch(() => ({}));
  const kind = body.action === "backup" ? "router-backup"
    : body.action === "disconnect" && body.username ? "router-disconnect" : "router-test";
  if (kind === "router-disconnect" && typeof body.username !== "string") {
    return NextResponse.json({ error: "username required" }, { status: 400 });
  }
  const { data: job } = await svc.rpc("enqueue_job", {
    p_kind: kind, p_isp_id: r.ispId,
    p_payload: { router_id: id, username: body.username ?? null },
  });
  return NextResponse.json({ job_id: job, message: "Queued. Poll /api/network/jobs for status." }, { status: 202 });
}
