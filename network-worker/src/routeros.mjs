// Pure RouterOS provisioning-script generator.
//
// Dependency-free and side-effect free so it can be unit-tested with
// `node --test` and reused by BOTH provisioning entry points:
//   * network-worker/scripts/provision-router.mjs  (script-only, no dashboard)
//   * apps/web/app/api/routers                     (manual add in the dashboard)
// Keeping one generator is deliberate: if the two drifted, a router provisioned
// by hand and one provisioned by script would end up configured differently.
//
// RATE ORDERING (the single most error-prone detail in this file):
// MikroTik writes every rate pair as "<upload>/<download>", upload FIRST.
//   RADIUS Mikrotik-Rate-Limit = "512k/5120k"   (512 up, 5120 down)
//   /queue simple max-limit     = "512k/5120k"   (same order)
// This matches formatRateLimit() in radius-logic.js and netpid_rate_limit() in
// supabase/migrations/0034. Getting it backwards silently halves a customer's
// download, so all formatting goes through ratePair() below.

/** MikroTik rate pair: upload first. Returns null when there is no cap. */
export function ratePair(uploadKbps, downloadKbps) {
  const up = Math.max(0, Math.floor(Number(uploadKbps) || 0));
  const down = Math.max(0, Math.floor(Number(downloadKbps) || 0));
  if (up <= 0 && down <= 0) return null;
  // A zero side means "same as the other": MikroTik reads a literal 0 as an
  // undefined limit, which is how customers end up uncapped by accident.
  const rx = up > 0 ? up : down;
  const tx = down > 0 ? down : up;
  return `${rx}k/${tx}k`;
}

// RouterOS quoting: wrap in double quotes, escape " and \ and newlines.
export function rosQuote(value) {
  const s = String(value ?? "");
  if (s !== "" && /^[A-Za-z0-9._:/@-]+$/.test(s)) return s;
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r?\n/g, " ")}"`;
}

/** RouterOS-safe name: letters, digits, dot, dash, underscore. */
export function rosName(value, fallback = "netpid") {
  const s = String(value ?? "")
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return s || fallback;
}

function comment(text) {
  return `# ${text}`;
}

/**
 * Full "point this router at NETPID" script.
 *
 * @param {object} o
 * @param {string} o.shortname     NAS shortname (matches the FreeRADIUS client)
 * @param {string} o.radiusServer  FreeRADIUS IP/hostname
 * @param {string} o.secret        Shared secret — shown once, never stored in clear
 * @param {string} [o.routerIp]    Source address presented to RADIUS
 * @param {number} [o.authPort]    default 1812
 * @param {number} [o.acctPort]    default 1813
 * @param {number} [o.coaPort]     default 3799 (RFC 3576 Disconnect-Request)
 * @param {string} [o.identity]    /system/identity name
 * @param {Array<{name:string,kind?:string,pool?:string,
 *                download_kbps?:number,upload_kbps?:number}>} [o.profiles]
 *        PPPoE + HotSpot profiles carrying per-profile speed caps.
 * @returns {string} RouterOS CLI, one command per line.
 */
export function buildRouterosSetup(o = {}) {
  const shortname = rosName(o.shortname, "netpid-nas");
  const server = rosQuote(o.radiusServer ?? "");
  const secret = rosQuote(o.secret ?? "");
  const authPort = Number(o.authPort) || 1812;
  const acctPort = Number(o.acctPort) || 1813;
  const coaPort = Number(o.coaPort) || 3799;
  const src = o.routerIp ? ` src-address=${rosQuote(o.routerIp)}` : "";
  const profiles = Array.isArray(o.profiles) ? o.profiles : [];
  const byName = (kind) => profiles.filter((p) => (p.kind ?? "pppoe") === kind);

  const lines = [
    comment("=== NETPID router provisioning ==="),
    comment(`NAS shortname : ${shortname}`),
    comment(`RADIUS server : ${o.radiusServer ?? "<not set>"}`),
    comment("Paste into Terminal, or upload as a .rsc and import it in Files."),
    "",
  ];

  if (o.identity) {
    lines.push(comment("0. Router identity (shown in the NETPID dashboard)"));
    lines.push(`/system identity set name=${rosQuote(o.identity)}`);
    lines.push("");
  }

  lines.push(comment("1. RADIUS accounting client (PPP + HotSpot share one service)"));
  // Replace any previous stanza first so re-running the script is idempotent.
  lines.push(`:do { /ip/radius remove [find comment=${rosQuote(`NETPID:${shortname}`)}] } on-error={}`);
  lines.push(
    `/radius add service=ppp,hotspot address=${server} secret=${secret} ` +
      `auth-port=${authPort} acct-port=${acctPort} timeout=1500ms${src} ` +
      `comment=${rosQuote(`NETPID:${shortname}`)}`,
  );
  lines.push("");

  lines.push(comment("2. PPPoE — credentials go to RADIUS, accounting comes back"));
  lines.push("/ppp aaa set use-radius=yes accounting=yes interim-update=5m");
  for (const p of byName("pppoe")) {
    const name = rosName(p.name, "pppoe-profile");
    const limit = ratePair(p.upload_kbps, p.download_kbps);
    const pool = p.pool ? ` remote-address=${rosQuote(p.pool)}` : "";
    const rate = limit ? ` rate-limit=${limit}` : "";
    lines.push(`/ppp profile set [find name=${rosQuote(name)}]${pool} use-radius=yes${rate}`);
  }
  lines.push("");

  lines.push(comment("3. HotSpot — captive-portal logins also authorize via RADIUS"));
  for (const p of byName("hotspot")) {
    const name = rosName(p.name, "hotspot-profile");
    const limit = ratePair(p.upload_kbps, p.download_kbps);
    const rate = limit ? ` rate-limit=${limit}` : "";
    lines.push(
      `/ip hotspot profile set [find name=${rosQuote(name)}] use-radius=yes ` +
        `accounting=yes interim-update=5m login-by=http-chap,http-pap,madius${rate}`,
    );
  }
  lines.push("");

  const capped = profiles.filter((p) => ratePair(p.upload_kbps, p.download_kbps));
  if (capped.length) {
    lines.push(comment("4. Simple queues — one per profile (upload/download, upload first)"));
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

  lines.push(comment("5. CoA — lets NETPID disconnect a user from the dashboard"));
  lines.push(
    `/radius incoming set accept=yes port=${coaPort} comment=${rosQuote(`NETPID:${shortname}`)}`,
  );
  lines.push("");
  lines.push(comment("Done. Confirm in NETPID: Dashboard > Network > this router."));
  return lines.join("\n");
}

/**
 * Per-customer simple queue — explicit download/upload capping on the router
 * itself, independent of RADIUS. Useful for a static-IP customer, or when the
 * ISP wants a hard ceiling the RADIUS attribute path cannot express.
 */
export function buildCustomerQueue(customer) {
  const name = rosName(`netpid-${customer.username ?? customer.customer_no}`, "netpid-user");
  const limit = ratePair(customer.upload_kbps, customer.download_kbps);
  if (!limit) return null;
  const target = customer.framed_ip
    ? `${customer.framed_ip}/32`
    : `[find name=${rosQuote(customer.username)}]`;
  return [
    comment(`Simple queue for ${customer.username ?? customer.customer_no}`),
    `:do { /queue simple remove [find name=${rosQuote(name)}] } on-error={}`,
    `/queue simple add name=${rosQuote(name)} target=${target} max-limit=${limit} ` +
      `queue=default/default comment=${rosQuote("NETPID")}`,
  ].join("\n");
}
