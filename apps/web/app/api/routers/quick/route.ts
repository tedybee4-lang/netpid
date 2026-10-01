import { NextResponse } from "next/server";
import { resolveIsp } from "@/lib/isp";
import { createServiceClient } from "@/lib/supabase/server";
import { checkRateLimit, encryptSecret, randomSecret } from "@/lib/secrets";
import { resolveRadiusHost } from "@/lib/radius-host";
import { buildRouterosScripts, normalizeRosVersion, rosName } from "@/lib/routeros";
import { z } from "zod";

/**
 * POST /api/routers/quick — onboard a router from a NAME alone.
 *
 * Everything else is derived from the ISP's provisioning defaults: the
 * management IP is the next free address in the configured subnet, the API
 * password is generated, the NAS shortname and identity are sanitised from the
 * name, and both a RouterOS 6 and a RouterOS 7 script are returned so the
 * operator pastes the one that matches their hardware.
 */
const quickRouterSchema = z.object({
  name: z.string().min(2).max(120),
  ros_version: z.enum(["6", "7"]).optional(),
  wifi_ssid: z.string().max(32).optional().or(z.literal("")),
});

function ipToInt(ip: string): number {
  return ip.split(".").reduce((acc, o) => ((acc << 8) + Number(o)) >>> 0, 0);
}
function intToIp(n: number): string {
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");
}
function parseCidr(cidr: string) {
  const [ip, lenRaw] = String(cidr).split("/");
  const prefix = Math.min(32, Math.max(8, Number(lenRaw ?? 24) || 24));
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  const network = (ipToInt(ip) & mask) >>> 0;
  const broadcast = (network | (~mask >>> 0)) >>> 0;
  return { network, prefix, broadcast, size: broadcast - network + 1 };
}

/**
 * Next unused management address in the subnet. Skips the network address, the
 * broadcast address, the gateway and anything a router already claims, then
 * advances the stored cursor so the next call continues from here.
 */
function nextFreeHost(subnet: string, startOffset: number, reserved: Set<string>): string | null {
  const { network, size } = parseCidr(subnet);
  const usableEnd = size - 2; // exclude network + broadcast addresses
  for (let off = Math.max(2, startOffset); off <= usableEnd; off++) {
    const candidate = intToIp((network + off) >>> 0);
    if (!reserved.has(candidate)) return candidate;
  }
  return null;
}

type Defaults = {
  mgmt_subnet: string; mgmt_gateway: string; next_host_offset: number;
  api_username: string; api_port: number; api_ssl_port: number; use_ssl: boolean;
  ros_version: string; radius_server: string | null;
  radius_auth_port: number; radius_acct_port: number; radius_coa_port: number;
  nas_prefix: string; dns_servers: string; ntp_servers: string;
  wifi_ssid: string | null; country_code: string;
};

export async function POST(req: Request) {
  const r = await resolveIsp(req);
  if ("error" in r) return r.error;

  const parsed = quickRouterSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "Give the router a name (2+ characters)." }, { status: 400 });
  }
  const { name, wifi_ssid, ros_version } = parsed.data;
  const svc = createServiceClient();

  const allowed = await checkRateLimit(svc, svc, `router-quick:${r.ispId}`, 20, 3600);
  if (!allowed) return NextResponse.json({ error: "Rate limited. Try again later." }, { status: 429 });

  // Provisioning defaults: created on first use so a new ISP works with no setup.
  const { data: existingDefaults } = await svc.from("isp_router_defaults")
    .select("*").eq("isp_id", r.ispId).maybeSingle();
  let defaults = existingDefaults;
  if (!defaults) {
    const { data: created, error: dErr } = await svc.from("isp_router_defaults")
      .insert({ isp_id: r.ispId, wifi_ssid: wifi_ssid || null })
      .select("*").single();
    if (dErr) return NextResponse.json({ error: dErr.message }, { status: 400 });
    defaults = created;
  }
  const d = defaults as Defaults;

  // The RADIUS address comes from NETPID, not from the operator. An ISP that
  // already has one keeps it; otherwise they inherit the platform server and
  // are never asked for an address they have no way of knowing.
  const radius = await resolveRadiusHost(svc, r.ispId, d.radius_server);
  if (!radius) {
    // Only reachable if the platform has not published a RADIUS server yet. The
    // message is for the platform operator, not the ISP, and it says so.
    console.error("no RADIUS server available for quick-add provisioning", {
      ispId: r.ispId,
    });
    return NextResponse.json({
      error: "Router provisioning is not available yet. NETPID has not published a "
        + "RADIUS server — contact support if you see this.",
    }, { status: 503 });
  }

  // Reserve everything this ISP already uses so we never hand out a duplicate.
  const { data: existingRouters } = await svc.from("routers")
    .select("host").eq("isp_id", r.ispId);
  const reserved = new Set<string>((existingRouters ?? []).map((x) => String(x.host)));
  if (d.mgmt_gateway) reserved.add(d.mgmt_gateway);

  const host = nextFreeHost(d.mgmt_subnet, d.next_host_offset ?? 1, reserved);
  if (!host) {
    return NextResponse.json({
      error: `No free address left in ${d.mgmt_subnet}. Widen the subnet in provisioning defaults.`,
    }, { status: 409 });
  }
  const { network, size } = parseCidr(d.mgmt_subnet);
  await svc.from("isp_router_defaults")
    .update({ next_host_offset: (ipToInt(host) - network + 1) % Math.max(1, size) })
    .eq("isp_id", r.ispId);

  const version = normalizeRosVersion(ros_version ?? d.ros_version);
  const apiPassword = randomSecret(12);
  const shortname = rosName(`${d.nas_prefix}-${name}`, "netpid-nas");
  const identity = rosName(name, "netpid-router");

  const { data: router, error: rErr } = await svc.from("routers").insert({
    isp_id: r.ispId, name, identity, host,
    api_port: d.api_port, api_ssl_port: d.api_ssl_port,
    api_username: d.api_username, use_ssl: d.use_ssl,
    radius_server_host: radius.host,
    ros_version: version, script_ros_version: version,
    provisioned_via: "quick", status: "unknown",
  }).select("id,name,host").single();
  if (rErr) return NextResponse.json({ error: rErr.message }, { status: 400 });

  await svc.from("router_credentials")
    .insert({ router_id: router.id, encrypted_password: encryptSecret(apiPassword) });

  // A RADIUS NAS client is created for every router so FreeRADIUS knows it.
  const secretOnce = randomSecret();
  const { data: nas } = await svc.from("radius_nas").insert({
    isp_id: r.ispId, router_uuid: router.id, shortname,
    nasname: host, sync_status: "pending",
  }).select("id,shortname").single();
  if (nas) {
    await svc.from("radius_nas_secrets")
      .insert({ nas_id: nas.id, encrypted_secret: encryptSecret(secretOnce) });
    await svc.rpc("enqueue_job", {
      p_kind: "radius-nas-sync", p_isp_id: r.ispId, p_payload: { nas_id: nas.id },
    });
  }
  await svc.rpc("enqueue_job", {
    p_kind: "router-health", p_isp_id: r.ispId, p_payload: { router_id: router.id },
  });
  await svc.from("router_provision_log").insert({
    isp_id: r.ispId, router_id: router.id, action: "created", source: "quick",
    detail: { shortname, host, auto_assigned: true },
  });

  return NextResponse.json({
    router,
    nas,
    detected_version: version,
    secret_once: secretOnce,
    api_password_once: apiPassword,
    // Both scripts, always: the operator pastes the one that matches their box.
    scripts: buildRouterosScripts({
      shortname,
      radiusServer: radius.host,
      secret: secretOnce,
      routerIp: host,
      authPort: d.radius_auth_port,
      acctPort: d.radius_acct_port,
      coaPort: d.radius_coa_port,
      identity,
      timezone: "Africa/Nairobi",
      dnsServers: d.dns_servers,
      ntpServers: d.ntp_servers,
      wifiSsid: wifi_ssid || d.wifi_ssid || undefined,
      country: d.country_code,
      apiPort: d.api_port,
      apiSslPort: d.api_ssl_port,
      useSsl: d.use_ssl,
    }),
    defaults_applied: {
      host, api_username: d.api_username, api_port: d.api_port,
      api_ssl_port: d.api_ssl_port, use_ssl: d.use_ssl,
      radius_server: radius.host, radius_source: radius.source, shortname,
    },
    warning: "Copy the RADIUS secret and the API password now — neither is shown again.",
  }, { status: 201 });
}
