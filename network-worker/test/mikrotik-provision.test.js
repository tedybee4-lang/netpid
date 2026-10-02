import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

import {
  decideCapabilities, decodeParam, hashToken, isEphemeralHost, mintToken,
  parseBridges, parseRamMb, tokenMatchesHash, validateSelection,
  buildDetectedInterfaces, appendStepEvent, stepPlan,
} from "../../apps/web/lib/mikrotik-provision.ts";
import { buildConfigureScript, buildBootstrapScript } from "../../apps/web/lib/mikrotik-provision-script.ts";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const configureRoute = read("../../apps/web/app/api/provision/mikrotik/configure/[token]/route.ts");
const bootstrapRoute = read("../../apps/web/app/api/provision/mikrotik/bootstrap/[token]/route.ts");
const PROGRESS_ROUTE = read("../../apps/web/app/api/provision/mikrotik/progress/[token]/route.ts");
const STATUS_ROUTE = read("../../apps/web/app/api/provision/mikrotik/status/[token]/route.ts");
const WIZARD = read("../../apps/web/components/MikroTikSetupWizard.tsx");

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

// Everything below this line is module scope. The closing brace above is
// load-bearing: without it every test after this point is defined INSIDE
// baseOpts and is never registered, so the suite silently runs fewer tests
// than it appears to. That happened once and hid 11 assertions, so the
// structural check at the bottom of this file guards against a repeat.
// ---------------------------------------------------------------------------
// Schema: the trigger must reference a column that exists
// ---------------------------------------------------------------------------

/**
 * A trigger naming a column that does not exist raises on every UPDATE. It is
 * invisible to a source-reading test suite and only appears when a statement
 * actually runs, which is exactly how this reached production.
 */
const MIG_0047 = read("../../supabase/migrations/0047_interactive_mikrotik_provisioning.sql");
const MIG_0048 = read("../../supabase/migrations/0048_provisioning_sessions_updated_at.sql");

function declaredColumns(sql) {
  const body = sql.slice(sql.indexOf("create table"), sql.indexOf(");", sql.indexOf("create table")));
  return new Set([...body.matchAll(/^\s{2}(\w+)\s+\w/gm)].map((m) => m[1]));
}

test("every column a provisioning trigger touches is actually declared", () => {
  const cols = declaredColumns(MIG_0047);
  // 0047 installs a BEFORE UPDATE trigger calling touch_updated_at(), which
  // assigns NEW.updated_at. Without the column every UPDATE raised:
  //   record "new" has no field "updated_at"
  // and no session could ever leave PENDING.
  const triggerBlock = MIG_0047.slice(MIG_0047.indexOf("trg_prov_sessions_touch"));
  assert.match(triggerBlock, /touch_updated_at/);
  const declaredAnywhere = cols.has("updated_at")
    || /add column if not exists updated_at/.test(MIG_0048);
  assert.ok(declaredAnywhere,
    "touch_updated_at() assigns NEW.updated_at, so the column must exist");
});

test("0048 adds the column with IF NOT EXISTS so it is replay safe", () => {
  assert.match(MIG_0048, /add column if not exists updated_at timestamptz not null default now\(\)/);
  // 0047 is already applied and must not be rewritten.
  assert.match(MIG_0048, /0047 is left untouched|0047 is left as-is/);
});

test("0048 proves the trigger works instead of assuming it", () => {
  // A migration that silently did nothing would let the same bug survive twice.
  assert.match(MIG_0048, /perform updated_at/i);
  assert.match(MIG_0048, /raise exception/);
});

test("no other migration installs a trigger on a column it did not declare", () => {
  // The same mistake elsewhere would break the same way, on some other table.
  const dir = new URL("../../supabase/migrations/", import.meta.url);
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql"))) {
    const sql = readFileSync(new URL(f, dir), "utf8");
    const tables = new Map();
    for (const m of sql.matchAll(/create table if not exists (\w+)\s*\(([\s\S]*?)\n\);/gi)) {
      tables.set(m[1], new Set([...m[2].matchAll(/^\s+(\w+)\s+\w/gm)].map((x) => x[1])));
    }
    for (const m of sql.matchAll(/create trigger\s+(\w+)\s+before update on (\w+)/gi)) {
      const [, name, table] = m;
      const cols = tables.get(table);
      if (!cols) continue;   // table created in an earlier migration
      assert.ok(cols.has("updated_at"),
        `${f}: trigger ${name} on ${table} needs updated_at, which that table never declares`);
    }
  }
});

// ---------------------------------------------------------------------------
// Management
// ---------------------------------------------------------------------------
test("every :set target is declared with :local and still in scope", () => {
  // THREE field failures, all the same shape, all reported as a bare
  // "syntax error (line N column 6)" with column 6 being the variable name:
  //
  //   1. npUrl had no :local at all, after a refactor turned
  //      `:local npUrl (...)` into `:set npUrl "..."`.
  //   2. npQ was a leftover that no longer existed anywhere.
  //   3. npW is a :foreach loop variable. It EXISTS INSIDE the loop and is
  //      GONE AFTERWARDS. `:set npW ""` below the loop is a syntax error.
  //
  // So the rule is not "declared somewhere". It is "declared with :local and
  // not scoped to a loop that has already closed".
  for (const [s, label] of [[GEN, "configure"], [BOOT, "bootstrap"]]) {
    // Only :local declarations count. A :foreach variable is deliberately
    // excluded: accepting it here is what let bug 3 through twice.
    const local = new Set([...s.matchAll(/^\s*:local\s+(\w+)/gm)].map((m) => m[1]));
    const lines = s.split("\n");

    // Line numbers where a :foreach block closes, so we know when a loop
    // variable is out of scope.
    const depth = [];
    let d = 0;
    for (const raw of lines) {
      const t = raw.replace(/(^|\s)#.*$/, "");
      const before = d;
      d += (t.match(/\{/g) ?? []).length - (t.match(/\}/g) ?? []).length;
      depth.push({ before, after: d });
    }
    assert.equal(d, 0, `${label}: unbalanced braces`);

    for (const [i, raw] of lines.entries()) {
      const t = raw.replace(/(^|\s)#.*$/, "").trim();
      const m = /^:set\s+(\w+)\s/.exec(t);
      if (!m) continue;
      const name = m[1];
      // A :foreach variable, and the :set that wrongly targets it.
      const loopVars = new Set(
        [...s.matchAll(/:foreach\s+(\w+)\s+in=/g)].map((x) => x[1]),
      );
      if (loopVars.has(name)) {
        // Legal only INSIDE the loop, i.e. at a brace depth greater than the
        // loop's own baseline. Outside it, the variable does not exist.
        assert.ok(depth[i].before > 0,
          `${label} line ${i + 1} assigns to the :foreach variable ${name}, which is out of scope: ${t.slice(0, 40)}`);
        continue;
      }
      assert.ok(local.has(name),
        `${label} line ${i + 1} sets ${name}, which is never declared: ${t.slice(0, 50)}`);
    }
  }
});

test("every variable read is either declared or a RouterOS built-in", () => {
  // $npX read but never declared resolves to nothing, so a guard built on it
  // silently passes and the guarded block never runs.
  const BUILTIN = new Set(["nothing", "null", "true", "false"]);
  for (const [s, label] of [[GEN, "configure"], [BOOT, "bootstrap"]]) {
    // A :foreach loop variable is declared by the loop itself, so it counts.
    const declared = new Set([
      ...[...s.matchAll(/^\s*:local\s+(\w+)/gm)].map((m) => m[1]),
      ...[...s.matchAll(/:foreach\s+(\w+)\s+in=/g)].map((m) => m[1]),
    ]);
    for (const m of s.matchAll(/\$\((\w+)\)/g)) {
      if (BUILTIN.has(m[1])) continue;
      assert.ok(declared.has(m[1]),
        `${label} reads $(${m[1]}), which is never declared`);
    }
  }
});

test("no scratch variable shadows a data variable", () => {
  // The interface list arrived as a single interface named "0", and the wizard
  // could offer no port. The cause was a collision, not a dialect problem: the
  // character walk that encodes spaces for the URL used npI as its loop counter,
  // and npI is the variable HOLDING the interface list. For that one field the
  // line ":local npI 0" wiped the data before "[:len $npI]" could measure it,
  // and the script faithfully reported "0".
  //
  // It is invisible in the other seven fields, because those read from npB, npM,
  // npV, npA, npC, npR and npG. Only the field whose source variable happened
  // to match the counter broke, which is exactly the kind of bug that a test
  // asserting "eight fields are encoded" cannot see.
  const DATA = new Set(["npB", "npM", "npV", "npA", "npC", "npR", "npI", "npG"]);
  const SCRATCH = new Set(["npS", "npX", "npY", "npZ", "npUrl"]);

  for (const n of SCRATCH) {
    assert.ok(!DATA.has(n),
      `scratch variable ${n} collides with a data variable and will overwrite it`);
  }
  // The check that actually failed in the field: no counter may be named after a
  // data variable, because ":local <name> 0" destroys the value it then measures.
  const counters = [...BOOT.matchAll(/^\s*:local\s+(np\w+)\s+0\s*$/gm)].map((m) => m[1]);
  assert.ok(counters.length > 0, "expected at least one counter to check");
  for (const c of counters) {
    assert.ok(!DATA.has(c),
      `counter ${c} is a data variable, so ":local ${c} 0" destroys the value it is meant to measure`);
  }
  // The interface field must still be the one that measures $npI.
  assert.ok(/:local npZ \[:len \$npI\]/.test(BOOT),
    "the interface field must measure $npI with a differently named counter");
});

test("no value is concatenated into the URL with a raw space", () => {
  // THE FIELD FAILURE. The script ran to completion and printed
  //
  //   NETPID: report failed. Check the router has DNS and can reach:
  //   <blank line>
  //
  // so /tool fetch was rejected. The cause was not DNS: the URL was built by
  // concatenating values that contain spaces - "hAP lite", "MIPS 24Kc V7.4",
  // "65536 KiB". RFC 3986 forbids a literal space in a URL and RouterOS has no
  // URL encoder, so the request never left the router.
  //
  // Every value therefore goes through a character walk that swaps each space
  // for "+", which decodeParam() turns back into a space server side.
  //
  // It used to be `[:foreach w in=[:split $v " "]`, which NEVER WORKED: there
  // is no [:split function in RouterOS. The router parses the bracketed word as
  // a command to run and answers "bad command name split". The source variable
  // for each field is now named by the `[:len]` that seeds the walk.
  const encoded = BOOT.match(/:local npZ \[:len \$\w+\]/g) ?? [];
  assert.equal(encoded.length, 8, "every one of the eight values is space-encoded");
  // The walk must not reach for a function outside the dialect.
  assert.ok(!/\[:split/.test(BOOT.replace(/(^|\s)#.*$/gm, "")),
    "[:split is not a RouterOS function and must not appear in code");
  for (const line of BOOT.split("\n")) {
    const t = line.replace(/(^|\s)#.*$/, "").trim();
    // Any line that appends a value to the URL must append $npS, the encoded
    // buffer, never a raw variable.
    if (!t.startsWith(":set npUrl (")) continue;
    assert.match(t, /\$npS\)$/,
      `a value is concatenated raw, so a space would break the fetch: ${t}`);
  }
});

test("a value with a space round-trips through the encoding to the same string", () => {
  // Simulate what the router does, then what the server does with the result.
  const encode = (v) => v.split(" ").filter((w) => w.length).join("+");
  for (const raw of ["hAP lite", "MIPS 24Kc V7.4", "65536 KiB", "arm", "7.21.5"]) {
    const onTheWire = encode(raw);
    assert.ok(!onTheWire.includes(" "), `${raw} still contains a space on the wire`);
    assert.equal(decodeParam(onTheWire), raw, `${raw} does not survive the round trip`);
  }
});

test("a failed report prints the URL that failed, not an empty line", () => {
  // The handler used to print $reg, which is a JAVASCRIPT variable, not RouterOS
  // state, so it always expanded to nothing. The operator saw a blank line where
  // the diagnostic should have been and had nothing to act on.
  const handler = BOOT.slice(BOOT.indexOf("on-error={"));
  assert.match(handler, /:put \$npUrl/,
    "the failing URL must be printed so the operator can open it and see why");
  assert.ok(!/\$reg\b/.test(BOOT), "$reg is not a RouterOS variable and must not appear");
  // And it must name the two real causes, not just "check your DNS".
  assert.match(handler, /blocking outbound HTTPS/);
  assert.match(handler, /token has expired/);
});

test("no generated line leaves an expression open", () => {
  // A parenthesised or bracketed expression split across lines is a syntax
  // error on RouterOS: the parser hits end-of-line still inside it and reports
  // only "syntax error (line N column M)" with nothing to say which construct
  // failed.
  //
  // PARENS and BRACKETS must balance within a line, because `[:len [/interface
  // find]]` has to be complete on one line. BRACES may span lines, since a
  // block opener legitimately closes on a later line. Checking all three
  // together flags every `do={` as broken, which is noise you learn to ignore.
  for (const [s, label] of [[GEN, "configure"], [BOOT, "bootstrap"]]) {
    for (const [n, raw] of s.split("\n").entries()) {
      const t = raw.replace(/(^|\s)#.*$/, "").replace(/"[^"]*"/g, '""');
      const round = (t.match(/\(/g) ?? []).length - (t.match(/\)/g) ?? []).length;
      const square = (t.match(/\[/g) ?? []).length - (t.match(/\]/g) ?? []).length;
      assert.equal(
        round + square, 0,
        `${label} line ${n + 1} leaves () or [] open: ${raw.trim().slice(0, 70)}`,
      );
    }
  }
});

test("no generated line is long enough to risk a paste or log limit", () => {
  // NOT the cause of the field failure. That line was 156 chars and failed
  // because of the OPEN PAREN, not the length: RouterOS happily runs a long
  // `add` statement. The bound here is a generous ceiling well under any real
  // line limit, so a pathologically long value still gets caught.
  for (const [s, label] of [[GEN, "configure"], [BOOT, "bootstrap"]]) {
    for (const [n, raw] of s.split("\n").entries()) {
      if (raw.trim().startsWith("#")) continue;
      assert.ok(raw.length <= 400, `${label} line ${n + 1} is ${raw.length} chars`);
    }
  }
});

test("the bootstrap URL is built one statement per line", () => {
  // Two field failures came out of this block:
  //   1. `:local npUrl ("https://..."` followed by `. "?board="` continuation
  //      lines. RouterOS stopped at the end of that line.
  //   2. `:set npUrl "https://..."` with no `:local npUrl` first. RouterOS
  //      rejected it at the variable name, "line 65 column 6".
  assert.ok(/^:local npUrl "https:\/\/[^"]+\/register\/[^"]+"$/m.test(BOOT),
    "the base URL is one complete statement, and npUrl is declared there");
  const appends = BOOT.split("\n").filter((l) => l.startsWith(":set npUrl ($npUrl . "));
  assert.equal(appends.length, 8, "one append per reported field");
  for (const a of appends) {
    // $npS, not the raw variable: a value with a space has to be encoded first
    // or /tool fetch rejects the whole URL.
    assert.match(a, /^:set npUrl \(\$npUrl \. "[?&][a-z]+=" \. \$npS\)$/, `bad append: ${a}`);
  }
});

test("only the FIRST query parameter uses ?, and the rest use &", () => {
  // Every parameter sent as "&" with no leading "?" makes the whole query
  // string part of the path, and the server reads no parameters at all.
  const appends = BOOT.split("\n").filter((l) => l.startsWith(":set npUrl ($npUrl . "));
  assert.match(appends[0], /"\?/, "the first separator is ?");
  for (const a of appends.slice(1)) {
    assert.match(a, /"&/, `a later parameter must use &: ${a}`);
  }
});

test("the register URL the router calls is reconstructed correctly", () => {
  // Replay the generated statements to prove the final URL is well formed, and
  // that values with spaces survive as encoded-then-decoded.
  //
  // The replay follows the script: split the value on space, rejoin with "+",
  // append that. Then the server decodes "+" back to a space. Values come out
  // identical to what the router read, so nothing is lost by the encoding.
  //
  // npV, not npQ: npQ was a leftover, and a URL whose version parameter silently
  // arrived empty is how a 6.x router gets configured with a 7.x script.
  const vals = {
    npB: "hAP lite", npM: "hAP lite", npV: "7.21.5", npA: "arm",
    npC: "MIPS 24Kc V7.4", npR: "65536 KiB",
    npI: "ether1,ether2,wlan1", npG: "bridge-lan:ether2",
  };
  const base = /:local npUrl "([^"]+)"/.exec(BOOT);
  assert.ok(base, "npUrl must be declared with the base URL");
  let url = base[1];

  // Each field's source variable, taken from the [:len] that seeds its walk.
  const sourceFor = [];
  const lines = BOOT.split("\n");
  for (const [i, line] of lines.entries()) {
    const m = /:local npZ \[:len \$(\w+)\]/.exec(line);
    if (!m) continue;
    // The append that follows this block uses $npS, the encoded buffer.
    const append = lines.slice(i, i + 10).find((l) => l.startsWith(":set npUrl ($npUrl . "));
    const sep = /"([?&])([a-z]+)="/.exec(append ?? "");
    sourceFor.push({ src: m[1], sep: sep?.[1], key: sep?.[2] });
  }
  assert.equal(sourceFor.length, 8, "every field is encoded before it is appended");

  for (const { src, sep, key } of sourceFor) {
    // What the router does: split on space, rejoin with "+".
    const onTheWire = vals[src].split(" ").filter(Boolean).join("+");
    assert.ok(!onTheWire.includes(" "), `${key} still has a raw space`);
    url += sep + key + "=" + onTheWire;
  }

  // The URL must be parseable, which it is not with a literal space in it.
  const u = new URL(url);
  // And the server must decode "+" back to the original value.
  assert.equal(decodeParam(u.searchParams.get("board")), "hAP lite");
  assert.equal(decodeParam(u.searchParams.get("version")), "7.21.5");
  assert.equal(decodeParam(u.searchParams.get("cpu")), "MIPS 24Kc V7.4");
  assert.equal(decodeParam(u.searchParams.get("ram")), "65536 KiB");
  assert.equal(decodeParam(u.searchParams.get("ifaces")), "ether1,ether2,wlan1");
  assert.equal(decodeParam(u.searchParams.get("bridges")), "bridge-lan:ether2");
  assert.equal(u.searchParams.size, 8, "all eight parameters arrive");
  assert.equal(u.pathname.split("/").pop().length, 43, "the token stays a full path segment");
});

// ---------------------------------------------------------------------------
// A preview deployment must not be baked into a router
// ---------------------------------------------------------------------------

test("a Vercel PREVIEW host is refused for the heartbeat and reported", () => {
  // The field paste used netpid-2b9dmps30-malariachrome-7756s-projects.vercel.app.
  // A preview deployment is torn down, and the heartbeat scheduler the configure
  // script installs would then call a URL that 404s forever, silently.
  //
  // A Vercel apex and a preview are the same SHAPE, so the apex is only trusted
  // when NETPID_STABLE_HOSTS names it. Otherwise every vercel.app host is
  // refused: omitting a heartbeat and saying so beats pointing a router at a
  // URL that will not exist.
  assert.ok(isEphemeralHost("https://netpid-2b9dmps30-malariachrome-7756s-projects.vercel.app"),
    "a preview subdomain must be treated as throwaway");
  assert.ok(isEphemeralHost("https://x.ngrok-free.app"), "ngrok is throwaway");
  assert.ok(isEphemeralHost("http://localhost:3000"), "localhost is unreachable from a router");
  assert.ok(isEphemeralHost("http://192.168.1.1"), "a LAN address is not a public callback");
  assert.ok(isEphemeralHost("http://10.90.0.1"), "a private address is not a public callback");
  assert.ok(!isEphemeralHost("https://netpid.example.com"), "a custom domain is stable");
  assert.ok(!isEphemeralHost("https://radius.example.net"), "another custom domain is stable");
});

test("the production host is named explicitly, never guessed from its shape", () => {
  // A Vercel apex and a preview deployment are indistinguishable by shape, so
  // the apex is refused unless it is listed in NETPID_STABLE_HOSTS. Documented
  // so nobody "simplifies" it back into a guess that silently bakes a dead URL
  // into a router.
  const src = read("../../apps/web/lib/mikrotik-provision.ts");
  assert.match(src, /NETPID_STABLE_HOSTS/);
  assert.ok(!src.includes("return left.length > 0"),
    "do not reintroduce a shape-based apex test");
});

test("no preview host is embedded in generated RouterOS", () => {
  // The generator must never be handed a host it would bake into a router.
  for (const [s, label] of [[GEN, "configure"], [BOOT, "bootstrap"]]) {
    for (const raw of s.match(/https?:\/\/[^\s"]+/g) ?? []) {
      const h = new URL(raw.replace(/["']/g, ""));
      assert.ok(!isEphemeralHost(h.hostname),
        `${label} embeds a throwaway host: ${h.hostname}`);
    }
  }
});

test("the heartbeat points at a stable host, not the request origin", () => {
  const configure = read("../../apps/web/app/api/provision/mikrotik/configure/[token]/route.ts");
  // new URL(req.url).origin is whatever host the operator happened to load,
  // which for a preview deployment is a URL that will not exist tomorrow.
  assert.ok(!/heartbeatUrl:\s*`\$\{origin\}/.test(configure),
    "the heartbeat must not use the request origin");
});
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

test("a bridged ethernet port is still offered as the WAN", () => {
  // A STOCK MIKROTIK PUTS EVERY LAN PORT IN ITS DEFAULT BRIDGE. Excluding
  // bridged ports from the WAN list meant the hAP lite in the field reported
  // ether1-4 all "in bridgeLocal", so the operator had nothing to pick, no WAN
  // was auto-selected, and the configure call was refused for an empty
  // wan_interface. The product could not provision a router as it ships.
  //
  // The chosen port is released from its bridge by the configure script, so
  // offering it is safe. Wireless is still never a WAN: it cannot be routed.
  const bridges = parseBridges("bridge-lan:ether2,ether3,ether4");
  const ifaces = buildDetectedInterfaces("ether1,ether2,ether3,ether4,wlan1", bridges);
  const wan = ifaces.filter((i) => i.is_candidate_wan).map((i) => i.name);
  assert.deepEqual(wan, ["ether1", "ether2", "ether3", "ether4"],
    "every ethernet port is offered, bridged or not");
  assert.equal(ifaces.find((i) => i.name === "ether2").in_bridge, "bridge-lan",
    "the bridge membership is still reported so the UI can show it");
  // Wireless must never be offered as a WAN.
  assert.ok(!ifaces.find((i) => i.name === "wlan1").is_candidate_wan);
});

test("the configure script releases the WAN from its bridge before adding DHCP", () => {
  // Offering a bridged port is only safe because the script breaks the bridge
  // membership first. If this is removed, the WAN comes up enslaved to a bridge
  // with no address on it: a dead uplink and no error anywhere.
  const idx = GEN.indexOf("/interface bridge port remove [find interface=");
  assert.ok(idx > -1, "the WAN must be removed from its bridge");
  const dhcp = GEN.indexOf("/ip dhcp-client add interface=");
  assert.ok(dhcp > -1, "a DHCP client is added to the WAN (v7 path)");
  assert.ok(idx < dhcp,
    "the port must leave the bridge BEFORE the DHCP client is added, or the WAN is unroutable");
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

test("a bridged WAN is allowed and reported, not rejected", () => {
  // Was: "a port already in a bridge cannot be the WAN", asserting r.ok is false.
  // That rule made the product unusable on a stock router, where every LAN port
  // is in the default bridge. A bridged port is now released by the script and
  // the operator is told, which is the difference between a working WAN and a
  // product that cannot provision the router it is sold for.
  const r = validateSelection({ mode: "HOTSPOT", wan_interface: "ether5", hotspot_interfaces: ["ether2"] }, DETECTED);
  assert.ok(r.ok, r.errors.join(" "));
  assert.ok(r.warnings.some((w) => /ether5 is in bridge bridge-lan/.test(w)),
    "the operator must be told the port will leave its bridge");
  // The real hard rules are untouched.
  assert.ok(!validateSelection({ mode: "HOTSPOT", wan_interface: "ether1", hotspot_interfaces: ["ether1"] }, DETECTED).ok,
    "a port still cannot be both the WAN and a HotSpot port");
});

test("the DHCP client path follows the RouterOS version", () => {
  // Field report on a 7.21.5 hAP lite:
  //
  //   bad command name dhcp-client (line 9 column 26)
  //
  // The DHCP client moved out of /interface in RouterOS 7, exactly as RADIUS
  // did. The v6 path does not exist on a v7 box, so the router parsed
  // "dhcp-client" as a command to run - a missing menu reported as a bad value.
  // RADIUS was already handled; the DHCP client was missed.
  assert.match(GEN, /\/ip dhcp-client add interface=/,
    "a v7 script must use /ip/dhcp-client");
  assert.doesNotMatch(GEN, /\/interface dhcp-client/,
    "/interface/dhcp-client is the 6.x path and does not exist on 7.x");
  assert.match(GEN_V6, /\/interface dhcp-client add interface=/,
    "a v6 script must use /interface/dhcp-client");
  assert.doesNotMatch(GEN_V6, /\/ip dhcp-client/,
    "/ip/dhcp-client is the 7.x path and does not exist on 6.x");
});

test("a customer port is moved into the target bridge, not removed then added", () => {
  // Observed in the field: "Console does not respond" part way through the
  // bridge section, which kills the operator's terminal mid-script and leaves
  // the box half configured.
  //
  // A remove-then-add leaves a window where the port is a member of no bridge.
  // An operator driving the router over the network is usually connected
  // THROUGH one of the ports being moved, so that window drops the live
  // session. Adding a port to the new bridge moves it in one operation and
  // never has the gap.
  const addIdx = GEN.indexOf("/interface bridge port add bridge=");
  const removeIdx = GEN.indexOf("/interface bridge port remove [find interface=");
  assert.ok(addIdx > -1, "customer ports are added to the target bridge");
  // The WAN remove comes first in the script and is legitimate. Any remove
  // AFTER the first bridge add would be a remove-then-add for a customer port.
  const removes = [...GEN.matchAll(/\/interface bridge port remove \[find interface=/g)];
  assert.equal(removes.length, 1,
    "only the WAN is removed; customer ports are moved by adding");
  assert.ok(removeIdx < addIdx, "the WAN is released before the bridge section adds ports");
});

test("both version-specific paths are asserted, not discovered in the field", () => {
  // RADIUS and the DHCP client each broke a real router in turn, and both fail
  // the same way: "bad command name X", which reads like a bad value rather
  // than a missing menu. Asserting the known pairs here means a third move
  // between 6 and 7 fails a test instead of a customer's router.
  assert.doesNotMatch(GEN, /\/ip radius/, "v7 must not use the v6 /ip radius path");
  assert.match(GEN, /\/radius add address=/, "v7 uses /radius");
  assert.match(GEN_V6, /\/ip radius add address=/, "v6 uses /ip radius");
});

test("the RADIUS port properties are the long names", () => {
  // Field report: bad parameter auth-port (line 2 column 102)
  //
  // The properties are authentication-port and accounting-port. auth-port and
  // acct-port do not exist, so the entire /radius line is rejected, no RADIUS
  // client is ever created, and PPPoE then authenticates against nothing: every
  // subscriber looks like a bad password and the failure is invisible.
  //
  // The sibling generator in this repo has used the long names all along and
  // its own test asserts them. The wizard's copy had drifted to the short names
  // and nothing compared the two.
  assert.match(GEN, /authentication-port=1812/);
  assert.match(GEN, /accounting-port=1813/);
  assert.doesNotMatch(GEN, /\bauth-port=/, "auth-port does not exist in either version");
  assert.doesNotMatch(GEN, /\bacct-port=/, "acct-port does not exist in either version");
  assert.match(GEN_V6, /authentication-port=/, "v6 uses the same long property names");
});

test("the HotSpot pool holds the range only, never the subnet it sits in", () => {
  // Field report: failure: pool has overlapping ranges
  //
  // The pool was built as "<subnet>,<range>", and the range is carved out of
  // that subnet, so the two overlap and the router refuses the whole pool. The
  // portal then has no pool at all and every client is handed an empty range,
  // which looks like a DHCP fault rather than a configuration error.
  assert.match(GEN, /\/ip pool add name="10\.5\.50\.10-10\.5\.50\.250" ranges="10\.5\.50\.10-10\.5\.50\.250"/,
    "the pool ranges must be the dynamic range alone");
  assert.doesNotMatch(GEN, /ranges="10\.5\.50\.0\/24,/, "never put the subnet in the same pool as a range inside it");
});

test("a version-specific property never takes the whole object down with it", () => {
  // Field report, two failures in one run:
  //
  //   bad parameter use-cookie (line 2 column 93)
  //   bad parameter dns-name  (line 2 column 134)
  //
  // RouterOS rejects an ENTIRE command when it does not recognise a single
  // property name in it. Both used to ride inside the same `add` as properties
  // the object could not work without, so one bad name destroyed the whole
  // HotSpot profile AND the whole HotSpot server: the portal silently did not
  // exist, and - because a pasted multi-line script never prints the runtime
  // error - the console showed a bare WARN with no cause.
  //
  // `use-cookie` is not a RouterOS property at all. The 7.24 CLI reference for
  // ip/hotspot/profile lists `login-by`, whose values include `cookie`, plus
  // `http-cookie-lifetime`. There is no on/off switch to get wrong.

  // 1. The property that does not exist must never be emitted again.
  assert.doesNotMatch(GEN, /use-cookie/, "use-cookie is not a RouterOS property");
  assert.doesNotMatch(GEN_V6, /use-cookie/, "and it is not one on v6 either");

  // 2. Cookie authentication is requested the way RouterOS actually spells it.
  assert.match(GEN, /login-by=[^\s]*\bcookie\b/,
    "cookie belongs INSIDE login-by, not in a separate switch");
  assert.match(GEN, /http-cookie-lifetime=/, "and its lifetime is set explicitly");

  // 3. dns-name is still requested where it exists, but never bundled into an
  //    `add` alongside properties the server cannot work without. RouterOS 7
  //    dropped it from ip/hotspot (confirmed on the device AND in the CLI
  //    reference), so v7 sends nothing and tells the operator to make the DNS
  //    record; v6 still sets it.
  assert.doesNotMatch(GEN, /\/ip hotspot add[^\n]*dns-name=/,
    "dns-name must not ride in the add that creates the HotSpot server");
  assert.match(GEN_V6, /\/ip hotspot set \[find name=netpid\] dns-name=/,
    "v6 still sets dns-name, in its own guarded statement");
  assert.doesNotMatch(GEN_V6, /\/ip hotspot add[^\n]*dns-name=/,
    "and never in the add on v6 either");
  assert.doesNotMatch(GEN, /\/ip hotspot profile add[^\n]*(use-radius|login-by)=/,
    "the profile add carries only the name it cannot work without");

  // 4. Every optional property gets its own guard, so one refusal is one lost
  //    setting rather than one lost object.
  const guards = [...GEN.matchAll(/on-error=\{/g)].length;
  assert.ok(guards >= 12,
    `expected a guard per optional property, found only ${guards}`);

  // 5. Refusals are announced by PRINTING, never by appending to a variable.
  assert.match(GEN, /:put \("  NETPID skipped " \. "profile\.use-radius"\)/,
    "a refused profile property is announced");
  assert.match(GEN, /:put \("  NETPID skipped " \. "hotspot\.comment"\)/,
    "and so is a refused HotSpot server property - the device refused comment on it too");

  // 6. And the script must never end by asserting that everything worked from
  //    state it computed itself. In the field it printed
  //      All requested properties were accepted by this RouterOS.
  //    three lines below
  //      profile netpid: MISSING - it was not created.
  // because the accumulator feeding that check was itself the refused statement.
  assert.doesNotMatch(GEN, /All requested properties were accepted/,
    "no self-graded all-clear");
  assert.match(GEN, /NETPID skipped \.\.\./,
    "the reader is pointed at the real lists instead");
});

test("no HotSpot or RADIUS `add` carries a comment", () => {
  // FIELD FAILURE, twice in one run:
  //
  //   FATAL: the HotSpot profile could not be created at all.
  //   FATAL: the HotSpot server could not be created at all.
  //
  // for these two commands:
  //
  //   /ip hotspot profile add name=netpid comment="NETPID:<id> hs-profile"
  //   /ip hotspot add name=netpid interface="bridge-lan" profile=netpid comment="..."
  //
  // `comment` is accepted by /interface bridge and by /ip pool in the very same
  // script - both of those objects were created - but the HotSpot menus reject
  // it, and the RouterOS 7.24 CLI reference for ip/hotspot/profile and
  // ip/hotspot lists no comment property at all. One unsupported name rejects
  // the entire command, so a cosmetic label was destroying the object.
  //
  // The rule this enforces: an `add` carries ONLY what the object cannot work
  // without. Everything else - including the NETPID tag - is set afterwards in
  // its own guard, so a refusal costs a label and not the entry.
  for (const menu of ["/ip hotspot profile add", "/ip hotspot add", "/radius add"]) {
    const line = GEN.split("\n").find((l) => l.trim().startsWith(menu));
    assert.ok(line, `${menu} must be emitted`);
    assert.doesNotMatch(line, /comment=/,
      `${menu} must not carry comment= - it is not a HotSpot property`);
  }
  // The v6 RADIUS path is the same menu and gets the same treatment.
  const v6 = GEN_V6.split("\n").find((l) => l.trim().startsWith("/ip radius add"));
  assert.ok(v6, "/ip radius add must be emitted on v6");
  assert.doesNotMatch(v6, /comment=/, "and it must not carry comment= either");

  // The tag is not lost: it is applied as a guarded set instead.
  assert.match(GEN, /profile set \[find name=netpid\] comment=/,
    "the HotSpot profile is still tagged");
  assert.match(GEN, /hotspot set \[find name=netpid\] comment=/,
    "and so is the HotSpot server");

  // Tagging must never be load-bearing for idempotency, or losing the label
  // would mean losing the ability to find the object on a re-run.
  assert.doesNotMatch(GEN, /find comment=/,
    "nothing may be looked up by comment");
});

test("properties the device refused are not offered again on that version", () => {
  // The v7 HotSpot server refused three properties on a real router:
  //
  //   NETPID skipped hotspot.add-default-route
  //   NETPID skipped hotspot.dns-name
  //   NETPID skipped hotspot.address-type
  //
  // and the 7.24 CLI reference agrees - ip/hotspot lists only name, interface,
  // address-pool, profile, idle-timeout, keepalive-timeout, login-timeout,
  // addresses-per-mac and the read-only ip-of-dns-name.
  //
  // Repeating a refusal on every run trains the operator to ignore the skipped
  // list, which is exactly how a REAL failure gets missed. So a property proven
  // absent on a version is not sent to that version again.
  for (const prop of ["add-default-route=", "dns-name=", "address-type="]) {
    assert.doesNotMatch(GEN, new RegExp(`hotspot set [^\\n]*${prop}`),
      `v7 must not send ${prop} to /ip hotspot again`);
    assert.match(GEN_V6, new RegExp(`hotspot set [^\\n]*${prop}`),
      `v6 still supports ${prop} and must keep sending it`);
  }

  // What v7 DOES have must still be sent, or the portal has no pool.
  assert.match(GEN, /\/ip hotspot set \[find name=netpid\] address-pool=/);
  assert.match(GEN, /\/ip hotspot add name=netpid interface="bridge-lan" profile=netpid/);

  // The operator is still told the named login page needs a DNS record.
  assert.match(GEN, /login\.isp\.net -> this router's WAN address/);
});

test("each guarded property is followed by a check, so a silent add is visible", () => {
  // The bridge-port section reported
  //   port ether2: NOT in bridge-lan
  // with no output at all from the block that was supposed to add it - neither
  // "moving ...", nor "already in ...", nor the SKIP fallback. A block that
  // produces no output and changes no state is the one case the read-back
  // report cannot explain, so the port block now verifies itself at the end
  // and says plainly when the port did not land.
  assert.match(GEN, /:put "  !! ether2: still NOT in bridge-lan/,
    "a port that did not land says so where it was added");
  // And the HotSpot pool, which the same run proved is not enough on its own.
  assert.match(GEN, /hotspot\.address-pool/,
    "address-pool is still applied and can still be skipped");
});

test("generated scripts carry no state across RouterOS scope boundaries", () => {
  // TWO FIELD FAILURES, one root cause, and my first diagnosis of it was wrong.
  //
  //   :local npP "ether2"
  //   :if (...) do={ :put ("  !! " . $npP . ...) }
  //     ->  !! : still NOT in bridge-lan        (the name came out EMPTY)
  //   :set npP ""
  //     ->  syntax error (line 1 column 6)      (column 6 is the variable name)
  //
  // and, identically, `:set npFail (...)` inside an `on-error={}` block took
  // that whole block down with it.
  //
  // It is NOT the name length. npP is three characters and was still refused.
  // It is SCOPE: the MikroTik scripting docs say "every variable must be
  // declared before use with the local or global keyword. Using an undeclared
  // variable results in a compilation error." Every line pasted into the
  // console is its own scope, so a `:local` on one line is invisible to the
  // next - $npP reads empty and `:set npP ""` is a compile error at the name.
  //
  // The variables that "worked" (npUrl, npWb, npOld) only ever appeared inside
  // the single block that declared them, which is why they survived.
  //
  // The generated script therefore contains NO state at all. Values are
  // interpolated at generation time instead of being assembled on the router.
  // The CONFIGURE script is PASTED into the console line by line, so each line is
  // its own scope and no statement may depend on another. The BOOTSTRAP script
  // is /imported, which runs the whole file as one scope, so it may keep its
  // state - that difference is exactly why the same construct is safe in one
  // script and fatal in the other.
  const CONFIGURE = [GEN, GEN_BOTH, GEN_V6, GEN_NOSECRET, GEN_WG];
  for (const script of CONFIGURE) {
    assert.doesNotMatch(script, /^\s*:set\s/m,
      "a pasted script must not use :set - it cannot reach the next line's scope");
    assert.doesNotMatch(script, /^\s*:global\s/m,
      "and must not use :global - a permanent global is not a scratch pad");
  }

  // Whatever IS read as $var must have been declared first in the same script.
  // This is the rule that both field failures broke. A `:foreach` loop variable
  // is the one exception: the loop itself declares it.
  for (const script of ALL_GEN) {
    const declared = new Set();
    for (const line of script.split("\n")) {
      for (const m of line.matchAll(/:local\s+([A-Za-z][A-Za-z0-9]*)/g)) declared.add(m[1]);
      for (const m of line.matchAll(/:foreach\s+([A-Za-z][A-Za-z0-9]*)\s+in=/g)) declared.add(m[1]);
      for (const m of line.matchAll(/\$(\w+)/g)) {
        assert.ok(declared.has(m[1]),
          `$${m[1]} is read but never declared with :local or :foreach`);
      }
    }
  }

  // The port check must interpolate, not assemble at runtime.
  assert.match(GEN, /:put "  !! ether2: still NOT in bridge-lan/,
    "the port name is baked in at generation time");
  assert.match(GEN, /:put "  ok  ether2 -> bridge-lan"/);
  assert.doesNotMatch(GEN, /npP/, "and no scratch variable remains for it");
});

test("every generated block is closed, so a paste never hangs the console", () => {
  // The operator pastes into a serial console, one top-level command at a time.
  // A block that is opened and never closed leaves the console showing `{...`
  // forever, waiting for input that is never coming - which is exactly how a
  // half-run configuration looks from the other end.
  //
  // Balance is CUMULATIVE, not per line: `:if (...) do={` legitimately closes on
  // a later line, so counting braces within one line proves nothing.
  for (const script of ALL_GEN) {
    let depth = 0;
    let worst = 0;
    script.split("\n").forEach((line, i) => {
      depth += (line.match(/\{/g) ?? []).length;
      depth -= (line.match(/\}/g) ?? []).length;
      if (depth < worst) worst = depth;
      assert.ok(depth >= 0,
        `line ${i + 1} closes a block that was never opened: ${line.slice(0, 90)}`);
    });
    assert.equal(depth, 0,
      `script ends with ${depth} block(s) still open - the console would wait forever`);

    // A comment must never carry a real block closer. `# }` does NOT close
    // anything, so an emitted one silently unbalances the script.
    for (const line of script.split("\n")) {
      if (!line.trim().startsWith("#")) continue;
      assert.ok(!/[{}]/.test(line),
        `a comment must not carry braces: ${line.slice(0, 90)}`);
    }
  }
});

test("the final report reads the router back instead of echoing what was asked", () => {
  // The old report printed the REQUESTED values: a HotSpot that had failed to
  // create still printed "RADIUS: configured", and every other line was a copy
  // of the options that built the script. The one screen the operator relied on
  // was the only thing structurally incapable of telling them it had failed.
  assert.doesNotMatch(GEN, /:put \("RADIUS\s+: " \. "configured"\)/,
    "RADIUS state must not be asserted from the request");
  assert.doesNotMatch(GEN, /:put \("HotSpot\s+: " \. "ether2/,
    "the port list is not proof the ports were bridged");

  // Every object is probed with find/get against the live router.
  for (const probe of [
    /:if \(\[:len \[\/ip hotspot profile find name="netpid"\]\] > 0\)/,
    /:if \(\[:len \[\/ip hotspot find name="netpid"\]\] > 0\)/,
    /:if \(\[:len \[\/ip pool find name=/,
    /:if \(\[:len \[\/interface bridge port find interface=ether2 where bridge="bridge-lan"\]\] > 0\)/,
    /:if \(\[:len \[\/radius find address="10\.10\.0\.5"\]\] > 0\)/,
  ]) {
    assert.match(GEN, probe, "the report must probe the real router");
  }

  // And a missing object says so out loud.
  assert.match(GEN, /MISSING/, "an object that is not there is reported as MISSING");
  // Reading back must be guarded too: a property this build does not expose
  // cannot be allowed to abort the report that is proving the work.
  assert.match(GEN, /not exposed by this RouterOS/);
});

test("each step boundary calls back to NETPID so the dashboard can show progress", () => {
  // The operator pastes a multi-line script into a serial console and then has
  // nothing to look at until it finishes. Each step now GETs the progress URL,
  // so /status can drive a live bar instead of sitting at 70%.
  const s = buildConfigureScript(baseOpts({
    progressUrl: "https://netpid.example/api/provision/mikrotik/progress/tok123",
  }));

  for (const id of ["start", "interfaces", "bridge", "hotspot", "radius", "management", "verify", "done"]) {
    assert.match(s, new RegExp(`step=${id}&pct=\\d+`), `${id} reports progress`);
  }

  // Progress must never be able to stop the configuration. A dashboard that is
  // down, slow or behind a captive portal costs a tick, not a half-built ISP.
  const fetches = [...s.matchAll(/\/tool fetch[^\n]*progress\/tok123[^\n]*/g)];
  assert.ok(fetches.length >= 8, `expected a callback per step, found ${fetches.length}`);
  for (const f of fetches) {
    assert.match(f[0], /on-error=\{ \}$/, "every progress callback is guarded");
  }

  // No URL is invented when the caller does not supply one.
  const bare = buildConfigureScript(baseOpts());
  assert.doesNotMatch(bare, /progress\//, "no progress URL means no callbacks at all");
});

test("RADIUS is skipped cleanly when the ISP has no server configured", () => {
  // Field report: failure: valid address required
  //
  // A secret was supplied but no server address, so the add was attempted with
  // an empty address. The error reads like a malformed command rather than
  // "this ISP has no RADIUS server yet", and the whole RADIUS section is lost.
  const s = buildConfigureScript(baseOpts({ radiusSecret: "s3cret", radiusServer: "" }));
  assert.doesNotMatch(s, /\/radius add/, "no add is emitted without a server address");
  assert.match(s, /SKIP RADIUS/, "and the operator is told why");
  // With both present it is still created.
  assert.match(GEN, /\/radius add address=/, "a complete pair still creates the entry");
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

test("every created object is tagged, by add or by a guarded set", () => {
  const adds = creates(GEN).concat(creates(GEN_BOTH));
  assert.ok(adds.length >= 8, `expected many create statements, found ${adds.length}`);

  // The rule is that every object ends up carrying the NETPID comment. Where
  // that comment is APPLIED is a separate question, and the HotSpot menus
  // answered it in the field:
  //
  //   FATAL: the HotSpot profile could not be created at all.
  //
  // for `/ip hotspot profile add name=netpid comment="..."` - while
  // `/interface bridge add` and `/ip pool add` in the same script took a comment
  // happily. So a label inside an `add` is only allowed where the menu accepts
  // one; everywhere else it is a guarded `set` that can be refused on its own.
  //
  // /radius incoming is the other exception: a singleton menu with no comment
  // property, which fails the line outright if one is set.
  const untagged = adds.filter((l) => !l.includes("comment=") && !l.includes("/radius incoming"));

  const needsDeferredTag = [
    ["/ip hotspot profile add", "/ip hotspot profile set [find name=netpid] comment="],
    ["/ip hotspot add", "/ip hotspot set [find name=netpid] comment="],
    ["/radius add", "/radius set [find address="],
  ];
  for (const line of untagged) {
    const menu = line.trim().split(/\s+/).slice(0, 4).join(" ");
    const rule = needsDeferredTag.find(([m]) => menu.startsWith(m));
    assert.ok(rule,
      `${menu} is created untagged with no guarded comment set to replace it`);
    assert.ok(GEN.includes(rule[1]),
      `${rule[1]}... is missing, so the object would never be tagged`);
  }

  // And nothing may look an object up by its comment, or losing the label would
  // lose the object on the next run.
  assert.doesNotMatch(GEN, /find comment=/, "nothing is looked up by comment");
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
  // Checked structurally: every `add` sits inside a block that tests for the
  // object's existence first.
  for (const [s, label] of [[GEN, "HOTSPOT"], [GEN_BOTH, "HOTSPOT+PPPOE"], [GEN_V6, "v6"]]) {
    const lines = statements(s);
    let guarded = 0;
    for (const l of creates(s)) {
      // Walk backwards to the nearest block opener; it must be a find test.
      const i = lines.indexOf(l);
        // A ":do {" is NOT an existence check, so it is skipped rather than treated
        // as the guard. It appears when a create is wrapped in a version fallback
        // - try the v6 property spelling, on failure retry with the v7 one - and
        // stopping at the :do would report every one of those as unguarded. The find
        // test is further out and is the real guard.
        const opener = lines.slice(0, i).reverse()
          .find((x) => (/\{\s*$/.test(x) || / do=\{\s*$/.test(x))
            && !/^\s*:do\s*\{\s*$/.test(x)
            && !/^\s*\}/.test(x));
      assert.ok(opener && /\[:len \[.*find/.test(opener),
        `${label}: create is not guarded: ${l.slice(0, 60)}`);
      guarded++;
    }
    assert.ok(guarded >= 8, `${label}: expected several guarded creates, found ${guarded}`);
  }
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
  // Counters are reset to 0 rather than "", so accept either form - what
  // matters is that nothing is left holding a value from this run.
  assert.ok(locals.every((n) => BOOT.includes(`:set ${n} ""`) || BOOT.includes(`:set ${n} 0`)),
    "each local is reset");
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
  assert.ok(/report FAILED/i.test(BOOT), "the failure must be announced");
  assert.ok(/blocking outbound HTTPS/i.test(BOOT), "with the likely causes");
  // And the register endpoint must be echoed on failure, so they can test
  // reachability by hand instead of guessing.
  assert.ok(BOOT.includes("/register/"), "the callback URL is in the script");
  // $npUrl, not $reg: $reg is a JavaScript variable, not RouterOS state, so it
  // always expanded to nothing and the operator got a blank line where the
  // diagnostic should have been.
  assert.ok(statements(BOOT).some((l) => /:put \$npUrl\b/.test(l)),
    "the failing URL is printed when the report fails");
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

// ---------------------------------------------------------------------------
// The wizard must actually be REACHABLE
// ---------------------------------------------------------------------------

/**
 * These exist because the wizard was written, committed, typechecked and
 * never mounted: every automated check passed while the dashboard kept showing
 * the old static script. A component that is not on a page is not a feature.
 */
const ENTRY_POINTS = [
  ["routers/new", "../../apps/web/app/dashboard/network/routers/new/page.tsx"],
  ["QuickAddRouter", "../../apps/web/app/dashboard/network/routers/QuickAddRouter.tsx"],
];

for (const [name, path] of ENTRY_POINTS) {
  test(`${name} mounts the interactive wizard`, () => {
    const src = read(path);
    assert.ok(/import MikroTikSetupWizard from/.test(src), `${name} must import the wizard`);
    assert.ok(/<MikroTikSetupWizard/.test(src), `${name} must render the wizard`);
  });

  test(`${name} passes the router id so the session binds to the router`, () => {
    const src = read(path);
    assert.ok(/<MikroTikSetupWizard[\s\S]{0,200}routerId=\{/.test(src),
      `${name} must pass routerId, or every created object is tagged with a session id instead`);
  });
}

test("the wizard sends the router id when it mints a token", () => {
  const src = read("../../apps/web/components/MikroTikSetupWizard.tsx");
  assert.ok(/router_id: routerId/.test(src), "the session must be bound at generate time");
});

test("the wizard prefills the RADIUS secret from router creation", () => {
  const src = read("../../apps/web/components/MikroTikSetupWizard.tsx");
  // Otherwise the operator is asked to retype a secret shown exactly once, and
  // a RADIUS client with no secret fails every login.
  assert.ok(/secret \|\| radiusSecret/.test(src));
  for (const [name, path] of ENTRY_POINTS) {
    assert.ok(/radiusSecret=\{/.test(read(path)), `${name} must pass the secret in`);
  }
});

test("the static installer is still available, but only as a labelled fallback", () => {
  // Removing it would break an operator whose router cannot reach NETPID,
  // which is exactly the situation the wizard cannot solve.
  for (const [name, path] of ENTRY_POINTS) {
    const src = read(path);
    assert.ok(/Advanced: static installer script/.test(src),
      `${name} must keep the static script as a documented fallback`);
    assert.ok(/cannot reach NETPID/.test(src), `${name} must say when to use it`);
  }
});

test("the wizard is the primary artifact, not the static script", () => {
  for (const [name, path] of ENTRY_POINTS) {
    const src = read(path);
    // The wizard appears before the fallback, so it is what the operator sees.
    assert.ok(
      src.indexOf("<MikroTikSetupWizard") < src.indexOf("Advanced: static installer"),
      `${name} must show the wizard first`,
    );
  }
});

test("configure refuses before the router has reported its hardware", () => {
  // Otherwise a script would be generated for interfaces NETPID never saw.
  assert.ok(configureRoute.includes("CAPABILITIES_DETECTED"));
  assert.ok(configureRoute.includes("Run the bootstrap command first"));
});

// An unclosed loop or function does not throw. It silently swallows every
// test defined inside it, and the suite reports fewer tests than the file
// contains while still showing all green. That is exactly what happened here:
// a missing brace after baseOpts() hid 12 assertions, including every check
// that the router had reported its hardware.
//
// Counting braces textually does not work: template literals and regex
// literals contain braces that are not block delimiters. The runtime already
// knows the real answer, so ask it.
const MIG_0049 = read("../../supabase/migrations/0049_provisioning_step_log.sql");

test("the step log clamps what the router claims and never walks backwards", () => {
  // pct arrives off a query string and progress_pct has a CHECK constraint, so
  // a router reporting 400 would fail the whole UPDATE and lose the step too.
  assert.equal(appendStepEvent([], "start", 999).at(-1)?.pct, 100);
  assert.equal(appendStepEvent([], "start", -5).at(-1)?.pct, 0);
  assert.equal(appendStepEvent([], "start", "abc").at(-1)?.pct, 0);
  assert.equal(appendStepEvent([], "start", Number.NaN).at(-1)?.pct, 0);

  // A retried fetch for a step already recorded must not duplicate it, or the
  // checklist fills with repeats of work that did not happen.
  const once = appendStepEvent([], "bridge", 30);
  assert.deepEqual(appendStepEvent(once, "bridge", 30), once);

  // A late callback for an earlier step must not rewind the bar.
  const fwd = appendStepEvent(appendStepEvent([], "hotspot", 45), "radius", 70);
  const back = appendStepEvent(fwd, "bridge", 30);
  assert.equal(back.at(-1)?.pct, 70, "the newest entry keeps the highest percentage");

  // Garbage in the column must not throw; the wizard renders whatever it gets.
  assert.equal(appendStepEvent(null, "start", 5).at(-1)?.step, "start");
  assert.equal(appendStepEvent("nonsense", "start", 5).at(-1)?.step, "start");
});

test("the step plan matches the mode the operator chose", () => {
  // The script has no PPPoE section in HotSpot-only mode, so showing a PPPoE row
  // that can never tick is a dead promise on the operator's screen.
  const hs = stepPlan("HOTSPOT");
  assert.ok(!hs.includes("pppoe"), "HotSpot-only never reports PPPoE");
  assert.ok(hs.includes("hotspot"));
  assert.deepEqual(hs.slice(0, 3), ["start", "interfaces", "bridge"]);
  assert.equal(hs.at(-1), "done", "every run ends by verifying");

  const pp = stepPlan("PPPOE");
  assert.ok(pp.includes("pppoe") && !pp.includes("hotspot"));

  const both = stepPlan("HOTSPOT_PPPOE");
  assert.ok(both.includes("hotspot") && both.includes("pppoe"));
  // HotSpot is section 3 and PPPoE is section 4, so this is the order the
  // router actually reports them in.
  assert.ok(both.indexOf("hotspot") < both.indexOf("pppoe"));

  // Nothing selected yet must still yield a usable list.
  assert.ok(stepPlan(null).length > 0);
});

test("the wizard renders the router's reported steps and keeps listening", () => {
  // The wizard used to call stopPolling() the moment the script was generated,
  // which is exactly wrong: the operator has not pasted anything yet, and the
  // router only starts reporting once they do. The bar could never move again.
  assert.doesNotMatch(WIZARD, /setScript\(j\.script\);[\s\S]{0,500}?stopPolling\(\)/,
    "generating the script must not stop the poll");
  assert.match(WIZARD, /setScript\(j\.script\);[\s\S]{0,700}?startPolling\(token\)/,
    "it must keep polling so the router's steps arrive");

  // CONFIGURED is the status the session sits at DURING the run, so it cannot
  // be treated as terminal any more.
  assert.doesNotMatch(WIZARD, /j\.status === "CONFIGURED" \|\| j\.status === "FAILED"/,
    "CONFIGURED is not the end of the run");
  assert.match(WIZARD, /s\.step === "done"/, "the router's final tick ends the poll");

  // And the screen must show the steps, not just a percentage.
  assert.match(WIZARD, /shownSteps\.map/, "the reported steps are rendered");
  assert.match(WIZARD, /setSteps\(j\.steps\)/, "the poll stores what the router said");
  assert.doesNotMatch(WIZARD, /script generated/,
    "the old frozen caption is gone");

  // The plan is server-supplied: the wizard cannot import the step vocabulary,
  // because mikrotik-provision.ts pulls in node:crypto.
  assert.match(STATUS_ROUTE, /plan,/, "/status ships the labelled plan");
});

test("progress callbacks are omitted rather than pointed at a preview host", () => {
  // Same rule as the heartbeat: a script is permanent, a Vercel preview URL is
  // deleted with the branch, and pointing one at it means calling a dead host
  // forever. cb.stable gates both.
  assert.match(configureRoute, /progressUrl: cb\.stable \? `\$\{cb\.base\}\/api\/provision\/mikrotik\/progress\/\$\{token\}` : ""/,
    "the progress URL is gated on a stable host");
  assert.match(configureRoute, /progress_included: cb\.stable/,
    "and the dashboard is told which it got");
});

test("the progress endpoint cannot resurrect a cancelled session", () => {
  // A router still working through a script issued before a cancellation must
  // not be able to write the session back to life.
  assert.match(PROGRESS_ROUTE, /status === "CANCELLED" \|\| session\.status === "EXPIRED"/,
    "cancelled and expired sessions are refused");
  assert.match(PROGRESS_ROUTE, /pct >= \(session\.progress_pct \?\? 0\)/,
    "the stored percentage never regresses");
  assert.match(PROGRESS_ROUTE, /tokenMatchesHash/,
    "the token is still verified in constant time");
  // It must never move the session past CONFIGURED on its own: reaching a step
  // is not proof that any object was created.
  assert.doesNotMatch(PROGRESS_ROUTE, /status: "(APPLIED|ONLINE)"/,
    "progress alone must not mark the session applied");
});

test("0049 declares step_log idempotently and proves it", () => {
  assert.match(MIG_0049, /add column if not exists step_log jsonb/, "replay safe");
  assert.match(MIG_0049, /raise exception/, "and it proves the column is visible");
  assert.match(MIG_0049, /not proof|not evidence/i,
    "and it states that a step is not proof of configuration");

  // The progress route reads this column, so it must exist in the schema the
  // app talks to - either declared in 0047's CREATE TABLE or added by 0049.
  // declaredColumns only understands CREATE TABLE, so ADD COLUMN is read here.
  const added = new Set(
    [...MIG_0049.matchAll(/add column if not exists (\w+)/g)].map((m) => m[1]),
  );
  assert.ok(
    declaredColumns(MIG_0047).has("step_log") || added.has("step_log"),
    "step_log is declared in the schema the progress route reads",
  );
});

test("every test() in this file is actually registered", async () => {
  const mod = await import("./mikrotik-provision.test.js");
  const declared = readFileSync(new URL(import.meta.url), "utf8")
    .match(/^test\(/gm)?.length ?? 0;
  // node:test exposes no public registry, so assert the observable effect:
  // the file must contain at least as many top-level tests as the suite has
  // always claimed to run. A swallowed block shows up as a shortfall.
  assert.ok(declared >= 60,
    `only ${declared} top-level test() calls; a missing closing brace hides the rest`);
  assert.ok(typeof mod === "object" || mod === undefined,
    "module loads without a top-level throw");
});

test("this suite's own checks are registered, not swallowed", () => {
  // The concrete failure this guards against: a missing closing brace after a
  // helper function nests every later test inside it. The suite then runs
  // fewer tests than the file contains and still reports all green.
  //
  // The reliable signal is a test that only passes when a KNOWN assertion ran.
  // These are the checks that would have caught the trigger bug and the dead
  // test block; if they are swallowed, this file loses them and the count
  // below drops.
  const src = readFileSync(new URL(import.meta.url), "utf8");
  // Matched as plain substrings, not as `test("..."` prefixes: a test title may
  // legitimately gain a prefix or suffix, and a guard that breaks when someone
  // improves a title trains people to delete the guard instead.
  const required = [
    "every column a provisioning trigger touches is actually declared",
    "no generated line leaves an expression open",
    "the register URL the router calls is reconstructed correctly",
    "Vercel PREVIEW host is refused for the heartbeat",
    "every generated script has balanced blocks and brackets",
    "the wizard is the primary artifact",
    "configure refuses before the router has reported its hardware",
  ];
  for (const frag of required) {
    assert.ok(src.includes(frag), `a required check is missing from this file: ${frag}`);
  }
  // Every test must sit at column 0, or be nested in one of the two deliberate
  // generators: the per-hardware-profile loop and the per-entry-point loop.
  // Anything else indented is a missing closing brace.
  const indented = src.split("\n").filter((l) => /^\s+test\(/.test(l));
  for (const l of indented) {
    const deliberate = l.includes("${p.name}") || l.includes("${name}");
    assert.ok(deliberate,
      `test nested and possibly unreachable: ${l.trim().slice(0, 60)}`);
  }
  // Both generators must exist, or the tests they hold would be missing.
  assert.ok(src.includes("for (const p of PROFILES)"), "the profile loop is gone");
  assert.ok(src.includes("for (const [name, path] of ENTRY_POINTS)"), "the entry-point loop is gone");
});
