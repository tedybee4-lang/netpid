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
  assert.match(S, /npMajor != "7"/, "must gate on the major version before touching anything");
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
  assert.match(S, /:global NP_WG_SERVER_PUB    ""/);
  assert.doesNotMatch(S, /NP_WG_SERVER_PUB\s+"[A-Za-z0-9+/]{43}="/);
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
  assert.match(s, /:global NP_WG_SERVER_PUB    ""/);
  assert.doesNotMatch(s, /NP_WG_SERVER_PUB\s+"[A-Za-z0-9+/]{43}="/);
});

// ---------------------------------------------------------------------------
// Completeness. Each of these proves one provisioning section is present, so a
// future edit that drops a section fails here rather than on a live router.
// ---------------------------------------------------------------------------

test("the installer refuses to generate a complete script with missing input", () => {
  // The whole point of the task: a half-configured .rsc must not be emittable.
  assert.throws(() => buildRouterosInstaller({}), /refusing to generate a complete/);
  assert.throws(() => buildRouterosInstaller({ ...FULL, radiusSecret: "" }), /RADIUS shared secret/);
  assert.throws(() => buildRouterosInstaller({ ...FULL, identity: "" }), /router identity/);
  assert.throws(() => buildRouterosInstaller({ ...FULL, nasShortname: "" }), /NAS shortname/);
  // A partial script is possible, but only when explicitly requested.
  assert.doesNotThrow(() => buildRouterosInstaller({ identity: "X" }, { strict: false }));
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
  assert.match(S, /\/ip pool add name=\$NP_DHCP_POOL ranges=\$npRange/);
  assert.match(S, /\/ip dhcp-server add name=\$NP_TAG interface=\$NP_LAN_BRIDGE/);
  assert.match(S, /\/ip dhcp-server network add address=\$npNet gateway=\$NP_LAN_GATEWAY dns-server=\$NP_DNS_SERVERS/);
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

