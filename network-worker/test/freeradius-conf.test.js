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
