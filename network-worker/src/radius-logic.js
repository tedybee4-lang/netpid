// Pure (dependency-free) RADIUS/tenant logic shared by the worker jobs.
// Kept side-effect free so it is unit-testable with `node --test`
// (network-worker/test/*.test.js) without a database or RADIUS server.

export const GIGAWORD = 4294967296; // 2^32 — Acct-Input/Output-Gigawords multiplier

// RFC 2865: radcheck/radreply/radusergroup keys on the bare username.
// FreeRADIUS strips the realm itself, but our sync + probes must agree on one
// canonical form: "DOMAIN\user@realm" -> "user".
export function bareUsername(raw) {
  let u = String(raw ?? "").trim();
  const at = u.indexOf("@");
  if (at > 0) u = u.slice(0, at);
  const back = u.lastIndexOf("\\");
  if (back >= 0) u = u.slice(back + 1);
  return u;
}

// RADIUS "User-Name" is printable ASCII only; reject early instead of writing
// garbage rows into radcheck.
export function isValidUsername(u) {
  const s = bareUsername(u);
  return s.length >= 2 && s.length <= 64 && /^[a-zA-Z0-9._-]+$/.test(s);
}

// A customer is entitled to RADIUS authorization only while active.
// pending/expired/suspended/blocked/terminated must never authorize.
export function isEnabledForStatus(status) {
  return String(status ?? "").toLowerCase() === "active";
}

export function octetsWithGigawords(octets, gigawords) {
  const lo = Number(octets ?? 0);
  if (!Number.isFinite(lo) || lo < 0) return 0;
  const hi = Number(gigawords ?? 0);
  if (!Number.isFinite(hi) || hi <= 0) return lo;
  return lo + hi * GIGAWORD;
}

export function normalizeIp(v) {
  if (v === null || v === undefined) return "";
  let s = String(v).trim();
  if (s.startsWith("::ffff:")) s = s.slice(7); // IPv4-mapped IPv6 from inet columns
  return s.toLowerCase();
}

// ---------------------------------------------------------------------------
// Tenant resolution
// ---------------------------------------------------------------------------

// `nas` rows are keyed (isp_id, nasname): two ISPs may share one public IP
// (CGNAT / shared VPN hub), so a NAS IP alone is NOT a tenant identity.
// A username may also legitimately exist in more than one ISP
// (docs/ARCHITECTURE.md: unique is (isp_id, username), never global).
// Resolution order:
//   1. the candidate ISP that actually owns the username (radius_users/radcheck)
//   2. otherwise the lowest NAS id (deterministic, never arbitrary)
// Callers must treat `null` as "unknown tenant" and never write cross-tenant.
export function pickIspId(candidates, ownerIspIds) {
  const list = (candidates ?? []).filter((c) => c && c.isp_id);
  if (!list.length) return null;
  const owners = ownerIspIds instanceof Set ? ownerIspIds : new Set(ownerIspIds ?? []);
  const byId = [...list].sort((a, b) => String(a.id ?? "").localeCompare(String(b.id ?? "")));
  if (owners.size) {
    const owned = byId.filter((c) => owners.has(c.isp_id));
    if (owned.length) return owned[0].isp_id;
  }
  return byId[0].isp_id;
}

// nasname -> candidate rows, preserving every ISP sharing that IP.
export function indexNasByName(nasRows) {
  const map = new Map();
  for (const n of nasRows ?? []) {
    if (!n?.nasname) continue;
    const key = normalizeIp(n.nasname);
    const list = map.get(key) ?? [];
    list.push({ id: n.id, isp_id: n.isp_id, nasname: n.nasname, shortname: n.shortname });
    map.set(key, list);
  }
  return map;
}

export function indexUsernameOwners(radiusUsers) {
  const map = new Map();
  for (const u of radiusUsers ?? []) {
    if (!u?.username || !u?.isp_id) continue;
    const key = bareUsername(u.username);
    const set = map.get(key) ?? new Set();
    set.add(u.isp_id);
    map.set(key, set);
  }
  return map;
}

// Resolve the tenant of an accounting/auth packet: NAS IP first, then the
// NAS-IP-Address attribute carried in the packet (CGNAT mode), then give up.
export function resolvePacketTenant({ nasIndex, ownerIndex, nasIp, nasIpAttr, username }) {
  const owners = ownerIndex?.get?.(bareUsername(username));
  for (const ip of [nasIp, nasIpAttr]) {
    const key = normalizeIp(ip);
    if (!key) continue;
    const candidates = nasIndex?.get?.(key);
    if (candidates?.length) return pickIspId(candidates, owners);
  }
  return null;
}

// ---------------------------------------------------------------------------
// radcheck / radreply / radusergroup / radgroupreply row planning
// ---------------------------------------------------------------------------

// Auth must be protocol-agnostic: PPPoE (CHAP/MS-CHAP) and HotSpot (PAP/CHAP)
// all authenticate from a single Cleartext-Password row, because FreeRADIUS
// auto-selects Auth-Type from the incoming request when no Auth-Type is stored.
// Forcing "Auth-Type := MS-CHAP" broke HotSpot/PAP, so it is never written;
// legacy rows are purged (LEGACY_AUTH_ATTRS).
export const LEGACY_AUTH_ATTRS = ["Auth-Type"];

export function radcheckRows(username, password, ispId) {
  const rows = [];
  if (password) {
    rows.push({ username: bareUsername(username), attribute: "Cleartext-Password", op: ":=", value: String(password), isp_id: ispId });
  }
  return rows;
}

// Per-user reply overrides. Bandwidth/session limits belong to the GROUP
// (radgroupreply); only identity/IP facts are per user here.
export function radreplyRows({ username, ispId, serviceType, staticIp, rateLimitOverride, sessionTimeout }) {
  const u = bareUsername(username);
  const rows = [];
  if (staticIp) rows.push({ username: u, attribute: "Framed-IP-Address", op: "=", value: String(staticIp), isp_id: ispId });
  if (serviceType === "pppoe" || serviceType === "static") {
    rows.push({ username: u, attribute: "Framed-Protocol", op: "=", value: "PPP", isp_id: ispId });
  }
  if (rateLimitOverride) {
    rows.push({ username: u, attribute: "Mikrotik-Rate-Limit", op: "=", value: rateLimitOverride, isp_id: ispId });
  }
  if (Number(sessionTimeout) > 0) {
    rows.push({ username: u, attribute: "Session-Timeout", op: "=", value: String(Number(sessionTimeout)), isp_id: ispId });
  }
  return rows;
}

export function radusergroupRows(username, groupName, ispId) {
  if (!groupName) return [];
  return [{ username: bareUsername(username), groupname: String(groupName), priority: 1, isp_id: ispId }];
}

// MikroTik expects "<rx-rate>/<tx-rate>" == "<upload>k/<download>k" — upload
// first (supabase/migrations/0021_radius_triggers.sql).
export function formatRateLimit(uploadKbps, downloadKbps) {
  const up = Number(uploadKbps ?? 0) || 0;
  const down = Number(downloadKbps ?? 0) || 0;
  if (up <= 0 && down <= 0) return null;
  const rx = up > 0 ? up : down;
  const tx = down > 0 ? down : up;
  return `${rx}k/${tx}k`;
}

const RADIUS_ATTR_NAME = /^[A-Za-z][A-Za-z0-9-]{1,63}$/;
const VALID_OPS = new Set(["=", ":=", "==", "+=", "!=", ">=", "<="]);

// radius_group_attributes -> radgroupreply rows.
// Zero/empty limits are dropped: "Session-Timeout = 0" would kill the session
// immediately on MikroTik instead of meaning "unlimited".
export function radgroupreplyRows(attributes) {
  const rows = [];
  for (const a of attributes ?? []) {
    const attr = String(a?.attribute ?? "").trim();
    if (!RADIUS_ATTR_NAME.test(attr)) continue;
    const raw = String(a?.value ?? "").trim();
    if (!raw || raw === "0" || /^0k\/0k$/i.test(raw)) continue;
    const opRaw = String(a?.op ?? "=").trim();
    rows.push({ groupname: String(a?.groupname ?? ""), attribute: attr, op: VALID_OPS.has(opRaw) ? opRaw : "=", value: raw });
  }
  return rows;
}
// ---------------------------------------------------------------------------
// Accounting lifecycle
// ---------------------------------------------------------------------------

// radacct row (radius_db) -> public.radius_sessions row (app DB).
export function mapAccountingRow(row, ispId) {
  const stopped = Boolean(row?.acctstoptime);
  return {
    isp_id: ispId,
    acct_session_id: String(row?.acctsessionid ?? ""),
    acct_unique_id: String(row?.acctuniqueid ?? ""),
    username: bareUsername(row?.username),
    nas_ip: row?.nasipaddress ?? null,
    framed_ip: row?.framedipaddress ?? null,
    calling_station: row?.callingstationid ?? null,
    start_time: row?.acctstarttime ?? null,
    last_update: row?.acctupdatetime ?? null,
    stop_time: stopped ? row.acctstoptime : null,
    session_seconds: Number(row?.acctsessiontime ?? 0) || 0,
    input_octets: octetsWithGigawords(row?.acctinputoctets, row?.acctinputgigawords),
    output_octets: octetsWithGigawords(row?.acctoutputoctets, row?.acctoutputgigawords),
    terminate_cause: row?.acctterminatecause ?? null,
    is_open: !stopped,
    updated_at: new Date().toISOString(),
  };
}

// A session that never received its Stop (router reboot / NAS vanished) would
// stay "online" forever. Anything open and not refreshed inside the grace
// window is force-closed by the accounting sweep.
export function isStaleOpenSession(lastUpdate, nowMs, graceMinutes = 30) {
  if (!lastUpdate) return true;
  const t = new Date(lastUpdate).getTime();
  if (!Number.isFinite(t)) return true;
  return nowMs - t > graceMinutes * 60_000;
}

export function staleCutoffIso(nowMs, graceMinutes = 30) {
  return new Date(nowMs - graceMinutes * 60_000).toISOString();
}

// radclient args / stdin for a Disconnect-Request (RFC 3576) to a MikroTik NAS.
export function radclientDisconnectArgs(server, port, secret) {
  return [String(server), String(port ?? 3799), "disconnect", String(secret)];
}

export function radclientDisconnectInput({ username, framedIp, acctSessionId }) {
  const lines = [`User-Name=${bareUsername(username)}`];
  if (framedIp) lines.push(`Framed-IP-Address=${framedIp}`);
  if (acctSessionId) lines.push(`Acct-Session-Id=${acctSessionId}`);
  return lines.join("\n") + "\n";
}

// Groups that still need a sync: new group, renamed group, or changed limits.
export function groupNeedsSync(group, attributes, nowMs) {
  if (!group?.group_name) return false;
  if (group.sync_status !== "synced") return true;
  const syncedAt = group.last_synced_at ? new Date(group.last_synced_at).getTime() : 0;
  for (const a of attributes ?? []) {
    const changed = a?.updated_at ? new Date(a.updated_at).getTime() : 0;
    if (changed > syncedAt) return true;
  }
  void nowMs;
  return false;
}

