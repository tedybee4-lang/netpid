// RouterOS provisioning-script generator for the dashboard.
//
// This is the TypeScript twin of network-worker/src/routeros.mjs. Both exist on
// purpose: the worker is plain Node ESM and the dashboard is a Next.js app that
// cannot import across package boundaries. The two are kept honest by
// network-worker/test/routeros.test.js, which pins the behaviour (rate order,
// version paths, quoting) that must never differ.
//
// RATE ORDERING: MikroTik writes every rate pair as "<upload>/<download>",
// upload FIRST. "/queue simple max-limit=512k/5120k" means 512k up, 5120k down.
// Reversing it silently halves a customer's download, so everything goes
// through ratePair().

/** MikroTik rate pair: upload first. Returns null when there is no cap. */
export function ratePair(uploadKbps: number | null | undefined, downloadKbps: number | null | undefined): string | null {
  const up = Math.max(0, Math.floor(Number(uploadKbps) || 0));
  const down = Math.max(0, Math.floor(Number(downloadKbps) || 0));
  if (up <= 0 && down <= 0) return null;
  // A zero side means "same as the other": MikroTik reads a literal 0 as an
  // undefined limit, which is how customers end up uncapped by accident.
  const rx = up > 0 ? up : down;
  const tx = down > 0 ? down : up;
  return `${rx}k/${tx}k`;
}

/** RouterOS quoting: wrap in double quotes, escape " and \ and newlines. */
export function rosQuote(value: unknown): string {
  const s = String(value ?? "");
  if (s !== "" && /^[A-Za-z0-9._:/@-]+$/.test(s)) return s;
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r?\n/g, " ")}"`;
}

/** RouterOS-safe name: letters, digits, dot, dash, underscore. */
export function rosName(value: unknown, fallback = "netpid"): string {
  const s = String(value ?? "")
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return s || fallback;
}

/** Normalise a RouterOS major version; anything unknown falls back to 7. */
export function normalizeRosVersion(value: unknown): "6" | "7" {
  const s = String(value ?? "").trim().toLowerCase();
  return s === "6" || s === "6.x" || s.startsWith("6.") ? "6" : "7";
}

/**
 * Menu paths that MOVED between RouterOS 6 and 7.
 *
 * The two that actually break a pasted script:
 *   - 7.14+ ships wifiwave2, so the radio is /interface/wifi, not
 *     /interface/wireless. A v7 script that assumes "wireless" finds nothing
 *     and the AP stays dark.
 *   - 7 moved the lease to /ip/dhcp-server/lease; the v6 form still resolves
 *     on 6.x, so each script gets its own.
 */
export function rosPaths(version: unknown) {
  const v7 = normalizeRosVersion(version) === "7";
  return {
    version: v7 ? ("7" as const) : ("6" as const),
    wireless: v7 ? "/interface wifi" : "/interface wireless",
    radioName: v7 ? "wifi1" : "wlan1",
    dhcpLease: v7 ? "/ip/dhcp-server/lease" : "/ip/dhcp-server lease",
    cookieHardening: v7,
  };
}

export interface ScriptProfile {
  name: string;
  kind?: string;
  pool?: string;
  download_kbps?: number;
  upload_kbps?: number;
}

export interface ScriptOptions {
  shortname?: string;
  radiusServer?: string;
  secret?: string;
  routerIp?: string;
  authPort?: number;
  acctPort?: number;
  coaPort?: number;
  identity?: string;
  rosVersion?: string;
  timezone?: string;
  dnsServers?: string;
  ntpServers?: string;
  wifiSsid?: string;
  country?: string;
  apiPort?: number;
  apiSslPort?: number;
  useSsl?: boolean;
  profiles?: ScriptProfile[];
}

/**
 * Full "point this router at NETPID" script. Everything the operator would
 * otherwise have to type is derived from the options, so a router onboarded by
 * name and one onboarded by hand end up configured identically.
 */
export function buildRouterosSetup(o: ScriptOptions = {}): string {
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

  const paths = rosPaths(o.rosVersion);
  const timezone = rosQuote(o.timezone ?? "Africa/Nairobi");
  const dns = String(o.dnsServers ?? "1.1.1.1,8.8.8.8").split(",").map((s) => s.trim()).filter(Boolean);
  const ntp = String(o.ntpServers ?? "pool.ntp.org").split(",").map((s) => s.trim()).filter(Boolean);
  const identity = o.identity ?? shortname;
  const c = (t: string) => `# ${t}`;

  const lines: string[] = [
    c(`=== NETPID router provisioning - RouterOS ${paths.version} ===`),
    c(`NAS shortname : ${shortname}`),
    c(`RADIUS server : ${o.radiusServer ?? "<not set>"}`),
    c("Paste into Terminal, or upload as a .rsc and import it in Files."),
    c("Idempotent: re-running replaces only the lines NETPID owns."),
    "",
  ];

  // 0 - system basics. A router with no clock or resolver fails RADIUS
  // handshakes intermittently, so this runs before anything else.
  lines.push(c("0. Identity, clock, DNS and NTP"));
  lines.push(`/system identity set name=${rosQuote(identity)}`);
  lines.push(`/system clock set time-zone-name=${timezone}`);
  for (const s of dns) lines.push(`/ip dns set servers=${rosQuote(s)}`);
  if (ntp.length) {
    lines.push("/system ntp client set enabled=yes");
    for (const s of ntp) lines.push(`/system ntp client servers add address=${rosQuote(s)}`);
  }
  lines.push("");

  // 1 - the API service. NETPID polls and configures this router over it, so it
  // must be on before the dashboard can see the device. The API password is set
  // by NETPID's provisioning call and never printed in this file.
  lines.push(c("1. RouterOS API - required so NETPID can manage this router"));
  lines.push(`/ip service set api disabled=no port=${Number(o.apiPort) || 8728}`);
  lines.push(
    `/ip service set api-ssl disabled=${o.useSsl === false ? "yes" : "no"} ` +
      `port=${Number(o.apiSslPort) || 8729}`,
  );
  lines.push("");

  lines.push(c("3. RADIUS accounting client (PPP + HotSpot share one service)"));
  lines.push(`:do { /ip/radius remove [find comment=${rosQuote(`NETPID:${shortname}`)}] } on-error={}`);
  lines.push(
    `/radius add service=ppp,hotspot address=${server} secret=${secret} ` +
      `auth-port=${authPort} acct-port=${acctPort} timeout=1500ms${src} ` +
      `comment=${rosQuote(`NETPID:${shortname}`)}`,
  );
  lines.push("");

  lines.push(c("4. PPPoE - credentials go to RADIUS, accounting comes back"));
  lines.push("/ppp aaa set use-radius=yes accounting=yes interim-update=5m");
  for (const p of byName("pppoe")) {
    const name = rosName(p.name, "pppoe-profile");
    const limit = ratePair(p.upload_kbps, p.download_kbps);
    const pool = p.pool ? ` remote-address=${rosQuote(p.pool)}` : "";
    const rate = limit ? ` rate-limit=${limit}` : "";
    lines.push(`/ppp profile set [find name=${rosQuote(name)}]${pool} use-radius=yes${rate}`);
  }
  lines.push("");

  lines.push(c("5. HotSpot - captive-portal logins also authorize via RADIUS"));
  for (const p of byName("hotspot")) {
    const name = rosName(p.name, "hotspot-profile");
    const limit = ratePair(p.upload_kbps, p.download_kbps);
    const rate = limit ? ` rate-limit=${limit}` : "";
    // HttpOnly on the session cookie is a 7.x property; older 6.x refuses it,
    // which would abort the rest of the paste, so it is v7-only.
    const cookie = paths.cookieHardening ? " http-cookie-httponly=yes" : "";
    lines.push(
      `/ip hotspot profile set [find name=${rosQuote(name)}] use-radius=yes ` +
        `accounting=yes interim-update=5m login-by=http-chap,http-pap,madius${rate}${cookie}`,
    );
  }
  lines.push("");

  const capped = profiles.filter((p) => ratePair(p.upload_kbps, p.download_kbps));
  if (capped.length) {
    lines.push(c("6. Simple queues - one per profile (upload/download, upload first)"));
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

  lines.push(c("7. CoA - lets NETPID disconnect a user from the dashboard"));
  lines.push(
    `/radius incoming set accept=yes port=${coaPort} comment=${rosQuote(`NETPID:${shortname}`)}`,
  );
  lines.push("");

  // 8 - radio. Only emitted when the ISP gave us an SSID: creating a bridge on
  // a router with an unknown topology is the operator's call, not something a
  // pasted script should guess at.
  if (o.wifiSsid) {
    const ssid = rosQuote(o.wifiSsid);
    const country = rosQuote(o.country ?? "Kenya");
    lines.push(c(`8. Wi-Fi AP - ${paths.version === "7"
      ? "v7.14+ moved this menu to /interface/wifi; on older 7.x use the v6 script"
      : "v6 keeps the radio at /interface/wireless"}`));
    // 6.x names the radios wlan1/wlan2; 7.14+ names them wifi1/wifi2.
    lines.push(
      `:do { ${paths.wireless} set [find name=${rosQuote(paths.radioName)}] ` +
        `ssid=${ssid} mode=ap-bridge country=${country} disabled=no } on-error={}`,
    );
    lines.push(c("   If the AP did not come up, your router is on the other major " +
      "version - run the matching script from this router's NETPID page."));
    lines.push("");
  }

  lines.push(c("Verify - these should print without error"));
  lines.push("/system resource print");
  lines.push("/ip/radius print");
  lines.push("/radius/incoming print");
  lines.push("/ppp/aaa print");
  lines.push("/interface/print");
  lines.push("");
  lines.push(c("Done. Confirm in NETPID: Dashboard > Network > this router."));
  return lines.join("\n");
}

/** Both scripts for one router, so the operator picks the one that matches. */
export function buildRouterosScripts(o: ScriptOptions = {}): { v6: string; v7: string } {
  return {
    v6: buildRouterosSetup({ ...o, rosVersion: "6" }),
    v7: buildRouterosSetup({ ...o, rosVersion: "7" }),
  };
}

/**
 * Per-customer simple queue - explicit download/upload capping on the router
 * itself, independent of RADIUS. Useful for a static-IP customer, or when the
 * ISP wants a hard ceiling the RADIUS attribute path cannot express.
 */
export function buildCustomerQueue(customer: {
  username?: string; customer_no?: string; framed_ip?: string | null;
  download_kbps?: number; upload_kbps?: number;
}): string | null {
  const name = rosName(`netpid-${customer.username ?? customer.customer_no}`, "netpid-user");
  const limit = ratePair(customer.upload_kbps, customer.download_kbps);
  if (!limit) return null;
  const target = customer.framed_ip
    ? `${customer.framed_ip}/32`
    : `[find name=${rosQuote(customer.username)}]`;
  return [
    `# Simple queue for ${customer.username ?? customer.customer_no}`,
    `:do { /queue simple remove [find name=${rosQuote(name)}] } on-error={}`,
    `/queue simple add name=${rosQuote(name)} target=${target} max-limit=${limit} ` +
      `queue=default/default comment=${rosQuote("NETPID")}`,
  ].join("\n");
}
