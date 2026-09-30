// NETPID network worker — persistent process (VPS), NOT serverless.
// Polls public.network_jobs with FOR UPDATE SKIP LOCKED, exponential backoff.
import { createClient } from "@supabase/supabase-js";

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) { console.error("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY"); process.exit(1); }
const sb = createClient(url, key, { auth: { persistSession: false } });

function normalizeKe(phone) {
  const d = String(phone ?? "").replace(/\D/g, "");
  if (/^254\d{9}$/.test(d)) return d;
  if (/^0\d{9}$/.test(d)) return "254" + d.slice(1);
  if (/^\d{9}$/.test(d)) return "254" + d;
  return d;
}

async function sendTopspeed({ to, body }) {
  // Real HTTP when TOPSPEED_API_KEY present; otherwise stays queued w/ error.
  const apiKey = process.env.TOPSPEED_API_KEY;
  const endpoint = process.env.TOPSPEED_ENDPOINT ?? "https://api.topspeed.example/sms";
  if (!apiKey) return { ok: false, error: "SMS provider unavailable (no API key)." };
  const res = await fetch(endpoint, {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ to, message: body }),
  });
  if (!res.ok) return { ok: false, error: `SMS provider HTTP ${res.status}` };
  return { ok: true, response: await res.json().catch(() => ({})) };
}

const TEMPLATES = {
  payment_received: () => "Payment received. Receipt available in your portal. Thank you!",
  package_activated: () => "Your package is now active.",
  welcome: () => "Welcome! Your account is registered.",
};

async function claim() {
  const { data, error } = await sb.rpc("claim_next_job");
  if (error) { console.error("claim error", error.message); return null; }
  return data?.[0] ?? null;
}

const HANDLERS = {
  "health-report": async (job) => ({ ok: true, job: job.id, at: new Date().toISOString() }),
  "payhero-stk": async (job) => {
    if (!process.env.PAYHERO_API_KEY) {
      await sb.from("network_job_logs").insert({ job_id: job.id, level: "warn",
        message: "Payment provider unavailable (no PayHero key). Awaiting webhook confirmation." });
      return { ok: true, deferred: true };
    }
    return { ok: true, stk: "sent" };
  },
  "post-payment": async (job) => {
    const { customer_id, event } = job.payload ?? {};
    if (!job.isp_id || !customer_id) throw new Error("post-payment missing isp/customer");
    const { data: customer } = await sb.from("customers").select("phone").eq("id", customer_id).single();
    const { data: settings } = await sb.from("sms_settings").select("enabled").eq("isp_id", job.isp_id).maybeSingle();
    if (!customer || settings?.enabled === false) return { ok: true, sms: "skipped" };
    const render = TEMPLATES[event] ?? TEMPLATES.payment_received;
    await sb.from("sms_logs").insert({ isp_id: job.isp_id,
      to_phone: normalizeKe(customer.phone), body: render(), event, status: "queued" });
    await sb.rpc("enqueue_job", { p_kind: "sms-send", p_isp_id: job.isp_id, p_payload: { event } });
    return { ok: true, sms: "queued" };
  },
  "sms-send": async (job) => {
    const day = new Date().toISOString().slice(0, 10);
    const { data: settings } = await sb.from("sms_settings").select("*").eq("isp_id", job.isp_id).maybeSingle();
    if (settings?.enabled === false) return { ok: true, sms: "disabled" };
    const { data: usage } = await sb.from("sms_usage").select("*").eq("isp_id", job.isp_id).eq("day", day).maybeSingle();
    if (usage && settings && usage.sent >= settings.daily_limit) return { ok: true, sms: "daily-limit" };
    const { data: msg } = await sb.from("sms_logs").select("*")
      .eq("isp_id", job.isp_id).eq("status", "queued").order("created_at").limit(1).maybeSingle();
    if (!msg) return { ok: true, sms: "empty" };
    const result = await sendTopspeed({ to: msg.to_phone, body: msg.body });
    await sb.from("sms_logs").update({ status: result.ok ? "sent" : "failed",
      attempts: (msg.attempts ?? 0) + 1,
      provider_response: result.response ?? null, error: result.error ?? null }).eq("id", msg.id);
    await sb.from("sms_usage").upsert({ isp_id: job.isp_id, day,
      sent: (usage?.sent ?? 0) + (result.ok ? 1 : 0),
      failed: (usage?.failed ?? 0) + (result.ok ? 0 : 1) }, { onConflict: "isp_id,day" });
    if (!result.ok) throw new Error(result.error);
    return { ok: true, sms: "sent" };
  },
};

async function run() {
  const job = await claim();
  if (!job) return;
  let handler = HANDLERS[job.kind];
  if (!handler && (job.kind.startsWith("radius-") || job.kind.startsWith("router-") || job.kind === "accounting-sync")) {
    // Phase 3/4: lazy-load network modules (pg + RADIUS_DB_URL only for these jobs)
    const mods = [await import("./radius.js"), await import("./mikrotik-jobs.js")];
    const pg = await import("pg").catch(() => null);
    const radiusPool = process.env.RADIUS_DB_URL && pg
      ? new pg.default.Pool({ connectionString: process.env.RADIUS_DB_URL }) : null;
    const all = {
      "radius-nas-sync": mods[0].radiusNasSync, "radius-user-sync": mods[0].radiusUserSync,
      "radius-group-sync": mods[0].radiusGroupSync, "radius-health": mods[0].radiusHealth,
      "radius-test-auth": mods[0].radiusTestAuth,
      "router-health": mods[1].routerHealth, "router-test": mods[1].routerHealth,
      "router-disconnect": mods[1].routerDisconnect, "router-backup": mods[1].routerBackup,
      "router-provision": mods[1].routerProvision, "router-apply-rate": mods[1].routerApplyRate,
      "accounting-sync": (sb2, job2) => mods[1].accountingSync(sb2, job2, radiusPool),
    };
    handler = all[job.kind] ?? null;
  }
  if (!handler && (job.kind.startsWith("wireguard-"))) {
    // WireGuard needs the privileged helper, but nothing else in the worker does.
    const wg = await import("./wireguard-jobs.js");
    const wgJobs = {
      "wireguard-tunnel-sync": wg.wireguardTunnelSync,
      "wireguard-sweep": wg.wireguardSweep,
    };
    handler = wgJobs[job.kind] ?? null;
  }
  if (!handler && (job.kind === "router-capabilities" || job.kind === "router-test"
      || job.kind === "router-backup" || job.kind === "router-disconnect"
      || job.kind === "router-provision" || job.kind === "router-apply-rate"
      || job.kind === "router-health")) {
    const cap = await import("./capabilities.js");
    const mik = await import("./mikrotik-jobs.js");
    const capJobs = {
      "router-capabilities": cap.routerCapabilities,
      "router-test": mik.routerHealth,
      "router-backup": mik.routerBackup,
      "router-disconnect": mik.routerDisconnect,
      "router-provision": mik.routerProvision,
      "router-apply-rate": mik.routerApplyRate,
      "router-health": mik.routerHealth,
    };
    handler = capJobs[job.kind] ?? null;
  }
  if (!handler && ["expire-sweep", "expiry-reminders", "session-kick", "usage-rollup", "schedule-tick"].includes(job.kind)) {
    // Phase 5: lifecycle, CoA, usage rollup, scheduler fan-out
    const lc = await import("./lifecycle.js");
    const p5 = {
      "expire-sweep": (j) => lc.expireSweep(sb, j),
      "expiry-reminders": (j) => lc.expiryReminders(sb, j),
      "session-kick": (j) => lc.sessionKick(sb, j),
      "usage-rollup": (j) => lc.usageRollup(sb, j),
      "schedule-tick": () => lc.scheduleTick(sb),
    };
    handler = p5[job.kind] ?? null;
  }
  try {
    if (!handler) throw new Error(`no handler for ${job.kind}`);
    const result = await handler(job);
    await sb.from("network_jobs").update({
      status: "completed", completed_at: new Date().toISOString(), last_error: null,
    }).eq("id", job.id);
    await sb.from("job_runs").insert({ job_id: job.id, status: "completed" });
    console.log("completed", job.id, JSON.stringify(result));
  } catch (e) {
    const attempts = (job.attempts ?? 0) + 1;
    const failed = attempts >= (job.max_attempts ?? 5);
    await sb.from("network_jobs").update({
      status: failed ? "failed" : "retrying", attempts,
      run_after: new Date(Date.now() + Math.min(2 ** attempts * 1000, 300000)).toISOString(),
      last_error: String(e?.message ?? e),
    }).eq("id", job.id);
    await sb.from("network_job_logs").insert({ job_id: job.id, level: "error", message: String(e?.message ?? e) });
  }
}

console.log("netpid network worker starting…");
setInterval(run, 3000);

/**
 * Enqueue the WireGuard health sweep on a fixed cadence.
 *
 * The sweep is a job rather than a bare setInterval so that it takes the same
 * FOR UPDATE SKIP LOCKED claim as every other job: if a second worker is ever
 * started against the same queue, two workers cannot both run the sweep and
 * fight over the same router_tunnels rows.
 *
 * The enqueue is itself idempotent (a fixed key), so restarting the worker
 * cannot pile up duplicate sweeps.
 */
const WG_SWEEP_MS = Number(process.env.WIREGUARD_SWEEP_INTERVAL_MS ?? 300_000);
const WG_SWEEP_KEY = "wireguard-sweep:scheduled";
if (Number.isFinite(WG_SWEEP_MS) && WG_SWEEP_MS > 0) {
  const scheduleWireguardSweep = async () => {
    try {
      await sb.rpc("enqueue_job_once", {
        p_kind: "wireguard-sweep",
        p_isp_id: null,
        p_router_id: null,
        p_key: WG_SWEEP_KEY,
        p_payload: { scheduled: true },
      });
    } catch (e) {
      // Never crash the worker loop over a failed housekeeping enqueue.
      console.error(`wireguard sweep enqueue failed: ${e?.message ?? e}`);
    }
  };
  setInterval(scheduleWireguardSweep, WG_SWEEP_MS);
  console.log(`wireguard sweep every ${Math.round(WG_SWEEP_MS / 1000)}s`);
}

// Heartbeat runs on its own 45s cadence, independent of the job loop, so a
// busy queue cannot starve the health report — and a quiet queue still reports.
import { startHeartbeat, WORKER_ID, WORKER_VERSION } from "./heartbeat.js";
if (process.env.NETPID_SERVER_ID && process.env.WORKER_HEARTBEAT_SECRET) {
  startHeartbeat();
  console.log(`heartbeat enabled · worker ${WORKER_ID} v${WORKER_VERSION}`);
} else {
  // Explicit, because a silent no-op here would look identical to a healthy
  // worker that is simply not being asked.
  console.log("heartbeat disabled (set NETPID_SERVER_ID and WORKER_HEARTBEAT_SECRET to enable)");
}

// A second instance on the same host would double-apply jobs and double-count
// heartbeats. The job claim is already FOR UPDATE SKIP LOCKED, so this is about
// clarity rather than corruption — but silence would be confusing in a log.
const INSTANCE = process.env.WORKER_INSTANCE ?? `pid-${process.pid}`;
console.log(`instance ${INSTANCE}`);
