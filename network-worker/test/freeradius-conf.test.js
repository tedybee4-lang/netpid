import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const conf = readFileSync(join(here, "..", "..", "freeradius", "sql-tenant-aware.conf"), "utf8");

// Brace depth must end at 0 and never go negative. String contents are ignored
// so `%{...}` xlat braces inside queries don't confuse the count.
test("sql-tenant-aware.conf braces are balanced", () => {
  let depth = 0;
  let inString = false;
  for (let i = 0; i < conf.length; i++) {
    const c = conf[i];
    if (inString) {
      if (c === "\\") { i++; continue; }
      if (c === '"') inString = false;
      continue;
    }
    if (c === '"') { inString = true; continue; }
    if (c === "#") { while (i < conf.length && conf[i] !== "\n") i++; continue; }
    if (c === "{") depth++;
    if (c === "}") depth--;
    assert.ok(depth >= 0, `unbalanced } at byte ${i}`);
  }
  assert.equal(depth, 0, "unclosed section");
  assert.equal(inString, false, "unterminated string");
});

// rlm_sql 3.x selects accounting queries through the reference mechanism; the
// flat v2 items (accounting_start_query & friends) are silently ignored, which
// would disable the whole accounting lifecycle without an error.
test("accounting uses the FreeRADIUS 3 reference/type structure", () => {
  assert.match(conf, /accounting \{\s*\n\s*reference = "%\{tolower:type\./);
  for (const block of [
    "start {", "interim-update {", "stop {",
    "accounting-on {", "accounting-off {", "accounting {",
  ]) {
    assert.ok(conf.includes(block), `missing accounting block: ${block}`);
  }
  assert.ok(conf.includes('query = "SELECT true"'), "missing no-Acct-Status-Type fallback");
  assert.doesNotMatch(conf, /^\s*accounting_(start|stop|update|onoff)_query\s*=/m, "flat v2 query item");
  assert.ok(!conf.includes("acctgigawords_kept"), "nonexistent column acctgigawords_kept");
});

// Every accounting write is tenant-gated: no unguarded INSERT into radacct and
// every UPDATE carries netpid_resolve_isp().
test("accounting queries are tenant-scoped", () => {
  assert.doesNotMatch(conf, /postauth_query\s*=/, "flat v2 postauth_query item");
  const inserts = conf.match(/INSERT INTO radacct/g) ?? [];
  assert.equal(inserts.length, 3, "start + lost-Start interim + lost-Start stop inserts");
  const resolves = conf.match(/netpid_resolve_isp\(/g) ?? [];
  assert.ok(resolves.length >= 10, `expected tenant resolution in every query, saw ${resolves.length}`);
  // The v3 spelling, not the ignored v2 flat item.
  assert.match(conf, /post-auth \{\s*\n\s*query = "/);
});

// Boolean column: `enabled = 1` is a runtime error in PostgreSQL.
test("client_query is valid PostgreSQL", () => {
  assert.ok(conf.includes("WHERE enabled ORDER BY id"));
  assert.doesNotMatch(conf, /enabled = 1/);
});

// FreeRADIUS xlat alternation is `%{%{Attr}:-default}`. The default must be a
// literal or another attribute — `%l` is neither, and radiusd rejects the whole
// module at parse time with "Unknown attribute", so the server never starts.
//
// This shipped broken: the unit had a bad default on 16 lines and every test
// still passed, because nothing here ever invoked a real radiusd parse. This
// test is the stand-in for that.
test("xlat alternation defaults are literal or attributes, never %l", () => {
  assert.doesNotMatch(conf, /:%-?%l\}/, "%l is not a valid xlat default");
  // Scan the config only. The header comment documents the very syntax being
  // checked — `%{%{Attr}:-default}` — and a comment is not parsed by radiusd,
  // so the literal word "default" there must not be treated as a bad default.
  const code = conf.split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");
  // Every `:-` default must resolve to digits or a nested %{} expansion.
  for (const m of code.matchAll(/%\{%\{[^}]+\}:-([^}]*)\}/g)) {
    const dflt = m[1];
    assert.ok(
      /^-?\d+$/.test(dflt) || /^%\{/.test(dflt),
      `alternation default "${dflt}" is neither numeric nor an attribute`,
    );
  }
});

// The deploy step substitutes these two passwords on its way to
// /etc/freeradius/3.0/mods-available/sql. They MUST still be present here, and
// no OTHER placeholder may be left behind — an unsubstituted password silently
// makes FreeRADIUS fail to authenticate while looking configured.
test("exactly the two documented placeholders are present", () => {
  assert.match(conf, /CHANGE_ME_RADIUS_AUTH/);
  assert.match(conf, /CHANGE_ME_RADIUS_ACCT/);
  const others = [...conf.matchAll(/CHANGE_ME_\w+/g)].map((m) => m[0]);
  assert.deepEqual(
    [...new Set(others)].sort(),
    ["CHANGE_ME_RADIUS_ACCT", "CHANGE_ME_RADIUS_AUTH"],
    "an undocumented placeholder would be deployed verbatim",
  );
});

// radiusd validates every %{...} in a module query string at parse time, so ONE
// attribute that the installed dictionaries do not define makes the whole
// module unloadable and the server refuses to start — the failure looks like a
// syntax error pointing at unrelated nearby text.
//
// Acct-Interval (RFC 2866 attr 85) is optional and is genuinely absent from
// the freeradius3 package dictionaries, so the deployment adds it to the LOCAL
// dictionary. This test records that dependency so the omission is a visible,
// deliberate decision rather than a surprise on the next install.
test("the accounting module needs Acct-Interval, which packages omit", () => {
  assert.match(conf, /%\{%\{Acct-Interval\}:-0\}/, "module no longer uses Acct-Interval");
});
