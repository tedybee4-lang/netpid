import { NextResponse } from "next/server";
import { resolveIsp } from "@/lib/isp";
import { createServiceClient } from "@/lib/supabase/server";
import { checkRateLimit, encryptSecret, randomSecret } from "@/lib/secrets";
import { resolveRadiusHost } from "@/lib/radius-host";
import { buildRouterosScripts, buildWireguardScript, normalizeRosVersion, rosName } from "@/lib/routeros";
import { allocateTunnelSubnet, encryptTunnelKey, generateKeyPair } from "@/lib/wireguard";
import { buildRouterosInstaller, installerMissing } from "@/lib/routeros-installer";
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

type Defaults = {
  mgmt_subnet: string; mgmt_gateway: string; next_host_offset: number;
  api_username: string; api_port: number; api_ssl_port: number; use_ssl: boolean;
  ros_version: string; radius_server: string | null;
  radius_auth_port: number; radius_acct_port: number; radius_coa_port: number;
  nas_prefix: string; dns_servers: string; ntp_servers: string;
  wifi_ssid: string | null; country_code: string;
  // 0046. The customer's own networks, for the RouterOS installer. Every one of
  // these is nullable on purpose: NETPID must not invent a subnet, so an unset
  // value is passed through as blank and the installer's preflight stops and
  // reports it on the router.
  mode: "NEW" | "EXISTING";
  wan: string | null; lan_bridge: string | null; lan_ports: string[] | null;
  lan_subnet: string | null; lan_gateway: string | null; dhcp_pool: string | null;
  hotspot_enabled: boolean;
  hotspot_subnet: string | null; hotspot_pool: string | null; hotspot_dns: string | null;
  pppoe_enabled: boolean; pppoe_pool: string | null;
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

  const version = normalizeRosVersion(ros_version ?? d.ros_version);
  const apiPassword = randomSecret(12);
  const shortname = rosName(`${d.nas_prefix}-${name}`, "netpid-nas");
  const identity = rosName(name, "netpid-router");

  // ---- The management address ---------------------------------------------
  // This used to hand out the next free host from isp_router_defaults
  // .mgmt_subnet, which defaulted to 10.10.10.0/24. That range is not routed
  // anywhere: the routers sit on separate customer LANs and NETPID's only
  // managed path is the WireGuard tunnel on 10.90.0.0/16. Every router created
  // that way was born permanently unreachable, and the dashboard could not say
  // so - it just showed UNKNOWN forever.
  //
  // So the address is a real tunnel address. It is carved from 10.90.0.0/16,
  // which wg0 actually owns, so when the tunnel comes up this host becomes
  // reachable with no further change. Until then the router is honestly
  // "wireguard_enrollment_required", not "unknown".
  const tunnel = await allocateTunnelSubnet();
  // NETPID's half of the key pair. The private half is encrypted before it is
  // stored and never leaves the server; the router generates its own half on
  // the box, which is why enrolment is a two-step handshake and not a one-shot
  // script.
  const keys = generateKeyPair();

  const { data: router, error: rErr } = await svc.from("routers").insert({
    isp_id: r.ispId, name, identity, host: tunnel.routerIp,
    api_port: d.api_port, api_ssl_port: d.api_ssl_port,
    api_username: d.api_username, use_ssl: d.use_ssl,
    radius_server_host: radius.host,
    ros_version: version, script_ros_version: version,
    provisioned_via: "quick", status: "unknown",
    lifecycle: "wireguard_enrollment_required",
  }).select("id,name,host").single();
  if (rErr) return NextResponse.json({ error: rErr.message }, { status: 400 });

  // The tunnel row holds NETPID's half of the key pair. The private half is
  // encrypted here and never leaves the server; the router generates ITS half
  // on the box, which is why enrolment is a two-step handshake and not a
  // one-shot script.
  const { error: tErr } = await svc.from("router_tunnels").insert({
    isp_id: r.ispId, router_id: (router as { id: string }).id,
    tunnel_subnet: tunnel.subnet, vps_tunnel_ip: tunnel.vpsIp, router_tunnel_ip: tunnel.routerIp,
    server_public_key: keys.publicKey,
    server_private_key_encrypted: encryptTunnelKey(keys.privateKey),
    // 'pending', not 'awaiting_router_key': router_tunnels.status has a check
    // constraint of (pending|provisioned|connected|unreachable|revoked). The
    // router has no key yet, so the tunnel is pending - that is what 'pending'
    // means here.
    router_public_key: null, status: "pending",
  });
  if (tErr) return NextResponse.json({ error: tErr.message }, { status: 400 });

  await svc.from("router_credentials")
    .insert({ router_id: router.id, encrypted_password: encryptSecret(apiPassword) });

  // A RADIUS NAS client is created for every router so FreeRADIUS knows it.
  // nasname is the TUNNEL address: that is the only source address the router
  // will have from NETPID's point of view, and it keeps accounting consistent
  // with the address the worker dials.
  const secretOnce = randomSecret();
  const { data: nas } = await svc.from("radius_nas").insert({
    isp_id: r.ispId, router_uuid: router.id, shortname,
    nasname: tunnel.routerIp, sync_status: "pending",
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
    detail: { shortname, host: tunnel.routerIp, tunnel: tunnel.subnet, auto_assigned: true },
  });

  return NextResponse.json({
    router,
    nas,
    detected_version: version,
    secret_once: secretOnce,
    api_password_once: apiPassword,
    lifecycle: "wireguard_enrollment_required",
    // Phase 1 of enrolment. The operator runs this ON the router, then pastes
    // the printed public key back into the router's NETPID page, which yields
    // the complete tunnel script.
    wireguard_script: buildWireguardScript({
      routerName: name,
      serverPublicKey: keys.publicKey,
      routerTunnelIp: tunnel.routerIp,
      vpsTunnelIp: tunnel.vpsIp,
      vpsEndpoint: process.env.NETPID_WG_ENDPOINT?.trim() || undefined,
    }),
    // THE authoritative installer. Everything the operator needs to take this
    // router to production is in this one file: LAN, DHCP, DNS, firewall, NAT,
    // HotSpot, PPPoE, RADIUS, CoA, WireGuard and the restricted API.
    //
    // The RADIUS secret and the API password are deliberately left blank. They
    // are operator inputs; a generator that embedded them would put a live
    // credential in git history. The installer skips RADIUS and generates a
    // one-time API password instead, printing each exactly once.
    //
    // The WireGuard server key IS included - NETPID just generated it - so the
    // peer is real. A router created without it would get an interface and no
    // tunnel, which is the state that was mistaken for "provisioned".
    installer: buildRouterosInstaller({
      mode: (d.mode as "NEW" | "EXISTING") ?? "EXISTING",
      identity: name,
      wan: d.wan ?? "ether1",
      lanBridge: d.lan_bridge ?? "bridge-lan",
      lanPorts: d.lan_ports?.length ? d.lan_ports : ["ether2", "ether3", "ether4", "ether5"],
      lanSubnet: d.lan_subnet ?? "",
      lanGateway: d.lan_gateway ?? "",
      dhcpPool: d.dhcp_pool ?? "",
      hotspotEnabled: d.hotspot_enabled !== false,
      hotspotSubnet: d.hotspot_subnet ?? "",
      hotspotPool: d.hotspot_pool ?? "",
      hotspotDnsName: d.hotspot_dns ?? "",
      pppoeEnabled: d.pppoe_enabled !== false,
      pppoePool: d.pppoe_pool ?? "",
      radiusServer: radius.host,
      nasShortname: shortname,
      wgServerPublicKey: keys.publicKey,
      wgServerTunnelIp: tunnel.vpsIp,
      wgRouterTunnelIp: tunnel.routerIp,
      wgEndpoint: process.env.NETPID_WG_ENDPOINT?.trim() || undefined,
      mgmtNetwork: tunnel.subnet,
    }),
    // What the operator still has to fill in before the installer will run.
    // Serving a config the router will reject is worse than saying so here.
    installer_missing: installerMissing({
      identity: name,
      lanSubnet: d.lan_subnet ?? "",
      lanGateway: d.lan_gateway ?? "",
      dhcpPool: d.dhcp_pool ?? "",
      hotspotEnabled: d.hotspot_enabled !== false,
      hotspotSubnet: d.hotspot_subnet ?? "",
      hotspotPool: d.hotspot_pool ?? "",
      hotspotDnsName: d.hotspot_dns ?? "",
      pppoeEnabled: d.pppoe_enabled !== false,
      pppoePool: d.pppoe_pool ?? "",
      radiusServer: radius.host,
      nasShortname: shortname,
    }),
    // Both scripts, always: the operator pastes the one that matches their box.
    scripts: buildRouterosScripts({
      shortname,
      radiusServer: radius.host,
      secret: secretOnce,
      routerIp: tunnel.routerIp,
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
      // The tunnel address, which is the only address NETPID can ever reach
      // this router on. Reporting anything else here is what made an unroutable
      // 10.10.10.x look like a completed setup.
      host: tunnel.routerIp, tunnel: tunnel.subnet,
      api_username: d.api_username, api_port: d.api_port,
      api_ssl_port: d.api_ssl_port, use_ssl: d.use_ssl,
      radius_server: radius.host, radius_source: radius.source, shortname,
    },
    warning: "Copy the RADIUS secret and the API password now — neither is shown again. "
      + "This router is NOT yet manageable: run the WireGuard script on the router, paste "
      + "its public key back into this router's page, then run the tunnel script it gives you.",
  }, { status: 201 });
}
