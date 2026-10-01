// Phase 4 worker jobs: router health/test/backup/disconnect.
// Dynamic-imported by index.js (like radius.js).
import { mtConnect, mtCommand, mtClose } from "./mikrotik.js";
import { decryptSecret } from "./secrets.js";
import { sendDisconnect } from "./radius-wire.js";
import { bareUsername, indexNasByName, indexUsernameOwners, mapAccountingRow, resolvePacketTenant, staleCutoffIso } from "./radius-logic.js";
import { buildCustomerQueue, rosPaths } from "./routeros.mjs";

const COA_TIMEOUT_MS = Number(process.env.RADIUS_COA_TIMEOUT_MS) || 5000;

async function routerCreds(sb, routerId) {
  const { data: router } = await sb.from("routers").select("*").eq("id", routerId).single();
  if (!router) throw new Error("router missing");
  const { data: cred } = await sb.from("router_credentials").select("encrypted_password").eq("router_id", routerId).single();
  if (!cred) throw new Error("router credentials missing");
  return { router, password: decryptSecret(cred.encrypted_password) };
}

export async function routerHealth(sb, job) {
  const { router_id } = job.payload ?? {};
  const { router, password } = await routerCreds(sb, router_id);
  const started = Date.now();
  let conn = null;
  try {
    conn = await mtConnect({ host: String(router.host),
      port: router.use_ssl ? router.api_ssl_port : router.api_port,
      username: router.api_username, password, ssl: router.use_ssl });
    const [res] = await mtCommand(conn, ["/system/resource/print"]);
    const [ident] = await mtCommand(conn, ["/system/identity/print"]);
    const uptime = parseUptime(res?.["uptime"] ?? "");
    const cpu = Number(res?.["cpu-load"] ?? 0);
    const memFree = Number(res?.["free-memory"] ?? 0);
    const memTotal = Number(res?.["total-memory"] ?? 0);
    const memPct = memTotal ? Math.round((1 - memFree / memTotal) * 100) : null;
    // lifecycle 'online' is written ONLY here, on a real API round-trip. A
    // database row, a RADIUS server entry or a generated script must never be
    // able to produce it - that conflation is what made five unenrolled routers
    // indistinguishable from five healthy ones.
    await sb.from("routers").update({ status: "online", lifecycle: "online",
      last_seen_at: new Date().toISOString(),
      ros_version: res?.["version"] ?? null, model: res?.["board-name"] ?? null,
      identity: ident?.["name"] ?? null, uptime_seconds: uptime,
      cpu_load: cpu || null, mem_used_pct: memPct }).eq("id", router.id);
    await sb.from("router_health").insert({ router_id: router.id, reachable: true,
      latency_ms: Date.now() - started, ros_version: res?.["version"] ?? null,
      model: res?.["board-name"] ?? null, uptime_seconds: uptime,
      cpu_load: cpu || null, mem_used_pct: memPct, detail: {} });
    return { ok: true, online: true };
  } catch (e) {
    // A failed check must not erase a real prior success, and it must not
    // overwrite the enrolment state either. If the router was never enrolled
    // that is still the truth, so only advance a router that HAD been online.
    await sb.from("routers")
      .update({ status: "offline", lifecycle: "routeros_unreachable" })
      .eq("id", router_id).neq("lifecycle", "wireguard_enrollment_required");
    await sb.from("router_health").insert({ router_id, reachable: false,
      latency_ms: Date.now() - started, detail: { error: String(e.message ?? e) } });
    throw new Error("Router connection failed: " + String(e.message ?? e));
  } finally { if (conn) mtClose(conn); }
}

// RADIUS Disconnect-Request (RFC 3576) to every CoA-enabled NAS of the tenant.
// A NAS that does not host the session answers Disconnect-NAK: harmless.
async function coaDisconnect(sb, job, { username, framedIp, acctSessionId }) {
  const ispId = job.isp_id;
  if (!ispId) return { attempted: false, ok: false, detail: "no tenant on job" };
  const { data: nasRows } = await sb.from("radius_nas")
    .select("id, shortname, nasname, coa_port, coa_enabled").eq("isp_id", ispId).limit(20);
  const targets = (nasRows ?? []).filter((n) => n.coa_enabled !== false).slice(0, 5);
  let last = null;
  for (const nas of targets) {
    const { data: sec } = await sb.from("radius_nas_secrets")
      .select("encrypted_secret").eq("nas_id", nas.id).maybeSingle();
    if (!sec?.encrypted_secret) continue;
    const res = await sendDisconnect({
      host: nas.nasname, port: nas.coa_port ?? 3799, secret: decryptSecret(sec.encrypted_secret),
      username, framedIp, acctSessionId, nasIp: nas.nasname, timeoutMs: COA_TIMEOUT_MS,
    });
    if (res.ok) return { attempted: true, ok: true, nas: nas.shortname, detail: res.detail };
    last = `${nas.shortname}: ${res.detail}`;
  }
  return {
    attempted: targets.length > 0, ok: false,
    detail: last ?? "no CoA-enabled NAS with a secret for this ISP",
  };
}

// router-disconnect: CoA/Disconnect first (the customer is kicked even if the
// router API is unreachable), then RouterOS-level kill as a fallback.
// PPPoE sessions live in /ppp/active and HotSpot sessions in /ip/hotspot/active —
// killing only the PPP list silently ignored every HotSpot login.
export async function routerDisconnect(sb, job) {
  const { router_id, username, framed_ip, acct_session_id } = job.payload ?? {};
  if (!router_id || !username) throw new Error("disconnect missing router/username");
  const bare = bareUsername(username);

  const coa = await coaDisconnect(sb, job, {
    username: bare, framedIp: framed_ip ?? null, acctSessionId: acct_session_id ?? null,
  });
  if (coa.ok) {
    await sb.from("network_job_logs").insert({ job_id: job.id, level: "info",
      message: `CoA Disconnect-ACK via ${coa.nas} for ${bare} (${coa.detail})` });
    return { ok: true, method: "coa", nas: coa.nas };
  }

  const { router, password } = await routerCreds(sb, router_id);
  let conn = null;
  try {
    conn = await mtConnect({ host: String(router.host),
      port: router.use_ssl ? router.api_ssl_port : router.api_port,
      username: router.api_username, password, ssl: router.use_ssl });
    const removed = { ppp: 0, hotspot: 0 };
    const ppp = await mtCommand(conn, ["/ppp/active/print", `?name=${bare}`]);
    for (const s of ppp ?? []) {
      if (s[".id"]) { await mtCommand(conn, ["/ppp/active/remove", `=.id=${s[".id"]}`]); removed.ppp++; }
    }
    const hotspot = await mtCommand(conn, ["/ip/hotspot/active/print", `?user=${bare}`]);
    for (const s of hotspot ?? []) {
      if (s[".id"]) { await mtCommand(conn, ["/ip/hotspot/active/remove", `=.id=${s[".id"]}`]); removed.hotspot++; }
    }
    const total = removed.ppp + removed.hotspot;
    await sb.from("network_job_logs").insert({ job_id: job.id, level: "info",
      message: `RouterOS kill for ${bare}: ppp=${removed.ppp} hotspot=${removed.hotspot}` +
        (coa.attempted ? ` (CoA failed: ${coa.detail})` : " (no CoA target)") });
    if (!total && coa.attempted) {
      // Both paths reported "not there": surface it instead of claiming success.
      return { ok: false, method: "none", coa_detail: coa.detail, removed };
    }
    return { ok: true, method: "routeros", removed, coa_detail: coa.attempted ? coa.detail : null };
  } catch (e) {
    throw new Error(`Router disconnect failed: ${String(e?.message ?? e)}`);
  } finally { if (conn) mtClose(conn); }
}

export async function routerBackup(sb, job) {
  const { router_id } = job.payload ?? {};
  const { router, password } = await routerCreds(sb, router_id);
  let conn = null;
  try {
    conn = await mtConnect({ host: String(router.host),
      port: router.use_ssl ? router.api_ssl_port : router.api_port,
      username: router.api_username, password, ssl: router.use_ssl });
    const fname = `netpid-${Date.now()}`;
    await mtCommand(conn, ["/system/backup/save", `=name=${fname}`, "=dont-encrypt=yes"]);
    await sb.from("router_backups").insert({ isp_id: router.isp_id, router_id,
      storage_path: `private/router-backups/${router.isp_id}/${router.id}/${fname}.backup` });
    return { ok: true, file: fname };
  } finally { if (conn) mtClose(conn); }
}

// accounting-sync: mirror radacct → radius_sessions (§14).
// Tenant assignment order: radacct.isp_id (written by the tenant-aware accounting
// queries) → NAS IP resolution with username-ownership tiebreak → skip. Never
// guessed, never cross-tenant. Rows with no Stop are swept after a grace window.
export async function accountingSync(sb, job, radiusPool) {
  if (!radiusPool) throw new Error("RADIUS database not connected (RADIUS_DB_URL unset).");
  const lookbackMinutes = Number(job.payload?.lookback_minutes) || 15;
  const graceMinutes = Number(job.payload?.stale_grace_minutes) || 30;
  const limit = Number(job.payload?.limit) || 2000;
  const client = await radiusPool.connect();
  try {
    const { rows } = await client.query(
      `select acctsessionid, acctuniqueid, username, nasipaddress, framedipaddress,
              callingstationid, acctstarttime, acctupdatetime, acctstoptime,
              acctsessiontime, acctinputoctets, acctoutputoctets,
              acctinputgigawords, acctoutputgigawords, acctterminatecause, isp_id
       from radacct
       where acctupdatetime > now() - ($1::int * interval '1 minute')
       order by acctupdatetime desc limit $2`,
      [lookbackMinutes, limit]
    );

    const [{ data: nasRows }, ownerIndex] = await Promise.all([
      sb.from("radius_nas").select("id, isp_id, nasname, shortname"),
      loadUsernameOwners(sb, rows),
    ]);
    const nasIndex = indexNasByName(nasRows);

    let mirrored = 0, unattributed = 0, outOfScope = 0, mismatched = 0;
    const seen = new Map(); // "isp|user" → newest row, for the stale-open sweep

    for (const r of rows) {
      const ownerIsps = ownerIndex.get(bareUsername(r.username));
      let ispId = r.isp_id
        ?? resolvePacketTenant({ nasIndex, ownerIndex, nasIp: r.nasipaddress, username: r.username });
      if (!ispId) { unattributed++; continue; }
      if (job.isp_id && job.isp_id !== ispId) { outOfScope++; continue; }
      // Defence in depth: a NAS may be shared by several ISPs, but a username is
      // owned by exactly one of them. Refuse to write to the wrong tenant.
      if (ownerIsps?.size && !ownerIsps.has(ispId)) { mismatched++; continue; }

      const record = mapAccountingRow(r, ispId);
      if (record.is_open) seen.set(`${ispId}|${record.username}`, record);
      else {
        // A real Stop closes any other open session of the same user on that NAS
        // (radacct keeps one row per session; the app mirror keeps them all).
        await sb.from("radius_sessions").update({ is_open: false, stop_time: record.stop_time })
          .eq("isp_id", ispId).eq("username", record.username).eq("nas_ip", record.nas_ip)
          .eq("is_open", true).neq("acct_session_id", record.acct_session_id);
      }
      await sb.from("radius_sessions").upsert(record, { onConflict: "isp_id,acct_session_id,acct_unique_id" });
      mirrored++;
    }

    // Sweep: an open row whose Start was replaced by a newer session (same user,
    // same NAS) or that has not been refreshed inside the grace window is closed.
    let swept = 0;
    for (const [key, record] of seen) {
      const [ispId] = key.split("|");
      const { data } = await sb.from("radius_sessions")
        .update({ is_open: false, stop_time: record.last_update })
        .eq("isp_id", ispId).eq("username", record.username).eq("is_open", true)
        .neq("acct_session_id", record.acct_session_id).lt("last_update", record.start_time)
        .select("acct_session_id");
      swept += data?.length ?? 0;
    }
    const staleBefore = staleCutoffIso(Date.now(), graceMinutes);
    const { data: stale } = await sb.from("radius_sessions")
      .update({ is_open: false, terminate_cause: "Stale-Session-Sweep" })
      .eq("is_open", true).lt("last_update", staleBefore).select("acct_session_id");
    swept += stale?.length ?? 0;

    return {
      ok: true, mirrored, swept, unattributed, out_of_scope: outOfScope, mismatched,
      stale_cutoff: staleBefore,
    };
  } finally { client.release(); }
}

// Only the usernames in this batch are looked up, in chunks (PostgREST URL limits).
async function loadUsernameOwners(sb, rows) {
  const names = [...new Set((rows ?? []).map((r) => bareUsername(r.username)).filter(Boolean))];
  const index = new Map();
  for (let i = 0; i < names.length; i += 100) {
    const { data } = await sb.from("radius_users").select("isp_id, username")
      .in("username", names.slice(i, i + 100));
    for (const u of data ?? []) {
      const key = bareUsername(u.username);
      const set = index.get(key) ?? new Set();
      set.add(u.isp_id);
      index.set(key, set);
    }
  }
  return index;
}

// ---------------------------------------------------------------------------
// router-apply-rate: push a per-customer simple queue to the router.
//
// RADIUS (Mikrotik-Rate-Limit) already caps PPPoE/HotSpot logins, but a static
// IP or a locally-authenticated user never passes through RADIUS, and an ISP
// sometimes wants a hard ceiling on the router itself. This writes
// /queue/simple with max-limit="<upload>k/<download>k" — upload first, same
// order as ratePair() and netpid_rate_limit().
export async function routerApplyRate(sb, job) {
  const { router_id, customer_id, username, framed_ip } = job.payload ?? {};
  if (!router_id) throw new Error("apply-rate missing router_id");

  let down = job.payload?.download_kbps ?? null;
  let up = job.payload?.upload_kbps ?? null;
  let label = username ?? null;

  if (customer_id) {
    const { data: c } = await sb.from("customers")
      .select("username, download_kbps, upload_kbps, package_id, packages(download_kbps, upload_kbps)")
      .eq("id", customer_id).single();
    if (!c) throw new Error("customer not found");
    const pkg = Array.isArray(c.packages) ? c.packages[0] : c.packages;
    // Customer override wins; otherwise inherit the package, as the RADIUS
    // group does — the two paths must never disagree about a speed.
    down = c.download_kbps ?? pkg?.download_kbps ?? null;
    up = c.upload_kbps ?? pkg?.upload_kbps ?? null;
    label = c.username ?? label;
  }
  if (down == null && up == null) throw new Error("no download/upload cap resolved for this customer");

  const commands = buildCustomerQueue({
    username: label, customer_no: label, framed_ip: framed_ip ?? null, download_kbps: down, upload_kbps: up,
  });
  if (!commands) throw new Error("speed cap resolved to 0/0 — refusing to write an uncapped queue");

  const { router, password } = await routerCreds(sb, router_id);
  let conn = null;
  try {
    conn = await mtConnect({ host: String(router.host),
      port: router.use_ssl ? router.api_ssl_port : router.api_port,
      username: router.api_username, password, ssl: router.use_ssl });
    // Simple queues have no "add or update"; remove-then-add is the idiom.
    const name = `netpid-${label}`;
    const existing = await mtCommand(conn, ["/queue/simple/print", `?name=${name}`]);
    let applied = 0;
    for (const row of existing ?? []) {
      if (row[".id"]) await mtCommand(conn, ["/queue/simple/remove", `=.id=${row[".id"]}`]);
    }
    for (const line of commands.split("\n")) {
      if (line.startsWith("#") || line.startsWith(":do")) continue;
      const words = line.split(" ").map((w, i) => (i === 0 ? w : `=${w}`));
      await mtCommand(conn, words);
      applied++;
    }
    await sb.from("router_provision_log").insert({ isp_id: job.isp_id, router_id,
      action: "speed-applied", source: "worker",
      detail: { username: label, download_kbps: down, upload_kbps: up, commands: applied } });
    return { ok: true, username: label, download_kbps: down, upload_kbps: up, applied };
  } catch (e) {
    throw new Error(`apply-rate failed: ${String(e?.message ?? e)}`);
  } finally { if (conn) mtClose(conn); }
}

// router-provision: push the RADIUS wiring to the router over the RouterOS
// API. Same end state as the generated .rsc, so an ISP that never logs into
// the dashboard still gets a router talking to NETPID.
export async function routerProvision(sb, job) {
  const { router_id } = job.payload ?? {};
  if (!router_id) throw new Error("provision missing router_id");
  const { router, password } = await routerCreds(sb, router_id);
  const { data: nasRows } = await sb.from("radius_nas")
    .select("id, shortname, nasname, coa_port").eq("router_uuid", router_id).limit(1);
  const nas = nasRows?.[0];
  if (!nas) throw new Error("no RADIUS NAS is linked to this router");
  const { data: sec } = await sb.from("radius_nas_secrets")
    .select("encrypted_secret").eq("nas_id", nas.id).maybeSingle();
  if (!sec?.encrypted_secret) throw new Error("no NAS secret stored — re-run provisioning");
  const secret = decryptSecret(sec.encrypted_secret);
  const { data: servers } = await sb.from("radius_servers")
    .select("host, auth_port, acct_port").or("isp_id.is.null").limit(1);
  const server = servers?.[0];
  if (!server) throw new Error("no FreeRADIUS server configured in NETPID");

  let conn = null;
  const run = async (words) => mtCommand(conn, words);
  try {
    conn = await mtConnect({ host: String(router.host),
      port: router.use_ssl ? router.api_ssl_port : router.api_port,
      username: router.api_username, password, ssl: router.use_ssl });

    // RADIUS is version-sensitive: RouterOS 7 promoted it out of /ip to a
    // top-level menu, and a 7.x router answers "bad command name radius" for
    // /ip radius. This handler used to mix the two forms - /ip/radius/* for the
    // client and /radius/incoming for CoA - so it failed on 6.x AND on 7.x.
    // Both halves now go through rosPaths.
    const paths = rosPaths(router.script_ros_version ?? router.ros_version);
    const R = paths.radiusClient;                 // "/radius" on 7, "/ip radius" on 6

    const stale = await run([`${R}/print`, `?comment=NETPID:${nas.shortname}`]);
    for (const row of stale ?? []) {
      if (row[".id"]) await run([`${R}/remove`, `=.id=${row[".id"]}`]);
    }
    await run([`${R}/add`, "=service=ppp,hotspot", `=address=${server.host}`,
      `=secret=${secret}`, `=auth-port=${server.auth_port ?? 1812}`,
      `=acct-port=${server.acct_port ?? 1813}`, "=timeout=1500ms",
      "=comment=NETPID:" + nas.shortname]);
    await run(["/ppp/aaa/set", "=use-radius=yes", "=accounting=yes", "=interim-update=5m"]);
    // CoA. The NAS may target a different port than the global 3799 default.
    await run([`${R}/incoming/set`, "=accept=yes", `=port=${nas.coa_port ?? 3799}`]);

    await sb.from("router_provision_log").insert({ isp_id: job.isp_id, router_id,
      action: "provisioned", source: "worker",
      detail: { shortname: nas.shortname, radius_server: server.host } });
    return { ok: true, nas: nas.shortname, radius_server: server.host };
  } catch (e) {
    throw new Error(`provision failed: ${String(e?.message ?? e)}`);
  } finally { if (conn) mtClose(conn); }
}

function parseUptime(s) {
  const m = String(s).match(/(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?/);
  if (!m) return null;
  return (Number(m[1] ?? 0) * 86400) + (Number(m[2] ?? 0) * 3600) + (Number(m[3] ?? 0) * 60) + Number(m[4] ?? 0);
}
