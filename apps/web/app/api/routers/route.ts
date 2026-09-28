import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { resolveIsp } from "@/lib/isp";
import { encryptSecret, randomSecret, checkRateLimit } from "@/lib/secrets";
import { createRouterSchema } from "@/lib/validation";

// GET /api/routers — list (passwords never returned)
export async function GET(req: Request) {
  const r = await resolveIsp(req);
  if ("error" in r) return r.error;
  const { data, error } = await r.supabase.from("routers")
    .select("id,name,identity,host,api_port,use_ssl,ros_version,model,status,last_seen_at,uptime_seconds,cpu_load,mem_used_pct,created_at")
    .eq("isp_id", r.ispId).order("created_at", { ascending: false });
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ routers: data });
}

// POST /api/routers — onboard router: encrypted creds + auto NAS + health job.
// Never returns the API password. Router RADIUS secret returned once.
export async function POST(req: Request) {
  const r = await resolveIsp(req);
  if ("error" in r) return r.error;
  const parsed = createRouterSchema.safeParse(await req.json());
  if (!parsed.success) return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  const svc = createServiceClient();
  const ok = await checkRateLimit(svc, svc, `router-add:${r.ispId}`, 10, 3600);
  if (!ok) return NextResponse.json({ error: "Rate limited." }, { status: 429 });
  const d = parsed.data;
  const { data: router, error } = await svc.from("routers").insert({
    isp_id: r.ispId, name: d.name, host: d.host, api_port: d.api_port,
    api_ssl_port: d.api_ssl_port, api_username: d.api_username, use_ssl: d.use_ssl,
    status: "unknown",
  }).select("id,name,host").single();
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  await svc.from("router_credentials").insert({
    router_id: router.id, encrypted_password: encryptSecret(d.api_password),
  });
  // Auto NAS (§11): same management IP as NAS IP unless overridden later
  const nasShort = d.nas_shortname ?? d.name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const { data: nas } = await svc.from("radius_nas").insert({
    isp_id: r.ispId, router_uuid: router.id, shortname: nasShort, nasname: d.host,
    sync_status: "pending",
  }).select("id,shortname").single();
  let secretOnce: string | null = null;
  if (nas) {
    secretOnce = randomSecret();
    await svc.from("radius_nas_secrets").insert({ nas_id: nas.id, encrypted_secret: encryptSecret(secretOnce) });
    await svc.rpc("enqueue_job", { p_kind: "radius-nas-sync", p_isp_id: r.ispId, p_payload: { nas_id: nas.id } });
  }
  await svc.rpc("enqueue_job", { p_kind: "router-health", p_isp_id: r.ispId, p_payload: { router_id: router.id } });
  return NextResponse.json({
    router, nas, secret_once: secretOnce,
    warning: secretOnce ? "Copy the RADIUS secret now — never shown again." : null,
    setup_preview: [
      `/radius add service=ppp,hotspot address=<RADIUS_SERVER_IP> secret=<SECRET_ABOVE>`,
      `/ppp aaa set use-radius=yes accounting=yes`,
      `/ip hotspot profile set <profile> use-radius=yes accounting=yes`,
    ],
  }, { status: 201 });
}
