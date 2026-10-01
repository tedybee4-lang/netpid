// NETPID MikroTik installer - static validation of the generated .rsc.
//
// The installer cannot be run against a real router in CI, so these tests pin
// the properties that make it SAFE to hand to an operator. Most of them exist
// because a specific way of writing this script breaks routers silently.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { buildRouterosSetup } from "../src/routeros.mjs";
import {
  buildRouterosInstaller, installerDefaults, installerMissing, isCidr, isWgKey,
} from "../src/installer.mjs";

const FULL = {
  identity: "GENE",
  lanSubnet: "192.168.88.0/24",
  lanGateway: "192.168.88.1",
  dhcpPool: "pool-lan",
  hotspotSubnet: "10.5.50.0/24",
  hotspotPool: "pool-hs",
  hotspotDnsName: "login.gene.net",
  pppoePool: "pool-pppoe",
  radiusServer: "10.90.0.1",
  // Supplied by the operator at run time, never committed. The generator takes
  // it as an input precisely so the value never lives in source control.
  radiusSecret: "operator-supplied-secret",
  nasShortname: "netpid-GENE",
  wgServerPublicKey: "iHtSz+Y0QLqLS+KxUqoTUn45AvMEvUe9NXGMAcK6QmY=",
  wgRouterTunnelIp: "10.90.0.2",
  wgServerTunnelIp: "10.90.0.1",
  mgmtNetwork: "10.90.0.0/30",
};
const S = buildRouterosInstaller(FULL);

/** Every non-blank, non-comment line: the RouterOS statements themselves. */
function statements(script) {
  return script.split("\n").map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
}

/** Lines that are neither a comment nor a RouterOS statement. A prose line
 *  emitted without a leading '#' is executed by the router and aborts the
 *  script partway through, leaving the box half configured. */
function executableLines(script) {
  return script.split("\n")
    .map((l, i) => [i + 1, l.trim()])
    .filter(([, l]) => l && !l.startsWith("#"))
    .filter(([, l]) => !(l.startsWith(":") || l.startsWith("/") || /[{}]$/.test(l)));
}

test("every emitted line is a comment or a RouterOS statement", () => {
  const bad = executableLines(S);
  assert.deepEqual(bad.map(([, l]) => l), [],
    `prose reached the router as a command:\n${bad.map(([n, l]) => `  ${n}: ${l}`).join("\n")}`);
});

test("RouterOS has no line continuation, so no statement spans two lines", () => {
  // A property like comment=... on its own line is a syntax error, not a
  // continuation. This is the failure that makes a pasted script die silently
  // halfway through, after the bridge but before the firewall.
  for (const [n, l] of executableLines(S)) {
    assert.doesNotMatch(l, /^\s+[a-z][a-zA-Z0-9-]*=/,
      `line ${n} looks like a dangling property assignment: ${l}`);
  }
});

test("the installer targets RouterOS 7 and refuses anything else", () => {
  assert.match(S, /RouterOS 7\.x/);
  // The gate is [:find $npVer "7."], not a [:pick] of the first character:
  // [:pick] is 1-based so index 0 returns nothing and the test failed on
  // EVERY router, printing "RouterOS  detected" on a healthy 7.x box.
  assert.match(S, /\[:find \$npVer "7\."\] < 0/, "must gate on the version before touching anything");
  assert.match(S, /targets 7\.x only/);
});

test("RADIUS uses the v7 top-level menu, never the v6 /ip path", () => {
  // RouterOS 7 promoted RADIUS out of /ip. A 7.x router answers
  // "bad command name radius" for /ip radius, so the client is never created
  // and PPPoE then authenticates against nothing.
  const st = statements(S);
  for (const l of st) {
    assert.doesNotMatch(l, /^\/ip radius/, `v6 RADIUS path emitted: ${l}`);
  }
  assert.ok(st.some((l) => l.startsWith("/radius add")), "no /radius add emitted");
});

test("/radius incoming gets accept and port and never a comment", () => {
  // It is a singleton with only accept/port/vrf. Setting a comment fails the
  // whole line, which is why CoA silently never worked before.
  const line = statements(S).find((l) => l.startsWith("/radius incoming set"));
  assert.ok(line, "no /radius incoming set emitted");
  assert.match(line, /accept=yes/);
  assert.match(line, /port=\$NP_RADIUS_COA/);
  assert.doesNotMatch(line, /comment/, "/radius incoming has no comment property");
});

test("PPP accounting and interim updates are enabled", () => {
  // Accounting is what makes NETPID see usage at all. Without it every
  // subscriber looks idle and the bill is wrong rather than obviously broken.
  assert.match(S, /\/ppp\/aaa set use-radius=yes accounting=yes interim-update=5m/);
});

test("no secret is baked into the generated script", () => {
  // The secret is an operator input. A generator default that carried one would
  // put a live RADIUS secret in git history permanently.
  assert.match(S, /:global NP_RADIUS_SECRET    ""/);
  assert.match(S, /:global NP_API_PASSWORD     ""/);
  assert.doesNotMatch(S, /secret=[^$\s"]/);
  assert.doesNotMatch(S, /password=[^$\s"]/);
});

test("no WireGuard peer is ever invented", () => {
  // A fabricated public key produces a tunnel that looks configured and never
  // handshakes, and a router NETPID still cannot manage.
  // Blank only when NETPID supplied nothing. When it supplies a real key the
  // script carries it, so the operator does not paste the same value twice.
  const none = buildRouterosInstaller({ ...FULL, wgServerPublicKey: "" }, { strict: false });
  assert.match(none, /:global NP_WG_SERVER_PUB    ""/);
  assert.match(S, /:global NP_WG_SERVER_PUB    "iHtSz\+Y0QLqLS/);
  assert.match(S, /ENROLMENT INCOMPLETE/, "must explain that enrolment is pending");
  assert.match(S, /public-key\]\)/, "must print the router's own public key for enrolment");
});

test("the RouterOS API is bound to a management source list, never open", () => {
  assert.match(S, /\/ip service set api-ssl disabled=no/);
  assert.match(S, /address-list=NETPID-MGMT/);
  assert.match(S, /\/ip firewall address-list add list=NETPID-MGMT/);
  // If there is no management network at all, the API must not be enabled
  // rather than enabled for the world.
  assert.match(S, /API WAITING FOR ENROLLMENT/);
  assert.match(S, /CANNOT be restricted to a management source/);
});

test("the firewall is added to, never flushed", () => {
  assert.match(S, /NOTHING IS FLUSHED/);
  assert.doesNotMatch(S, /\/ip firewall filter remove/);
  assert.doesNotMatch(S, /\/ip firewall filter clear/);
  assert.doesNotMatch(S, /\/ip firewall nat remove/);
});

test("EXISTING mode never deletes a bridge, WAN, DHCP, hotspot, PPPoE or RADIUS", () => {
  // These are the objects that carry a customer's live service. Deleting one
  // to 'rebuild' it is how a provisioning script takes a site offline.
  for (const banned of [
    "/interface bridge remove",
    "/interface bridge port remove",
    "/ip dhcp-server remove",
    "/ip hotspot remove",
    "/interface pppoe-server server remove",
    "/radius remove",
  ]) {
    assert.ok(!S.includes(banned), `EXISTING mode must never run: ${banned}`);
  }
});

test("every object it does remove is scoped to NETPID's own namespace", () => {
  // The removals that survive are for the LAN address and the WireGuard
  // address, both of which must converge. Each is scoped by interface or by
  // the NETPID interface name, never a blanket wipe.
  const removals = statements(S)
    .filter((l) => l.startsWith("/") && l.includes(" remove"));
  assert.ok(removals.length > 0);
  for (const r of removals) {
    // The static-WAN conversion removes the DHCP client, because a static WAN
    // and a DHCP client on the same interface is a real conflict. It is allowed
    // only because it is scoped to NETPID's chosen WAN and gated behind the
    // explicit NP_WAN_STATIC opt-in, which the next test pins.
    // The LAN-address and WireGuard-address removals must converge when the
    // operator changes a subnet, so they are allowed but must stay scoped to
    // NETPID's own interfaces.
    assert.match(r,
      /find (interface=netpid-wg|interface=\$NP_LAN_BRIDGE|name=\$NP_TAG|interface=\$NP_WG_IFACE|comment=\$npRComment|address=\$NP_RADIUS_SERVER|interface=\$NP_WAN)/,
      `removal is not scoped to NETPID's own objects: ${r}`);
  }
});

test("the only WAN rewrite is behind the explicit static-WAN opt-in", () => {
  // Removing the WAN DHCP client is legitimate but disruptive, so it must never
  // happen because the script guessed a static address was wanted.
  const idx = S.indexOf("/interface dhcp-client remove");
  assert.ok(idx > 0, "expected a scoped dhcp-client removal in the static-WAN block");
  const before = S.slice(0, idx);
  const guard = before.lastIndexOf(':if ($NP_WAN_STATIC = "yes") do={');
  assert.ok(guard > 0, "the dhcp-client removal must sit inside the NP_WAN_STATIC guard");
  // And the address it installs is never invented: it comes from a variable.
  assert.doesNotMatch(S, /\/interface dhcp-client add[^\n]*address=/);
});

test("idempotent objects are guarded so a re-run cannot stack duplicates", () => {
  // A duplicate masquerade per run is the classic 'router got slower every
  // time someone re-applied the script'.
  assert.match(S, /\/ip firewall nat find comment="\$NP_TAG masquerade"\]\] = 0/);
  assert.match(S, /\/interface bridge find name=\$NP_LAN_BRIDGE\]\] = 0/);
  assert.match(S, /\/ip dhcp-server find name=\$NP_TAG\]\] = 0/);
  assert.match(S, /\/ip hotspot find name=netpid\]\] = 0/);
  assert.match(S, /\/interface wireguard find name=\$NP_WG_IFACE\]\] = 0/);
  assert.match(S, /\/ip pool find name=\$NP_DHCP_POOL\]\] = 0/);
});

test("HotSpot is on its own subnet and authorised by RADIUS, with no local users", () => {
  assert.match(S, /\/ip hotspot add name=netpid/);
  assert.match(S, /address-pool=\$NP_HOTSPOT_POOL/);
  assert.match(S, /dns-name=\$NP_HOTSPOT_DNS/);
  assert.match(S, /use-radius=yes/);
  assert.match(S, /NO LOCAL USERS ARE CREATED/);
  // A local hotspot user is an account nobody bills and nobody can revoke.
  assert.doesNotMatch(S, /\/ip hotspot user add/);
  assert.doesNotMatch(S, /\/ip hotspot user profile add/);
});

test("PPPoE is on the LAN bridge, RADIUS only, with no local accounts", () => {
  assert.match(S, /\/interface pppoe-server server add service-name=\$NP_PPPOE_SERVICE/);
  assert.match(S, /interface=\$NP_LAN_BRIDGE/);
  assert.match(S, /authentication-service=pppoe/);
  assert.match(S, /max-mtu=\$NP_PPPOE_MTU/);
  assert.match(S, /NO LOCAL PPP ACCOUNTS ARE CREATED/);
  assert.doesNotMatch(S, /\/ppp secret add/);
});

test("the router generates its own key rather than receiving one", () => {
  assert.match(S, /\/interface wireguard add name=\$NP_WG_IFACE/);
  assert.doesNotMatch(S, /private-key=/, "a private key must never be pushed to a router");
});

test("the report separates CONFIGURED from CONNECTED and REACHABLE", () => {
  // The whole point: a router with working RADIUS is still not online in
  // NETPID until a worker health check succeeds over the tunnel.
  assert.match(S, /WIREGUARD CONFIGURED/);
  assert.match(S, /WIREGUARD CONNECTED/);
  assert.match(S, /RADIUS REACHABLE \.+ NOT PROVEN/);
  assert.match(S, /ROUTEROS API REACHABLE/);
  assert.match(S, /NETPID WORKER REACHABLE/);
  assert.match(S, /Working RADIUS alone does NOT make a router online/);
  assert.match(S, /NETPID INSTALLATION REPORT/);
});

test("nothing is written to /file, /system script or /system scheduler", () => {
  // NETPID drives routers entirely through live API calls. Populating those
  // menus would make /file print look provisioned without changing anything.
  for (const menu of ["/file add", "/system script add", "/system scheduler add"]) {
    assert.ok(!S.includes(menu), `installer must not create fake NETPID files: ${menu}`);
  }
});

test("required variables are reported rather than invented", () => {
  const empty = installerMissing({});
  assert.ok(empty.length >= 5, "an empty config must report every missing value");
  const labels = empty.join(" ");
  assert.match(labels, /router identity/);
  assert.match(labels, /LAN subnet/);
  assert.match(labels, /RADIUS server IP/);
  assert.match(labels, /NAS/);
  assert.match(labels, /HotSpot subnet/);
  assert.match(labels, /PPPoE pool/);
});

test("a complete config reports nothing missing", () => {
  assert.deepEqual(installerMissing(FULL), []);
  assert.equal(
    installerMissing({ ...FULL, hotspotEnabled: false }).filter((x) => /HotSpot/.test(x)).length, 0);
});

test("the preflight prints the missing values and stops", () => {
  assert.match(S, /NETPID INSTALLER STOPPED/);
  assert.match(S, /Nothing has been changed/);
  assert.match(S, /NP_IDENTITY/);
});

test("the unroutable 10.10.10.0/24 never appears", () => {
  // That range is not routed anywhere. Every router created against it was
  // born unreachable, which is what Quick Add used to do.
  assert.doesNotMatch(S, /10\.10\.10\./);
});

test("the defaults do not ship an invented network or key", () => {
  const d = installerDefaults();
  for (const k of ["lanSubnet", "hotspotSubnet", "radiusServer", "nasShortname",
    "wgServerPublicKey", "wgRouterTunnelIp", "wgServerTunnelIp", "apiPassword", "radiusSecret"]) {
    assert.equal(d[k], "", `${k} must default to empty so the preflight catches it`);
  }
});

test("validators reject the shapes they are meant to reject", () => {
  assert.equal(isCidr("192.168.88.0/24"), true);
  assert.equal(isCidr("192.168.88.0"), false);
  assert.equal(isCidr("not-a-subnet"), false);
  assert.equal(isWgKey("iHtSz+Y0QLqLS+KxUqoTUn45AvMEvUe9NXGMAcK6QmY="), true);
  assert.equal(isWgKey("too-short"), false);
});

test("there is exactly one installer generator", () => {
  // A second copy of this script is a copy that will drift, exactly like the
  // inline RouterOS generator that used to live in app/api/routers/route.ts.
  const root = join(process.cwd(), "..", "apps", "web");
  const hits = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name === ".next" || e.name.startsWith(".")) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.tsx?$/.test(e.name)) {
        const src = readFileSync(p, "utf8");
        if (/function\s+buildRouterosInstaller|const\s+buildRouterosInstaller\s*=/.test(src)
          && !p.endsWith(join("lib", "routeros-installer.ts"))) hits.push(p);
      }
    }
  };
  walk(root);
  assert.deepEqual(hits, [], `duplicate installer generator(s): ${hits.join(", ")}`);
});

// The worker twin and the web port must agree. Quick Add serves the .rsc from
// the web copy while the worker tests the twin; if the two drift, an operator
// gets a different router depending on which path generated the script.
test("the web port and the worker twin produce identical output", async () => {
  const web = await import(pathToFileURL(join(process.cwd(), "..", "apps", "web", "lib", "routeros-installer.ts")).href);
  const a = web.buildRouterosInstaller(FULL);
  const b = buildRouterosInstaller(FULL);
  if (a !== b) {
    const A = a.split("\n"), B = b.split("\n");
    const at = A.findIndex((l, i) => l !== B[i]);
    throw new Error(
      `web port and worker twin diverged at line ${at + 1}:\n`
      + `  web:   ${JSON.stringify(A[at])}\n  twin:  ${JSON.stringify(B[at])}`);
  }
  // And the defaults and the validator agree, or the server-side preflight
  // would pass a config the router then refuses.
  assert.deepEqual(web.installerDefaults(), installerDefaults());
  assert.deepEqual(web.installerMissing({}), installerMissing({}));
  assert.deepEqual(web.installerMissing(FULL), installerMissing(FULL));
});

test("the web port also refuses to invent a network or a key", async () => {
  const web = await import(pathToFileURL(join(process.cwd(), "..", "apps", "web", "lib", "routeros-installer.ts")).href);
  // Deliberately partial: strict:false is the only way to get a script that is
  // missing required values, which is what this test inspects.
  const s = web.buildRouterosInstaller({ identity: "GENE" }, { strict: false });
  assert.doesNotMatch(s, /10\.10\.10\./);
  assert.match(s, /:global NP_RADIUS_SECRET    ""/);
  // Still must never invent one when NETPID gave it nothing.
  assert.match(s, /:global NP_WG_SERVER_PUB    ""/);
  assert.doesNotMatch(s, /NP_WG_SERVER_PUB\s+"[A-Za-z0-9+/]{43}="/);
});

// The bug this pins: buildRouterosInstaller() existed, but the dashboard
// rendered buildRouterosSetup()'s RADIUS/PPP-only script, so operators were
// handed identity+API+RADIUS+PPP AAA+CoA and believed the router was
// provisioned. Every unit test above passed while that was true.
test("the RADIUS/PPP-only generator cannot be reached by accident", async () => {
  // The canonical twin refuses without the explicit opt-in...
  assert.throws(() => buildRouterosSetup({ shortname: "s", radiusServer: "1.1.1.1" }),
    /RADIUS\/PPP-only script/);
  // ...and so does the web copy the dashboard actually imports.
  const webRouteros = await import(pathToFileURL(
    join(process.cwd(), "..", "apps", "web", "lib", "routeros.ts")).href);
  assert.throws(() => webRouteros.buildRouterosSetup({ shortname: "s", radiusServer: "1.1.1.1" }),
    /RADIUS\/PPP-only script/);
  // With the opt-in it still works, because the repair tool needs it.
  assert.match(buildRouterosSetup({ radiusOnly: true, shortname: "s", radiusServer: "1.1.1.1" }),
    /\/radius/);
});

test("the old partial script cannot satisfy the full-installer contract", () => {
  // The exact shape the dashboard was rendering.
  const partial = buildRouterosSetup({ radiusOnly: true, shortname: "netpid-X", radiusServer: "10.0.0.5", secret: "x", identity: "X" });
  // It has exactly the authentication plane the operator reported: identity,
  // clock, DNS/NTP, the RouterOS API service, /radius and /radius incoming.
  assert.match(partial, /# NAS shortname : netpid-X/);
  assert.match(partial, /\/system identity set name=X/);
  assert.match(partial, /\/ip service set api disabled=no/);
  assert.match(partial, /\/radius add/);
  assert.match(partial, /\/radius incoming/);
  // Size is the giveaway: the partial is ~40 lines, the full installer ~890.
  assert.ok(partial.split("\n").length < 80,
    "the partial script is no longer the short one; re-check this test's premise");
  assert.ok(S.split("\n").length > 700,
    "the full installer should be the long one");
  // ...and none of the router. Each of these is what an operator was missing.
  for (const [what, re] of [
    ["LAN bridge", /\/interface bridge add/],
    ["DHCP server", /\/ip dhcp-server add/],
    ["NAT masquerade", /action=masquerade/],
    ["firewall", /\/ip firewall filter add/],
    ["HotSpot server", /\/ip hotspot add/],
    ["PPPoE server", /\/interface pppoe-server server add/],
    ["WireGuard", /\/interface wireguard/],
  ]) {
    assert.doesNotMatch(partial, re,
      `the old script unexpectedly has ${what}; the test premise is wrong`);
  }
  // And the full installer differs from it in every one of those ways.
  for (const re of [
    /\/interface bridge add/, /\/ip dhcp-server add/, /action=masquerade/,
    /\/ip firewall filter add/, /\/ip hotspot add/,
    /\/interface pppoe-server server add/, /\/interface wireguard add/,
  ]) {
    assert.match(S, re, `the full installer is missing ${re}`);
  }
});

// The same module the dashboard imports, called the same way the Quick Add
// route calls it, with the real database defaults for an ISP that has not
// recorded its site networks yet.
test("the Quick Add API path yields the full installer, not the partial one", async () => {
  const web = await import(pathToFileURL(
    join(process.cwd(), "..", "apps", "web", "lib", "routeros-installer.ts")).href);

  // Mirrors app/api/routers/quick/route.ts exactly.
  const d = {
    mode: "EXISTING", wan: null, lan_bridge: null, lan_ports: null,
    lan_subnet: null, lan_gateway: null, dhcp_pool: null,
    hotspot_enabled: true, hotspot_subnet: null, hotspot_pool: null, hotspot_dns: null,
    pppoe_enabled: true, pppoe_pool: null,
  };
  const response = {
    installer: web.buildRouterosInstaller({
      mode: d.mode,
      identity: "REGRESSION-SITE",
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
      radiusServer: "10.90.0.1",
      radiusSecret: "generated-at-request-time",
      nasShortname: "netpid-REGRESSION-SITE",
      wgServerPublicKey: "iHtSz+Y0QLqLS+KxUqoTUn45AvMEvUe9NXGMAcK6QmY=",
      wgServerTunnelIp: "10.90.0.1",
      wgRouterTunnelIp: "10.90.0.2",
      mgmtNetwork: "10.90.0.0/30",
    }, { strict: false }),
    installer_missing: web.installerMissing({ identity: "REGRESSION-SITE" }),
  };

  for (const [label, re] of [
    ["A preflight/validation", /# SECTION B - PREFLIGHT/],
    ["A preflight stop", /NETPID INSTALLER STOPPED/],
    ["B identity", /# SECTION C - IDENTITY, BRIDGE, LAN/],
    ["B clock", /\/system clock set time-zone-name=\$NP_TIMEZONE/],
    ["B NTP", /\/system ntp client set servers=\$NP_NTP_SERVERS/],
    ["B DNS", /\/ip dns set servers=\$NP_DNS_SERVERS/],
    ["C WAN section", /# SECTION E - WAN AND NAT/],
    ["C WAN interface list", /\/interface list add name=NETPID-WAN/],
    ["C WAN dhcp client", /\/interface dhcp-client add interface=\$NP_WAN/],
    ["D LAN bridge", /\/interface bridge add name=\$NP_LAN_BRIDGE/],
    ["D LAN address", /\/ip address add address=\$NP_LAN_NET interface=\$NP_LAN_BRIDGE/],
    ["D LAN ports", /\/interface bridge port add bridge=\$NP_LAN_BRIDGE/],
    ["E DHCP pool", /\/ip pool add name=\$NP_DHCP_POOL/],
    ["E DHCP server", /\/ip dhcp-server add name=\$NP_TAG interface=\$NP_LAN_BRIDGE/],
    ["E DHCP network", /\/ip dhcp-server network add address=\$NP_LAN_NET gateway=\$NP_LAN_GATEWAY/],
    ["F NAT masquerade", /\/ip firewall nat add chain=srcnat action=masquerade/],
    ["G firewall section", /# SECTION F - FIREWALL/],
    ["G firewall established", /connection-state=established,related comment="\$NP_TAG established"/],
    ["G firewall WAN drop", /action=drop in-interface-list=NETPID-WAN comment="\$NP_TAG wan-drop"/],
    ["H WireGuard section", /# SECTION J - WIREGUARD/],
    ["H WireGuard interface", /\/interface wireguard add name=\$NP_WG_IFACE/],
    ["H WireGuard peer", /\/interface wireguard peers add interface=\$NP_WG_IFACE/],
    ["I API section", /# SECTION K - ROUTEROS API/],
    ["I API-SSL", /\/ip service set api-ssl disabled=no/],
    ["I API restricted", /address-list=NETPID-MGMT/],
    ["I API certificate", /:certificate sign \[find name=NETPID\]/],
    ["J RADIUS section", /# SECTION G - RADIUS \(auth, accounting, CoA\)/],
    ["J RADIUS client", /\/radius add service=ppp,hotspot/],
    ["J PPP accounting", /\/ppp\/aaa set use-radius=yes accounting=yes/],
    ["J CoA", /\/radius incoming set accept=yes port=\$NP_RADIUS_COA/],
    ["K HotSpot section", /# SECTION H - HOTSPOT/],
    ["K HotSpot server", /\/ip hotspot add name=netpid/],
    ["K HotSpot profile", /\/ip hotspot profile add name=netpid use-radius=yes/],
    ["L PPPoE section", /# SECTION I - PPPoE SERVER/],
    ["L PPPoE server", /\/interface pppoe-server server add service-name=\$NP_PPPOE_SERVICE/],
    ["L PPPoE profile", /\/ppp profile add name=netpid use-radius=yes/],
    ["final report", /# SECTION L - NETPID INSTALLATION REPORT/],
  ]) {
    assert.match(response.installer, re, `the Quick Add path is missing ${label}`);
  }

  // And it must NOT be the old short script.
  assert.ok(response.installer.split("\n").length > 700,
    "the Quick Add installer is too short to be the full router");
  assert.ok(response.installer_missing.length > 0, "unset site values were not reported");
  assert.doesNotMatch(response.installer, /RouterOS 6/);
  assert.doesNotMatch(response.installer, /generated-at-request-time/,
    "the RADIUS secret must not be written into the script");
});



test("the installer refuses to generate a complete script with missing input", () => {
  // The whole point of the task: a half-configured .rsc must not be emittable.
  assert.throws(() => buildRouterosInstaller({}), /refusing to generate a complete/);
  assert.throws(() => buildRouterosInstaller({ ...FULL, radiusSecret: "" }), /RADIUS shared secret/);
  assert.throws(() => buildRouterosInstaller({ ...FULL, identity: "" }), /router identity/);
  assert.throws(() => buildRouterosInstaller({ ...FULL, nasShortname: "" }), /NAS shortname/);
  // A partial script is possible, but only when explicitly requested.
  assert.doesNotThrow(() => buildRouterosInstaller({ identity: "X" }, { strict: false }));
});

// Quick Add calls the generator for an ISP whose site networks are all NULL,
// which is the normal state on day one. Strict mode threw there, the route had
// no catch, and the dashboard reported "Unexpected end of JSON input" - an
// error that pointed at the browser and named neither the cause nor the field.
// This pins the exact input that broke, so it cannot regress.
test("Quick Add's real input still yields a script rather than throwing", () => {
  const quickAddInput = {
    mode: "EXISTING",
    identity: "NEW-SITE",
    wan: "ether1",
    lanBridge: "bridge-lan",
    lanPorts: ["ether2", "ether3", "ether4", "ether5"],
    lanSubnet: "", lanGateway: "", dhcpPool: "",
    hotspotEnabled: true,
    hotspotSubnet: "", hotspotPool: "", hotspotDnsName: "",
    pppoeEnabled: true, pppoePool: "",
    radiusServer: "10.90.0.1",
    radiusSecret: "generated-at-request-time",
    nasShortname: "netpid-NEW-SITE",
    wgServerPublicKey: "iHtSz+Y0QLqLS+KxUqoTUn45AvMEvUe9NXGMAcK6QmY=",
    wgServerTunnelIp: "10.90.0.1",
    wgRouterTunnelIp: "10.90.0.2",
    mgmtNetwork: "10.90.0.0/30",
  };
  let script = null;
  assert.doesNotThrow(() => { script = buildRouterosInstaller(quickAddInput, { strict: false }); },
    "Quick Add's input must not throw");
  // And it must be a usable, coherent script, not an empty string.
  assert.ok(script.length > 5000);
  for (const marker of [
    "SECTION A", "SECTION B", "SECTION C", "SECTION D", "SECTION E", "SECTION F",
    "SECTION G", "SECTION H", "SECTION I", "SECTION J", "SECTION K", "SECTION L",
  ]) {
    assert.ok(script.includes(marker), `partial installer is missing ${marker}`);
  }
  // The unset values are reported rather than invented, so the operator knows
  // exactly what to fill in.
  const missing = installerMissing(quickAddInput);
  for (const label of ["LAN subnet", "LAN gateway", "DHCP pool", "HotSpot subnet", "PPPoE pool"]) {
    assert.ok(missing.includes(label) || missing.some((m) => m.includes(label)),
      `Quick Add would not report the missing ${label}`);
  }
  // NETPID's own values are present even though the site's are not.
  assert.match(script, /:global NP_RADIUS_SERVER    "10\.90\.0\.1"/);
  assert.match(script, /iHtSz\+Y0QLqLS\+KxUqoTUn45AvMEvUe9NXGMAcK6QmY=/);
  assert.doesNotMatch(script, /secret=generated-at-request-time/);
});


test("every required value is named when input is rejected", () => {
  const text = installerMissing({}).join(" | ");
  for (const label of [
    "router identity", "LAN subnet", "LAN gateway", "DHCP pool",
    "HotSpot subnet", "HotSpot pool", "HotSpot DNS name", "PPPoE pool",
    "RADIUS server IP", "RADIUS shared secret", "NAS shortname",
    "WireGuard server public key", "WireGuard router tunnel address",
  ]) {
    assert.ok(text.includes(label), `missing-required-input does not report: ${label}`);
  }
});

test("an invalid WireGuard key is rejected, not accepted as a placeholder", () => {
  for (const bad of ["not-a-key", "", "AAAA"]) {
    assert.equal(
      installerMissing({ ...FULL, wgServerPublicKey: bad })
        .filter((m) => /public key/.test(m)).length, 1,
      `a bad server key was accepted: ${JSON.stringify(bad)}`);
  }
  assert.equal(installerMissing(FULL).length, 0);
});

test("out-of-range RADIUS and CoA ports are rejected", () => {
  for (const k of ["radiusAuthPort", "radiusAcctPort", "radiusCoaPort", "wgListenPort"]) {
    for (const bad of [0, 70000, "x"]) {
      assert.ok(
        installerMissing({ ...FULL, [k]: bad }).some((m) => /port/i.test(m)),
        `${k}=${bad} was accepted`);
    }
  }
});

test("identity, timezone, NTP and DNS are configured", () => {
  assert.match(S, /\/system identity set name=\$NP_IDENTITY/);
  assert.match(S, /:global NP_TIMEZONE         "Africa\/Nairobi"/);
  assert.match(S, /\/system clock set time-zone-name=\$NP_TIMEZONE/);
  assert.match(S, /\/system ntp client set servers=\$NP_NTP_SERVERS/);
  assert.match(S, /\/ip dns set servers=\$NP_DNS_SERVERS allow-remote-requests=yes/);
});

test("WAN is declared, never assumed, and gets a DHCP client", () => {
  assert.match(S, /:global NP_WAN              "ether1"/);
  assert.match(S, /\/interface list add name=NETPID-WAN/);
  assert.match(S, /\/interface list member add list=NETPID-WAN interface=\$NP_WAN/);
  assert.match(S, /\/interface dhcp-client add interface=\$NP_WAN disabled=no/);
  // It must warn rather than silently proceed when the interface is absent.
  assert.match(S, /WARNING: no interface named/);
});

test("LAN, bridge and DHCP are derived from the declared values", () => {
  assert.match(S, /\/interface bridge add name=\$NP_LAN_BRIDGE/);
  assert.match(S, /\/interface bridge port add bridge=\$NP_LAN_BRIDGE interface=\$p/);
  assert.match(S, /\/ip address add address=\$NP_LAN_NET interface=\$NP_LAN_BRIDGE/);
  assert.match(S, /\/ip pool add name=\$NP_DHCP_POOL ranges=\$NP_DHCP_RANGE/);
  assert.match(S, /\/ip dhcp-server add name=\$NP_TAG interface=\$NP_LAN_BRIDGE/);
  assert.match(S, /\/ip dhcp-server network add address=\$NP_LAN_NET gateway=\$NP_LAN_GATEWAY dns-server=\$NP_DNS_SERVERS/);
});

test("NAT masquerade is present and idempotent", () => {
  assert.match(S, /\/ip firewall nat add chain=srcnat action=masquerade out-interface-list=NETPID-WAN/);
  assert.match(S, /\/ip firewall nat find comment="\$NP_TAG masquerade"\]\] = 0/);
  assert.match(S, /NAT masquerade already present \(no duplicate created\)/);
});





test("every required firewall rule is present", () => {
  for (const [what, re] of [
    ["established/related", /connection-state=established,related comment="\$NP_TAG established"/],
    ["invalid drop", /action=drop connection-state=invalid comment="\$NP_TAG invalid"/],
    ["WAN input protection", /chain=input action=drop in-interface-list=NETPID-WAN comment="\$NP_TAG wan-drop"/],
    ["LAN management", /chain=input action=accept in-interface=\$NP_LAN_BRIDGE comment="\$NP_TAG lan-accept"/],
    ["ICMP rate limit", /action=accept protocol=icmp limit=20,10 comment="\$NP_TAG icmp"/],
    ["RADIUS in", /dst-port=\$NP_RADIUS_AUTH,\$NP_RADIUS_ACCT src-address=\$NP_RADIUS_SERVER comment="\$NP_TAG radius-in"/],
    ["CoA in", /dst-port=\$NP_RADIUS_COA src-address=\$NP_RADIUS_SERVER comment="\$NP_TAG coa-in"/],
    ["WireGuard in", /dst-port=\$NP_WG_LISTEN in-interface-list=NETPID-WAN comment="\$NP_TAG wg-in"/],
  ]) {
    assert.match(S, re, `firewall rule missing: ${what}`);
  }
  // WireGuard must be accepted BEFORE the WAN drop or the tunnel never forms.
  assert.match(S, /comment="\$NP_TAG wg-in"[\s\S]{0,200}place-before=\[find comment="\$NP_TAG wan-drop"\]/,
    "the WireGuard rule is not placed before the WAN drop");
});

test("RADIUS source address is configurable and never emitted blank", () => {
  assert.match(S, /:global NP_RADIUS_SRC       ""/);
  assert.match(S, /:if \(\[:len \$NP_RADIUS_SRC\] > 0\)/);
  const withSrc = buildRouterosInstaller({ ...FULL, radiusSrcAddress: "10.90.0.2" });
  assert.match(withSrc, /set npRAcct \(" src-address=" \. \$NP_RADIUS_SRC\)/);
  assert.doesNotMatch(S, /src-address=""/);
});

test("the post-install backup is safe and bounded", () => {
  assert.match(S, /:global NP_BACKUP_ON         "yes"/);
  assert.match(S, /\/system\/backup\/save name=netpid-post-install/);
  assert.match(S, /on-error=/);
  // The script must not claim an external backup exists.
  assert.doesNotMatch(S, /scp |sftp |curl |wget /);
});

test("NEW and EXISTING modes both keep every safety guarantee", () => {
  const isNew = buildRouterosInstaller({ ...FULL, mode: "NEW" });
  const isExisting = buildRouterosInstaller({ ...FULL, mode: "EXISTING" });
  assert.match(isNew, /:global NP_MODE             "NEW"/);
  assert.match(isExisting, /:global NP_MODE             "EXISTING"/);
  // NEW takes ownership of the identity; EXISTING leaves a set name alone.
  assert.match(isNew, /if \(\$NP_MODE = "NEW"\) do=/);
  assert.match(isExisting, /identity kept/);
  for (const s of [isNew, isExisting]) {
    assert.doesNotMatch(s, /\/ip firewall filter remove/);
    assert.doesNotMatch(s, /\/interface bridge remove/);
    assert.doesNotMatch(s, /\/ip pool remove/);
    assert.doesNotMatch(s, /\/ppp profile remove/);
    assert.doesNotMatch(s, /\/ip address remove \[find\]$/m);
  }
});

test("the state model names PROVISIONED, CONNECTED, VERIFIED and ONLINE", () => {
  assert.match(S, /PROVISIONED = configuration was written to this router/);
  assert.match(S, /CONNECTED   = NETPID management transport is actually reachable/);
  assert.match(S, /VERIFIED    = NETPID successfully tested the service/);
  assert.match(S, /ONLINE      = every required health check passed/);
  assert.match(S, /ENROLLMENT STATE/);
  assert.match(S, /WIREGUARD ENROLLMENT REQUIRED/);
  // A last-handshake check is the only thing allowed to say CONNECTED.
  assert.match(S, /last-handshake-time/);
});

test("the password generator uses a valid 1-based index range", () => {
  // [:pick] and [:rndnum] are 1-based and inclusive. from=0 makes
  // [:pick $str 0] fail, which aborts the script before the user is created.
  assert.match(S, /:rndnum from=1 to=\$npLen/);
  assert.doesNotMatch(S, /:rndnum from=0/);
  assert.match(S, /:local npLen \[:len \$npChars\]/);
});

test("the certificate is signed by name, not by a bare token", () => {
  // A bare token is read as an internal id and matches nothing on RouterOS 7.
  assert.match(S, /:certificate sign \[find name=NETPID\]/);
  assert.doesNotMatch(S, /:certificate sign NETPID/);
});

test("no route is invented pointing the VPS at the router's own address", () => {
  // gateway=$NP_WG_ROUTER_IP is the router's OWN tunnel IP: such a route points
  // at itself and black-holes the management path. The peer's allowed-address
  // installs the correct route in the kernel.
  assert.doesNotMatch(S, /gateway=\$NP_WG_ROUTER_IP/);
  assert.match(S, /allowed-address=\$npAllowed/);
});



// ---------------------------------------------------------------------------
// RouterOS dialect. Every one of these was caught by a real hAP lite rejecting
// the script. None was caught by a generator unit test, because the generator
// is correct and the failures only exist on the router.
// ---------------------------------------------------------------------------

// Only EXECUTABLE lines are checked. Several of the constructs below are named
// in the comments that explain why they are banned - "[:pick] with a 0 start",
// ":continue" - so scanning raw text would flag the very documentation that
// records the fix.
function exec(script) {
  return script.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
}

test("no construct RouterOS actually rejects is emitted", () => {
  const E = exec(S);
  for (const [what, re] of [
    // [:pick] is 1-BASED. A 0 index returns nothing instead of erroring, which
    // made the version test abort on every router and print "RouterOS  detected".
    ["[:pick] with a 0 start", /\[:pick\s+\$[A-Za-z]+\s+0\b/],
    // A nested [:find] inside [:pick] arguments is a parse error.
    ["nested [:find] inside [:pick]", /\[:pick[^\n]*\[:find/],
    // [:pick] takes one or two indices. Three is "expected end of command".
    ["three-argument [:pick]", /\[:pick\s+\$[A-Za-z]+\s+\[:/],
    // RouterOS has no :continue.
    [":continue", /:continue\b/],
    // [:len /ip service find name=api] is missing its closing bracket.
    ["[:len with an unclosed menu", /\[:len\s+\/[a-z]/],
  ]) {
    const hit = E.find((l) => re.test(l));
    assert.equal(hit, undefined, `RouterOS rejects this (${what}): ${hit ?? ""}`);
  }
});

test("the installer stops cleanly when SECTION A was never run", () => {
  // The operator pasted from SECTION B. Every :global lives in SECTION A, so
  // every command below failed with a bare "expected end of command" that named
  // nothing. The script now proves SECTION A ran, and stops before changing
  // anything.
  assert.match(S, /SECTION 0 - PROOF THAT SECTION A RAN/);
  assert.match(S, /SECTION A did not run/);
  assert.match(S, /:error "NETPID: SECTION A did not run; nothing was changed"/);
  assert.match(S, /paste it from the VERY TOP, including/);
});

test("the version test cannot silently pass on a non-7.x router", () => {
  assert.match(S, /\[:find \$npVer "7\."\] < 0/);
  assert.doesNotMatch(S, /\[:pick \$npVer/);
  assert.match(S, /RouterOS .* confirmed\./);
});

test("pool ranges and the PPPoE local address are supplied, never derived", () => {
  // Deriving them needed 1-based [:pick] arithmetic that silently produced empty
  // values, and an empty range breaks every client on the LAN.
  assert.match(S, /:global NP_DHCP_RANGE       /);
  assert.match(S, /:global NP_HOTSPOT_RANGE    /);
  assert.match(S, /:global NP_PPPOE_LOCAL      /);
  assert.match(S, /ranges=\$NP_DHCP_RANGE/);
  assert.match(S, /local-address=\$npPppLocal/);
  assert.doesNotMatch(S, /\$npOct/);
  assert.doesNotMatch(S, /\$hOct/);
  assert.doesNotMatch(S, /\$npRange/);
});

test("the generated password uses a valid two-argument [:pick]", () => {
  assert.match(S, /:set npIdx \[:rndnum from=1 to=\$npLen\]/);
  assert.match(S, /\[:pick \$npChars \$npIdx\]/);
  assert.doesNotMatch(S, /\[:pick \$npChars \[:rndnum/);
});

test("LAN ports are filtered without :continue", () => {
  // RouterOS has no :continue, and the comment that documents this names it, so
  // the check is on executable lines only.
  assert.equal(exec(S).find((l) => /:continue\b/.test(l)), undefined);
  assert.match(S, /SKIP-EMPTY/);
});

test("every else branch actually opens", () => {
  // 28 "} else={" statements were being emitted as COMMENTS by an automated
  // pass, so no else branch in the whole installer ever opened and every else
  // body ran unconditionally - the SKIP branch printed even when the condition
  // was false. A brace-balanced script is not enough; each if must have its
  // own else emitted.
  const E = exec(S);
  const ifs = E.filter((l) => /^\s*:if\s*\(/.test(l) && /do=\{\s*$/.test(l)).length;
  const elses = E.filter((l) => /^\s*\} else=\{/.test(l)).length;
  // Some :if lines are single-line do={ ... } with no else. Every multi-line
  // :if that opens a block must be closed, and the closers must be statements.
  assert.ok(elses > 40, `only ${elses} else branches were emitted as statements`);
  // And none of them is a comment.
  assert.equal(S.split("\n").filter((l) => /^#\s*\} else=\{/.test(l)).length, 0,
    "an '} else={' was emitted as a comment, so that branch never opens");
  assert.ok(ifs > 40, `only ${ifs} block-opening :if statements found`);
});

test("the generated script is brace-balanced as RouterOS sees it", () => {
  // Pasted line by line, an unbalanced block leaves the terminal sitting in a
  // continuation prompt for the rest of the file.
  let depth = 0, min = 0;
  for (const raw of S.split("\n")) {
    const l = raw.trim();
    if (!l || l.startsWith("#")) continue;
    for (const ch of l) { if (ch === "{") depth++; if (ch === "}") depth--; }
    if (depth < min) min = depth;
  }
  assert.equal(depth, 0, `unclosed block remains (depth ${depth})`);
  assert.equal(min, 0, `a closing brace appears before its opening (depth ${min})`);
});

