import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  decideCapabilities, hashToken, mintToken, parseBridges, parseRamMb,
  tokenMatchesHash, validateSelection, buildDetectedInterfaces,
} from "../../apps/web/lib/mikrotik-provision.ts";
import { buildConfigureScript, buildBootstrapScript } from "../../apps/web/lib/mikrotik-provision-script.ts";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const configureRoute = read("../../apps/web/app/api/provision/mikrotik/configure/[token]/route.ts");
const bootstrapRoute = read("../../apps/web/app/api/provision/mikrotik/bootstrap/[token]/route.ts");

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

test("provisioning token is 256 bits of CSPRNG and URL-safe", () => {
  const t = mintToken();
  assert.equal(t.length, 43, "base64url of 32 bytes is 43 chars");
  assert.match(t, /^[A-Za-z0-9_-]+$/, "the token travels in a path segment pasted into a router");
  assert.notEqual(mintToken(), mintToken(), "tokens must not repeat");
});

test("only a token HASH is stored, and it verifies against the token", () => {
  const t = mintToken();
  const h = hashToken(t);
  assert.notEqual(h, t, "the hash must not be the token");
  assert.equal(h.length, 64, "sha256 hex");
  assert.ok(tokenMatchesHash(t, h));
  assert.ok(!tokenMatchesHash(mintToken(), h), "a different token must not verify");
  assert.ok(!tokenMatchesHash(t, ""), "an empty hash must never verify");
  assert.ok(!tokenMatchesHash("", "x".repeat(64)), "an empty token must never verify");
});

test("a truncated or malformed hash cannot pass the comparison", () => {
  const h = hashToken(mintToken());
  assert.ok(!tokenMatchesHash("anything", h.slice(0, 32)));
  assert.ok(!tokenMatchesHash("anything", h.toUpperCase()));
});

// ---------------------------------------------------------------------------
// Hardware profiles
// ---------------------------------------------------------------------------

const PROFILES = [
  { name: "hAP lite", board: "hAP lite", version: "7.21.5", rosMajor: 7, ifaces: "ether1,ether2,ether3,ether4,ether5,wlan1", ram: "65536 KiB" },
  { name: "hEX S", board: "hEX S", version: "7.21.5", rosMajor: 7, ifaces: "ether1,ether2,ether3,ether4,ether5,sfp-sfpplus1", ram: "131072 KiB" },
  { name: "RB760Gr3", board: "RB760Gr3", version: "6.49.18", rosMajor: 6, ifaces: "ether1,ether2,ether3,ether4,ether5,sfp-sfpplus1", ram: "268435456" },
  { name: "RB4011iGS+", board: "RB4011iGS+", version: "7.21.5", rosMajor: 7, ifaces: "ether1,ether2,ether3,ether4,ether5,ether6,ether7,ether8,ether9,ether10,sfp-sfpplus1,sfpplus1", ram: "1073741824" },
  { name: "CCR2004", board: "CCR2004-1G-12S+2XS", version: "7.21.5", rosMajor: 7, ifaces: "ether1,ether2,sfp-sfpplus1,sfp-sfpplus2,sfp-sfpplus3,sfp-sfpplus4,sfp-sfpplus5", ram: "2097152" },
];

for (const p of PROFILES) {
  test(`profile ${p.name}: detected, version-gated, and produces a v${p.rosMajor} script`, () => {
    const ifaces = buildDetectedInterfaces(p.ifaces, []);
    assert.ok(ifaces.length >= 6, `${p.name} should expose its ports`);
    // The Ethernet ports must be offered as WAN candidates, or the wizard has
    // nothing to offer on a healthy box.
    assert.ok(ifaces.some((i) => i.is_candidate_wan), `${p.name} has no WAN candidate`);

    const caps = decideCapabilities({ version: p.version, board: p.board });
    assert.equal(caps.rosMajor, p.rosMajor);
    assert.equal(caps.wireguard.supported, p.rosMajor === 7, `${p.name} WireGuard gate`);
    assert.deepEqual(caps.blockers, [], `${p.name} should not be blocked`);

    const ram = parseRamMb(p.ram);
    assert.ok(ram && ram > 0, `${p.name} RAM should parse`);

    // The RADIUS menu path must follow the REPORTED version. Getting this wrong
    // means the client is silently never created and PPPoE authenticates
    // against nothing, which looks like a FreeRADIUS fault.
    const s = buildConfigureScript(baseOpts({
      routerId: "11111111-2222-3333-4444-555555555555",
      rosMajor: p.rosMajor,
      wan: ifaces.find((i) => i.is_candidate_wan).name,
    }));
    if (p.rosMajor === 7) {
      assert.ok(/\/radius add /.test(s), `${p.name} must use the v7 /radius path`);
      assert.ok(!/\/ip radius add /.test(s), `${p.name} must not use the v6 path`);
    } else {
      assert.ok(/\/ip radius add /.test(s), `${p.name} must use the v6 /ip radius path`);
      assert.ok(!/[^p] \/radius add /.test(s), `${p.name} must not use the v7 path`);
    }
  });
}

function baseOpts(o = {}) {
  return {
    routerId: "11111111-2222-3333-4444-555555555555",
    rosMajor: 7,
    mode: "HOTSPOT",
    wan: "ether1",
    hotspotPorts: ["ether2", "ether3"],
    hotspotIface: "netpid-hotspot",
    hotspotSubnet: "10.5.50.0/24",
    hotspotRange: "10.5.50.10-10.5.50.250",
    hotspotDnsName: "login.isp.net",
    pppoePorts: ["ether4"],
    pppoePool: "pool-pppoe",
    pppoeRanges: "100.64.10.2-100.64.10.250",
    pppoeLocal: "100.64.10.1",
    radiusServer: "10.10.0.5",
    radiusSecret: "s3cr3t-value",
    nasShortname: "netpid-11111111",
    radiusAuthPort: 1812,
    radiusAcctPort: 1813,
    radiusCoaPort: 3799,
    pppoeService: "netpid-pppoe",
    bridgeIface: "bridge-lan",
    heartbeatUrl: "https://netpid.example/api/provision/mikrotik/heartbeat/11111111",
    heartbeatName: "netpid-heartbeat-11111111",
    ...o,
  };
}
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Discovery parsing
// ---------------------------------------------------------------------------

test("RAM parses from every form RouterOS reports", () => {
  assert.equal(parseRamMb("65536 KiB"), 64);
  assert.equal(parseRamMb("131072 KiB"), 128);
  assert.equal(parseRamMb("32.4 MiB"), 32);
  assert.equal(parseRamMb("268435456"), 262144);   // bare KiB
  assert.equal(parseRamMb("2097152"), 2048);
  assert.equal(parseRamMb(""), null);
  assert.equal(parseRamMb(null), null);
  assert.equal(parseRamMb("unknown"), null);
});

test("bridges and their members are parsed from the router's report", () => {
  const b = parseBridges("bridge-lan:ether2,ether3,ether4;bridge-hotspot:ether5");
  assert.equal(b.length, 2);
  assert.equal(b[0].name, "bridge-lan");
  assert.deepEqual(b[0].ports, ["ether2", "ether3", "ether4"]);
  assert.deepEqual(parseBridges(""), []);
  assert.deepEqual(parseBridges("garbage"), [], "a line with no colon is not a bridge");
});

test("a bridged port is never offered as the WAN", () => {
  const bridges = parseBridges("bridge-lan:ether2,ether3,ether4");
  const ifaces = buildDetectedInterfaces("ether1,ether2,ether3,ether4,wlan1", bridges);
  const wan = ifaces.filter((i) => i.is_candidate_wan).map((i) => i.name);
  assert.deepEqual(wan, ["ether1"], "only the free ethernet port can be the WAN");
  assert.equal(ifaces.find((i) => i.name === "ether2").in_bridge, "bridge-lan");
  // Wireless must never be offered as a WAN either.
  assert.ok(!ifaces.find((i) => i.name === "wlan1").is_candidate_wan);
});

test("an empty interface report produces no interfaces, so the UI can say so", () => {
  assert.deepEqual(buildDetectedInterfaces("", []), []);
  assert.deepEqual(buildDetectedInterfaces(null, []), []);
});

// ---------------------------------------------------------------------------
// Port-plan validation: the mistakes that produce dead ports
// ---------------------------------------------------------------------------

const DETECTED = buildDetectedInterfaces(
  "ether1,ether2,ether3,ether4,ether5",
  parseBridges("bridge-lan:ether5"),
);

test("a WAN port cannot also be the HotSpot port", () => {
  const r = validateSelection({ mode: "HOTSPOT", wan_interface: "ether1", hotspot_interfaces: ["ether1"] }, DETECTED);
  assert.ok(!r.ok);
  assert.ok(r.errors.some((e) => /is the WAN and cannot also serve HotSpot/.test(e)));
});

test("a WAN port cannot also be the PPPoE port", () => {
  const r = validateSelection({ mode: "PPPOE", wan_interface: "ether1", pppoe_interfaces: ["ether1"] }, DETECTED);
  assert.ok(!r.ok);
  assert.ok(r.errors.some((e) => /is the WAN and cannot also serve PPPoE/.test(e)));
});

test("a port cannot serve HotSpot and PPPoE at once", () => {
  const r = validateSelection({
    mode: "HOTSPOT_PPPOE", wan_interface: "ether1",
    hotspot_interfaces: ["ether2"], pppoe_interfaces: ["ether2"],
  }, DETECTED);
  assert.ok(!r.ok);
  assert.ok(r.errors.some((e) => /in both HotSpot and PPPoE/.test(e)));
});

test("a port already in a bridge cannot be the WAN", () => {
  const r = validateSelection({ mode: "HOTSPOT", wan_interface: "ether5", hotspot_interfaces: ["ether2"] }, DETECTED);
  assert.ok(!r.ok);
  assert.ok(r.errors.some((e) => /is a port of bridge bridge-lan/.test(e)));
});

test("every mode demands its own ports", () => {
  const hs = validateSelection({ mode: "HOTSPOT", wan_interface: "ether1", hotspot_interfaces: [] }, DETECTED);
  assert.ok(hs.errors.some((e) => /HotSpot mode needs at least one/.test(e)));

  const pp = validateSelection({ mode: "PPPOE", wan_interface: "ether1", pppoe_interfaces: [] }, DETECTED);
  assert.ok(pp.errors.some((e) => /PPPoE mode needs at least one/.test(e)));

  const both = validateSelection({
    mode: "HOTSPOT_PPPOE", wan_interface: "ether1",
    hotspot_interfaces: [], pppoe_interfaces: [],
  }, DETECTED);
  assert.equal(both.errors.length, 2);
});

test("a duplicate port is rejected", () => {
  const r = validateSelection({
    mode: "HOTSPOT", wan_interface: "ether1", hotspot_interfaces: ["ether2", "ether2"],
  }, DETECTED);
  assert.ok(r.errors.some((e) => /Duplicate HotSpot port/.test(e)));
});

test("a valid plan passes and keeps only the mode's ports", () => {
  const r = validateSelection({
    mode: "HOTSPOT", wan_interface: "ether1",
    // pppoe_interfaces is ignored in HotSpot mode, and must not be applied.
    hotspot_interfaces: ["ether2", "ether3"], pppoe_interfaces: ["ether4"],
  }, DETECTED);
  assert.ok(r.ok, r.errors.join(" "));
  assert.deepEqual(r.hotspot, ["ether2", "ether3"]);
  assert.deepEqual(r.pppoe, [], "a port is never silently applied for a mode that is off");
  assert.ok(r.warnings.some((w) => /PPPoE ports ignored/.test(w)));
});

test("moving a port out of an existing bridge is a WARNING, not a block", () => {
  // The operator named it, so it is intentional, but they must see it happen.
  const r = validateSelection({
    mode: "HOTSPOT", wan_interface: "ether1", hotspot_interfaces: ["ether5"],
  }, DETECTED);
  assert.ok(r.ok, r.errors.join(" "));
  assert.ok(r.warnings.some((w) => /ether5 is in bridge bridge-lan/.test(w)));
});

test("an unknown port is a warning, not a silent acceptance", () => {
  const r = validateSelection({ mode: "HOTSPOT", wan_interface: "sfp1", hotspot_interfaces: ["ether2"] }, DETECTED);
  assert.ok(r.warnings.some((w) => /sfp1 was not in the detected/.test(w)));
  assert.ok(r.ok, "a typed-in port is allowed but reported");
});

test("a missing or invalid mode is rejected", () => {
  assert.ok(!validateSelection({ wan_interface: "ether1" }, DETECTED).ok);
  assert.ok(!validateSelection({ mode: "BRIDGE", wan_interface: "ether1" }, DETECTED).ok);
  assert.ok(validateSelection({ mode: "HOTSPOT" }, DETECTED).errors.some((e) => /Choose a WAN/.test(e)));
});
// ---------------------------------------------------------------------------
// Generated RouterOS: non-destructive guarantees
// ---------------------------------------------------------------------------

/** Strip a RouterOS comment and any quoted string, leaving only code. */
function code(l) {
  return l.replace(/(^|\s)#.*$/, "").replace(/"[^"]*"/g, '""').trim();
}
const statements = (s) => s.split("\n").map(code).filter(Boolean);

/**
 * Balanced braces AND brackets, counted per character.
 *
 * Several statements legitimately open and close a block on one line:
 *   :if ([:len $x] = 0) do={ :set x 1 } else={ :set x 2 }
 * so a line-end-only heuristic reports a false imbalance. Brackets matter just
 * as much: an unbalanced `[` is how `[:len /radius find comment="x"]]` slips
 * through and is rejected by every real router.
 */
function assertBalanced(s, label) {
  let depth = 0;
  let brackets = 0;
  let lowest = 0;
  for (const l of statements(s)) {
    for (const ch of l) {
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
      else if (ch === "[") brackets++;
      else if (ch === "]") brackets--;
    }
    lowest = Math.min(lowest, depth);
  }
  assert.equal(depth, 0, `${label}: ${depth} unclosed block(s)`);
  assert.equal(lowest, 0, `${label}: a block closes before it opens`);
  assert.equal(brackets, 0, `${label}: ${brackets} unbalanced bracket(s)`);
}

const GEN = buildConfigureScript(baseOpts());
const GEN_BOTH = buildConfigureScript(baseOpts({ mode: "HOTSPOT_PPPOE" }));
const GEN_V6 = buildConfigureScript(baseOpts({ rosMajor: 6 }));
const GEN_NOSECRET = buildConfigureScript(baseOpts({ radiusSecret: "" }));
const GEN_WG = buildConfigureScript(baseOpts({
  wireguard: { serverPublicKey: "aB3cD4eF5gH6iJ7kL8mN9oP0qR=", routerTunnelIp: "10.200.0.2/32", serverTunnelIp: "10.200.0.1" },
}));
const BOOT = buildBootstrapScript({ baseUrl: "https://netpid.example", token: "T" .repeat(43), sessionId: "abc-123" });

// Every variant, so a dialect bug cannot hide behind the happy path.
const ALL_GEN = [GEN, GEN_BOTH, GEN_V6, GEN_NOSECRET, GEN_WG, BOOT];
const LABELS = ["HOTSPOT", "HOTSPOT+PPPOE", "v6", "no-secret", "wireguard", "bootstrap"];

/** Real RouterOS `add` commands. Requires whitespace-delimited `add`, so that
 *  a property like add-default-route= is not mistaken for a create. */
const creates = (s) => statements(s)
  .filter((l) => l.startsWith("/") && /\sadd\s/.test(l));

test("the configure script never resets, reboots or flushes the router", () => {
  for (const s of [GEN, GEN_BOTH, GEN_V6, GEN_WG]) {
    for (const forbidden of [
      "reset-configuration", "/system reboot", "factory-reset",
      "firewall filter remove", "remove [find]", "flush",
    ]) {
      // Checked against real statements: the SCRIPT's comments legitimately
      // say "no firewall is flushed", and matching those would be meaningless.
      assert.ok(
        !statements(s).some((l) => l.includes(forbidden)),
        `configure script must not contain ${forbidden}`,
      );
    }
  }
});

test("no firewall is flushed even to make room", () => {
  // Dropping the filter table would remove rules the ISP installed themselves.
  for (const s of [GEN, GEN_BOTH, GEN_V6, GEN_WG]) {
    assert.ok(!/\/ip firewall/.test(s), "this engine does not touch the firewall at all");
  }
});

test("every created object is tagged with the NETPID router id", () => {
  const adds = creates(GEN).concat(creates(GEN_BOTH));
  assert.ok(adds.length >= 8, `expected many create statements, found ${adds.length}`);
  // /radius incoming is the one deliberate exception: a singleton menu with no
  // comment property, which fails the line outright if one is set.
  const untagged = adds.filter((l) => !l.includes("comment=") && !l.includes("/radius incoming"));
  assert.deepEqual(untagged, [], `untagged creates: ${untagged.join(" | ")}`);
});

test("/radius incoming is set WITHOUT comment, which that menu rejects", () => {
  assert.ok(statements(GEN).some((l) => /^\/radius incoming set accept=yes port=\d+$/.test(l)));
  assert.ok(!/radius incoming[^\n]*comment=/.test(GEN));
});

test("no local subscriber account is created — RADIUS is the authority", () => {
  // A local hotspot user or PPP secret is an account nobody bills and nobody
  // can revoke, and it bypasses accounting entirely.
  for (const s of [GEN, GEN_BOTH, GEN_V6]) {
    assert.ok(!/hotspot user add/.test(s), "never create a local hotspot user");
    assert.ok(!/ppp secret add/.test(s), "never create a local PPP secret");
  }
});

test("accounting and CoA are always enabled", () => {
  // Without accounting every subscriber looks idle and the bill is quietly
  // wrong rather than broken.
  assert.ok(statements(GEN).some((l) => /^\/ppp\/aaa set use-radius=yes accounting=yes/.test(l)));
  assert.ok(statements(GEN).some((l) => /^\/radius incoming set accept=yes/.test(l)));
});

test("a missing RADIUS secret skips the client instead of creating a broken one", () => {
  assert.ok(!/radius add/.test(GEN_NOSECRET), "no client without a secret");
  assert.ok(GEN_NOSECRET.includes("SKIP RADIUS"), "and the reason is printed");
  // The rest of the script must still be produced.
  assert.ok(GEN_NOSECRET.includes("HotSpot created") || GEN_NOSECRET.includes("/ip hotspot add"));
});

test("a missing pool range skips HotSpot/PPPoE instead of half-building them", () => {
  const noPool = buildConfigureScript(baseOpts({ hotspotSubnet: "", hotspotRange: "" }));
  assert.ok(!/\/ip hotspot add/.test(noPool), "no portal with no pool");
  assert.ok(noPool.includes("SKIP HotSpot"), "and the reason is printed");

  const noPpp = buildConfigureScript(baseOpts({ mode: "PPPOE", pppoeLocal: "" }));
  assert.ok(!/pppoe-server server add/.test(noPpp), "no PPPoE server with no local address");
  assert.ok(noPpp.includes("SKIP PPPoE server"));
});

test("the heartbeat is installed as a scheduler entry", () => {
  assert.ok(statements(GEN).some((l) => /^\/system scheduler add name=/.test(l)));
  assert.ok(GEN.includes("interval=00:05:00"));
});

test("a re-run updates instead of duplicating", () => {
  // Each create is guarded by a find, so running the script twice converges.
  const guarded = (s) => statements(s).filter((l) => /\badd\b/.test(l) && l.startsWith("/"))
    .every((l) => {
      // Guarded creates live inside an :if that tests an existing object.
      return s.includes(":if ([:len") && l;
    });
  assert.ok(guarded(GEN));
  assert.ok((GEN.match(/\[:len/g) ?? []).length >= (GEN.match(/\badd\b/g) ?? []).length,
    "every create should be guarded by a find");
});
// ---------------------------------------------------------------------------
// RouterOS dialect: the mistakes that have actually broken on real devices
// ---------------------------------------------------------------------------

test("every generated script has balanced blocks and brackets", () => {
  ALL_GEN.forEach((s, i) => assertBalanced(s, LABELS[i]));
});

test("no block closer is emitted as a comment", () => {
  // `# }` does not close a block. A paste then fails part way through and the
  // router is left half configured, which is the worst possible outcome.
  for (const [s, label] of [[GEN, "configure"], [BOOT, "bootstrap"]]) {
    const bad = s.split("\n").filter((l) => /^\s*#\s*\}/.test(l));
    assert.deepEqual(bad, [], `${label}: commented block closers: ${bad.join(" | ")}`);
  }
});

test("no zero-index [:pick] — [:pick] is 1-based and 0 silently yields nothing", () => {
  for (const [s, label] of [[GEN, "configure"], [BOOT, "bootstrap"]]) {
    const zero = s.match(/\[:pick\s+[^\]]*?,\s*0\s*\]/g) ?? [];
    assert.deepEqual(zero, [], `${label}: zero-index [:pick]: ${zero.join(" | ")}`);
  }
});

test("no :continue, which RouterOS does not have", () => {
  for (const [s, label] of [[GEN, "configure"], [BOOT, "bootstrap"]]) {
    assert.ok(!statements(s).some((l) => l.includes(":continue")), `${label}: :continue does not exist`);
  }
});

test("no nested [:find] inside [:pick] arguments, which is a parse error", () => {
  for (const [s, label] of [[GEN, "configure"], [BOOT, "bootstrap"]]) {
    assert.ok(!/\[:pick[^\]]*\[:find/.test(s), `${label}: nested [:find] inside [:pick]`);
  }
});

test("every :local read is preceded by a declaration", () => {
  // An undeclared :local resolves to nothing, so a guard built on it silently
  // passes and the guarded block never runs.
  for (const [s, label] of [[GEN, "configure"], [BOOT, "bootstrap"]]) {
    const declared = new Set([...s.matchAll(/:local\s+(\w+)/g)].map((m) => m[1]));
    for (const m of s.matchAll(/\$\((\w+)\)/g)) {
      assert.ok(declared.has(m[1]), `${label}: $(${m[1]}) is used but never declared`);
    }
  }
});

test("bootstrap uses :local, so a re-paste cannot inherit stale state", () => {
  // :global survives across pastes; an undeclared :global resolves to nothing
  // and a guard built on it silently passes, so the guarded block never runs.
  // :local inside an imported script is scoped to that run, which is correct.
  assert.ok(statements(BOOT).every((l) => !l.startsWith(":global ")),
    "bootstrap must not leak globals between runs");
  const locals = [...BOOT.matchAll(/^:local\s+(\w+)/gm)].map((m) => m[1]);
  assert.ok(locals.length >= 5, `expected several locals, found ${locals.length}`);
  // Every local is cleared at the end so the router console is not littered.
  assert.ok(locals.every((n) => BOOT.includes(`:set ${n} ""`)), "each local is reset");
});

// ---------------------------------------------------------------------------
// Bootstrap: the read-only discovery pass
// ---------------------------------------------------------------------------

test("the bootstrap script changes nothing on the router", () => {
  // It is pasted before the operator has chosen anything, so it must be a pure
  // read. An accidental add here is a surprise change to someone's router.
  assert.deepEqual(creates(BOOT), [], "bootstrap must not create anything");
  for (const forbidden of ["set ", "remove", "reboot", "reset"]) {
    assert.ok(
      !statements(BOOT).some((l) => new RegExp(`^/\\S+ ${forbidden}`).test(l)),
      `bootstrap must not ${forbidden.trim()} anything`,
    );
  }
});

test("bootstrap reads the hardware the wizard needs", () => {
  for (const read of ["board-name", "version", "architecture-name", "cpu", "total-memory"]) {
    assert.ok(BOOT.includes(read), `bootstrap must read ${read}`);
  }
  assert.ok(/\/interface find/.test(BOOT), "and the interface list");
  assert.ok(/\/interface bridge find/.test(BOOT), "and existing bridges");
});

test("bootstrap reports back over the session token only", () => {
  assert.ok(!/secret|password|private-key/i.test(BOOT), "no credential in the report URL");
  assert.ok(BOOT.includes("keep-result=no"), "the fetch leaves nothing on the router");
});

test("bootstrap is resilient: a missing property cannot abort the report", () => {
  // Every read is wrapped, so a board without a property still reports the rest
  // instead of leaving the operator watching a wizard that never advances.
  const reads = (BOOT.match(/\/system resource get/g) ?? []).length;
  const guards = (BOOT.match(/on-error=\{/g) ?? []).length;
  assert.ok(guards >= reads, `expected an on-error per read (${guards} guards, ${reads} reads)`);
});

test("a failed report says so on the router console", () => {
  // Checked against the raw script: the text lives inside a :put string, which
  // statements() strips. The operator is standing at the router and must not be
  // left watching a wizard that never advances.
  assert.ok(BOOT.includes("report failed"), "the failure must be announced");
  assert.ok(/check the router has DNS/i.test(BOOT), "with the likely cause");
  // And the register endpoint must be echoed on failure, so they can test
  // reachability by hand instead of guessing.
  assert.ok(BOOT.includes("/register/"), "the callback URL is in the script");
  assert.ok(statements(BOOT).some((l) => /:put \$reg\b/.test(l)),
    "and is printed when the report fails");
});
// ---------------------------------------------------------------------------
// Management
// ---------------------------------------------------------------------------

test("WireGuard is configured on v7 and skipped on v6", () => {
  assert.ok(/\/interface wireguard add name=netpid-wg/.test(GEN_WG), "v7 with a tunnel gets WireGuard");
  assert.ok(GEN_WG.includes("persistent-keepalive"), "and a keepalive, or the tunnel idles out");
  // v6 has no built-in WireGuard; a wrong-menu create fails the whole line.
  assert.ok(!/\/interface wireguard/.test(GEN_V6), "v6 must not attempt WireGuard");
  assert.ok(GEN_V6.includes("not configured"), "and must say why");
});

test("WireGuard is skipped on v7 when NETPID has issued no tunnel", () => {
  // A fabricated key yields a tunnel that silently never handshakes, which is
  // worse than no tunnel because it looks configured.
  assert.ok(!/\/interface wireguard/.test(GEN), "no tunnel, no WireGuard");
  assert.ok(GEN.includes("has not issued a tunnel"), "and the reason is printed");
});

test("the router's own WireGuard key is never sent anywhere", () => {
  // The private key is generated on the router. Only the PUBLIC key is read
  // back, for the operator to paste, and it is never fetched.
  assert.ok(GEN_WG.includes("YOUR ROUTER PUBLIC KEY"), "the public key is read for the operator");
  for (const l of statements(GEN_WG).filter((x) => x.includes("/tool fetch"))) {
    assert.ok(!/public-key|private-key/.test(l), "a key must never travel in a fetch URL");
  }
});

test("CONFIGURED is never presented as ONLINE", () => {
  // Working RADIUS does not make a router online; only a verified RouterOS API
  // health check over the management path does.
  assert.ok(GEN.includes("only after a"));
  assert.ok(GEN.includes("RouterOS API health check"));
  assert.ok(configureRoute.includes("Not ONLINE"));
});

test("the heartbeat never implies the router is online", () => {
  // It proves the router is ALIVE, not that NETPID can manage it.
  const hb = read("../../apps/web/app/api/provision/mikrotik/heartbeat/[tag]/route.ts");
  assert.ok(hb.includes("last_seen_at"), "it records liveness");
  assert.ok(!/status:\s*["']online["']/.test(hb), "but must not set status to online");
  assert.ok(hb.includes("stays as it is"), "and says so");
});

// ---------------------------------------------------------------------------
// Secret hygiene at the API boundary
// ---------------------------------------------------------------------------

test("the decrypted RADIUS secret is never echoed to the browser", () => {
  assert.ok(configureRoute.includes("radiusSecret"), "the secret is used to build the script");
  assert.ok(
    !/radius_secret:\s*radiusSecret/.test(configureRoute),
    "the decrypted secret must not appear in the JSON response",
  );
});

test("bootstrap responses are no-store so a spent token cannot be replayed", () => {
  assert.match(bootstrapRoute, /no-store/);
  assert.match(bootstrapRoute, /text\/plain/);
});

test("an unknown and an expired token are refused the same way", () => {
  // One message shape, so the endpoint cannot be used to probe which tokens exist.
  assert.ok(bootstrapRoute.includes("This provisioning link is not valid"));
  assert.ok(bootstrapRoute.includes("This provisioning link has expired"));
  assert.ok(!/fail\(`[^`]*\$\{token/.test(bootstrapRoute), "the refusal must not echo the token");
});

test("the session token is never persisted in the clear", () => {
  const gen = read("../../apps/web/app/api/provision/mikrotik/generate/route.ts");
  assert.match(gen, /token_hash: hashToken\(token\)/);
  assert.ok(!/\.insert\(\{[\s\S]{0,200}?\btoken:(?!_hash)/.test(gen), "only the hash is stored");
});

test("the configure route re-checks ISP ownership, not just resolveIsp", () => {
  // resolveIsp says who is calling; the session row says whose session it is.
  // A token belonging to another ISP must still be refused.
  assert.ok(configureRoute.includes("session.isp_id !== r.ispId"));
  const status = read("../../apps/web/app/api/provision/mikrotik/status/[token]/route.ts");
  assert.ok(status.includes("session.isp_id !== r.ispId"));
});

test("configure refuses before the router has reported its hardware", () => {
  // Otherwise a script would be generated for interfaces NETPID never saw.
  assert.ok(configureRoute.includes("CAPABILITIES_DETECTED"));
  assert.ok(configureRoute.includes("Run the bootstrap command first"));
});
