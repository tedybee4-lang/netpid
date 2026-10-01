// RouterOS provisioning script: the rate pair is upload-first, everywhere.
// A reversed pair is the difference between a 5 Mbps up / 20 Mbps down customer
// and one who gets 5 Mbps down, so it is pinned by test rather than by review.
import test from "node:test";
import assert from "node:assert/strict";

import { buildCustomerQueue, buildRouterosSetup, normalizeRosVersion, ratePair, rosName, rosPaths, rosQuote } from "../src/routeros.mjs";

// --- RouterOS 6 vs 7 -------------------------------------------------------
// These pin the menu paths that MOVED between majors. A script that emits the
// wrong path does not error — it silently configures nothing, which is exactly
// the failure this suite exists to prevent.

// --- What a real router actually rejected ----------------------------------
// These three were found by pasting the generated script into a live
// hAP lite running RouterOS 7.21.5, not by reading the source. The router
// answered "expected end of command" and "bad command name radius", and the
// RADIUS server was never created, so PPPoE authenticated against nothing.

test("a colon in a value is quoted, or the router aborts the line", () => {
  // RouterOS ends an unquoted value at a colon. The NETPID tag is full of them.
  assert.equal(rosQuote("NETPID:netpid-TEVENN"), '"NETPID:netpid-TEVENN"');
  assert.equal(rosQuote("a:b:c"), '"a:b:c"');
  // Values with no colon stay bare, so ordinary output is not churned.
  assert.equal(rosQuote("netpid-TEVENN"), "netpid-TEVENN");
  assert.equal(rosQuote("1.1.1.1"), "1.1.1.1");
  assert.equal(rosQuote(""), '""');
});

test("the RADIUS server line survives a paste on a v7 router", () => {
  const s = buildRouterosSetup({
    shortname: "TEVENN", radiusServer: "87.76.137.72", secret: "s3cr3t", rosVersion: "7",
  });

  // v7 moved RADIUS out of /ip. /ip/radius is "bad command name radius" on 7.x.
  assert.match(s, /^\/radius add service=ppp,hotspot address=87\.76\.137\.72 /m);
  assert.doesNotMatch(s, /\/ip\/radius/, "the RouterOS 6 path must not appear in a v7 script");
  assert.doesNotMatch(s, /\/ip radius/, "the RouterOS 6 path must not appear in a v7 script");

  // The property names are authentication-port / accounting-port. auth-port and
  // acct-port do not exist and the whole line is rejected.
  assert.match(s, /authentication-port=1812/);
  assert.match(s, /accounting-port=1813/);
  assert.doesNotMatch(s, /\bauth-port=/);
  assert.doesNotMatch(s, /\bacct-port=/);

  // Every command must have its tag quoted.
  assert.match(s, /comment="NETPID:TEVENN"/);
  assert.doesNotMatch(s, /comment=NETPID:/, "an unquoted colon aborts the line");
});

test("v6 still uses the v6 RADIUS path, because 6.x has no top-level /radius", () => {
  const s = buildRouterosSetup({
    shortname: "core", radiusServer: "10.0.0.5", secret: "x", rosVersion: "6",
  });
  assert.match(s, /\/ip radius add service=ppp,hotspot/);
  assert.doesNotMatch(s, /^\/radius add/m);
});

test("CoA needs a firewall rule, or disconnect from the dashboard does nothing", () => {
  // accept=yes alone leaves the listener behind the default input policy, so
  // every Disconnect-Request is dropped before it is parsed.
  const s = buildRouterosSetup({
    shortname: "TEVENN", radiusServer: "87.76.137.72", secret: "s3cr3t",
    rosVersion: "7", routerIp: "10.10.10.2",
  });
  assert.match(s, /\/radius incoming set accept=yes port=3799/);
  assert.match(s, /\/ip\/firewall\/filter add chain=input action=accept protocol=udp dst-port=3799/);
  // Scoped to the RADIUS server, not open to the internet.
  assert.match(s, /dst-port=3799 src-address=87\.76\.137\.72/);
  assert.match(s, /comment="NETPID:coa:TEVENN"/);
});

test("a section with nothing to configure is not announced", () => {
  // With no hotspot profiles the old script printed the header and no commands,
  // which reads as "this half failed" on a terminal.
  const s = buildRouterosSetup({
    shortname: "TEVENN", radiusServer: "10.0.0.5", secret: "x", rosVersion: "7",
  });
  assert.doesNotMatch(s, /5\. HotSpot/);

  const withHotspot = buildRouterosSetup({
    shortname: "TEVENN", radiusServer: "10.0.0.5", secret: "x", rosVersion: "7",
    profiles: [{ name: "hs", kind: "hotspot", download_kbps: 5000, upload_kbps: 1000 }],
  });
  assert.match(withHotspot, /5\. HotSpot/);
  assert.match(withHotspot, /\/ip hotspot profile set \[find name=hs\] use-radius=yes/);
});

test("verify block uses paths that exist on the target version", () => {
  const v7 = buildRouterosSetup({ shortname: "a", radiusServer: "10.0.0.5", secret: "x", rosVersion: "7" });
  assert.match(v7, /^\/radius print$/m);
  assert.doesNotMatch(v7, /^\/ip\/radius print$/m);
  const v6 = buildRouterosSetup({ shortname: "a", radiusServer: "10.0.0.5", secret: "x", rosVersion: "6" });
  assert.match(v6, /^\/ip radius print$/m);
});

test("normalizeRosVersion accepts the shapes an operator actually types", () => {
  assert.equal(normalizeRosVersion("6"), "6");
  assert.equal(normalizeRosVersion("6.49.10"), "6");
  assert.equal(normalizeRosVersion("6.x"), "6");
  assert.equal(normalizeRosVersion(6), "6");
  assert.equal(normalizeRosVersion("7"), "7");
  assert.equal(normalizeRosVersion("7.14.3"), "7");
  assert.equal(normalizeRosVersion(""), "7", "an unprobed router defaults to v7");
  assert.equal(normalizeRosVersion("banana"), "7", "never emits a broken version");
});

test("v6 and v7 use the correct radio menu and interface name", () => {
  const opts = { shortname: "core", radiusServer: "10.0.0.5", secret: "x", wifiSsid: "Lipanet" };

  const v6 = buildRouterosSetup({ ...opts, rosVersion: "6" });
  assert.match(v6, /RouterOS 6/);
  assert.match(v6, /\/interface wireless set \[find name=wlan1\]/);
  assert.doesNotMatch(v6, /\/interface wifi /, "v6 has no /interface/wifi menu");

  const v7 = buildRouterosSetup({ ...opts, rosVersion: "7" });
  assert.match(v7, /RouterOS 7/);
  assert.match(v7, /\/interface wifi set \[find name=wifi1\]/);
  assert.doesNotMatch(v7, /\/interface wireless set/,
    "7.14+ wifiwave2 replaced /interface/wireless");
});

test("HotSpot cookie hardening is v7-only", () => {
  const base = { shortname: "core", radiusServer: "10.0.0.5", secret: "x",
    profiles: [{ name: "hs", kind: "hotspot", download_kbps: 5000, upload_kbps: 1000 }] };
  assert.match(buildRouterosSetup({ ...base, rosVersion: "7" }), /http-cookie-httponly=yes/);
  assert.doesNotMatch(buildRouterosSetup({ ...base, rosVersion: "6" }), /http-cookie-httponly/,
    "6.x refuses this property — emitting it would abort the paste");
});

test("both versions open the API and set identity, clock, DNS and NTP", () => {
  for (const v of ["6", "7"]) {
    const s = buildRouterosSetup({ shortname: "core", radiusServer: "10.0.0.5",
      secret: "x", identity: "Nairobi Core", rosVersion: v });
    assert.match(s, /\/system identity set name="Nairobi Core"/);
    assert.match(s, /\/system clock set time-zone-name=Africa\/Nairobi/);
    assert.match(s, /\/ip dns set servers=1\.1\.1\.1/);
    assert.match(s, /\/system ntp client set enabled=yes/);
    assert.match(s, /\/ip service set api disabled=no port=8728/);
    assert.match(s, /\/ip service set api-ssl disabled=no port=8729/);
  }
});

test("an SSID is only touched when the ISP supplied one", () => {
  const no = buildRouterosSetup({ shortname: "core", radiusServer: "10.0.0.5", secret: "x" });
  assert.doesNotMatch(no, /mode=ap-bridge/, "never guess at a bridge layout");
  const yes = buildRouterosSetup({ shortname: "core", radiusServer: "10.0.0.5",
    secret: "x", wifiSsid: "Lipanet" });
  assert.match(yes, /mode=ap-bridge country=Kenya/);
});

test("the DHCP lease path is exposed per version", () => {
  assert.equal(rosPaths("6").dhcpLease, "/ip/dhcp-server lease");
  assert.equal(rosPaths("7").dhcpLease, "/ip/dhcp-server/lease");
});

test("ratePair is UPLOAD first, then download", () => {
  assert.equal(ratePair(512, 5120), "512k/5120k");
  assert.equal(ratePair(5000, 20000), "5000k/20000k");
});

test("a zero side mirrors the other side instead of writing 0k", () => {
  assert.equal(ratePair(0, 5120), "5120k/5120k");
  assert.equal(ratePair(512, 0), "512k/512k");
  assert.equal(ratePair(0, 0), null);
  assert.equal(ratePair(null, null), null);
  assert.equal(ratePair(-5, 100), "100k/100k", "negative speeds are clamped, never emitted");
});

test("ratePair agrees with the RADIUS path (formatRateLimit)", async () => {
  const { formatRateLimit } = await import("../src/radius-logic.js");
  for (const [up, down] of [[512, 5120], [0, 5120], [1000, 0], [2048, 2048]]) {
    assert.equal(ratePair(up, down), formatRateLimit(up, down),
      `router queue and RADIUS attribute must never disagree for up=${up} down=${down}`);
  }
});

test("quoting keeps ordinary tokens bare and escapes the rest", () => {
  assert.equal(rosQuote("196.201.214.10"), "196.201.214.10");
  assert.equal(rosQuote("Nairobi Core 1"), '"Nairobi Core 1"');
  assert.equal(rosQuote('bad"name'), '"bad\\"name"');
});

test("names are sanitised for RouterOS and never empty", () => {
  assert.equal(rosName("Nairobi Core 1"), "Nairobi-Core-1");
  assert.equal(rosName("///"), "netpid");
  assert.equal(rosName(""), "netpid");
  assert.equal(rosName("", "core-nas"), "core-nas", "an explicit fallback is honoured");
});

test("setup script wires RADIUS, PPPoE, HotSpot and CoA", () => {
  const s = buildRouterosSetup({
    shortname: "nairobi-core-1",
    radiusServer: "10.0.0.5",
    secret: "s3cr3t",
    routerIp: "196.201.214.10",
    identity: "nairobi-core-1",
  });
  assert.match(s, /\/radius add service=ppp,hotspot address=10\.0\.0\.5 secret=s3cr3t/);
  assert.match(s, /authentication-port=1812 accounting-port=1813/);
  assert.match(s, /src-address=196\.201\.214\.10/);
  assert.match(s, /\/ppp aaa set use-radius=yes accounting=yes/);
  assert.match(s, /\/radius incoming set accept=yes port=3799/);
  // Secret must appear in the generated script — that is the whole point — but
  // the script is an output artefact, never stored server-side in clear.
  assert.ok(s.includes("s3cr3t"));
});

test("profile queues carry the same upload/download pair as RADIUS", () => {
  const s = buildRouterosSetup({
    shortname: "core", radiusServer: "10.0.0.5", secret: "x",
    profiles: [
      { name: "pppoe-20m", kind: "pppoe", pool: "10.10.0.2-10.10.0.254",
        download_kbps: 20000, upload_kbps: 5000 },
      { name: "hotspot-5m", kind: "hotspot", download_kbps: 5000, upload_kbps: 1000 },
    ],
  });
  assert.match(s, /remote-address=10\.10\.0\.2-10\.10\.0\.254/);
  assert.match(s, /rate-limit=5000k\/20000k/, "PPPoE profile caps 5M up / 20M down");
  assert.match(s, /max-limit=1000k\/5000k/, "hotspot queue caps 1M up / 5M down");
});

test("a profile with no cap produces no queue line", () => {
  const s = buildRouterosSetup({
    shortname: "core", radiusServer: "10.0.0.5", secret: "x",
    profiles: [{ name: "uncapped", kind: "pppoe", download_kbps: 0, upload_kbps: 0 }],
  });
  assert.equal(s.includes("/queue simple add"), false);
});

test("customer queue targets a framed IP when known, else the username", () => {
  const withIp = buildCustomerQueue({ username: "brian", framed_ip: "10.10.0.5",
    download_kbps: 20480, upload_kbps: 5120 });
  assert.match(withIp, /max-limit=5120k\/20480k/);
  assert.match(withIp, /target=10\.10\.0\.5\/32/);

  const byName = buildCustomerQueue({ username: "brian",
    download_kbps: 20480, upload_kbps: 5120 });
  assert.match(byName, /target=\[find name=brian\]/);

  assert.equal(buildCustomerQueue({ username: "brian", download_kbps: 0, upload_kbps: 0 }), null,
    "never write a queue that would leave the customer uncapped");
});
