/**
 * Interactive MikroTik provisioning.
 *
 * Two phases, because a single generated .rsc has to guess at hardware it has
 * never seen:
 *
 *   1. BOOTSTRAP. NETPID mints a single-use token. The operator pastes ONE
 *      command into the router terminal. The router fetches a discovery script
 *      from NETPID, reads its own hardware, and reports back over the same
 *      token. NETPID now knows the board, the RouterOS version and the real
 *      interface list.
 *
 *   2. CONFIGURE. The operator picks mode / WAN / HotSpot / PPPoE ports in the
 *      dashboard against those REAL interfaces, and NETPID emits a script built
 *      from what the hardware reported.
 *
 * ---------------------------------------------------------------------------
 * WHY THE ROUTER CALLS BACK WITH A GET AND NOT A POST
 * ---------------------------------------------------------------------------
 * The brief asked for the router to "POST JSON back". RouterOS has no HTTP
 * client. `/tool fetch` performs a GET and nothing else, and its scripting
 * language has no request body, no verb selection and no URL encoder. A router
 * therefore CANNOT issue a POST without something extra installed on it first,
 * which is exactly what we are trying to avoid.
 *
 * So the callback is a GET whose query string carries the discovery data. That
 * works on a stock, factory-fresh box with nothing installed. The register
 * endpoint still ACCEPTS a POST body for any future client that can (a
 * container, a package, a newer RouterOS), so the contract holds either way;
 * the router-side path is the GET.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS NEVER IN THE URL
 * ---------------------------------------------------------------------------
 * No permanent credential, API password, RADIUS secret or WireGuard key ever
 * appears in a token URL. The token is single-use, expires in 30 minutes and is
 * stored only as a SHA-256 hash, so it grants hardware discovery and nothing
 * more. Phase 2 is still a human clicking COPY in the dashboard.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const SESSION_TTL_MINUTES = 30;

export type SessionStatus =
  | "PENDING" | "BOOTSTRAPPED" | "CAPABILITIES_DETECTED"
  | "CONFIGURED" | "APPLIED" | "FAILED" | "EXPIRED" | "CANCELLED";

export type ProvisionMode = "HOTSPOT" | "PPPOE" | "HOTSPOT_PPPOE";

export interface DetectedInterface {
  name: string;
  type: string;
  in_bridge: string | null;
  is_candidate_wan: boolean;
}

export interface DetectedBridge {
  name: string;
  ports: string[];
}

export interface SessionRow {
  id: string;
  isp_id: string;
  router_id: string | null;
  token_hash: string;
  status: SessionStatus;
  board_name: string | null;
  router_model: string | null;
  routeros_version: string | null;
  architecture: string | null;
  cpu: string | null;
  ram_mb: number | null;
  capabilities: Record<string, unknown>;
  detected_interfaces: DetectedInterface[];
  detected_bridges: DetectedBridge[];
  selected_mode: ProvisionMode | null;
  wan_interface: string | null;
  hotspot_interfaces: string[];
  pppoe_interfaces: string[];
  current_step: string | null;
  progress_pct: number;
  error_message: string | null;
  started_at: string;
  last_seen_at: string | null;
  completed_at: string | null;
  expires_at: string;
}

// --------------------------------------------------------------------------
// Tokens
// --------------------------------------------------------------------------

/** 256 bits of CSPRNG output, URL-safe. Shown to the operator exactly once. */
export function mintToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/**
 * Constant-time compare. A provisioning token is a bearer credential for
 * hardware detail, so it must not be discoverable a character at a time.
 */
export function tokenMatchesHash(token: string, hash: string): boolean {
  const a = Buffer.from(hashToken(token), "utf8");
  const b = Buffer.from(String(hash ?? ""), "utf8");
  if (a.length !== b.length || a.length === 0) return false;
  return timingSafeEqual(a, b);
}

export function isExpired(s: { expires_at?: string | null }): boolean {
  if (!s?.expires_at) return true;
  return new Date(s.expires_at).getTime() <= Date.now();
}

// --------------------------------------------------------------------------
// Capability decision
// --------------------------------------------------------------------------

export interface Gate {
  supported: boolean;
  reason: string;
}

export interface CapabilityDecision {
  rosMajor: 7 | 6 | null;
  wireguard: Gate;
  sstp: Gate;
  ppp: Gate;
  hotspot: Gate;
  radius: Gate;
  scheduler: Gate;
  /** Blocking reasons. A script is not produced while any is set. */
  blockers: string[];
}

/**
 * Gates decided from what the router REPORTED, never from a guess. Anything
 * NETPID cannot do on this box is reported unsupported with a reason, rather
 * than silently omitted so the operator discovers it on a dead port.
 */
export function decideCapabilities(reported: {
  version?: string | null;
  architecture?: string | null;
  board?: string | null;
}): CapabilityDecision {
  const ver = String(reported.version ?? "").trim();
  const m = /^(\d+)\./.exec(ver);
  const rosMajor = (m ? Number(m[1]) : null) as 7 | 6 | null;

  const d: CapabilityDecision = {
    rosMajor,
    // WireGuard became part of RouterOS in 7. On 6.x it is a separate package
    // that may or may not be installed; assuming either way yields a tunnel
    // that silently never handshakes.
    wireguard: rosMajor === 7
      ? { supported: true, reason: "RouterOS 7 includes WireGuard." }
      : rosMajor === 6
        ? {
          supported: false,
          reason: "WireGuard is not part of RouterOS 6. Install the wireguard package first, or accept the SSTP fallback for management.",
        }
        : { supported: false, reason: "The router did not report its RouterOS version, so WireGuard support cannot be confirmed." },
    sstp: rosMajor
      ? { supported: true, reason: "SSTP is available as the fallback management transport." }
      : { supported: false, reason: "The router did not report its RouterOS version." },
    ppp: { supported: true, reason: "The PPP server is present on every supported model." },
    hotspot: { supported: true, reason: "HotSpot is present on every supported model." },
    radius: !rosMajor
      ? { supported: false, reason: "No RouterOS version reported, so the RADIUS menu path cannot be chosen." }
      : rosMajor === 7
        ? { supported: true, reason: "RouterOS 7 uses the top-level /radius menu." }
        : { supported: true, reason: "RouterOS 6 nests the RADIUS client under /ip." },
    scheduler: { supported: true, reason: "The scheduler is present on every supported model." },
    blockers: [],
  };

  if (rosMajor === null) {
    d.blockers.push(
      "The router did not report its RouterOS version, so a version-correct script cannot be generated.",
    );
  }
  return d;
}

// --------------------------------------------------------------------------
// Public base URL
// --------------------------------------------------------------------------

/**
 * The router has to REACH NETPID, so this cannot be a guess. In production it
 * is VERCEL_URL; in development it is whatever the operator typed, because the
 * router is usually not on the internet-facing host.
 */
export function publicBaseUrl(): string {
  const explicit = process.env.NETPID_PUBLIC_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/, "");
  const vercel = process.env.VERCEL_URL?.trim();
  if (vercel) return vercel.startsWith("http") ? vercel : `https://${vercel}`;
  return "http://localhost:3000";
}

/** A private/LAN address a router on the same site could reach. */
function isPrivateHost(h: string): boolean {
  return h === "localhost"
    || h.startsWith("127.")
    || h.startsWith("10.")
    || h.startsWith("192.168.")
    || /^172\.(1[6-9]|2\d|3[01])\./.test(h)
    || h.endsWith(".local")
    || h.endsWith(".internal");
}

/**
 * Is this a throwaway deployment?
 *
 * The field paste used netpid-2b9dmps30-...-projects.vercel.app. A Vercel
 * preview host is deleted when its branch is deleted or merged, and the
 * configure script installs a heartbeat scheduler pointing at whatever host
 * served the request. Baking a preview host in leaves a router reporting to a
 * URL that 404s forever, with nothing in the dashboard to explain it.
 */
export function isEphemeralHost(host: string): boolean {
  const h = String(host ?? "").toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  if (!h) return true;
  if (h.includes("vercel.app") && !h.endsWith("vercel.app")) return true;  // a *preview* subdomain
  if (/\.preview\./.test(h)) return true;
  if (h.includes("ngrok") || h.includes("trycloudflare") || h.includes("loca.lt")) return true;
  return isPrivateHost(h);
}

/**
 * The host a router may call indefinitely, plus whether it is safe to bake in.
 *
 * The heartbeat is installed on the router with no expiry, so an unstable host
 * is a silent time bomb. When the host is not trustworthy the heartbeat is
 * omitted and the reason is returned for the dashboard to show.
 */
export function stableCallbackBase(): { base: string; stable: boolean; reason: string } {
  const explicit = process.env.NETPID_PUBLIC_URL?.trim();
  if (explicit) {
    const b = explicit.replace(/\/+$/, "");
    return { base: b, stable: true, reason: `NETPID_PUBLIC_URL (${b}).` };
  }
  const vercel = process.env.VERCEL_URL?.trim();
  if (vercel) {
    const b = vercel.startsWith("http") ? vercel : `https://${vercel}`;
    if (isEphemeralHost(b)) {
      return {
        base: b,
        stable: false,
        reason: `${b} is a preview or private address and will not exist long term. `
          + "Set NETPID_PUBLIC_URL to the production host, or the heartbeat this installs will call a URL that 404s.",
      };
    }
    return { base: b, stable: true, reason: `VERCEL_URL (${b}).` };
  }
  return {
    base: "http://localhost:3000",
    stable: false,
    reason: "No public host is configured. The router cannot reach a localhost address, so the heartbeat is omitted.",
  };
}

export interface SelectionInput {
  mode?: string | null;
  wan_interface?: string | null;
  hotspot_interfaces?: string[] | null;
  pppoe_interfaces?: string[] | null;
}

export interface SelectionResult {
  ok: boolean;
  mode: ProvisionMode | null;
  wan: string | null;
  hotspot: string[];
  pppoe: string[];
  errors: string[];
  warnings: string[];
}

const MODES: ProvisionMode[] = ["HOTSPOT", "PPPOE", "HOTSPOT_PPPOE"];

/**
 * Reject an impossible port plan BEFORE any script exists, so the conflict is
 * visible in the dashboard rather than discovered on a router that is now half
 * configured.
 */
export function validateSelection(
  input: SelectionInput,
  detected: DetectedInterface[] = [],
): SelectionResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const known = new Map(detected.map((d) => [d.name, d]));

  const raw = String(input.mode ?? "").toUpperCase();
  const mode = (MODES as string[]).includes(raw) ? (raw as ProvisionMode) : null;
  if (!mode) errors.push("Choose HotSpot, PPPoE, or both.");

  const wan = input.wan_interface?.trim() || null;
  if (!wan) {
    errors.push("Choose a WAN port.");
  } else if (!known.has(wan)) {
    warnings.push(`${wan} was not in the detected interface list.`);
  } else if (known.get(wan)!.in_bridge) {
    // A port enslaved to a bridge cannot also be routed as the WAN: the bridge
    // owns its addressing and the port becomes a LAN member.
    errors.push(`${wan} is a port of bridge ${known.get(wan)!.in_bridge}, so it cannot also be the WAN.`);
  }

  const hotspot = (input.hotspot_interfaces ?? []).map((s) => s.trim()).filter(Boolean);
  const pppoe = (input.pppoe_interfaces ?? []).map((s) => s.trim()).filter(Boolean);

  const wantsHotspot = mode === "HOTSPOT" || mode === "HOTSPOT_PPPOE";
  const wantsPppoe = mode === "PPPOE" || mode === "HOTSPOT_PPPOE";

  if (wantsHotspot && !hotspot.length) errors.push("HotSpot mode needs at least one HotSpot port.");
  if (wantsPppoe && !pppoe.length) errors.push("PPPoE mode needs at least one PPPoE port.");

  // The classic mistakes. Each silently produces a dead port on the box.
  for (const p of hotspot) {
    if (p === wan) errors.push(`${p} is the WAN and cannot also serve HotSpot.`);
    if (pppoe.includes(p)) errors.push(`${p} is in both HotSpot and PPPoE. A port serves one service.`);
  }
  for (const p of pppoe) {
    if (p === wan) errors.push(`${p} is the WAN and cannot also serve PPPoE.`);
  }
  const dup = hotspot.filter((p, i) => hotspot.indexOf(p) !== i);
  if (dup.length) errors.push(`Duplicate HotSpot port: ${dup[0]}.`);

  if (mode === "HOTSPOT" && pppoe.length) warnings.push("PPPoE ports ignored: mode is HotSpot.");
  if (mode === "PPPOE" && hotspot.length) warnings.push("HotSpot ports ignored: mode is PPPoE.");

  for (const p of [...hotspot, ...pppoe]) {
    const d = known.get(p);
    if (d?.in_bridge) {
      warnings.push(`${p} is in bridge ${d.in_bridge}; it will be removed from that bridge.`);
    }
  }

  return {
    ok: errors.length === 0,
    mode,
    wan: mode ? wan : null,
    hotspot: mode === "PPPOE" ? [] : hotspot,
    pppoe: mode === "HOTSPOT" ? [] : pppoe,
    errors,
    warnings,
  };
}

export interface DiscoveryPayload {
  board?: string | null;
  model?: string | null;
  version?: string | null;
  arch?: string | null;
  cpu?: string | null;
  ram?: string | null;
  ifaces?: string | null;
  bridges?: string | null;
}

/**
 * RouterOS query strings arrive with `+` for a space and %XX for anything
 * else. Its scripting language has no encoder, so a few fields travel raw and
 * need a tolerant decode.
 */
export function decodeParam(v: string | null | undefined): string {
  if (v == null) return "";
  let s = String(v).replace(/\+/g, " ");
  try { s = decodeURIComponent(s); } catch { /* keep the raw value */ }
  return s.trim();
}

/** "65536 KiB" / "32.4 MiB" / a bare number -> megabytes. */
export function parseRamMb(raw: string | number | null | undefined): number | null {
  if (raw == null || raw === "") return null;
  const s = String(raw).trim();
  const unit = /^([\d.]+)\s*([kmg])i?b$/i.exec(s);
  if (unit) {
    const v = Number.parseFloat(unit[1]);
    if (!Number.isFinite(v)) return null;
    if (/^m/i.test(unit[2])) return Math.round(v);
    if (/^k/i.test(unit[2])) return Math.round(v / 1024);
    return Math.round(v * 1024);
  }
  const n = Number.parseFloat(s);
  // A bare number from RouterOS total-memory is in KiB.
  return Number.isFinite(n) ? Math.round(n / 1024) : null;
}

export function parseInterfaceList(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return String(raw).split(/[,;]/).map((s) => s.trim()).filter(Boolean);
}

/** "bridge-lan:ether2,ether3" entries -> the bridges and their members. */
export function parseBridges(raw: string | null | undefined): DetectedBridge[] {
  if (!raw) return [];
  const out: DetectedBridge[] = [];
  for (const line of String(raw).split(/[;\n]/)) {
    const s = line.trim();
    if (!s) continue;
    const idx = s.indexOf(":");
    if (idx <= 0) continue;
    out.push({
      name: s.slice(0, idx).trim(),
      ports: parseInterfaceList(s.slice(idx + 1)),
    });
  }
  return out;
}

/**
 * The router's flat interface report, turned into what the wizard renders.
 *
 * A port enslaved to a bridge is never a WAN candidate: the bridge owns its
 * addressing, so that port is a LAN member whether or not the operator wants
 * it to be anything else.
 */
export function buildDetectedInterfaces(
  raw: string | null | undefined,
  bridges: DetectedBridge[] = [],
): DetectedInterface[] {
  const owner = new Map<string, string>();
  for (const b of bridges) for (const p of b.ports) owner.set(p, b.name);

  return parseInterfaceList(raw)
    .filter((n) => n && !n.startsWith("netpid-"))
    .map((name) => {
      const l = name.toLowerCase();
      const type = l.startsWith("bridge") ? "bridge"
        : l.startsWith("sfp") ? "sfp"
        : l.startsWith("vlan") ? "vlan"
        : l.startsWith("wlan") || l.startsWith("wifi") ? "wireless"
        : l.startsWith("lte") || l.startsWith("ppp") ? "cellular"
        : l.startsWith("ether") ? "ethernet"
        : "other";
      const inBridge = owner.get(name) ?? null;
      return {
        name,
        type,
        in_bridge: inBridge,
        is_candidate_wan: type === "ethernet" && inBridge === null,
      };
    });
}