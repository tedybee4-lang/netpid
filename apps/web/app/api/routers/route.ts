import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { resolveIsp } from "@/lib/isp";
import { encryptSecret, randomSecret, checkRateLimit } from "@/lib/secrets";
import { createRouterSchema } from "@/lib/validation";
// One generator for both provisioning paths, so a router added by hand and
// one added by script are configured identically:
//   * manual UI add   -> this file (inline, typed copy)
//   * script-only CLI -> network-worker/scripts/provision-router.mjs
// Both copies are generated from network-worker/src/routeros.mjs; keep the
// rate-pair rule (upload FIRST — "512k/5120k") in sync if you touch either.
function ratePair(uploadKbps: number | null | undefined, downloadKbps: number | null | undefined): string | null {
  const up = Math.max(0, Math.floor(Number(uploadKbps) || 0));
  const down = Math.max(0, Math.floor(Number(downloadKbps) || 0));
  if (up <= 0 && down <= 0) return null;
  const rx = up > 0 ? up : down;
  const tx = down > 0 ? down : up;
  return `${rx}k/${tx}k`;
}

function rosQuote(value: string | number | null | undefined): string {
  const s = String(value ?? "");
  if (s !== "" && /^[A-Za-z0-9._:/@-]+$/.test(s)) return s;
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r?\n/g, " ")}"`;
}

function rosName(value: string | null | undefined, fallback = "netpid"): string {
  const s = String(value ?? "").trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
  return s || fallback;
}

function buildRouterosSetup(o: {
  shortname?: string; radiusServer?: string; secret?: string; routerIp?: string;
  authPort?: number; acctPort?: number; coaPort?: number; identity?: string;
  profiles?: { name: string; kind?: string; pool?: string; download_kbps?: number; upload_kbps?: number }[];
}): string {
  const shortname = rosName(o.shortname, "netpid-nas");
  const server = rosQuote(o.radiusServer ?? "");
  const secret = rosQuote(o.secret ?? "");
  const authPort = Number(o.authPort) || 1812;
  const acctPort = Number(o.acctPort) || 1813;
  const coaPort = Number(o.coaPort) || 3799;
  const src = o.routerIp ? ` src-address=${rosQuote(o.routerIp)}` : "";
  const profiles = Array.isArray(o.profiles) ? o.profiles : [];
  const byName = (kind: string) =>
    profiles.filter((p) => String(p.kind ?? "pppoe").toLowerCase() === kind);
  const lines = [
    `# NETPID setup for ${shortname} (RouterOS CLI — paste in a terminal)`,
    `# RADIUS: ${o.radiusServer} auth=${authPort} acct=${acctPort}`,
  ];
  if (o.identity) lines.push(`# Identity : ${o.identity}`);
  if (o.routerIp) lines.push(`# Source   : ${o.routerIp} (presented to RADIUS as NAS-IP-Address)`);
  lines.push("");
  lines.push("# 1. RADIUS accounting client (PPP + HotSpot share one service)");
  lines.push(`:do { /ip/radius remove [find comment=${rosQuote(`NETPID:${shortname}`)}] } on-error={}`);
  lines.push(
    `/radius add service=ppp,hotspot address=${server} secret=${secret} ` +
      `auth-port=${authPort} acct-port=${acctPort} timeout=1500ms${src} ` +
      `comment=${rosQuote(`NETPID:${shortname}`)}`,
  );
  lines.push("");
  lines.push("# 2. PPPoE — credentials go to RADIUS, accounting comes back");
  lines.push("/ppp aaa set use-radius=yes accounting=yes interim-update=5m");
  for (const p of byName("pppoe")) {
    const name = rosName(p.name, "pppoe-profile");
    const limit = ratePair(p.upload_kbps, p.download_kbps);
    const pool = p.pool ? ` remote-address=${rosQuote(p.pool)}` : "";
    lines.push(`/ppp profile set [find name=${rosQuote(name)}]${pool} use-radius=yes${limit ? ` rate-limit=${limit}` : ""}`);
  }
  lines.push("");
  lines.push("# 3. HotSpot — captive-portal logins also authorize via RADIUS");
  for (const p of byName("hotspot")) {
    const name = rosName(p.name, "hotspot-profile");
    const limit = ratePair(p.upload_kbps, p.download_kbps);
    lines.push(
      `/ip hotspot profile set [find name=${rosQuote(name)}] use-radius=yes ` +
        `accounting=yes interim-update=5m login-by=http-chap,http-pap,madius${limit ? ` rate-limit=${limit}` : ""}`,
    );
  }
  lines.push("");
  const capped = profiles.filter((p) => ratePair(p.upload_kbps, p.download_kbps));
  if (capped.length) {
    lines.push("# 4. Simple queues — one per profile (upload/download, upload first)");
    for (const p of capped) {
      const name = rosName(`netpid-${p.name}`, "netpid-queue");
      lines.push(`:do { /queue simple remove [find name=${rosQuote(name)}] } on-error={}`);
      lines.push(
        `/queue simple add name=${rosQuote(name)} target=0.0.0.0/0 ` +
          `max-limit=${ratePair(p.upload_kbps, p.download_kbps)} ` +
          `queue=default/default comment=${rosQuote(`NETPID:${p.name}`)}`,
      );
    }
    lines.push("");
  }
  lines.push("# 5. CoA — lets NETPID disconnect a user from the dashboard");
  lines.push(`/radius incoming set accept=yes port=${coaPort} comment=${rosQuote(`NETPID:${shortname}`)}`);
  lines.push("");
  lines.push("# Done. Confirm in NETPID: Dashboard > Network > this router.");
  return lines.join("\n");
}


// GET /api/routers — list (passwords never returned)
export async function GET(req: Request) {
  const r = await resolveIsp(req);
  if ("error" in r) return r.error;
  const { data, error } = await r.supabase.from("routers")
    .select("id,name,identity,host,api_port,use_ssl,ros_version,model,serial,status,site,notes,last_seen_at,uptime_seconds,cpu_load,mem_used_pct,provisioned_via,created_at")
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
    site: d.site ?? null, notes: d.notes ?? null,
    radius_server_host: d.radius_server ?? null,
    provisioned_via: "ui", status: "unknown",
  }).select("id,name,host").single();
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  await svc.from("router_credentials").insert({
    router_id: router.id, encrypted_password: encryptSecret(d.api_password),
  });

  // Auto NAS (§11): same management IP as NAS IP unless overridden later
  const nasShort = d.nas_shortname ?? d.name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  let nas: { id: string; shortname: string } | null = null;
  let secretOnce: string | null = null;
  if (d.nas !== false) {
    const { data: created } = await svc.from("radius_nas").insert({
      isp_id: r.ispId, router_uuid: router.id, shortname: nasShort, nasname: d.host,
      sync_status: "pending",
    }).select("id,shortname").single();
    nas = created ?? null;
    if (nas) {
      secretOnce = randomSecret();
      await svc.from("radius_nas_secrets").insert({
        nas_id: nas.id, encrypted_secret: encryptSecret(secretOnce),
      });
      await svc.rpc("enqueue_job", {
        p_kind: "radius-nas-sync", p_isp_id: r.ispId, p_payload: { nas_id: nas.id },
      });
    }
  }
  await svc.rpc("enqueue_job", {
    p_kind: "router-health", p_isp_id: r.ispId, p_payload: { router_id: router.id },
  });
  await svc.from("router_provision_log").insert({
    isp_id: r.ispId, router_id: router.id, action: "created", source: "ui",
    detail: { shortname: nasShort, nas_created: Boolean(nas) },
  });

  // A ready-to-paste RouterOS script. The secret appears in it, so it is
  // returned exactly once, in the same response as the secret itself.
  const routeros_script = buildRouterosSetup({
    shortname: nasShort,
    radiusServer: d.radius_server ?? "<RADIUS_SERVER_IP>",
    secret: secretOnce ?? "<no NAS registered for this router>",
    routerIp: d.host,
    identity: d.name,
    profiles: Array.isArray(d.profiles) ? d.profiles : [],
  });

  return NextResponse.json({
    router, nas, secret_once: secretOnce, routeros_script,
    warning: secretOnce
      ? "Copy the RADIUS secret now — it is never shown again."
      : null,
  }, { status: 201 });
}
