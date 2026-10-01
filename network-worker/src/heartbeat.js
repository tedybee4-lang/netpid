// Worker -> NETPID heartbeat.
//
// Reports resource metrics and service state so the Super Admin console can
// tell ONLINE from DELAYED from OFFLINE without an active SSH session.
//
// WHAT THIS NEVER SENDS: a password, a private key, an encryption key, an API
// token, or any env value. The payload is built field by field from local
// measurements only — there is no code path that reads a secret into it.

import fs from "fs";
import os from "os";
import crypto from "crypto";
import { execSync } from "child_process";

// The heartbeat destination is REQUIRED, never defaulted.
//
// A hardcoded production fallback is the exact failure this codebase already
// refuses to accept elsewhere: a worker with no NETPID_HEARTBEAT_URL configured
// would silently post live metrics to production, where the Super Admin console
// shows a healthy box that nobody is actually operating. Failing loudly at
// startup is the only safe answer, because a missing env var is a config
// mistake and config mistakes should be visible rather than defaulted away.
const HEARTBEAT_URL = process.env.NETPID_HEARTBEAT_URL;
if (!HEARTBEAT_URL) {
  throw new Error(
    "NETPID_HEARTBEAT_URL is not set. Point it at the stable production host, "
    + "e.g. https://<deployment-host>/api/worker/heartbeat. See "
    + "network-worker/scripts/PROVISIONING-ENV.md. Refusing to guess: a wrong "
    + "default reports a box as online against the wrong deployment.",
  );
}
const SECRET = process.env.WORKER_HEARTBEAT_SECRET;
const SERVER_ID = process.env.NETPID_SERVER_ID;
const INTERVAL_MS = Number(process.env.HEARTBEAT_INTERVAL_MS ?? 45_000);

// A stable per-host id. Prefers an explicit env value so a systemd unit can pin
// it; otherwise derives from the machine-id, which actually identifies the box
// and is stable across restarts.
function resolveWorkerId() {
  if (process.env.WORKER_ID) return process.env.WORKER_ID;
  for (const p of ["/etc/machine-id", "/var/lib/dbus/machine-id"]) {
    try {
      const v = fs.readFileSync(p, "utf8").trim();
      if (v) return `w-${v.slice(0, 12)}`;
    } catch { /* not present on every platform */ }
  }
  return `w-${crypto.createHash("sha256").update(os.hostname()).digest("hex").slice(0, 12)}`;
}

const WORKER_ID = resolveWorkerId();
const WORKER_VERSION = process.env.npm_package_version ?? "0.1.0";

/** A short command that never throws. Returns trimmed stdout, or null. */
function run(cmd) {
  try {
    return execSync(cmd, { encoding: "utf8", timeout: 5_000, stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

/**
 * Whether a systemd unit is LOADED. This deliberately does not claim the unit
 * is *running* — liveness is reported separately by the console's SSH probe, so
 * a unit that is loaded but dead is not misreported as healthy here.
 */
function unitLoaded(unit) {
  try {
    fs.accessSync(`/etc/systemd/system/${unit}`);
    return true;
  } catch {
    return null; // absent: report "unknown", not "inactive"
  }
}

/**
 * True/false for an installed service, and undefined when the unit is not
 * installed at all — "unknown" must never be flattened into "stopped".
 */
function serviceActive(unit) {
  const files = run(`systemctl list-unit-files ${unit}.service --no-legend --no-pager`);
  if (!files || !files.includes(`${unit}.service`)) return undefined;
  return run(`systemctl is-active ${unit}.service --no-pager`) === "active";
}

function firstService(...units) {
  for (const u of units) {
    const v = serviceActive(u);
    if (v !== undefined) return v;
  }
  return undefined;
}

function memInfo() {
  try {
    const m = fs.readFileSync("/proc/meminfo", "utf8");
    const total = Number(/MemTotal:\s+(\d+)/.exec(m)?.[1]) / 1024;
    const avail = Number(/MemAvailable:\s+(\d+)/.exec(m)?.[1]) / 1024;
    return {
      mem_total_mb: Math.round(total),
      mem_percent: total > 0 ? Math.round(((total - avail) / total) * 100) : undefined,
    };
  } catch {
    return {};
  }
}

function diskInfo() {
  // Routed through run() so a missing `df` (Windows, or a minimal container) is
  // caught quietly instead of writing to stderr on every 45-second beat.
  const out = run("df -P / | awk 'NR==2{print $2,$5}'");
  const [blocks, percent] = (out ?? "").trim().split(/\s+/);
  const total = Number(blocks);
  const used = Number(String(percent ?? "").replace("%", ""));
  if (!Number.isFinite(total) || !Number.isFinite(used)) return {};
  return {
    disk_percent: used,
    disk_total_gb: Math.round(total / 1_048_576),
  };
}

function osInfo() {
  const out = {};
  if (os.platform() === "linux") {
    out.kernel = run("uname -r") ?? undefined;
    try {
      const rel = fs.readFileSync("/etc/os-release", "utf8");
      out.os_name = /^PRETTY_NAME="?([^"\n]+)"?/m.exec(rel)?.[1];
    } catch { /* minimal images have no os-release */ }
  }
  return out;
}

// Delta-based CPU: reading /proc/stat twice is the only dependency-free way.
// The first sample primes the baseline and reports nothing.
let prevCpu = null;
function sampleCpu() {
  try {
    const parts = fs.readFileSync("/proc/stat", "utf8").split("\n")[0].slice(5)
      .trim().split(/\s+/).map(Number);
    const total = parts.reduce((s, v) => s + v, 0);
    const idle = parts[3] + parts[4];
    if (prevCpu && total > prevCpu.total) {
      const dTotal = total - prevCpu.total;
      const dIdle = idle - prevCpu.idle;
      const pct = Math.round(((dTotal - dIdle) / dTotal) * 100);
      prevCpu = { total, idle };
      return pct;
    }
    prevCpu = { total, idle };
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Whether a WireGuard interface exists and is up.
 *
 * `wg show` needs CAP_NET_ADMIN, and the worker deliberately runs as the
 * unprivileged `netpid` user — so a wg-based check could NEVER succeed and the
 * console showed "unknown" for a tunnel that was working. /sys/class/net is
 * world readable and answers the same question.
 *
 * Returns undefined when there is no wg interface at all, so an unconfigured
 * box is reported as unknown rather than as a broken tunnel.
 */
function wireguardState() {
  let entries;
  try {
    entries = fs.readdirSync("/sys/class/net");
  } catch {
    return undefined; // not Linux
  }
  const ifaces = entries.filter((n) => n.startsWith("wg"));
  if (!ifaces.length) return undefined;
  return ifaces.some((n) => {
    try {
      // IFF_UP is bit 0. `operstate` is NOT usable here: a WireGuard interface
      // reports "unknown" even when fully established, because it has no
      // carrier in the ARP sense.
      const flags = parseInt(fs.readFileSync(`/sys/class/net/${n}/flags`, "utf8").trim(), 16);
      return (flags & 0x1) === 0x1;
    } catch {
      return false;
    }
  });
}

export function buildHeartbeat(jobsProcessed = 0) {
  const load = os.loadavg()[0];
  const mem = memInfo();
  const disk = diskInfo();
  // Every top-level key here is declared in the zod schema of
  // apps/web/app/api/worker/heartbeat/route.ts. Anything extra would be silently
  // stripped on arrival, so totals go in `detail` instead of guessing.
  const payload = {
    server_id: SERVER_ID,
    worker_id: WORKER_ID,
    worker_version: WORKER_VERSION,
    status: "ok",
    uptime_seconds: Math.round(os.uptime()),
    jobs_processed: jobsProcessed,
    mem_percent: mem.mem_percent,
    disk_percent: disk.disk_percent,
    ...osInfo(),
  };

  const cpu = sampleCpu();
  if (cpu !== undefined) payload.cpu_percent = cpu;

  // Only a DEFINED service state is sent. An omitted key means "unknown" in the
  // console; a hardcoded false would read as "stopped" and raise a false alarm.
  const radius = firstService("freeradius3", "freeradius");
  if (radius !== undefined) payload.radius_running = radius;

  const wg = wireguardState();
  if (wg !== undefined) payload.wireguard_active = wg;

  const fw = firstService("ufw", "nftables", "firewalld");
  if (fw !== undefined) payload.firewall_active = fw;

  const detail = { load1: load, mem_total_mb: mem.mem_total_mb, disk_total_gb: disk.disk_total_gb };
  if (unitLoaded("netpid-worker.service") !== null) detail.worker_unit = "netpid-worker.service";
  payload.detail = detail;
  return payload;
}

let timer = null;
let consecutiveFailures = 0;
let sent = 0;

export async function sendHeartbeat() {
  if (!SERVER_ID || !SECRET) {
    // Do not pretend to be healthy when the worker was never wired to the
    // console — silence here is honest, a fake "ok" beat is not.
    return { ok: false, error: "heartbeat not configured" };
  }
  try {
    const res = await fetch(HEARTBEAT_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        // The shared secret travels in a header. It is never logged, never
        // placed in the URL, and never included in the payload.
        "x-netpid-heartbeat": SECRET,
      },
      body: JSON.stringify(buildHeartbeat(sent)),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    sent += 1;
    consecutiveFailures = 0;
    return { ok: true, warning: (await res.json().catch(() => ({}))).warning };
  } catch (e) {
    consecutiveFailures += 1;
    // Log the first few, then go quiet — a network outage should not fill a
    // journal on the VPS at 45-second intervals.
    if (consecutiveFailures <= 3) {
      console.error(`[heartbeat] ${e.message} (failure ${consecutiveFailures})`);
    }
    return { ok: false, error: e.message };
  }
}

export function startHeartbeat() {
  if (timer) return;
  // Beat immediately so a freshly started worker shows up without a 45s wait.
  sendHeartbeat();
  timer = setInterval(sendHeartbeat, INTERVAL_MS);
  timer.unref?.();
}

export function stopHeartbeat() {
  if (timer) clearInterval(timer);
  timer = null;
}

export { WORKER_ID, WORKER_VERSION };

