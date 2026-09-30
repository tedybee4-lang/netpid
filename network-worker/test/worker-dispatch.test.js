// Regression test for the worker job dispatcher.
//
// The dispatcher used to map BARE function references from radius.js,
// mikrotik-jobs.js, capabilities.js and wireguard-jobs.js into its job table.
// Every one of those exports takes `sb` as its first parameter, but run()
// invokes `handler(job)` — so the JOB was passed as `sb` and `job` arrived
// undefined. Every radius-*, router-* and wireguard-* job died with
// "Cannot read properties of undefined (reading 'payload')". router-backup was
// observed failing this way six times in the live jobs table.
//
// run() connects to Postgres on import, so the tables cannot be exercised
// directly from a unit test. This asserts their shape instead: no entry may
// map a bare reference, and each must forward the module-scope `sb` first.
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const src = readFileSync(path.join(HERE, "..", "src", "index.js"), "utf8");

test("the dispatcher invokes a handler with the job only", () => {
  assert.match(src, /await handler\(job\)/);
});

test("no job-table entry maps a bare function reference", () => {
  // e.g. `"router-backup": mods[1].routerBackup,` or `"router-test": mik.routerHealth,`
  const bare = src.match(/^\s*"[a-z0-9-]+":\s*(?:mods\[\d+\]|cap|mik|wg)\.[A-Za-z]+\s*,/gm) ?? [];
  assert.deepEqual(
    bare, [],
    `bare references reintroduced (these take sb as arg 1):\n${bare.join("\n")}`,
  );
});

test("every dynamic entry forwards the module-scope sb first", () => {
  // `mods[1].routerHealth` etc. — brackets are part of the member expression.
  const wrapped =
    [...src.matchAll(/^\s*"[a-z0-9-]+":\s*\(\)\s*=>\s*[\w.[\]]+\(sb\s*\)/gm)].length
    + [...src.matchAll(/^\s*"[a-z0-9-]+":\s*\(j\)\s*=>\s*[\w.[\]]+\(sb\s*,\s*j/gm)].length;
  // 12 (all) + 7 (capJobs) + 5 (lifecycle p5) + 2 (wgJobs) = 26
  assert.ok(wrapped >= 26, `only ${wrapped} entries pass sb; expected at least 26`);
});

test("the job kinds that were silently broken are all wrapped", () => {
  for (const kind of [
    "router-backup", "router-health", "router-test", "router-disconnect",
    "router-provision", "router-apply-rate", "router-capabilities",
    "radius-nas-sync", "radius-user-sync", "radius-group-sync",
    "radius-health", "radius-test-auth", "accounting-sync",
    "wireguard-tunnel-sync",
  ]) {
    assert.match(
      src, new RegExp(`"${kind}":\\s*\\(j\\)\\s*=>\\s*[\\w.[\\]]+\\(sb\\s*,\\s*j`),
      `${kind} is not forwarding sb`,
    );
  }
  // sweep takes sb only, never a job.
  assert.match(src, /"wireguard-sweep":\s*\(\)\s*=>\s*wg\.wireguardSweep\(sb\)/);
});

test("the inline HANDLERS table keeps its own (job)-only contract", () => {
  // These are defined in index.js and take (job) — they must NOT be wrapped,
  // or they would receive the wrong arity.
  assert.match(src, /"post-payment":\s*async\s*\(job\)\s*=>/);
  assert.match(src, /"sms-send":\s*async\s*\(job\)\s*=>/);
});

test("the SMS template renderer is wired into post-payment", () => {
  // Regression guard for the Phase C work: a stored sms_templates row must
  // actually decide the outgoing text, not a hardcoded string.
  assert.match(src, /import \{ resolveSmsBody[^}]*\} from "\.\/sms-templates\.js"/);
  assert.match(src, /await resolveSmsBody\(sb, \{ ispId: job\.isp_id, event: evt, vars \}\)/);
  assert.match(src, /if \(resolved\.disabled\)/);
});
