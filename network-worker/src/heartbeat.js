// Worker → NETPID heartbeat.
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

const HEARTBEAT_URL =
  process.env.NETPID_HEARTBEAT_URL ?? "https://netpid.vercel.app/api/worker/heartbeat";
const SECRET = process.env.WORKER_HEARTBEAT_SECRET;
const SERVER_ID = process.env.NETPID_SERVER_ID;

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
  try {
    const out = execSync("df -P / | awk 'NR==2{print $2,$5}'", { encoding: "utf8" })
      .trim().split(/\s+/);
    return {
      disk_total_gb: Math.round(Number(out[0]) / 1_048_576),

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

export function buildHeartbeat(jobsProcessed = 0) {
  const load = os.loadavg()[0];
  return {
    server_id: SERVER_ID,
    worker_id: WORKER_ID,
    worker_version: WORKER_VERSION,
    status: "ok",
    cpu_percent: sampleCpu(),
    uptime_seconds: Math.floor(os.uptime()),
    os_name: `${os.type()} ${os.release()}`,
    jobs_processed: jobsProcessed,
    radius_running: unitLoaded("freeradius.service"),
    wireguard_active: unitLoaded("wg-quick@netpid.service") ?? unitLoaded("wg0.service"),
    firewall_active: unitLoaded("ufw.service") ?? unitLoaded("nftables.service"),
    ...memInfo(),
    ...diskInfo(),
    detail: { load_avg_1: load.toFixed(2), node: os.hostname() },
  };
}

let timer = null;
let sent = 0;
let consecutiveFailures = 0;

export async function sendHeartbeat() {
  // Fail closed and quietly: an unconfigured heartbeat must not spam the log
  // or, worse, silently pretend to be reporting.
  if (!SECRET || !SERVER_ID) return { ok: false, skipped: true };
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

      disk_percent: Number(String(out[1]).replace("%", "")),
    };
  } catch {
    return {};
  }
}

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
  try {
    const out = execSync("df -P / | awk 'NR==2{print $2,$5}'", { encoding: "utf8" })
      .trim().split(/\s+/);
    return {
      disk_total_gb: Math.round(Number(out[0]) / 1_048_576),
      disk_percent: Number(String(out[1]).replace("%", "")),
    };
  } catch {
    return {};
  }
}
