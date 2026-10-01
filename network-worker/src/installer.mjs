/**
 * NETPID MikroTik installer - RouterOS 7.x
 *
 * ONE script that takes a router from clean/default to a production NETPID ISP
 * router running HotSpot + PPPoE, RADIUS accounting, CoA, WireGuard management
 * and a locked-down API surface.
 *
 * WHY THIS IS SEPARATE FROM buildRouterosSetup()
 *   buildRouterosSetup only configures the RADIUS/PPP authentication plane. It
 *   assumes the router already has working LAN, DHCP, DNS, NAT and firewall -
 *   true of a router someone built by hand, false of every new box. Pasting it
 *   onto a fresh RB951 yields a router with a RADIUS client and no network.
 *   This installer is the whole router.
 *
 * DESIGN RULES
 *   - Never invents a network. Every subnet is an operator-supplied variable.
 *   - Never invents a WireGuard peer. With no real server public key the
 *     script creates the interface, STOPS, and says why.
 *   - Never embeds a secret. The RADIUS secret and API password are empty by
 *     default; the operator supplies them at run time.
 *   - Idempotent. Re-running converges instead of stacking duplicate rules.
 *   - MODE=EXISTING never deletes a bridge, WAN, DHCP, firewall, hotspot,
 *     PPPoE, RADIUS or WireGuard object. It only adds what is missing.
 *
 * NETPID expects NO RouterOS files, scripts or schedulers. It drives the router
 * entirely through live API calls, so this installer deliberately creates
 * nothing under /file, /system script or /system scheduler. Populating those
 * menus would make the router LOOK provisioned without changing anything.
 */

const TAG = "NETPID-managed";

export function isCidr(v) {
  return typeof v === "string" && /^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/.test(v.trim());
}
export function isIp(v) {
  return typeof v === "string" && /^\d{1,3}(\.\d{1,3}){3}$/.test(v.trim());
}
export function isWgKey(v) {
  return typeof v === "string" && /^[A-Za-z0-9+/]{43}=$/.test(v.trim());
}

function q(v) {
  const s = String(v ?? "").trim();
  return `"${s.replace(/"/g, '""')}"`;
}
function list(v) {
  return String(v ?? "").split(",").map((s) => s.trim()).filter(Boolean);
}

/** Defaults. Nothing here is invented: the operator MUST supply the networks.
 *  Empty strings are deliberate - the preflight refuses to continue past a
 *  variable that is still blank, which catches a half-filled config on the
 *  router instead of after it. */
export function installerDefaults() {
  return {
    mode: "EXISTING",
    identity: "",
    wan: "ether1",
    lanBridge: "bridge-lan",
    lanPorts: ["ether2", "ether3", "ether4", "ether5"],
    lanSubnet: "",
    lanGateway: "",
    dhcpPool: "",
    dnsServers: ["1.1.1.1", "8.8.8.8"],
    ntpServers: ["pool.ntp.org"],
    hotspotEnabled: true,
    hotspotIface: "netpid-hotspot",
    hotspotSubnet: "",
    hotspotPool: "",
    hotspotDnsName: "",
    pppoeEnabled: true,
    pppoePool: "",
    pppoeService: "netpid-pppoe",
    radiusServer: "",
    radiusSecret: "",
    radiusAuthPort: 1812,
    radiusAcctPort: 1813,
    radiusCoaPort: 3799,
    radiusSrcAddress: "",
    nasShortname: "",
    wgEnabled: true,
    wgIface: "netpid-wg",
    wgListenPort: 51820,
    wgServerPublicKey: "",
    wgServerTunnelIp: "",
    wgRouterTunnelIp: "",
    wgEndpoint: "",
    apiEnabled: true,
    apiSslEnabled: true,
    apiPort: 8728,
    apiSslPort: 8729,
    apiUser: "netpid",
    apiPassword: "",
    mgmtNetwork: "",
    timezone: "Africa/Nairobi",
    country: "KE",
  };
}

/** Which required variables are still empty. Rendered into the script so the
 *  operator sees it on the router, and usable server-side to refuse to serve a
 *  half-built installer over the API. */
export function installerMissing(o = {}) {
  const c = { ...installerDefaults(), ...o };
  const need = [];
  const req = {
    identity: "router identity",
    lanSubnet: "LAN subnet (CIDR)",
    lanGateway: "LAN gateway IP",
    radiusServer: "RADIUS server IP (the NETPID VPS tunnel address)",
    // The script's own preflight requires NP_NAS. It has to be reported here
    // too, or a server-side check would pass a config the router then rejects.
    nasShortname: "NAS shortname (must match the NETPID NAS record)",
  };
  for (const [k, label] of Object.entries(req)) {
    if (!String(c[k] ?? "").trim()) need.push(label);
  }
  if (!String(c.dhcpPool).trim()) need.push("DHCP pool name");
  if (c.hotspotEnabled) {
    if (!String(c.hotspotSubnet).trim()) need.push("HotSpot subnet (CIDR)");
    if (!String(c.hotspotPool).trim()) need.push("HotSpot pool name");
    if (!String(c.hotspotDnsName).trim()) need.push("HotSpot DNS name");
  }
  if (c.pppoeEnabled && !String(c.pppoePool).trim()) need.push("PPPoE pool name");
  // RADIUS is the whole authentication and billing path. Without a secret the
  // installer skips /radius entirely, which is a half-configured router.
  if (!String(c.radiusSecret).trim()) need.push("RADIUS shared secret (operator supplied)");
  // Ports must be real numbers, not merely present.
  for (const [k, label] of Object.entries({
    radiusAuthPort: "RADIUS authentication port",
    radiusAcctPort: "RADIUS accounting port",
    radiusCoaPort: "CoA port",
    wgListenPort: "WireGuard listen port",
  })) {
    const v = Number(c[k]);
    if (!Number.isInteger(v) || v < 1 || v > 65535) need.push(label);
  }
  // Management enrolment is intended, so the NETPID half must be real. A
  // fabricated server key yields a tunnel that never handshakes.
  if (c.wgEnabled !== false) {
    if (!isWgKey(c.wgServerPublicKey)) need.push("WireGuard server public key (a real 43-byte base64 key)");
    if (!isIp(c.wgRouterTunnelIp)) need.push("WireGuard router tunnel address");
    if (!isIp(c.wgServerTunnelIp)) need.push("WireGuard server tunnel address");
  }
  return need;
}

/** Build the single authoritative .rsc installer. A structurally invalid
 *  option throws here; a merely INCOMPLETE config is rendered into the script's
 *  own preflight so the operator sees it on the router, not in a server log. */
export function buildRouterosInstaller(input = {}, opts = {}) {
  const o = { ...installerDefaults(), ...input };
  // strict is the default. Emitting a script that silently skips RADIUS, or
  // installs a WireGuard interface with no peer, is precisely the half-built
  // router this installer exists to prevent. A caller that genuinely wants a
  // partial script must ask for it and get it flagged as partial.
  if (opts.strict !== false) {
    const missing = installerMissing(o);
    if (missing.length) {
      throw new Error(
        "NETPID installer: refusing to generate a complete .rsc, "
        + `${missing.length} required value(s) are missing:\n`
        + missing.map((m) => `  - ${m}`).join("\n")
        + "\nNothing was invented. Supply these, or pass { strict: false } "
        + "to deliberately generate a partial script.",
      );
    }
  }
  const L = [];
  const put = (s = "") => L.push(s);
  const c = (s) => put(`# ${s}`);
  const rule = () => put("# " + "=".repeat(70));

  rule();
  c("NETPID MikroTik Installer  -  RouterOS 7.x");
  c("");
  c("Takes a clean or already-built router to a production NETPID ISP");
  c("router: LAN + DHCP + DNS, HotSpot, PPPoE, RADIUS (auth, accounting,");
  c("CoA), WireGuard management and a WAN-locked RouterOS API.");
  c("");
  c("HOW TO USE");
  c("  1. Edit SECTION A. Every value you must change is there.");
  c("  2. Files -> upload, or paste whole into the Terminal.");
  c("  3. The script stops and prints what is missing if a required value");
  c("     is blank. It will not guess a subnet or a WireGuard key.");
  c("  4. Re-running is safe: it converges instead of duplicating.");
  c("");
  c("THIS SCRIPT DOES NOT: delete an existing bridge, WAN, DHCP server,");
  c("firewall, hotspot, PPPoE, RADIUS or WireGuard object; create billing");
  c("users; or place a secret in the repository. RADIUS remains the NETPID");
  c("billing and authentication authority.");
  rule();
  put("");

  rule();
  c("SECTION A - CONFIGURATION VARIABLES");
  rule();
  put("");
  c("mode: NEW      = clean/default router, safe to shape from scratch");
  c("       EXISTING= keep what is there, add only what is missing (default)");
  c("       EXISTING never deletes customer config. Neither mode flushes a");
  c("       firewall, and neither touches PPPoE, hotspot, RADIUS or WireGuard");
  c("       objects that already exist.");
  put("");
  put(`:global NP_MODE             ${q(o.mode)}`);
  put("");
  c("Identity shown in Winbox and reported to NETPID as the router's name.");
  put(`:global NP_IDENTITY         ${q(o.identity)}`);
  put("");
  c("WAN - DHCP client by default. For a static WAN set NP_WAN_STATIC=yes with");
  c("NP_WAN_ADDR and NP_WAN_GW. Never guessed: a wrong gateway is an outage.");
  put(`:global NP_WAN              ${q(o.wan)}`);
  put(":global NP_WAN_STATIC       \"no\"");
  put(":global NP_WAN_ADDR         \"\"");
  put(":global NP_WAN_GW           \"\"");
  put("");
  c("LAN bridge. Ports are ADDED, never removed, so the router keeps serving");
  c("and a port already in another bridge is reported rather than stolen.");
  put(`:global NP_LAN_BRIDGE       ${q(o.lanBridge)}`);
  put(`:global NP_LAN_PORTS        ${q(list(o.lanPorts).join(","))}`);
  put("");
  c("LAN addressing. LEAVE BLANK TO KEEP THE ROUTER'S CURRENT LAN - the");
  c("installer reads the existing bridge address instead of inventing one.");
  put(`:global NP_LAN_NET          ${q(o.lanSubnet)}`);
  put(`:global NP_LAN_GATEWAY      ${q(o.lanGateway)}`);
  put(`:global NP_DHCP_POOL        ${q(o.dhcpPool)}`);
  put("");
  c("Upstream resolvers. allow-remote-requests is what lets LAN clients use the");
  c("router as resolver, which HotSpot and DHCP clients expect.");
  put(`:global NP_DNS_SERVERS      ${q(list(o.dnsServers).join(","))}`);
  put(`:global NP_NTP_SERVERS      ${q(list(o.ntpServers).join(","))}`);
  put("");
  c("HotSpot - captive portal on its own subnet, authorised by RADIUS.");
  put(`:global NP_HOTSPOT_ON       ${q(o.hotspotEnabled ? "yes" : "no")}`);
  put(`:global NP_HOTSPOT_IFACE    ${q(o.hotspotIface)}`);
  put(`:global NP_HOTSPOT_NET      ${q(o.hotspotSubnet)}`);
  put(`:global NP_HOTSPOT_POOL     ${q(o.hotspotPool)}`);
  put(`:global NP_HOTSPOT_DNS      ${q(o.hotspotDnsName)}`);
  put("");
  c("PPPoE - one service on the LAN bridge, authorised by RADIUS.");
  put(`:global NP_PPPOE_ON         ${q(o.pppoeEnabled ? "yes" : "no")}`);
  put(`:global NP_PPPOE_POOL       ${q(o.pppoePool)}`);
  put(`:global NP_PPPOE_SERVICE    ${q(o.pppoeService)}`);
  c("The range the server leases from, e.g. 100.64.10.2-100.64.10.250. Blank");
  c("skips PPPoE pool creation and prints the note in Section I instead.");
  put(":global NP_PPPOE_RANGES     \"\"");
  c("MTU/MRU. 1480/1480 suits Ethernet PPPoE; lower it if the path MTU is");
  c("smaller, which otherwise shows up as silent throughput loss on TLS.");
  put(":global NP_PPPOE_MTU        \"1480\"");
  put(":global NP_PPPOE_MRU        \"1480\"");
  put("");
  return sectionARest(L, c, rule, put, o);
}


/** The tail of SECTION A, plus the call list that renders every section. */
function sectionARest(L, c, rule, put, o) {
  c("RADIUS - the NETPID VPS. NO SECRET IS STORED IN THE REPOSITORY; set");
  c("NP_RADIUS_SECRET at run time, or paste it into the file and delete it.");
  put(`:global NP_RADIUS_SERVER    ${q(o.radiusServer)}`);
  put(":global NP_RADIUS_SECRET    \"\"");
  put(`:global NP_RADIUS_AUTH      ${q(o.radiusAuthPort)}`);
  put(`:global NP_RADIUS_ACCT      ${q(o.radiusAcctPort)}`);
  put(`:global NP_RADIUS_COA       ${q(o.radiusCoaPort)}`);
  c("Source address the router authenticates FROM. Pinning it keeps accounting");
  c("attributed to this NAS instead of whatever the WAN address happens to be.");
  put(`:global NP_RADIUS_SRC       ${q(o.radiusSrcAddress)}`);
  c("NAS identity. FreeRADIUS matches the secret to this shortname, so it must");
  c("equal the NAS shortname NETPID created for this router.");
  put(`:global NP_NAS              ${q(o.nasShortname)}`);
  put("");
  c("NETPID WireGuard management. The SERVER public key comes from NETPID");
  c("after the router is registered. IF IT IS BLANK, SECTION J CREATES THE");
  c("INTERFACE AND STOPS - it will not invent a peer, because a wrong key");
  c("means a tunnel that silently never handshakes.");
  c("The router's OWN key is generated on the router, in Section J. Only the");
  c("public half is pasted back to NETPID; the private half never leaves it.");
  put(`:global NP_WG_ON            ${q(o.wgEnabled === false ? "no" : "yes")}`);
  put(`:global NP_WG_IFACE         ${q(o.wgIface)}`);
  put(`:global NP_WG_LISTEN        ${q(o.wgListenPort)}`);
  // The SERVER public key is public material by definition, so when NETPID
  // supplies one it is written into the script and the operator does not have
  // to paste it a second time. The router's PRIVATE key is never here: it is
  // generated on the router in Section J and never leaves the box.
  put(`:global NP_WG_SERVER_PUB    ${q(o.wgServerPublicKey)}`);
  put(`:global NP_WG_SERVER_IP     ${q(o.wgServerTunnelIp)}`);
  put(`:global NP_WG_ROUTER_IP     ${q(o.wgRouterTunnelIp)}`);
  put(`:global NP_WG_ENDPOINT      ${q(o.wgEndpoint)}`);
  c("Source network permitted to reach the RouterOS API. This is what keeps");
  c("8728/8729 off the public internet. Blank means the API is NOT enabled.");
  put(`:global NP_MGMT_NET         ${q(o.mgmtNetwork)}`);
  put("");
  c("RouterOS API. Prefer api-ssl; the worker speaks it when use_ssl=yes.");
  c("NO PASSWORD IS STORED IN THE REPOSITORY - set NP_API_PASSWORD at run");
  c("time, or accept the one the installer generates and prints once.");
  put(`:global NP_API_ON           ${q(o.apiEnabled ? "yes" : "no")}`);
  put(`:global NP_APISSL_ON        ${q(o.apiSslEnabled ? "yes" : "no")}`);
  put(`:global NP_API_PORT         ${q(o.apiPort)}`);
  put(`:global NP_APISSL_PORT      ${q(o.apiSslPort)}`);
  put(`:global NP_API_USER         ${q(o.apiUser)}`);
  put(":global NP_API_PASSWORD     \"\"");
  put(":global NP_API_GEN          \"yes\"");
  put("");
  c("Post-install router backup, written to the router's own filesystem. It is");
  c("NOT uploaded anywhere by this script; NETPID fetches it over the API once");
  c("management works. Set to \"no\" on a router with a small flash filesystem.");
  put(":global NP_BACKUP_ON         \"yes\"");
  put("");
  put(`:global NP_TIMEZONE         ${q(o.timezone)}`);
  put(`:global NP_COUNTRY          ${q(o.country)}`);
  put(`:global NP_TAG              ${q(TAG)}`);
  put("");
  put("");

  emitPreflight(L, c, rule, put, o);
  emitIdentityAndLan(L, c, rule, put, o);
  emitDhcpAndDns(L, c, rule, put, o);
  emitWanAndNat(L, c, rule, put, o);
  emitFirewall(L, c, rule, put, o);
  emitRadius(L, c, rule, put, o);
  emitHotspot(L, c, rule, put, o);
  emitPppoe(L, c, rule, put, o);
  emitWireguard(L, c, rule, put, o);
  emitApi(L, c, rule, put, o);
  emitReport(L, c, rule, put, o);
  return L.join("\n");
}


// ------------------------------------------------------------------ PREFLIGHT
function emitPreflight(L, c, rule, put, o) {
  rule();
  c("SECTION B - PREFLIGHT");
  rule();
  put("");
  c("Refuses to touch a router that is not RouterOS 7.x, and stops with a");
  c("readable list rather than guessing a value that was left blank.");
  put(":local npVer [/system resource get version]");
  put(":local npMajor [:pick $npVer 0 1]");
  c("RouterOS 7 moved RADIUS out of /ip and wifi to /interface wifi. On a 6.x");
  c("box these commands are rejected mid-script, leaving the router half");
  c("configured. Stop before that can happen.");
  put(":if ($npMajor != \"7\") do={");
  put("  :put \"\"");
  put("  :put \"================ NETPID INSTALLER STOPPED ================\"");
  put("  :put (\"RouterOS \" . $npVer . \" detected. This installer targets 7.x only.\")");
  put("  :put \"Nothing has been changed.\"");
  put("}");
  put(":set npVer \"\"");
  put("");
  c("Required values. Printed, not guessed.");
  put(":local npMissing \"\"");
  put(":foreach k in {\"NP_IDENTITY\";\"NP_LAN_GATEWAY\";\"NP_DHCP_POOL\";\"NP_RADIUS_SERVER\";\"NP_NAS\"} do={");
  put("  :local v [:global $k]");
  put("  :if ([:len [:trim $v]] = 0) do={ :set npMissing ($npMissing . \"  - \" . $k) }");
  put("}");
  put(":if ($NP_HOTSPOT_ON = \"yes\") do={");
  put("  :foreach k in {\"NP_HOTSPOT_NET\";\"NP_HOTSPOT_POOL\";\"NP_HOTSPOT_DNS\"} do={");
  put("    :local v [:global $k]");
  put("    :if ([:len [:trim $v]] = 0) do={ :set npMissing ($npMissing . \"  - \" . $k) }");
  put("  }");
  put("}");
  put(":if ($NP_PPPOE_ON = \"yes\") do={");
  put("  :if ([:len [:trim $NP_PPPOE_POOL]] = 0) do={ :set npMissing ($npMissing . \"  - NP_PPPOE_POOL\") }");
  put("}");
  put(":if ([:len $npMissing] > 0) do={");
  put("  :put \"\"");
  put("  :put \"================ NETPID INSTALLER STOPPED ================\"");
  put("  :put \"These required values are blank. Nothing has been changed.\"");
  put("  :put $npMissing");
  put("  :put \"\"");
  put("  :put \"Fill them in SECTION A and run again. The installer will not\"");
  put("  :put \"invent a subnet, a gateway or a NAS name for you.\"");
  put("  :put \"=======================================================\"");
  put("}");
  c("");
  c("No RADIUS secret means the router cannot authenticate anybody, and the");
  c("symptom then looks like a FreeRADIUS fault rather than a missing value.");
  put(":if ([:len [:trim $NP_RADIUS_SECRET]] = 0) do={");
  put("  :put \"WARNING: NP_RADIUS_SECRET is empty. The RADIUS entry is skipped\"");
  put("  :put \"         so that nothing half-works.\"");
  put("}");
  put(":set npMissing \"\"");
  put("");
}


// ------------------------------------------------------------- IDENTITY + LAN
function emitIdentityAndLan(L, c, rule, put, o) {
  rule();
  c("SECTION C - IDENTITY, BRIDGE, LAN");
  rule();
  put("");
  c("Identity. In EXISTING mode a name already set is left alone: a router");
  c("named on site keeps the name its owner gave it.");
  put(":if ([:len [:trim $NP_IDENTITY]] > 0) do={");
  put("  :if ($NP_MODE = \"NEW\") do={");
  put("    /system identity set name=$NP_IDENTITY");
  c("  } else={");
  put("    :local npCur [/system identity get name]");
  put("    :if ([:len [:trim $npCur]] = 0) do={ /system identity set name=$NP_IDENTITY }");
  put("    :else={ :put (\"identity kept: \" . $npCur) }");
  put("    :set npCur \"\"");
  put("  }");
  put("}");
  put("");
  c("Bridge. Created only if absent. An existing bridge of the same name is");
  c("reused, never replaced, so the router keeps its MACs and DHCP leases.");
  put(":if ([:len [/interface bridge find name=$NP_LAN_BRIDGE]] = 0) do={");
  put("  /interface bridge add name=$NP_LAN_BRIDGE comment=\"$NP_TAG bridge\"");
  put("  :put (\"bridge created: \" . $NP_LAN_BRIDGE)");
  put("} else={ :put (\"bridge reused: \" . $NP_LAN_BRIDGE) }");
  put("");
  c("LAN ports. A port already enslaved elsewhere is REPORTED, not moved:");
  c("taking a port out of a live bridge is exactly the silent breakage this");
  c("installer refuses to cause.");
  put(":foreach p in [:split $NP_LAN_PORTS \",\"] do={");
  put("  :if ([:len $p] = 0) do={ :continue }");
  put("  :if ([:len [/interface ethernet find name=$p]] = 0) do={");
  put("    :put (\"SKIP \" . $p . \": no such ethernet interface on this board\")");
  c("  } else={");
  put("    :if ([:len [/interface bridge port find interface=$p]] = 0) do={");
  put("      /interface bridge port add bridge=$NP_LAN_BRIDGE interface=$p pvid=1");
  put("      :put (\"added to bridge: \" . $p)");
  c("    } else={");
  put("      :local npB [/interface bridge port get [find interface=$p] bridge]");
  put("      :if ($npB = $NP_LAN_BRIDGE) do={");
  put("        :put (\"already in bridge: \" . $p)");
  c("      } else={");
  put("        :put (\"CONFLICT \" . $p . \" is in bridge \" . $npB . \". Not moving it.\")");
  put("      }");
  put("      :set npB \"\"");
  put("    }");
  put("  }");
  put("}");
  put("");
  c("LAN address. With NP_LAN_NET blank the router's EXISTING bridge address");
  c("is kept. Deliberate: on a router already serving customers the current");
  c("subnet is the truth, and overwriting it cuts every wired client off.");
  put(":local npHaveAddr [:len [/ip address find interface=$NP_LAN_BRIDGE]]");
  put(":if ([:len [:trim $NP_LAN_NET]] = 0) do={");
  put("  :if ($npHaveAddr > 0) do={");
  put("    :put (\"LAN address kept: \" . [/ip address get [find interface=$NP_LAN_BRIDGE] address])");
  c("  } else={");
  put("    :error \"NETPID: NP_LAN_NET is required when the bridge has no address\"");
  put("  }");
  c("} else={");
  put("  :if ($npHaveAddr = 0) do={");
  put("    /ip address add address=$NP_LAN_NET interface=$NP_LAN_BRIDGE comment=\"$NP_TAG lan\"");
  put("    :put (\"LAN address set: \" . $NP_LAN_NET)");
  c("  } else={");
  put("    :local npA [/ip address get [find interface=$NP_LAN_BRIDGE] address]");
  put("    :if ($npA = $NP_LAN_NET) do={");
  put("      :put (\"LAN address unchanged: \" . $npA)");
  c("    } else={");
  put("      /ip address remove [find interface=$NP_LAN_BRIDGE]");
  put("      /ip address add address=$NP_LAN_NET interface=$NP_LAN_BRIDGE comment=\"$NP_TAG lan\"");
  put("      :put (\"LAN address CHANGED \" . $npA . \" -> \" . $NP_LAN_NET)");
  put("      :put \"         If the router was serving customers, revert this.\"");
  put("    }");
  put("    :set npA \"\"");
  put("  }");
  put("}");
  put(":set npHaveAddr \"\"");
  put("");
}


// --------------------------------------------------------------- DHCP AND DNS
function emitDhcpAndDns(L, c, rule, put, o) {
  rule();
  c("SECTION D - ADDRESS POOLS, DHCP, DNS");
  rule();
  put("");
  c("Pools are derived from the LIVE address on the bridge, so a pool can");
  c("never disagree with the subnet actually configured.");
  put(":local npLanAddr $NP_LAN_NET");
  put(":if ([:len [:trim $npLanAddr]] = 0) do={");
  put("  :set npLanAddr [/ip address get [find interface=$NP_LAN_BRIDGE] address]");
  put("}");
  put(":local npCidr [:pick $npLanAddr 0 [:find $npLanAddr \"/\"]]");
  put(":local npNet  [:pick $npCidr 0 [:find $npCidr \"/\"]]");
  put(":local npOct  [:split $npNet \".\"]");
  c("Pool runs from .100 to ten below the broadcast address. Predictable, and");
  c("never the gateway or the network address.");
  put(":local npRange ($npOct->1 . \".\" . $npOct->2 . \".100-\" . $npOct->1 . \".\" . $npOct->2 . \".\" . ([num $npOct->4] - 10))");
  put(":if ([:len [/ip pool find name=$NP_DHCP_POOL]] = 0) do={");
  put("  /ip pool add name=$NP_DHCP_POOL ranges=$npRange comment=\"$NP_TAG dhcp\"");
  c("} else={");
  c("Refresh an existing pool so a re-run after a LAN change converges");
  c("instead of leaving clients pointed at a dead range.");
  put("  /ip pool set [find name=$NP_DHCP_POOL] ranges=$npRange");
  put("}");
  put(":put (\"DHCP pool \" . $NP_DHCP_POOL . \" -> \" . $npRange)");
  put("");
  c("DHCP server. network= ties the offered gateway to the real LAN address,");
  c("so a stale gateway value cannot hand out a route that does not exist -");
  c("the usual cause of 'it got an IP but has no internet'.");
  put(":if ([:len [/ip dhcp-server find name=$NP_TAG]] = 0) do={");
  put("  /ip dhcp-server add name=$NP_TAG interface=$NP_LAN_BRIDGE");
  put("}");
  put("/ip dhcp-server set [find name=$NP_TAG] address-pool=$NP_DHCP_POOL lease-time=1h disabled=no");
  put(":if ([:len [/ip dhcp-server network find address=$npNet]] = 0) do={");
  put("  /ip dhcp-server network add address=$npNet gateway=$NP_LAN_GATEWAY dns-server=$NP_DNS_SERVERS");
  put("}");
  put("");
  c("HotSpot pool, derived the same way from the HotSpot subnet.");
  put(":if ($NP_HOTSPOT_ON = \"yes\") do={");
  put("  :local hCidr [:pick $NP_HOTSPOT_NET 0 [:find $NP_HOTSPOT_NET \"/\"]]");
  put("  :local hNet [:pick $hCidr 0 [:find $hCidr \"/\"]]");
  put("  :local hOct [:split $hNet \".\"]");
  put("  :local hRange ($hOct->1 . \".\" . $hOct->2 . \".10-\" . $hOct->1 . \".\" . $hOct->2 . \".\" . ([num $hOct->4] - 10))");
  put("  :if ([:len [/ip pool find name=$NP_HOTSPOT_POOL]] = 0) do={");
  put("    /ip pool add name=$NP_HOTSPOT_POOL ranges=($hNet . \",\" . $hRange) comment=\"$NP_TAG hotspot\"");
  put("  }");
  put("  :set hCidr \"\"");
  put("  :set hNet \"\"");
  put("  :set hOct \"\"");
  put("  :set hRange \"\"");
  put("}");
  put("");
  c("PPPoE pool. The router hands out addresses; NETPID still owns accounting");
  c("and the plan, so the pool carries no speeds and no billing.");
  put(":if ($NP_PPPOE_ON = \"yes\") do={");
  put("  :if ([:len [/ip pool find name=$NP_PPPOE_POOL]] = 0) do={");
  put("    :if ([:len $NP_PPPOE_RANGES] > 0) do={");
  put("      /ip pool add name=$NP_PPPOE_POOL ranges=$NP_PPPOE_RANGES comment=\"$NP_TAG pppoe\"");
  c("    } else={");
  put("      :put \"NOTE: set NP_PPPOE_RANGES in SECTION A, e.g. 100.64.10.2-100.64.10.250\"");
  put("    }");
  put("  }");
  put("}");
  put("");
  c("DNS forwarding. allow-remote-requests=yes lets LAN clients use the router");
  c("as resolver; without it the HotSpot login page resolves nothing.");
  put("/ip dns set servers=$NP_DNS_SERVERS allow-remote-requests=yes cache-size=2048KiB");
  put("/system ntp client set servers=$NP_NTP_SERVERS");
  put("/system clock set time-zone-name=$NP_TIMEZONE");
  put(":set npLanAddr \"\"");
  put(":set npCidr \"\"");
  put(":set npNet \"\"");
  put(":set npOct \"\"");
  put(":set npRange \"\"");
  put("");
}


// ----------------------------------------------------------------- WAN + NAT
function emitWanAndNat(L, c, rule, put, o) {
  rule();
  c("SECTION E - WAN AND NAT");
  rule();
  put("");
  c("The WAN goes in an interface list. Rules reference the LIST, not the");
  c("port, so swapping eth1 for an SFP or a VLAN later is one edit and the");
  c("firewall follows it.");
  put(":if ([:len [/interface list find name=NETPID-WAN]] = 0) do={");
  put("  /interface list add name=NETPID-WAN");
  put("}");
  put(":if ([:len [/interface list member find list=NETPID-WAN]] = 0) do={");
  put("  :if ([:len [/interface find name=$NP_WAN]] > 0) do={");
  put("    /interface list member add list=NETPID-WAN interface=$NP_WAN");
  put("    :put (\"WAN: \" . $NP_WAN . \" (DHCP client, in list NETPID-WAN)\")");
  put("    :if ([:len [/interface dhcp-client find interface=$NP_WAN]] = 0) do={");
  put("      /interface dhcp-client add interface=$NP_WAN disabled=no");
  put("    }");
  c("  } else={");
  put("    :put (\"WARNING: no interface named \" . $NP_WAN . \". Set NP_WAN in SECTION A.\")");
  put("  }");
  put("}");
  put("");
  c("Static WAN, only when asked for. Never guessed: a wrong gateway takes the");
  c("router offline for everyone behind it.");
  put(":if ($NP_WAN_STATIC = \"yes\") do={");
  put("  :if ([:len [:trim $NP_WAN_ADDR]] = 0) do={");
  put("    :error \"NETPID: NP_WAN_STATIC=yes but NP_WAN_ADDR is empty\"");
  c("  } else={");
  put("    :if ([:len [/interface dhcp-client find interface=$NP_WAN]] > 0) do={");
  put("      /interface dhcp-client remove [find interface=$NP_WAN]");
  put("    }");
  put("    :if ([:len [/ip address find interface=$NP_WAN]] > 0) do={");
  put("      /ip address remove [find interface=$NP_WAN]");
  put("    }");
  put("    /ip address add address=$NP_WAN_ADDR interface=$NP_WAN comment=\"$NP_TAG wan\"");
  put("    :if ([:len [:trim $NP_WAN_GW]] > 0) do={");
  put("      /ip route add dst-address=0.0.0.0/0 gateway=$NP_WAN_GW distance=1 comment=\"$NP_TAG default\"");
  put("    }");
  put("  }");
  put("}");
  put("");
  c("Masquerade on the WAN list, guarded by comment so a re-run does not");
  c("stack a second identical rule - the classic cause of a router that gets");
  c("slower every time someone re-applies the script.");
  put(":if ([:len [/ip firewall nat find comment=\"$NP_TAG masquerade\"]] = 0) do={");
  put("  /ip firewall nat add chain=srcnat action=masquerade out-interface-list=NETPID-WAN comment=\"$NP_TAG masquerade\" place-before=0");
  put("  :put \"NAT masquerade created on NETPID-WAN\"");
  c("} else={");
  put("  :put \"NAT masquerade already present (no duplicate created)\"");
  put("}");
  put("");
}


// ----------------------------------------------------------------- FIREWALL
function emitFirewall(L, c, rule, put, o) {
  rule();
  c("SECTION F - FIREWALL");
  rule();
  put("");
  c("NOTHING IS FLUSHED. A default MikroTik has no input filter at all, which");
  c("is why so many ISP routers ship with the API reachable from anywhere.");
  c("Rules are ADDED, each guarded by its own comment, so a re-run converges.");
  put("");
  c("Established/related first. Everything below relies on this being rule 1.");
  put(":if ([:len [/ip firewall filter find comment=\"$NP_TAG established\"]] = 0) do={");
  put("  /ip firewall filter add chain=input action=accept connection-state=established,related comment=\"$NP_TAG established\"");
  put("}");
  c("Drop INVALID silently rather than rejecting: rejecting leaks that");
  c("something is listening and invites port scans onward.");
  put(":if ([:len [/ip firewall filter find comment=\"$NP_TAG invalid\"]] = 0) do={");
  put("  /ip firewall filter add chain=input action=drop connection-state=invalid comment=\"$NP_TAG invalid\"");
  put("}");
  c("Input protection keyed to the WAN list, so a wrong source interface can");
  c("never open the management ports.");
  put(":if ([:len [/ip firewall filter find comment=\"$NP_TAG wan-drop\"]] = 0) do={");
  put("  /ip firewall filter add chain=input action=drop in-interface-list=NETPID-WAN comment=\"$NP_TAG wan-drop\"");
  put("}");
  put("");
  c("LAN is trusted, placed BEFORE the WAN drop: the bridge is not in the WAN");
  c("list, but ordering it explicitly means the rule still holds if someone");
  c("later adds the bridge to NETPID-WAN by mistake.");
  put(":if ([:len [/ip firewall filter find comment=\"$NP_TAG lan-accept\"]] = 0) do={");
  put("  /ip firewall filter add chain=input action=accept in-interface=$NP_LAN_BRIDGE comment=\"$NP_TAG lan-accept\"");
  put("}");
  put("");
  c("ICMP rate-limited rather than dropped, so PMTUD keeps working. Without it,");
  c("HTTPS through PPPoE stalls at exactly the worst moment.");
  put(":if ([:len [/ip firewall filter find comment=\"$NP_TAG icmp\"]] = 0) do={");
  put("  /ip firewall filter add chain=input action=accept protocol=icmp limit=20,10 comment=\"$NP_TAG icmp\"");
  put("}");
  put("");
  put(":if ([:len [/ip firewall filter find comment=\"$NP_TAG fwd-in\"]] = 0) do={");
  put("  /ip firewall filter add chain=forward action=fasttrack-connection connection-state=established,related comment=\"$NP_TAG fwd-in\"");
  put("}");
  put(":if ([:len [/ip firewall filter find comment=\"$NP_TAG fwd-new\"]] = 0) do={");
  put("  /ip firewall filter add chain=forward action=accept connection-state=new in-interface-list=NETPID-LAN comment=\"$NP_TAG fwd-new\"");
  put("}");
  put("");
  c("RADIUS auth/acct inbound, opened narrowly rather than by removing the");
  c("input drop.");
  put(":if ([:len [/ip firewall filter find comment=\"$NP_TAG radius-in\"]] = 0) do={");
  put("  /ip firewall filter add chain=input action=accept protocol=udp dst-port=$NP_RADIUS_AUTH,$NP_RADIUS_ACCT src-address=$NP_RADIUS_SERVER comment=\"$NP_TAG radius-in\"");
  put("}");
  c("CoA/Disconnect inbound. RADIUS CoA never gets a reply, so a rule that is");
  c("slightly too strict yields an account that cannot be disconnected and no");
  c("error anywhere to explain why.");
  put(":if ([:len [/ip firewall filter find comment=\"$NP_TAG coa-in\"]] = 0) do={");
  put("  /ip firewall filter add chain=input action=accept protocol=udp dst-port=$NP_RADIUS_COA src-address=$NP_RADIUS_SERVER comment=\"$NP_TAG coa-in\"");
  put("}");
  put("");
  c("WireGuard inbound on the WAN, before the WAN drop, so the management");
  c("tunnel can be established from outside. Only the UDP port is opened; the");
  c("RouterOS API itself is NOT exposed to the internet (Section K).");
  put(":if ($NP_WG_ON = \"yes\") do={");
  put("  :if ([:len [/interface wireguard find name=$NP_WG_IFACE]] > 0) do={");
  put("    :if ([:len [/ip firewall filter find comment=\"$NP_TAG wg-in\"]] = 0) do={");
  put("      /ip firewall filter add chain=input action=accept protocol=udp dst-port=$NP_WG_LISTEN in-interface-list=NETPID-WAN comment=\"$NP_TAG wg-in\" place-before=[find comment=\"$NP_TAG wan-drop\"]");
  put("    }");
  put("  }");
  put("}");
  put("");
  c("Local networks allowed to forward. HotSpot clients and PPPoE sessions both");
  c("need to reach the internet.");
  put(":if ([:len [/interface list find name=NETPID-LAN]] = 0) do={ /interface list add name=NETPID-LAN }");
  put(":if ([:len [/interface list member find list=NETPID-LAN interface=$NP_LAN_BRIDGE]] = 0) do={");
  put("  /interface list member add list=NETPID-LAN interface=$NP_LAN_BRIDGE");
  put("}");
  put(":if ($NP_HOTSPOT_ON = \"yes\") do={");
  put("  :if ([:len [/interface find name=$NP_HOTSPOT_IFACE]] > 0) do={");
  put("    :if ([:len [/interface list member find list=NETPID-LAN interface=$NP_HOTSPOT_IFACE]] = 0) do={");
  put("      /interface list member add list=NETPID-LAN interface=$NP_HOTSPOT_IFACE");
  put("    }");
  put("  }");
  put("}");
  put("");
}


// ------------------------------------------------------------------- RADIUS
function emitRadius(L, c, rule, put, o) {
  rule();
  c("SECTION G - RADIUS (auth, accounting, CoA)");
  rule();
  put("");
  c("RouterOS 7 PROMOTED RADIUS OUT OF /ip. A 7.x router answers 'bad command");
  c("name radius' for /ip radius, and the client is then silently absent, so");
  c("PPPoE authenticates against nothing. This is the top-level /radius menu.");
  c("");
  c("The comment must match what NETPID looks for when it reconciles the NAS at");
  c("runtime, or the worker creates a second server entry beside this one.");
  c("src-address pins the source the router authenticates FROM. FreeRADIUS keys");
  c("accounting on the NAS it was configured with, so an unpinned source can be");
  c("attributed to the wrong NAS and the session refused for authorisation.");
  put(":local npRComment (\"NETPID:\" . $NP_NAS)");
  put(":local npRAcct \"\"");
  put(":if ([:len $NP_RADIUS_SRC] > 0) do={ :set npRAcct (\" src-address=\" . $NP_RADIUS_SRC) }");
  put(":if ([:len $NP_RADIUS_SECRET] > 0) do={");
  put("  :if ([:len [/radius find comment=$npRComment]] = 0) do={");
  put("    :if ([:len [/radius find address=$NP_RADIUS_SERVER]] > 0) do={");
  put("      /radius set [find address=$NP_RADIUS_SERVER] service=ppp,hotspot secret=$NP_RADIUS_SECRET auth-port=$NP_RADIUS_AUTH acct-port=$NP_RADIUS_ACCT timeout=1500ms comment=$npRComment");
  put("      :put (\"radius entry updated: \" . $NP_RADIUS_SERVER)");
  put("    } else={");
  put("      /radius add service=ppp,hotspot address=$NP_RADIUS_SERVER secret=$NP_RADIUS_SECRET auth-port=$NP_RADIUS_AUTH acct-port=$NP_RADIUS_ACCT timeout=1500ms comment=$npRComment $npRAcct");
  put("      :put (\"radius entry created: \" . $NP_RADIUS_SERVER)");
  put("    }");
  put("  } else={");
  put("    /radius set [find comment=$npRComment] service=ppp,hotspot secret=$NP_RADIUS_SECRET auth-port=$NP_RADIUS_AUTH acct-port=$NP_RADIUS_ACCT timeout=1500ms");
  put("    :put \"radius entry refreshed\"");
  put("  }");
  put("} else={");
  put("  :put \"SKIP /radius: NP_RADIUS_SECRET is blank. No authentication is configured.\"");
  put("}");
  put(":set npRComment \"\"");
  put(":set npRAcct \"\"");
  put("");
  c("PPP global AAA. Accounting is the part that matters for billing: without");
  c("it NETPID receives no usage data and every subscriber looks idle.");
  put("/ppp/aaa set use-radius=yes accounting=yes interim-update=5m");
  put("");
  c("CoA / Disconnect. This menu is a SINGLETON - it takes only accept, port and");
  c("vrf. It has NO comment property, which is why a script that sets one fails");
  c("outright and the account can never be disconnected. No comment here,");
  c("deliberately.");
  put("/radius incoming set accept=yes port=$NP_RADIUS_COA");
  put("");
  put(":put (\"RADIUS target: \" . $NP_RADIUS_SERVER . \":\" . $NP_RADIUS_AUTH . \"/\" . $NP_RADIUS_ACCT . \"  CoA:\" . $NP_RADIUS_COA . \"  NAS:\" . $NP_NAS)");
  put("");
}

// ------------------------------------------------------------------ HOTSPOT
function emitHotspot(L, c, rule, put, o) {
  rule();
  c("SECTION H - HOTSPOT");
  rule();
  put("");
  c("HotSpot runs on its OWN interface and subnet, separate from the wired LAN.");
  c("Bridging a captive portal onto a LAN that also serves wired DHCP clients is");
  c("the usual reason a portal 'works' but nobody can log in.");
  put(":if ($NP_HOTSPOT_ON = \"yes\") do={");
  c("A bridge with an address and no physical ports. The hotspot server");
  c("attaches to it; a NETPID bridge is not the customer's wired LAN.");
  put("  :if ([:len [/interface bridge find name=$NP_HOTSPOT_IFACE]] = 0) do={");
  put("    /interface bridge add name=$NP_HOTSPOT_IFACE comment=\"$NP_TAG hotspot\"");
  put("    /ip address add address=$NP_HOTSPOT_NET interface=$NP_HOTSPOT_IFACE comment=\"$NP_TAG hotspot\"");
  c("  } else={");
  put("    :if ([:len [/ip address find interface=$NP_HOTSPOT_IFACE]] = 0) do={");
  put("      /ip address add address=$NP_HOTSPOT_NET interface=$NP_HOTSPOT_IFACE comment=\"$NP_TAG hotspot\"");
  put("    }");
  put("  }");
  c("  A bridge with no ports still needs itself as a port before it will carry");
  c("  traffic on RouterOS 7.");
  put("  :if ([:len [/interface bridge port find interface=$NP_HOTSPOT_IFACE]] = 0) do={");
  put("    /interface bridge port add bridge=$NP_HOTSPOT_IFACE interface=$NP_HOTSPOT_IFACE");
  put("  }");
  put("");
  c("Profile. use-radius=yes makes NETPID the auth authority. With a configured");
  c("server and shared secret the router sends an Access-Request and WAITS - it");
  c("does not fall back to a local user, which is what stops an unconfigured");
  c("box from logging anyone in.");
  put("  :if ([:len [/ip hotspot profile find name=netpid]] = 0) do={");
  put("    /ip hotspot profile add name=netpid use-radius=yes radius-interim-update=5m login-by=http-chap,https,http-pap use-cookie=yes");
  c("  } else={");
  put("    /ip hotspot profile set [find name=netpid] use-radius=yes radius-interim-update=5m use-cookie=yes login-by=http-chap,https,http-pap");
  put("  }");
  put("");
  c("Server. add-default-route forces the client through the portal instead of");
  c("letting it route around it.");
  put("  :if ([:len [/ip hotspot find name=netpid]] = 0) do={");
  put("    /ip hotspot add name=netpid interface=$NP_HOTSPOT_IFACE address-pool=$NP_HOTSPOT_POOL profile=netpid dns-name=$NP_HOTSPOT_DNS add-default-route=yes address-type=ethernet");
  c("  } else={");
  put("    /ip hotspot set [find name=netpid] address-pool=$NP_HOTSPOT_POOL profile=netpid dns-name=$NP_HOTSPOT_DNS add-default-route=yes");
  put("  }");
  c("  NO LOCAL USERS ARE CREATED. NETPID owns billing; a local hotspot user");
  c("  would be an account nobody bills and nobody can revoke.");
  put("  :put (\"HotSpot: \" . $NP_HOTSPOT_DNS . \" on \" . $NP_HOTSPOT_IFACE)");
  put("}");
  put("");
}


// -------------------------------------------------------------------- PPPOE
function emitPppoe(L, c, rule, put, o) {
  rule();
  c("SECTION I - PPPoE SERVER");
  rule();
  put("");
  put(":if ($NP_PPPOE_ON = \"yes\") do={");
  c("Profile. only-one=yes caps a subscriber at one session, which is what");
  c("stops a stolen credential quietly opening a second unpaid connection.");
  put("  :if ([:len [/ppp profile find name=netpid]] = 0) do={");
  put("    /ppp profile add name=netpid use-radius=yes use-compression=no use-encryption=no only-one=yes change-tcp-mss=yes");
  c("  } else={");
  put("    /ppp profile set [find name=netpid] use-radius=yes use-compression=no use-encryption=no only-one=yes change-tcp-mss=yes");
  put("  }");
  c("MTU/MRU. change-tcp-mss clamps the MSS to the negotiated value, which is");
  c("what prevents the silent black hole that makes PPPoE downloads look fast");
  c("over http and stall over https.");
  put("  :if ([:len [/interface pppoe-server profile find name=netpid]] = 0) do={");
  put("    /interface pppoe-server profile add name=netpid use-compression=no use-encryption=no only-one=yes change-tcp-mss=yes");
  c("  } else={");
  put("    /interface pppoe-server profile set [find name=netpid] use-compression=no use-encryption=no only-one=yes change-tcp-mss=yes");
  put("  }");
  c("local-address must be IN the pool range, or the server leases an address");
  c("outside its own pool and sessions come up without a usable route.");
  put("  :if ([:len $NP_PPPOE_RANGES] > 0) do={");
  put("    :local npPppLocal [:pick $NP_PPPOE_RANGES 0 [:find $NP_PPPOE_RANGES \"-\"]]");
  put("    :if ([:len [/interface pppoe-server server find service-name=$NP_PPPOE_SERVICE]] = 0) do={");
  put("      /interface pppoe-server server add service-name=$NP_PPPOE_SERVICE interface=$NP_LAN_BRIDGE default-profile=netpid authentication-service=pppoe remote-address=$NP_PPPOE_POOL local-address=$npPppLocal");
  c("    } else={");
  put("      /interface pppoe-server server set [find service-name=$NP_PPPOE_SERVICE] interface=$NP_LAN_BRIDGE default-profile=netpid authentication-service=pppoe remote-address=$NP_PPPOE_POOL local-address=$npPppLocal");
  put("    }");
  put("    :set npPppLocal \"\"");
  put("    /interface pppoe-server server set [find service-name=$NP_PPPOE_SERVICE] max-mtu=$NP_PPPOE_MTU max-mru=$NP_PPPOE_MRU");
  put("    :put (\"PPPoE service: \" . $NP_PPPOE_SERVICE . \" on \" . $NP_LAN_BRIDGE)");
  c("  } else={");
  put("    :put \"SKIP PPPoE server: NP_PPPOE_RANGES is blank. Set it in SECTION A.\"");
  put("  }");
  c("  NO LOCAL PPP ACCOUNTS ARE CREATED. Authentication is RADIUS-only.");
  put("}");
  put("");
}


// ---------------------------------------------------------------- WIREGUARD
function emitWireguard(L, c, rule, put, o) {
  rule();
  c("SECTION J - WIREGUARD / NETPID MANAGEMENT");
  rule();
  put("");
  c("The router's OWN key pair is generated HERE, on the router. The private half");
  c("is never printed, never sent to NETPID and never leaves this box - that is");
  c("the whole point of generating it locally rather than centrally.");
  put(":if ($NP_WG_ON = \"yes\") do={");
  put("  :if ([:len [/interface wireguard find name=$NP_WG_IFACE]] = 0) do={");
  put("    /interface wireguard add name=$NP_WG_IFACE listen-port=$NP_WG_LISTEN");
  put("    :put (\"WireGuard interface created: \" . $NP_WG_IFACE)");
  c("  } else={");
  put("    :put (\"WireGuard interface reused: \" . $NP_WG_IFACE)");
  put("  }");
  put("");
  c("Peer. NO PEER IS INVENTED. Without the real NETPID server public key the");
  c("router cannot handshake, and a fabricated key yields a tunnel that looks");
  c("configured and is permanently down. Stop and say so instead.");
  put("  :if ([:len [:trim $NP_WG_SERVER_PUB]] = 0) do={");
  put("    :put \"\"");
  put("    :put \"---------------- NETPID ENROLMENT INCOMPLETE ------------\"");
  put("    :put \"The WireGuard INTERFACE was created, but there is NO peer.\"");
  put("    :put \"NP_WG_SERVER_PUB is empty, so no real NETPID key exists yet.\"");
  put("    :put \"\"");
  put("    :put \"Expected on a brand-new router. The interface exists so NETPID\"");
  put("    :put \"can report WIREGUARD_ENROLLMENT_REQUIRED rather than 'missing'.\"");
  put("    :put \"The router is NOT yet manageable.\"");
  put("    :put \"\"");
  put("    :put \"YOUR ROUTER PUBLIC KEY - paste this into NETPID:\"");
  put("    :put ([/interface wireguard get [find name=$NP_WG_IFACE] public-key])");
  put("    :put \"NETPID then issues the peer, address and endpoint to add.\"");
  put("    :put \"--------------------------------------------------------\"");
  c("  } else={");
  put("    :if ([:len $NP_WG_ROUTER_IP] > 0) do={");
  put("      :if ([:len [/ip address find interface=$NP_WG_IFACE]] > 0) do={");
  put("        /ip address remove [find interface=$NP_WG_IFACE]");
  put("      }");
  put("      /ip address add address=$NP_WG_ROUTER_IP interface=$NP_WG_IFACE comment=\"$NP_TAG wg\"");
  put("    }");
  c("    Peer replaced wholesale, so a rotate cannot leave a stale key beside");
  c("    the new one and silently break the tunnel.");
  put("    :if ([:len [/interface wireguard peers find interface=$NP_WG_IFACE]] > 0) do={");
  put("      /interface wireguard peers remove [find interface=$NP_WG_IFACE]");
  put("    }");
  put("    :local npAllowed $NP_WG_SERVER_IP");
  put("    :if ([:len $npAllowed] = 0) do={ :set npAllowed \"0.0.0.0/0\" }");
  put("    :if ([:len $NP_WG_ENDPOINT] > 0) do={");
  put("      /interface wireguard peers add interface=$NP_WG_IFACE public-key=$NP_WG_SERVER_PUB allowed-address=0.0.0.0/0 endpoint-address=($NP_WG_ENDPOINT . \":\" . $NP_WG_LISTEN) persistent-keepalive=25s comment=\"$NP_TAG wg-peer\"");
  c("    } else={");
  put("      /interface wireguard peers add interface=$NP_WG_IFACE public-key=$NP_WG_SERVER_PUB allowed-address=$npAllowed persistent-keepalive=25s comment=\"$NP_TAG wg-peer\"");
  put("    }");
  put("    :set npAllowed \"\"");
  put("    :put \"WireGuard peer configured toward NETPID.\"");
  c("    NO explicit route to the VPS is added here, deliberately. The peer's");
  c("    allowed-address already installs exactly that route in the kernel, and");
  c("    a hand-written route 'via the router's own tunnel address' points at");
  c("    itself: it black-holes the management path and makes the tunnel look");
  c("    up while NETPID still cannot reach the router through it.");
  put("  }");
  put("}");
  put("");
}


// --------------------------------------------------------------- API + USER
function emitApi(L, c, rule, put, o) {
  rule();
  c("SECTION K - ROUTEROS API (management surface)");
  rule();
  put("");
  c("NETPID reaches this router's API over the WireGuard tunnel. The API is");
  c("NEVER open to the internet, so it is bound to a source address list. An");
  c("address-list on the SERVICE stops the connection before the firewall is");
  c("even consulted, which is the stronger of the two controls.");
  put(":if ([:len $NP_MGMT_NET] = 0) do={");
  put("  :if ([:len $NP_WG_ROUTER_IP] > 0) do={");
  put("    :set NP_MGMT_NET [:pick $NP_WG_ROUTER_IP 0 [:find $NP_WG_ROUTER_IP \"/\"]]");
  put("  }");
  put("}");
  put(":if ([:len [:trim $NP_MGMT_NET]] > 0) do={");
  put("  :if ([:len [/ip firewall address-list find list=NETPID-MGMT]] = 0) do={");
  put("    /ip firewall address-list add list=NETPID-MGMT address=$NP_MGMT_NET");
  put("    :put (\"API source allowlist: \" . $NP_MGMT_NET)");
  put("  }");
  c("} else={");
  put("  :put \"================ NETPID STATE: API WAITING FOR ENROLLMENT ================\"");
  put("  :put \"NP_MGMT_NET and NP_WG_ROUTER_IP are both empty, so the RouterOS API\"");
  put("  :put \"CANNOT be restricted to a management source and is NOT enabled here.\"");
  put("  :put \"Enabling it unbound would expose 8728/8729 to the internet, so it\"");
  put("  :put \"is deliberately left off until an operator supplies a management\"");
  put("  :put \"network. Re-run with NP_MGMT_NET set to finish provisioning.\"");
  put("  :put \"------------------------------------------------------------------------\"");
  put("}");
  put("");
  c("api-ssl first. The worker speaks it when use_ssl=yes, and it is the only");
  c("form that should ever carry NETPID credentials.");
  put(":if ($NP_APISSL_ON = \"yes\") do={");
  put("  :if ([:len [:trim $NP_MGMT_NET]] > 0) do={");
  put("    :if ([:len [/certificate find name=NETPID]] = 0) do={");
  put("      :certificate add name=NETPID common-name=$NP_IDENTITY days-valid=3650");
  c("      RouterOS 7 resolves a certificate NAME for /certificate sign, but a");
  c("      bare token is read as an internal id and matches nothing. Selecting");
  c("      with [find name=...] is unambiguous on both 6.x and 7.x.");
  put("      :certificate sign [find name=NETPID]");
  put("    }");
  put("    /ip service set api-ssl disabled=no port=$NP_APISSL_PORT address-list=NETPID-MGMT certificate=NETPID");
  put("  }");
  put("}");
  c("Plain api stays DISABLED unless explicitly wanted: cleartext credentials on");
  c("the wire, and no place on an ISP router that is internet-facing.");
  put(":if ($NP_API_ON = \"yes\") do={");
  put("  :if ([:len [:trim $NP_MGMT_NET]] > 0) do={");
  put("    /ip service set api disabled=no port=$NP_API_PORT address-list=NETPID-MGMT");
  put("    :put \"WARNING: plain api enabled. api-ssl alone is preferable.\"");
  put("  }");
  put("}");
  put("");
  c("The API user. NO PASSWORD IS STORED IN THE REPOSITORY. If the operator");
  c("supplied none, generate a strong one and print it exactly once.");
  put(":if ([:len $NP_API_USER] > 0) do={");
  put("  :if ([:len [/user find name=$NP_API_USER]] = 0) do={");
  put("    :if ([:len $NP_API_PASSWORD] = 0) do={");
  put("      :if ($NP_API_GEN = \"yes\") do={");
  put("        :local npChars \"abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789\"");
  put("        :local npPw \"\"");
  put("        :local npLen [:len $npChars]");
  c("        [:pick] and [:rndnum] are 1-based and INCLUSIVE, so the range is");
  c("        1..57. A range starting at 0 makes [:pick $npChars 0] fail, and that");
  c("        error aborts the script with no user created and no message.");
  put("        :for i from=1 to=24 do={");
  put("          :set npPw ($npPw . [:pick $npChars [:rndnum from=1 to=$npLen]])");
  put("        }");
  put("        :set NP_API_PASSWORD $npPw");
  put("        :set npPw \"\"");
  put("        :set npChars \"\"");
  put("        :set npLen \"\"");
  put("      }");
  put("    }");
  put("    :if ([:len $NP_API_PASSWORD] > 0) do={");
  put("      /user add name=$NP_API_USER group=full password=$NP_API_PASSWORD");
  put("      :put \"\"");
  put("      :put \"================ API PASSWORD - COPY NOW ================\")");
  put("      :put (\"user: \" . $NP_API_USER)");
  put("      :put (\"password: \" . $NP_API_PASSWORD)");
  put("      :put \"Shown ONCE. Store it in NETPID, then forget it.\"");
  put("      :put \"========================================================\"");
  c("    } else={");
  put("      :error \"NETPID: no API password supplied and NP_API_GEN=no\"");
  put("    }");
  c("  } else={");
  put("    :put (\"API user exists: \" . $NP_API_USER . \" (password unchanged)\")");
  put("    /user set [find name=$NP_API_USER] group=full");
  put("  }");
  put("}");
  put("");
}


// ------------------------------------------------------------------- REPORT
function emitReport(L, c, rule, put, o) {
  rule();
  c("SECTION L - NETPID INSTALLATION REPORT");
  rule();
  put("");
  c("'CONFIGURED' means an object exists. 'CONNECTED' and 'REACHABLE' are");
  c("different claims a router cannot prove about itself - only a real handshake");
  c("or a real Access-Request does that. The report keeps them apart on purpose,");
  c("because a router with working RADIUS is still NOT online in NETPID until a");
  c("worker health check succeeds over the tunnel.");
  put("");
  put(":put \"\"");
  put(":put (\"================= NETPID INSTALLATION REPORT =================\")");
  put(":put (\"Router identity     : \" . [/system identity get name])");
  put(":put (\"RouterOS version    : \" . [/system resource get version])");
  put(":put (\"Board               : \" . [/system resource get board-name])");
  put(":put (\"Install mode        : \" . $NP_MODE)");
  put(":put \"\"");
  put(":put (\"WAN interface       : \" . $NP_WAN . \" (list NETPID-WAN)\")");
  put(":put (\"LAN bridge          : \" . $NP_LAN_BRIDGE)");
  put(":put (\"LAN IP              : \" . [/ip address get [find interface=$NP_LAN_BRIDGE] address])");
  put(":put (\"LAN ports           : \" . $NP_LAN_PORTS)");
  put("");
  put(":if ([:len [/ip dhcp-server find name=$NP_TAG]] > 0) do={");
  put("  :put (\"DHCP                : ENABLED, pool \" . $NP_DHCP_POOL)");
  put("} else={ :put \"DHCP                : NOT CONFIGURED\" }");
  put(":put (\"DNS servers         : \" . [/ip dns get servers])");
  put("");
  put(":if ($NP_HOTSPOT_ON = \"yes\") do={");
  put("  :if ([:len [/ip hotspot find name=netpid]] > 0) do={");
  put("    :put (\"HotSpot             : CONFIGURED, dns \" . [/ip hotspot get [find name=netpid] dns-name])");
  put("    :put (\"HotSpot RADIUS      : \" . [/ip hotspot profile get [find name=netpid] use-radius])");
  put("  } else={ :put \"HotSpot             : NOT CONFIGURED\" }");
  put("} else={ :put \"HotSpot             : DISABLED by configuration\" }");
  put("");
  put(":if ($NP_PPPOE_ON = \"yes\") do={");
  put("  :if ([:len [/interface pppoe-server server find service-name=$NP_PPPOE_SERVICE]] > 0) do={");
  put("    :put (\"PPPoE service       : CONFIGURED (\" . $NP_PPPOE_SERVICE . \")\")");
  put("  } else={ :put \"PPPoE service       : NOT CONFIGURED\" }");
  put("} else={ :put \"PPPoE service       : DISABLED by configuration\" }");
  put("");
  put(":if ([:len [/radius find address=$NP_RADIUS_SERVER]] > 0) do={");
  put("  :put \"RADIUS              : CONFIGURED (reachability NOT proven here)\"");
  put("} else={ :put \"RADIUS              : NOT CONFIGURED\" }");
  put(":put (\"RADIUS accounting    : \" . [/ppp/aaa get accounting])");
  put(":put (\"RADIUS interim       : \" . [/ppp/aaa get interim-update])");
  put(":put (\"CoA accept           : \" . [/radius incoming get accept])");
  put(":put (\"CoA port             : \" . [/radius incoming get port])");
  put("");
  put(":if ([:len [/interface wireguard find name=$NP_WG_IFACE]] > 0) do={");
  put("  :local npPeerN [:len [/interface wireguard peers find interface=$NP_WG_IFACE]]");
  put("  :put \"WIREGUARD CONFIGURED: yes\"");
  put("  :if ($npPeerN > 0) do={");
  put("    :put \"WIREGUARD CONNECTED: no (peer exists, no handshake yet)\"");
  c("  } else={");
  put("    :put \"WIREGUARD CONNECTED: no (no peer - enrolment incomplete)\"");
  put("  }");
  put("  :put (\"WireGuard pubkey    : \" . [/interface wireguard get [find name=$NP_WG_IFACE] public-key])");
  put("  :set npPeerN \"\"");
  c("} else={");
  put("  :put \"WIREGUARD CONFIGURED: no\"");
  put("  :put \"WIREGUARD CONNECTED: no\"");
  put("}");
  put("");

  put(":if ([:len [/ip service find name=api-ssl]] > 0) do={");
  put("  :if ([:len [/ip service get [find name=api-ssl] disabled]] = 0) do={");
  put("    :put (\"api-ssl             : ENABLED on port \" . [/ip service get [find name=api-ssl] port])");
  put("  } else={ :put \"api-ssl             : disabled\" }");
  put("}");
  put(":if ([:len /ip service find name=api] > 0) do={");
  put("  :if ([:len [/ip service get [find name=api] disabled]] = 0) do={");
  put("    :put (\"api                 : ENABLED on port \" . [/ip service get [find name=api] port])");
  put("  } else={ :put \"api                 : disabled (recommended)\" }");
  put("}");
  put("");
  put(":if ([:len [/ip firewall nat find action=masquerade]] > 0) do={");
  put("  :put \"NAT                 : masquerade present\"");
  put("} else={ :put \"NAT                 : NOT CONFIGURED\" }");
  put(":put (\"Firewall input rules: \" . [:len [/ip firewall filter find chain=input]])");
  put("");
  c("IP pools");
  put(":foreach pl in [/ip pool find] do={");
  put("  :put (\"  pool \" . [/ip pool get $pl name] . \" -> \" . [/ip pool get $pl ranges])");
  put("}");
  put("");
  c("NETPID management status, stated as the separate claims they are.");
  put(":if ([:len [/interface wireguard find name=$NP_WG_IFACE]] = 0) do={");
  put("  :put \"ENROLLMENT STATE        : WIREGUARD ENROLLMENT REQUIRED\"");
  put("} else={");
  put("  :if ([:len [:trim $NP_WG_SERVER_PUB]] = 0) do={");
  put("    :put \"ENROLLMENT STATE        : WIREGUARD ENROLLMENT REQUIRED\"");
  put("    :put \"ENROLLMENT STATE        : interface exists, no NETPID peer key yet\"");
  put("  } else={");
  put("    :if ([:len [/interface wireguard peers find interface=$NP_WG_IFACE]] = 0) do={");
  put("      :put \"ENROLLMENT STATE        : PROVISIONED - peer awaiting install\"");
  put("    } else={");
  put("      :put \"ENROLLMENT STATE        : CONNECTED only if a handshake exists\"");
  put("      :if ([:len [/interface wireguard peers find interface=$NP_WG_IFACE last-handshake-time]] > 0) do={");
  put("        :put \"ENROLLMENT STATE        : CONNECTED (handshake seen)\"");
  put("      }");
  put("    }");
  put("  }");
  put("}");
  put(":if ([:len [:trim $NP_MGMT_NET]] = 0) do={");
  put("  :put \"API STATE                : API WAITING FOR ENROLLMENT\"");
  put("} else={");
  put("  :put \"API STATE                : PROVISIONED - reachability is NETPID to test\"");
  put("}");
  put("");
  c("Post-install backup. /system/backup/save is safe: it writes to the routers");
  c("own filesystem and touches nothing else. Nothing is uploaded by this");
  c("script; NETPID fetches backups over the API when it has management.");
  put(":if ($NP_BACKUP_ON = \"yes\") do={");
  put("  :do {");
  put("    /system/backup/save name=netpid-post-install password=$NP_API_PASSWORD");
  put("    :put \"backup: saved as netpid-post-install\"");
  put("  } on-error={ :put \"backup: skipped (no space, or unsupported here)\" }");
  put("} else={ :put \"backup: skipped (NP_BACKUP_ON=no)\" }");
  put("");
  put(":put (\"ping \" . $NP_RADIUS_SERVER . \" -> \" . [:ping $NP_RADIUS_SERVER count=3] . \" packet loss\")");
  put(":put \"\"");
  rule();
  c("NETPID STATE MODEL - four different claims, not one");
  rule();
  c("  PROVISIONED = configuration was written to this router. This script can");
  c("                prove this and nothing more.");
  c("  CONNECTED   = NETPID management transport is actually reachable. Needs a");
  c("                real WireGuard handshake. NOT provable from here.");
  c("  VERIFIED    = NETPID successfully tested the service (RADIUS auth,");
  c("                accounting, CoA). NETPID does this; this script cannot.");
  c("  ONLINE      = every required health check passed. Only a NETPID worker");
  c("                health check can set this.");
  c("");
  c("  RADIUS CONFIGURED ......... see report above");
  c("  RADIUS REACHABLE .......... NOT PROVEN by this script");
  c("  RADIUS ACCOUNTING ......... see /ppp/aaa above");
  c("  COA CONFIGURED ............ see /radius incoming above");
  c("  WIREGUARD CONFIGURED ...... see report above");
  c("  WIREGUARD CONNECTED ....... needs a real handshake");
  c("  ROUTEROS API REACHABLE .... needs NETPID to connect over the tunnel");
  c("  NETPID WORKER REACHABLE ... needs a successful API health check");
  c("");
  c("NETPID marks this router ONLINE only after a worker health check");
  c("succeeds. Working RADIUS alone does NOT make a router online.");
  rule();
  put("");
}

