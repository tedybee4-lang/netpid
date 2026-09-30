// Phase 5 worker jobs: expiry engine, CoA/disconnect, usage rollup, fan-out.
// Dynamic-imported by index.js. CoA uses the built-in RFC 3576 client
// (radius-wire.js) so no `radclient` binary is required; fallback router-disconnect.
import { sendDisconnect } from "./radius-wire.js";
import { bareUsername } from "./radius-logic.js";
import { decryptSecret } from "./secrets.js";
import { resolveSmsBody, dateOnly } from "./sms-templates.js";

const COA_TIMEOUT_MS = Number(process.env.RADIUS_COA_TIMEOUT_MS) || 5000;

// One lookup per worker run rather than one per message: an expiry sweep can
// queue hundreds of SMS rows for the same ISP.
const ispNameCache = new Map();
async function ispName(sb, ispId) {
  if (ispNameCache.has(ispId)) return ispNameCache.get(ispId);
  const { data } = await sb.from("isps").select("name").eq("id", ispId).maybeSingle();
  const name = data?.name ?? "";
  ispNameCache.set(ispId, name);
  return name;
}

// `fallbackBody` is the wording used when the ISP has no template for `event`.
// A template that exists and is enabled always wins, so editing one changes what
// subscribers receive without a deploy. Disabled template => nothing is sent.
async function queueSms(sb, ispId, customer, event, fallbackBody) {
  const { data: settings } = await sb.from("sms_settings").select("enabled").eq("isp_id", ispId).maybeSingle();
  if (settings?.enabled === false) return;
  const d = String(customer.phone ?? "").replace(/\D/g, "");
  const to = /^254\d{9}$/.test(d) ? d : /^0\d{9}$/.test(d) ? "254" + d.slice(1) : d;

  const resolved = await resolveSmsBody(sb, {
    ispId, event, fallback: fallbackBody,
    vars: {
      name: customer.full_name ?? "",
      customer_no: customer.customer_no ?? "",
      phone: to,
      expiry: dateOnly(customer.expiry_date),
      isp: await ispName(sb, ispId),
    },
  });
  if (resolved.disabled) return;

  await sb.from("sms_logs").insert({ isp_id: ispId, to_phone: to, body: resolved.body, event, status: "queued" });
  await sb.rpc("enqueue_job", { p_kind: "sms-send", p_isp_id: ispId, p_payload: { event } });
}

// expire-sweep: active + past expiry → expired + RADIUS revoke + kick + SMS.
export async function expireSweep(sb, job) {
  const ispId = job.isp_id ?? job.payload?.isp_id ?? null;
  let q = sb.from("customers").select("id, isp_id, phone, full_name, username, expiry_date, customer_no")
    .eq("status", "active").lt("expiry_date", new Date().toISOString()).limit(500);
  if (ispId) q = q.eq("isp_id", ispId);
  const { data: expired } = await q;
  let count = 0;
  for (const c of expired ?? []) {
    await sb.from("customers").update({ status: "expired" }).eq("id", c.id).eq("status", "active");
    const { data: ru } = await sb.from("radius_users").select("id").eq("customer_id", c.id).maybeSingle();
    if (ru) {
      await sb.from("radius_users").update({ enabled: false, sync_status: "pending" }).eq("id", ru.id);
      await sb.rpc("enqueue_job", { p_kind: "radius-user-sync", p_isp_id: c.isp_id, p_payload: { radius_user_id: ru.id } });
    }
    await sb.rpc("enqueue_job", { p_kind: "session-kick", p_isp_id: c.isp_id,
      p_payload: { customer_id: c.id, username: c.username } });
    await queueSms(sb, c.isp_id, c, "package_expired",
      `Hi ${c.full_name}, your package has expired. Renew via M-Pesa to restore service.`);
    count++;
  }
  return { ok: true, expired: count };
}

// expiry-reminders: active, expiring <24h, never reminded → SMS once.
export async function expiryReminders(sb, job) {
  const ispId = job.isp_id ?? job.payload?.isp_id ?? null;
  const soon = new Date(Date.now() + 24 * 3600_000).toISOString();
  let q = sb.from("customers").select("id, isp_id, phone, full_name, expiry_date, customer_no")
    .eq("status", "active").lt("expiry_date", soon)
    .gt("expiry_date", new Date().toISOString()).is("expiry_reminded_at", null).limit(500);
  if (ispId) q = q.eq("isp_id", ispId);
  const { data: rows } = await q;
  for (const c of rows ?? []) {
    await queueSms(sb, c.isp_id, c, "package_expiring",
      `Reminder: your package expires ${new Date(c.expiry_date).toLocaleDateString()}. Renew via M-Pesa to stay connected.`);
    await sb.from("customers").update({ expiry_reminded_at: new Date().toISOString() }).eq("id", c.id);
  }
  return { ok: true, reminded: (rows ?? []).length };
}

// session-kick: RADIUS Disconnect-Request (RFC 3576) to each NAS the user is on;
// fallback router-disconnect (PPPoE + HotSpot) when CoA is unavailable.
// Framed-IP-Address / Acct-Session-Id are sent when known so MikroTik terminates
// exactly the right session instead of every session of that username.
export async function sessionKick(sb, job) {
  const { username } = job.payload ?? {};
  if (!job.isp_id || !username) throw new Error("session-kick missing isp/username");
  const bare = bareUsername(username);
  const { data: sessions } = await sb.from("radius_sessions")
    .select("nas_ip, framed_ip, acct_session_id")
    .eq("isp_id", job.isp_id).eq("username", bare).eq("is_open", true).limit(10);
  const open = sessions ?? [];
  const { data: nasRows } = await sb.from("radius_nas")
    .select("id, nasname, shortname, coa_port, coa_enabled").eq("isp_id", job.isp_id);

  // Only the NAS rows that actually host one of this user's sessions (a user with
  // no mirror record yet still gets kicked on every CoA-enabled NAS).
  const relevant = (nasRows ?? []).filter((n) => n.coa_enabled !== false &&
    (!open.length || open.some((s) => String(s.nas_ip) === String(n.nasname))));

  let kicked = 0;
  const details = [];
  for (const nas of relevant) {
    const { data: sec } = await sb.from("radius_nas_secrets")
      .select("encrypted_secret").eq("nas_id", nas.id).maybeSingle();
    if (!sec?.encrypted_secret) continue;
    const session = open.find((s) => String(s.nas_ip) === String(nas.nasname));
    const res = await sendDisconnect({
      host: nas.nasname, port: nas.coa_port ?? 3799, secret: decryptSecret(sec.encrypted_secret),
      username: bare, framedIp: session?.framed_ip ?? null,
      acctSessionId: session?.acct_session_id ?? null, nasIp: nas.nasname,
      timeoutMs: COA_TIMEOUT_MS,
    });
    if (res.ok) kicked++;
    else {
      details.push(`${nas.shortname}: ${res.detail}`);
      await sb.from("network_job_logs").insert({ job_id: job.id, level: "warn",
        message: `CoA to ${nas.nasname} failed: ${res.detail}` });
    }
  }

  if (!kicked) {
    // Fallback: RouterOS-level kill on every router of this ISP. Only usable when
    // the job is for a specific router (API credentials are per router).
    const routerIds = job.payload?.router_id
      ? [job.payload.router_id]
      : (await sb.from("routers").select("id").eq("isp_id", job.isp_id).limit(10)).data?.map((r) => r.id) ?? [];
    const session = open[0];
    for (const id of routerIds) {
      await sb.rpc("enqueue_job", { p_kind: "router-disconnect", p_isp_id: job.isp_id,
        p_payload: { router_id: id, username: bare,
          framed_ip: session?.framed_ip ?? null, acct_session_id: session?.acct_session_id ?? null } });
    }
    // Mirror-side close so the dashboard stops showing a session we just cut.
    if (open.length) {
      await sb.from("radius_sessions").update({ is_open: false, terminate_cause: "Admin-Reset" })
        .eq("isp_id", job.isp_id).eq("username", bare).eq("is_open", true);
    }
    return { ok: true, kicked: 0, fallback: true, routers: routerIds.length, details };
  }
  if (open.length) {
    await sb.from("radius_sessions").update({ is_open: false, terminate_cause: "Admin-Reset" })
      .eq("isp_id", job.isp_id).eq("username", bare).eq("is_open", true);
  }
  return { ok: true, kicked, fallback: false, sessions: open.length, details };
}

// usage-rollup: sessions → data_usage; completed payments → package_sales_daily.
export async function usageRollup(sb, job) {
  const ispId = job.isp_id ?? job.payload?.isp_id ?? null;
  const day = job.payload?.day ?? new Date().toISOString().slice(0, 10);
  let sq = sb.from("radius_sessions")
    .select("isp_id, username, input_octets, output_octets, session_seconds, start_time")
    .gte("start_time", `${day}T00:00:00Z`).lt("start_time", `${day}T23:59:59Z`).limit(5000);
  if (ispId) sq = sq.eq("isp_id", ispId);
  const { data: sessions } = await sq;
  const byUser = new Map();
  for (const s of sessions ?? []) {
    const k = `${s.isp_id}|${s.username}`;
    const a = byUser.get(k) ?? { isp: s.isp_id, up: 0, down: 0, secs: 0, n: 0 };
    a.up += Number(s.input_octets ?? 0); a.down += Number(s.output_octets ?? 0);
    a.secs += Number(s.session_seconds ?? 0); a.n++;
    byUser.set(k, a);
  }
  for (const [k, a] of byUser) {
    const username = k.split("|")[1];
    const { data: cust } = await sb.from("customers").select("id")
      .eq("isp_id", a.isp).eq("username", username).maybeSingle();
    await sb.from("data_usage").upsert({
      isp_id: a.isp, customer_id: cust?.id ?? null, day,
      upload_bytes: a.up, download_bytes: a.down, session_seconds: a.secs, sessions: a.n,
      updated_at: new Date().toISOString(),
    }, { onConflict: "isp_id,customer_id,day" });
  }
  let pq = sb.from("payments").select("isp_id, package_id, amount, paid_at")
    .eq("status", "completed")
    .gte("paid_at", `${day}T00:00:00Z`).lt("paid_at", `${day}T23:59:59Z`).limit(5000);
  if (ispId) pq = pq.eq("isp_id", ispId);
  const { data: pays } = await pq;
  const byPkg = new Map();
  for (const p of pays ?? []) {
    if (!p.package_id) continue;
    const k = `${p.isp_id}|${p.package_id}`;
    const a = byPkg.get(k) ?? { isp: p.isp_id, pkg: p.package_id, n: 0, rev: 0 };
    a.n++; a.rev += Number(p.amount ?? 0); byPkg.set(k, a);
  }
  for (const a of byPkg.values()) {
    await sb.from("package_sales_daily").upsert({
      isp_id: a.isp, package_id: a.pkg, day, count: a.n, revenue: a.rev,
    }, { onConflict: "isp_id,package_id,day" });
  }
  return { ok: true, users: byUser.size, packages: byPkg.size };
}

// schedule-tick: fan-out — enqueue sweeps + syncs + health per ISP.
// Run every 5 min (pg_cron or external scheduler). Idempotent.
export async function scheduleTick(sb) {
  const { data: isps } = await sb.from("isps").select("id").not("status", "in", "(suspended,cancelled)").limit(500);
  for (const isp of isps ?? []) {
    for (const kind of ["expire-sweep", "expiry-reminders", "accounting-sync", "usage-rollup"]) {
      await sb.rpc("enqueue_job", { p_kind: kind, p_isp_id: isp.id, p_payload: {} });
    }
    const { data: routers } = await sb.from("routers").select("id").eq("isp_id", isp.id).limit(50);
    for (const r of routers ?? []) {
      await sb.rpc("enqueue_job", { p_kind: "router-health", p_isp_id: isp.id, p_payload: { router_id: r.id } });
    }
  }
  return { ok: true, isps: (isps ?? []).length };
}

