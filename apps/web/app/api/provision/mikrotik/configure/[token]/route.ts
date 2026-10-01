import { NextResponse } from "next/server";
import { z } from "zod";
import { resolveIsp } from "@/lib/isp";
import { createServiceClient } from "@/lib/supabase/server";
import { decryptSecret } from "@/lib/secrets";
import { buildConfigureScript } from "@/lib/mikrotik-provision-script";
import {
  decideCapabilities, hashToken, isExpired, tokenMatchesHash, validateSelection,
} from "@/lib/mikrotik-provision";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  mode: z.enum(["HOTSPOT", "PPPOE", "HOTSPOT_PPPOE"]),
  wan_interface: z.string().min(1),
  hotspot_interfaces: z.array(z.string()).default([]),
  pppoe_interfaces: z.array(z.string()).default([]),
  hotspot_subnet: z.string().default(""),
  hotspot_range: z.string().default(""),
  hotspot_dns: z.string().default(""),
  pppoe_pool: z.string().default(""),
  pppoe_ranges: z.string().default(""),
  pppoe_local: z.string().default(""),
  radius_secret: z.string().default(""),
});

/**
 * POST /api/provision/mikrotik/configure/:token — phase 2.
 *
 * The operator's port choices are validated against the interfaces the router
 * actually reported BEFORE a script is produced, so a conflict shows up in the
 * dashboard rather than as a dead port on a half-configured box.
 *
 * Nothing is written to the router from here. The script is returned for the
 * operator to paste, the same trust boundary phase 1 uses.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  const r = await resolveIsp(req);
  if ("error" in r) return r.error;
  const svc = createServiceClient();

  const { token } = await params;
  const { data: session } = await svc.from("router_provisioning_sessions")
    .select("*").limit(1).eq("token_hash", hashToken(token)).maybeSingle();

  // Same refusal for unknown, someone else's and expired: the response must
  // not reveal whether another ISP holds a live session.
  const deny = () => NextResponse.json(
    { error: "Unknown or expired provisioning session." }, { status: 404 });
  if (!session || !tokenMatchesHash(token, session.token_hash)) return deny();
  if (isExpired(session)) return deny();
  if (session.isp_id !== r.ispId) {
    return NextResponse.json({ error: "Forbidden." }, { status: 403 });
  }
  if (session.status !== "CAPABILITIES_DETECTED" && session.status !== "CONFIGURED") {
    return NextResponse.json({
      error: `The router has not reported its hardware yet (status ${session.status}). Run the bootstrap command first.`,
    }, { status: 409 });
  }

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid selection." }, { status: 400 });
  const b = parsed.data;

  const sel = validateSelection({
    mode: b.mode,
    wan_interface: b.wan_interface,
    hotspot_interfaces: b.hotspot_interfaces,
    pppoe_interfaces: b.pppoe_interfaces,
  }, (session.detected_interfaces ?? []) as never);

  if (!sel.ok) {
    return NextResponse.json({ errors: sel.errors, warnings: sel.warnings }, { status: 400 });
  }

  // Capabilities come from what the ROUTER reported, never from a guess.
  const caps = decideCapabilities({
    version: session.routeros_version,
    architecture: session.architecture,
    board: session.board_name,
  });
  if (caps.blockers.length) {
    return NextResponse.json({ errors: caps.blockers, capabilities: caps }, { status: 409 });
  }
const { data: defaults } = await svc.from("isp_router_defaults")
    .select("*").eq("isp_id", r.ispId).maybeSingle();
  const d = (defaults ?? {}) as Record<string, unknown>;
  const str = (k: string, fallback = "") => String(d[k] ?? fallback);

  // The secret is decrypted here, used to build the script, and never stored in
  // the session or returned to the browser. A caller-supplied secret wins.
  let radiusSecret = b.radius_secret;
  if (!radiusSecret && session.router_id) {
    const { data: nas } = await svc.from("radius_nas")
      .select("id").eq("router_uuid", session.router_id).limit(1).maybeSingle();
    if (nas) {
      const { data: sec } = await svc.from("radius_nas_secrets")
        .select("encrypted_secret").eq("nas_id", nas.id).maybeSingle();
      if (sec?.encrypted_secret) {
        try { radiusSecret = decryptSecret(sec.encrypted_secret); } catch { /* stays empty */ }
      }
    }
  }

  const routerId = session.router_id ?? session.id;
  const origin = new URL(req.url).origin;
  const short = routerId.slice(0, 8);

  // WireGuard is included only when the box reported v7 AND NETPID has already
  // issued a real tunnel. A fabricated key yields a tunnel that never
  // handshakes, so "not yet" is the only honest alternative.
  let wireguard:
    | { serverPublicKey: string; routerTunnelIp: string; serverTunnelIp: string }
    | undefined;
  if (caps.wireguard.supported && session.router_id) {
    const { data: tunnel } = await svc.from("router_tunnels")
      .select("server_public_key,router_tunnel_ip,vps_tunnel_ip,status")
      .eq("router_id", session.router_id).maybeSingle();
    if (tunnel && (tunnel.status === "provisioned" || tunnel.status === "connected")) {
      wireguard = {
        serverPublicKey: tunnel.server_public_key,
        routerTunnelIp: tunnel.router_tunnel_ip,
        serverTunnelIp: tunnel.vps_tunnel_ip,
      };
    }
  }

  const script = buildConfigureScript({
    routerId,
    rosMajor: caps.rosMajor === 6 ? 6 : 7,
    mode: sel.mode!,
    wan: sel.wan!,
    hotspotPorts: sel.hotspot,
    hotspotIface: str("hotspot_iface", "netpid-hotspot"),
    hotspotSubnet: b.hotspot_subnet,
    hotspotRange: b.hotspot_range,
    hotspotDnsName: b.hotspot_dns,
    pppoePorts: sel.pppoe,
    pppoePool: b.pppoe_pool,
    pppoeRanges: b.pppoe_ranges,
    pppoeLocal: b.pppoe_local,
    radiusServer: str("radius_server"),
    radiusSecret,
    nasShortname: `${str("nas_prefix", "netpid")}-${short}`,
    radiusAuthPort: Number(d.radius_auth_port ?? 1812),
    radiusAcctPort: Number(d.radius_acct_port ?? 1813),
    radiusCoaPort: Number(d.radius_coa_port ?? 3799),
    pppoeService: str("pppoe_service", "netpid-pppoe"),
    bridgeIface: str("lan_bridge", "bridge-lan"),
    heartbeatUrl: `${origin}/api/provision/mikrotik/heartbeat/${short}`,
    heartbeatName: `netpid-heartbeat-${short}`,
    wireguard,
  });

  await svc.from("router_provisioning_sessions").update({
    status: "CONFIGURED",
    selected_mode: sel.mode,
    wan_interface: sel.wan,
    hotspot_interfaces: sel.hotspot,
    pppoe_interfaces: sel.pppoe,
    current_step: "Paste the configuration script on the router",
    progress_pct: 70,
    error_message: null,
  }).eq("id", session.id);

  return NextResponse.json({
    ok: true,
    status: "CONFIGURED",
    script,
    warnings: sel.warnings,
    capabilities: caps,
    wireguard_included: Boolean(wireguard),
    // Named explicitly so the dashboard cannot imply more than is true.
    state: "CONFIGURED. Not ONLINE: NETPID must still confirm a RouterOS API health check.",
  }, { status: 200 });
}