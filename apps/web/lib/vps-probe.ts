import { Client } from "ssh2";
import type { ServerRow } from "@/lib/vps";

// A single SSH probe that answers everything the console shows, in ONE
// connection. Chaining separate `systemctl is-active` round-trips would take
// five round-trips and make a slow link look like a dead server.
//
// SECURITY: the remote script only prints resource/service state. It has no
// access to, and never transmits, the credential, any key, or any env value.
// The `command` sent is a fixed literal — never built from user input.

const PROBE = [
  "echo __OS__$( . /etc/os-release 2>/dev/null; echo \"$PRETTY_NAME\" )",
  "echo __KERNEL__$(uname -r)",
  "echo __UPTIME__$(awk '{print int($1)}' /proc/uptime)",
  "echo __LOAD__$(cut -d' ' -f1 /proc/loadavg)",
  "echo __CPU__$(top -bn1 | awk '/Cpu\\(s\\)/{print 100-$8; exit}' | cut -d. -f1)",
  "echo __MEMTOT__$(awk '/MemTotal/{print int($2/1024)}' /proc/meminfo)",
  "echo __MEMUSED__$(awk '/MemAvailable/{print int(($2-$7)*100/$2)}' /proc/meminfo)",
  "echo __DISKTOT__$(df -BG / | awk 'NR==2{gsub(/G/,\"\",$2); print $2}')",
  "echo __DISKUSED__$(df -P / | awk 'NR==2{gsub(/%/,\"\",$5); print $5}')",
  "echo __WORKER__$(systemctl is-active netpid-worker 2>/dev/null || echo unknown)",
  "echo __RADIUS__$(systemctl is-active freeradius 2>/dev/null || echo unknown)",
  "echo __WG__$(wg show 2>/dev/null | head -1 | grep -q interface && echo active || echo inactive)",
  "echo __FW__$(ufw status 2>/dev/null | head -1 | grep -qi active && echo active || echo inactive)",
].join("; ");

export type ProbeResult = {
  ok: boolean;
  error?: string;
  os?: string;
  kernel?: string;
  uptimeSeconds?: number;
  load1?: string;
  cpuPercent?: number;
  memTotalMb?: number;
  memPercent?: number;
  diskTotalGb?: number;
  diskPercent?: number;
  worker?: string;
  radius?: string;
  wireguard?: string;
  firewall?: string;
  durationMs?: number;
};

function field(out: string, key: string): string | undefined {
  const line = out.split("\n").find((l) => l.startsWith(`__${key}__`));
  if (!line) return undefined;
  const v = line.slice(key.length + 4).trim();
  return v === "" ? undefined : v;
}
const num = (v?: string) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

/**
 * Connect, run the probe, disconnect. Bounded end to end by SSH_TIMEOUT_MS so
 * a black-holed host fails fast instead of holding a serverless invocation open
 * until the platform kills it.
 */
export async function probeServer(
  row: ServerRow,
  credential: string | null,
  timeoutMs = 12_000,
): Promise<ProbeResult> {
  const started = Date.now();
  if (!credential) {
    return { ok: false, error: "No credential stored — add one first." };
  }

  return new Promise<ProbeResult>((resolve) => {
    let settled = false;
    // Settle exactly once, whichever event arrives first.
    const done = (r: ProbeResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { conn.end(); } catch { /* already closed */ }
      resolve({ ...r, durationMs: Date.now() - started });
    };

    const conn = new Client();
    const timer = setTimeout(
      () => done({ ok: false, error: `No response within ${timeoutMs / 1000}s` }),
      timeoutMs,
    );

    conn.on("ready", () => {
      conn.exec(PROBE, (err, stream) => {
        if (err) return done({ ok: false, error: err.message });
        let out = "";
        let errOut = "";
        stream.on("data", (d: Buffer) => { out += d.toString(); });
        stream.stderr.on("data", (d: Buffer) => { errOut += d.toString(); });
        stream.on("close", () => {
          if (!field(out, "OS")) {
            return done({ ok: false, error: errOut.trim() || "Probe returned no output" });
          }
          done({
            ok: true,
            os: field(out, "OS"),
            kernel: field(out, "KERNEL"),
            uptimeSeconds: num(field(out, "UPTIME")),
            load1: field(out, "LOAD"),
            cpuPercent: num(field(out, "CPU")),
            memTotalMb: num(field(out, "MEMTOT")),
            memPercent: num(field(out, "MEMUSED")),
            diskTotalGb: num(field(out, "DISKTOT")),
            diskPercent: num(field(out, "DISKUSED")),
            worker: field(out, "WORKER") ?? "unknown",
            radius: field(out, "RADIUS") ?? "unknown",
            wireguard: field(out, "WG") ?? "unknown",
            firewall: field(out, "FW") ?? "unknown",
          });
        });
      });
    });

    conn.on("error", (e: Error) => done({ ok: false, error: e.message }));
    conn.on("close", () => {
      if (!settled) done({ ok: false, error: "Connection closed before a reply" });
    });

    const auth = row.auth_method === "key"
      ? { privateKey: credential }
      : { password: credential };
    conn.connect({
      host: row.ip_address,
      port: row.ssh_port,
      username: row.ssh_username,
      ...auth,
      // Vercel functions have no interactive TTY; ask for none.
      readyTimeout: timeoutMs,
      keepaliveInterval: 0,
    });
  });
}
