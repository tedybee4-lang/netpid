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
  if (s !== "" && /^[A-Za-z0-9._/@-]+$/.test(s)) return s;
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
 * Normalise a RouterOS major version. Anything unrecognised falls back to "7",
 * the version NETPID provisions by default.
 */
export function normalizeRosVersion(value) {
  const s = String(value ?? "").trim().toLowerCase();
  if (s === "6" || s === "6.x" || s.startsWith("6.")) return "6";
  return "7";
}

/**
 * Menu paths that MOVED between RouterOS 6 and 7.
 *
 * The two that actually break a pasted script:
 *   - 7.14+ ships wifiwave2, so the radio is /interface/wifi, not
 *     /interface/wireless. A v7 script that assumes "wireless" simply finds
 *     nothing and the AP stays dark.
 *   - 7 moved lease to the /ip/dhcp-server/lease path. The v6 form still
 *     resolves on 6.x and on 6.46+, so each script gets its own.
 */
export function rosPaths(version) {
  const v7 = normalizeRosVersion(version) === "7";
  return {
    version: v7 ? "7" : "6",
    wireless: v7 ? "/interface wifi" : "/interface wireless",
    // The radio interface is named wlan* on 6.x and wifi* on 7.14+.
    radioName: v7 ? "wifi1" : "wlan1",
    dhcpLease: v7 ? "/ip/dhcp-server/lease" : "/ip/dhcp-server lease",
    // 7 added HttpOnly to the HotSpot cookie (6.46 backported it, older 6 not).
    // v6 nests the RADIUS client under /ip; v7 promotes it to a top-level menu.
    radiusClient: v7 ? "/radius" : "/ip radius",
    cookieHardening: v7,
  };
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
  if (o.radiusOnly !== true) {
    throw new Error(
      "buildRouterosSetup() is the RADIUS/PPP-only script and does not configure "
      + "LAN, DHCP, NAT, firewall, HotSpot or PPPoE. For router provisioning use "
      + "buildRouterosInstaller() from ./installer.mjs.",
    );
  }
  const shortname = rosName(o.shortname, "netpid-nas");
  const server = rosQuote(o.radiusServer ?? "");
  const secret = rosQuote(o.secret ?? "");
  const authPort = Number(o.authPort) || 1812;
  const acctPort = Number(o.acctPort) || 1813;
  const coaPort = Number(o.coaPort) || 3799;
  const src = o.routerIp ? ` src-address=${rosQuote(o.routerIp)}` : "";
  const profiles = Array.isArray(o.profiles) ? o.profiles : [];
  const byName = (kind) => profiles.filter((p) => (p.kind ?? "pppoe") === kind);

  const paths = rosPaths(o.rosVersion);
  const timezone = rosQuote(o.timezone ?? "Africa/Nairobi");
  const dns = String(o.dnsServers ?? "1.1.1.1,8.8.8.8").split(",").map((s) => s.trim()).filter(Boolean);
  const ntp = String(o.ntpServers ?? "pool.ntp.org").split(",").map((s) => s.trim()).filter(Boolean);
  const identity = o.identity ?? shortname;

  const lines = [
    comment(`=== NETPID router provisioning - RouterOS ${paths.version} ===`),
    comment(`NAS shortname : ${shortname}`),
    comment(`RADIUS server : ${o.radiusServer ?? "<not set>"}`),
    comment("Paste into Terminal, or upload as a .rsc and import it in Files."),
    comment("Idempotent: re-running replaces only the lines NETPID owns."),
    "",
  ];

  // 0 - system basics. A router with no clock or resolver fails RADIUS
  // handshakes intermittently, so this runs before anything else.
  lines.push(comment("0. Identity, clock, DNS and NTP"));
  lines.push(`/system identity set name=${rosQuote(identity)}`);
  lines.push(`/system clock set time-zone-name=${timezone}`);
  for (const s of dns) lines.push(`/ip dns set servers=${rosQuote(s)}`);
  if (ntp.length) {
    lines.push("/system ntp client set enabled=yes");
    for (const s of ntp) lines.push(`/system ntp client servers add address=${rosQuote(s)}`);
  }
  lines.push("");

  // 1 - the API service. NETPID polls and configures this router over it, so
  // it must be on before the dashboard can see the device. The password is set
  // by NETPID's own provisioning call, never printed in this file.
  lines.push(comment("1. RouterOS API - required so NETPID can manage this router"));
  lines.push(`/ip service set api disabled=no port=${Number(o.apiPort) || 8728}`);
  lines.push(
    `/ip service set api-ssl disabled=${o.useSsl === false ? "yes" : "no"} ` +
      `port=${Number(o.apiSslPort) || 8729}`,
  );
  lines.push("");

  lines.push(comment("3. RADIUS server - one entry serves PPPoE and HotSpot"));
  // Replace any previous stanza first so re-running the script is idempotent.
  lines.push(`:do { ${paths.radiusClient} remove [find comment=${rosQuote(`NETPID:${shortname}`)}] } on-error={}`);
  lines.push(
    `${paths.radiusClient} add service=ppp,hotspot address=${server} secret=${secret} ` +
      `authentication-port=${authPort} accounting-port=${acctPort} timeout=1500ms${src} ` +
      `comment=${rosQuote(`NETPID:${shortname}`)}`,
  );
  lines.push("");

  lines.push(comment("4. PPPoE - credentials go to RADIUS, accounting comes back"));
  lines.push("/ppp aaa set use-radius=yes accounting=yes interim-update=5m");
  for (const p of byName("pppoe")) {
    const name = rosName(p.name, "pppoe-profile");
    const limit = ratePair(p.upload_kbps, p.download_kbps);
    const pool = p.pool ? ` remote-address=${rosQuote(p.pool)}` : "";
    const rate = limit ? ` rate-limit=${limit}` : "";
    lines.push(`/ppp profile set [find name=${rosQuote(name)}]${pool} use-radius=yes${rate}`);
  }
  lines.push("");

  const hotspot = byName("hotspot");
  if (hotspot.length) {
    lines.push(comment("5. HotSpot - captive-portal logins also authorize via RADIUS"));
    for (const p of hotspot) {
      const name = rosName(p.name, "hotspot-profile");
      const limit = ratePair(p.upload_kbps, p.download_kbps);
      const rate = limit ? ` rate-limit=${limit}` : "";
      // HttpOnly on the session cookie is a 7.x property; on 6.x it is either
      // absent or refused, so it is only emitted for v7.
      const cookie = paths.cookieHardening ? " http-cookie-httponly=yes" : "";
      lines.push(
        `/ip hotspot profile set [find name=${rosQuote(name)}] use-radius=yes ` +
          `accounting=yes interim-update=5m login-by=http-chap,http-pap,madius${rate}${cookie}`,
      );
    }
  }
  lines.push("");

  const capped = profiles.filter((p) => ratePair(p.upload_kbps, p.download_kbps));
  if (capped.length) {
    lines.push(comment("6. Simple queues - one per profile (upload/download, upload first)"));
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

  lines.push(comment("7. CoA - lets NETPID disconnect a user from the dashboard"));
  // /radius/incoming is a SETTINGS singleton with only accept, port and vrf.
  // Setting "comment" on it is not a property, so the line was rejected and CoA
  // stayed off. A singleton needs no remove-first either.
  lines.push(`/radius incoming set accept=yes port=${coaPort}`);
  // accept=yes is only half of it. The default input policy drops unsolicited
  // UDP, so without this rule the listener is enabled and every Disconnect-Request
  // is still discarded before it reaches it. Scoped to the RADIUS server.
  lines.push(`:do { /ip/firewall/filter remove [find comment=${rosQuote(`NETPID:coa:${shortname}`)}] } on-error={}`);
  lines.push(
    `/ip/firewall/filter add chain=input action=accept protocol=udp ` +
      `dst-port=${coaPort}${src ? ` src-address=${server}` : ""} ` +
      `comment=${rosQuote(`NETPID:coa:${shortname}`)}`,
  );
  lines.push("");

  // 8 - radio. Only emitted when the ISP actually gave us an SSID: creating a
  // bridge on a router with a different topology is the operator's call, not
  // something a pasted script should guess at.
  if (o.wifiSsid) {
    const ssid = rosQuote(o.wifiSsid);
    const country = rosQuote(o.country ?? "Kenya");
    lines.push(comment(`8. Wi-Fi AP - ${paths.version === "7"
      ? "v7.14+ moved this menu to /interface/wifi; on older 7.x use the v6 script"
      : "v6 keeps the radio at /interface/wireless"}`));
    // 6.x calls the radios wlan1/wlan2; 7.14+ calls them wifi1/wifi2.
    lines.push(
      `:do { ${paths.wireless} set [find name=${rosQuote(paths.radioName)}] ` +
        `ssid=${ssid} mode=ap-bridge country=${country} disabled=no } on-error={}`,
    );
    lines.push(
      comment("   If the AP did not come up, your router is on the other major " +
        "version - run the matching script from this router's NETPID page."),
    );
    lines.push("");
  }

  lines.push(comment("Verify - these should print without error"));
  lines.push(`/system resource print`);
  lines.push(`${paths.radiusClient} print`);
  lines.push(`/radius/incoming print`);
  lines.push(`/ppp/aaa print`);
  lines.push(`/ip/firewall/filter print where comment~"NETPID"`);
  lines.push("/interface/print");
  lines.push("");
  lines.push(comment("Done. Confirm in NETPID: Dashboard > Network > this router."));
  lines.push(
    comment("If any line above reported an error, stop and re-read it - the rest of "
      + "the script will not have run either."),
  );
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

const WG_TAG = "NETPID-managed";

/** A WireGuard key is 32 bytes base64: 43 characters then a single '='. */
export function isWireguardKey(v) {
  return typeof v === "string" && /^[A-Za-z0-9+/]{43}=$/.test(v);
}

/**
 * WireGuard setup for a MikroTik in the NETPID management tunnel (RouterOS 7+).
 *
 * This is the mjs twin of buildWireguardScript in apps/web/lib/routeros.ts. The
 * two are kept honest by network-worker/test/wireguard-script.test.js, which
 * pins the properties that must never differ — above all that the script is
 * NON-DESTRUCTIVE.
 */
export function buildWireguardScript(o = {}) {
  const c = (s) => `# ${s}`;
  const name = rosName(o.routerName ?? "router", "netpid-router");
  const ifName = "netpid-wg";
  const port = o.listenPort ?? 51820;
  // This script is RouterOS 7 only (see below), so the RADIUS client path is
  // the v7 one. It still goes through rosPaths so the two cannot drift.
  const paths = rosPaths("7");
  const L = [];

  L.push(c("=".repeat(62)));
  L.push(c(`NETPID WireGuard management tunnel — ${name}`));
  L.push(c(""));
  L.push(c("SAFE TO RE-RUN. Only removes objects carrying the"));
  L.push(c(`"${WG_TAG}" comment. Does NOT flush the firewall and does NOT`));
  L.push(c("modify existing PPPoE, HotSpot, NAT, bridge, VLAN or routing config."));
  L.push(c("Requires RouterOS 7.x."));
  L.push(c("=".repeat(62)));
  L.push("");

  if (!isWireguardKey(o.serverPublicKey)) {
    L.push(c("ERROR: serverPublicKey is not a valid WireGuard key (32 bytes, base64)."));
    return L.join("\n");
  }
  if (!isWireguardKey(o.routerPublicKey)) {
    L.push(c("1. Interface — the router's private key stays on the router"));
    L.push(c("   Run this on the router, then paste its public key into NETPID:"));
    L.push("");
    L.push(`  /interface/wireguard/add name=${rosQuote(ifName)} listen-port=${port}`);
    L.push("  /interface/wireguard/print");
    return L.join("\n");
  }

  L.push(c("1. Interface"));
  L.push(c("   The router's private key stays on the router — NETPID only ever"));
  L.push(c("   receives its PUBLIC key."));
  L.push(`:do { /interface/wireguard remove [find name=${rosQuote(ifName)}] } on-error={}`);
  L.push(`/interface/wireguard add name=${rosQuote(ifName)}`);
  L.push(`  listen-port=${port}`);
  L.push("");
  L.push(c("   !! Read /interface/wireguard/print and paste lPrivate-key above !!"));

  L.push("");
  L.push(c("2. Address — the router's end of the point-to-point /30"));
  L.push(`:do { /ip/address remove [find interface=${rosQuote(ifName)}] } on-error={}`);
  L.push(`/ip/address add address=${o.routerTunnelIp}/30 interface=${rosQuote(ifName)} comment=${rosQuote(WG_TAG)}`);

  L.push("");
  L.push(c("3. Peer — the VPS end of the tunnel"));
  L.push(`:do { /interface/wireguard/peers remove [find interface=${rosQuote(ifName)}] } on-error={}`);
  L.push(`/interface/wireguard/peers add interface=${rosQuote(ifName)}`);
  L.push(`  public-key=${o.serverPublicKey}`);
  if (o.vpsEndpoint) {
    L.push("  allowed-address=0.0.0.0/0");
    L.push(`  endpoint-address=${o.vpsEndpoint}:${port}`);
  } else {
    L.push(`  allowed-address=${o.vpsTunnelIp}/32`);
  }
  L.push(`  persistent-keepalive=25s comment=${rosQuote(WG_TAG)}`);

  L.push("");
  L.push(c("4. Firewall — ADD one rule. Nothing is flushed."));
  L.push(`:do { /ip/firewall/filter remove [find comment=${rosQuote(`${WG_TAG}-wg-in`)}] } on-error={}`);
  L.push(`/ip/firewall/filter add chain=input action=accept protocol=udp dst-port=${port} ` +
    `in-interface-list=WAN comment=${rosQuote(`${WG_TAG}-wg-in`)} ` +
    `place-before=[find chain=input action=drop]`);

  if (o.includeRadius !== false) {
    const hotspotProfile = o.hotspotProfile ?? "default";
    L.push("");
    L.push(c("5. RADIUS over the tunnel — this is what removes the need for any"));
    L.push(c("   publicly exposed management port."));
    if (!o.radiusSecret) {
      L.push(c("   No RADIUS secret is stored for this router's NAS yet. Add one on"));
      L.push(c("   the NAS record, then download this script again."));
    } else {
      const secret = rosQuote(o.radiusSecret);
      L.push(c(""));
      L.push(c("   Router as RADIUS CLIENT: auth + accounting to the VPS, over the"));
      L.push(c("   tunnel. The secret is the one already held for this NAS."));
      L.push(`:do { ${paths.radiusClient} remove [find comment=${rosQuote(WG_TAG)}] } on-error={}`);
      L.push(
        `${paths.radiusClient} add service=ppp,hotspot address=${o.vpsTunnelIp} ` +
          `secret=${secret} comment=${rosQuote(WG_TAG)}`,
      );
      L.push("");
      L.push(c("   PPPoE: credentials are verified by the VPS, not on the router,"));
      L.push(c("   so revoking a customer in NETPID takes effect on next login."));
      L.push("/ppp/aaa set use-radius=yes accounting=yes interim-update=5m");
      L.push("");
      L.push(c("   HotSpot: captive-portal logins authorize the same way."));
      L.push(
        `:do { /ip/hotspot/profile set [find name=${rosQuote(hotspotProfile)}] ` +
          `use-radius=yes radius-interim-update=5m } on-error={}`,
      );
      L.push("");
      L.push(c("   Inbound: lets NETPID disconnect a user from the dashboard."));
      L.push(`:do { /radius/incoming remove [find comment~${rosQuote(WG_TAG)}] } on-error={}`);
      L.push(
        `/radius/incoming add address=${o.vpsTunnelIp}/32 port=3799 accept=yes ` +
          `secret=${secret} comment=${rosQuote(WG_TAG)}`,
      );
    }
  }
  return L.join("\n");
}

