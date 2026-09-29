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
  assert.match(s, /auth-port=1812 acct-port=1813/);
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
