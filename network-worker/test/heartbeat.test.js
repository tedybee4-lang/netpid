// The heartbeat is the only thing that tells the Super Admin console this VPS
// exists. Two properties are worth pinning here rather than in a code review:
//
//   1. the payload matches the zod schema in apps/web/app/api/worker/heartbeat
//      — a stray key is silently stripped, and a missing one silently degrades
//      the console, so neither failure is visible without a test;
//   2. no credential can leave the box, however the payload is assembled.
//
// Env is set BEFORE the import on purpose: the module reads it at load time,
// which is exactly why a careless refactor can start shipping it.

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFileSync } from "node:fs";

const SECRET = "s3cr3t-heartbeat-shared-value";
const SERVICE_ROLE = "super-secret-service-role-key";
const PAYHERO = "payhero-api-key-value";
const PORT = 39217;

process.env.NETPID_SERVER_ID = "11111111-2222-3333-4444-555555555555";
process.env.WORKER_HEARTBEAT_SECRET = SECRET;
process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE_ROLE;
process.env.PAYHERO_API_KEY = PAYHERO;
process.env.NETPID_HEARTBEAT_URL = `http://127.0.0.1:${PORT}/api/worker/heartbeat`;

// Mirrors the zod schema in apps/web/app/api/worker/heartbeat/route.ts. A key
// added to the payload but not here fails this test instead of vanishing.
const ALLOWED = new Set([
  "server_id", "worker_id", "worker_version", "status", "cpu_percent", "mem_percent",
  "disk_percent", "uptime_seconds", "radius_running", "wireguard_active",
  "firewall_active", "jobs_processed", "os_name", "kernel", "detail",
]);

let captured = null;
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => { body += c; });
  req.on("end", () => {
    captured = { header: req.headers["x-netpid-heartbeat"], body };
    if (req.url.includes("fail=1")) {
      // Mirrors the console failing closed when WORKER_HEARTBEAT_SECRET is unset.
      res.writeHead(503, { "content-type": "application/json" });
      res.end('{"error":"Heartbeat endpoint is not configured"}');
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"ok":true}');
  });
});
await new Promise((r) => server.listen(PORT, "127.0.0.1", r));
test.after(() => server.close());

const { buildHeartbeat, sendHeartbeat, startHeartbeat, stopHeartbeat, WORKER_ID, WORKER_VERSION } =
  await import("../src/heartbeat.js");

// Strips comments so an assertion about CODE cannot be satisfied or broken by
// prose that merely names a command. Block comments go first: the JSDoc headers
// are multi-line, and a per-line pass cannot touch them.
function codeOf(file) {
  return readFileSync(new URL(file, import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");
}

test("every payload key is declared in the API schema", () => {
  buildHeartbeat();
  const beat = buildHeartbeat();
  for (const key of Object.keys(beat)) {
    assert.ok(ALLOWED.has(key), `undeclared key "${key}" would be stripped by zod`);
  }
});

test("required fields are present and well typed", () => {
  const beat = buildHeartbeat(7);
  assert.equal(beat.server_id, process.env.NETPID_SERVER_ID);
  assert.equal(beat.worker_id, WORKER_ID);
  assert.equal(beat.status, "ok");
  assert.equal(beat.jobs_processed, 7);
  assert.equal(beat.worker_version, WORKER_VERSION);
  assert.ok(beat.worker_id.length > 0 && beat.worker_id.length <= 80);
  assert.ok(Number.isInteger(beat.uptime_seconds) && beat.uptime_seconds >= 0);
  assert.equal(typeof beat.detail, "object");
});

test("percentages are in range whenever they are reported", () => {
  buildHeartbeat(); // first call only primes the /proc/stat baseline
  const beat = buildHeartbeat();
  for (const k of ["cpu_percent", "mem_percent", "disk_percent"]) {
    if (beat[k] === undefined) continue;
    assert.ok(beat[k] >= 0 && beat[k] <= 100, `${k} out of range: ${beat[k]}`);
  }
});

test("a missing service is omitted, never reported as stopped", () => {
  // On a dev machine no radius/wireguard/firewall unit is installed. Sending
  // `false` here would make the console show a fault that does not exist.
  const beat = buildHeartbeat();
  for (const k of ["radius_running", "wireguard_active", "firewall_active"]) {
    assert.ok(beat[k] === undefined || typeof beat[k] === "boolean");
  }
});

// `wg show` needs CAP_NET_ADMIN, and the worker runs as the unprivileged
// netpid user, so a wg-based check could NEVER succeed: the console reported
// "unknown" for a tunnel that was up and carrying traffic. The interface flags
// in /sys/class/net answer the same question with no privilege at all.
test("wireguard is detected from /sys, never by shelling out to wg", () => {
  const code = codeOf("../src/heartbeat.js");
  assert.doesNotMatch(code, /\bwg\s+show\b/, "`wg show` cannot run as the netpid user");
  assert.match(code, /readdirSync\("\/sys\/class\/net"\)/);
  assert.match(code, /flags/, "IFF_UP is bit 0 of the interface flags file");
  // operstate is useless for WireGuard - it reports "unknown" even when the
  // tunnel is fully established - so the flags file is the only correct source.
  assert.doesNotMatch(code, /[`"']operstate[`"']/, "never read the operstate file");
});

test("no env value or credential appears anywhere in the serialised payload", () => {
  const raw = JSON.stringify(buildHeartbeat());
  for (const secret of [SECRET, SERVICE_ROLE, PAYHERO, "v1:", "PRIVATE KEY"]) {
    assert.equal(raw.includes(secret), false, `payload leaked ${secret.slice(0, 12)}...`);
  }
  // A belt-and-braces check that no key even *looks* like a credential field.
  for (const key of Object.keys(JSON.parse(raw))) {
    assert.doesNotMatch(key, /pass|secret|token|key|cred/i, `suspicious field "${key}"`);
  }
});

test("the shared secret travels in the header, and the body stays clean", async () => {
  const res = await sendHeartbeat();
  assert.equal(res.ok, true, `send failed: ${res.error}`);
  assert.equal(captured.header, SECRET, "secret must authenticate the request");
  const body = JSON.parse(captured.body);
  assert.equal(body.server_id, process.env.NETPID_SERVER_ID);
  assert.equal(captured.body.includes(SECRET), false, "secret must never be in the body");
});

test("an HTTP error from the console is reported, not thrown", async () => {
  // A cache-busting import re-evaluates the module with a failing endpoint.
  // If sendHeartbeat ever let a rejection escape, this would fail the worker's
  // event loop instead of just logging it.
  process.env.NETPID_HEARTBEAT_URL = `http://127.0.0.1:${PORT}/?fail=1`;
  const failing = await import("../src/heartbeat.js?fail=1");
  const res = await failing.sendHeartbeat();
  assert.equal(res.ok, false);
  assert.match(res.error, /HTTP 503/);
  process.env.NETPID_HEARTBEAT_URL = `http://127.0.0.1:${PORT}/`;
});

test("start and stop are safe to call repeatedly", () => {
  startHeartbeat();
  startHeartbeat();
  stopHeartbeat();
  stopHeartbeat();
  assert.ok(true);
});
