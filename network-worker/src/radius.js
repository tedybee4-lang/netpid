// Phase 3/5 worker: RADIUS sync, health probe and test-auth.
//
// Multi-tenant rules enforced here:
//  * the APP database is the source of truth; radius_db is a derived cache
//  * every statement is scoped by isp_id AND username/nasname — never global
//  * a disabled/expired customer has authorization rows DELETED (auth fails),
//    instead of relying on client-side or UI checks
//  * auth is protocol-agnostic (Cleartext-Password only) so PPPoE (CHAP/MS-CHAP)
//    and HotSpot (PAP/CHAP) both work from one credential
//  * syncs are transactional: a partially synced user must never exist
import { decryptSecret } from "./secrets.js";
import { probeAccess } from "./radius-wire.js";
import {
  bareUsername, formatRateLimit, isValidUsername, radcheckRows, radgroupreplyRows,
  radreplyRows, radusergroupRows, LEGACY_AUTH_ATTRS,
} from "./radius-logic.js";

// `pg` is loaded lazily: the health/test jobs do not touch the RADIUS database at
// all, and a worker without RADIUS_DB_URL still starts (and says so loudly).
let radiusPool = null;
let pgError = null;
if (process.env.RADIUS_DB_URL) {
  try {
    const { default: pg } = await import("pg");
    radiusPool = new pg.Pool({ connectionString: process.env.RADIUS_DB_URL, max: 5 });
  } catch (e) {
    pgError = String(e?.message ?? e);
  }
}

export function radiusDbConfigured() {
  return Boolean(radiusPool);
}

// Test-only injection point so the sync SQL can be asserted without a live DB.
export function __setRadiusPoolForTests(pool) {
  radiusPool = pool;
}

function needPool() {
  if (!radiusPool) {
    throw new Error(pgError
      ? `RADIUS database driver unavailable (${pgError}).`
      : "RADIUS database not connected (RADIUS_DB_URL unset).");
  }
  return radiusPool;
}

// All auth-table writes for one user/group happen in a single transaction.
async function tx(fn) {
  const pool = needPool();
  const client = await pool.connect();
  try {
    await client.query("begin");
    const out = await fn(client);
    await client.query("commit");
    return out;
  } catch (e) {
    try { await client.query("rollback"); } catch { /* connection already gone */ }
    throw e;
  } finally {
    client.release();
  }
}

async function warn(sb, job, message) {
  await sb.from("network_job_logs").insert({
    job_id: job.id, level: "warn", message: String(message).slice(0, 300),
  });
}

// Explicit override wins, else the group auto-provisioned from the customer's package.
async function resolveGroupName(sb, ru) {
  if (ru.radius_group) return ru.radius_group;
  const { data: cust } = await sb.from("customers")
    .select("package_id").eq("id", ru.customer_id).maybeSingle();
  if (!cust?.package_id) return null;
  const { data: g } = await sb.from("radius_groups").select("group_name")
    .eq("isp_id", ru.isp_id).eq("package_id", cust.package_id).maybeSingle();
  return g?.group_name ?? null;
}

// ---------------------------------------------------------------------------
// NAS sync (router -> nas table == FreeRADIUS client stanza)
// ---------------------------------------------------------------------------

export async function radiusNasSync(sb, job) {
  const { nas_id } = job.payload ?? {};
  if (!nas_id) throw new Error("nas-sync payload missing nas_id");
  const { data: nas } = await sb.from("radius_nas").select("*").eq("id", nas_id).single();
  if (!nas) throw new Error("NAS missing");
  const { data: sec } = await sb.from("radius_nas_secrets")
    .select("encrypted_secret").eq("nas_id", nas_id).maybeSingle();
  if (!sec?.encrypted_secret) throw new Error("NAS secret missing — rotate it before syncing.");
  const secret = decryptSecret(sec.encrypted_secret);
  const marker = `netpid:${nas.id}`; // own provenance marker, never user input
  const coaPort = nas.coa_port ?? 3799;
  const enabled = nas.enabled !== false;

  try {
    await tx(async (c) => {
      // Conflict target is (isp_id, nasname): two ISPs may share a public IP
      // (CGNAT / shared hub) and each keeps its own secret + tenant.
      await c.query(
        `insert into nas (nasname, shortname, type, secret, description, isp_id, router_id, coa_port, enabled)
         values ($1::inet, $2, 'other', $3, $4, $5, $6, $7, $8)
         on conflict (isp_id, nasname) do update set
           shortname = excluded.shortname, secret = excluded.secret,
           description = excluded.description, router_id = excluded.router_id,
           coa_port = excluded.coa_port, enabled = excluded.enabled, updated_at = now()`,
        [nas.nasname, String(nas.shortname).slice(0, 32), secret, marker, nas.isp_id,
          nas.router_uuid ?? null, coaPort, enabled]
      );
      // A NAS that changed IP must not leave a ghost client behind. Deleting by
      // our own marker can only ever remove this exact NAS row.
      await c.query("delete from nas where description = $1 and nasname <> $2::inet", [marker, nas.nasname]);
    });
    await sb.from("radius_nas").update({ sync_status: "synced", sync_error: null }).eq("id", nas_id);
    return { ok: true, nas: nas.shortname, nasname: nas.nasname, coa_port: coaPort, enabled };
  } catch (e) {
    await sb.from("radius_nas")
      .update({ sync_status: "error", sync_error: String(e?.message ?? e).slice(0, 300) })
      .eq("id", nas_id);
    throw e;
  }
}

// ---------------------------------------------------------------------------
// User sync (customer login -> radcheck/radreply/radusergroup)
// ---------------------------------------------------------------------------

// Withdraw every authorization artifact for one user in one ISP.
async function clearUser(c, username, ispId) {
  for (const table of ["radcheck", "radreply", "radusergroup"]) {
    await c.query(`delete from ${table} where username = $1 and isp_id = $2`, [username, ispId]);
  }
}

export async function radiusUserSync(sb, job) {
  const { radius_user_id } = job.payload ?? {};
  if (!radius_user_id) throw new Error("user-sync payload missing radius_user_id");
  const { data: ru } = await sb.from("radius_users").select("*").eq("id", radius_user_id).single();
  if (!ru) throw new Error("radius user missing");
  const username = bareUsername(ru.username);
  if (!isValidUsername(username)) throw new Error(`invalid RADIUS username: ${ru.username}`);

  // Suspended/expired/blocked/terminated: no authorization rows at all.
  // (Reactivation re-creates them — see the enabled branch below.)
  if (!ru.enabled) {
    await tx((c) => clearUser(c, username, ru.isp_id));
    const { data: left } = await sb.from("radius_sessions").select("acct_session_id")
      .eq("isp_id", ru.isp_id).eq("username", username).eq("is_open", true).limit(1);
    await sb.from("radius_users").update({ sync_status: "disabled", sync_error: null }).eq("id", ru.id);
    if (left?.length) {
      // A disabled account must not stay online: cut the live session too.
      await sb.rpc("enqueue_job", {
        p_kind: "session-kick", p_isp_id: ru.isp_id, p_payload: { username },
      });
    }
    return { ok: true, disabled: true, username, kicked_open_session: Boolean(left?.length) };
  }

  const { data: cred } = await sb.from("radius_user_credentials")
    .select("encrypted_password").eq("radius_user_id", ru.id).maybeSingle();
  if (!cred?.encrypted_password) {
    // Retrying cannot fix this (an operator must set a password): mark + surface
    // it instead of burning attempts in a retry storm.
    await sb.from("radius_users").update({
      password_set: false, sync_status: "error",
      sync_error: "No RADIUS password stored for this account — set one to activate.",
    }).eq("id", ru.id);
    await warn(sb, job, `radius-user ${username}: no credential stored, cannot authorize yet`);
    return { ok: false, skipped: "no-credential", username };
  }
  const password = decryptSecret(cred.encrypted_password);
  const groupName = await resolveGroupName(sb, ru);

  // Static IP / CGNAT: an address is only framed when the account really has one.
  const { data: acct } = await sb.from("pppoe_accounts")
    .select("static_ip, ip_pool, enabled").eq("customer_id", ru.customer_id).maybeSingle();
  const staticIp = ru.service_type === "pppoe" || ru.service_type === "static"
    ? (acct?.static_ip ?? null) : null;

  const check = radcheckRows(username, password, ru.isp_id);
  const reply = radreplyRows({
    username, ispId: ru.isp_id, serviceType: ru.service_type, staticIp,
  });
  const groups = radusergroupRows(username, groupName, ru.isp_id);

  let legacyRemoved = 0;
  await tx(async (c) => {
    // Purge rows written by the previous version that forced Auth-Type := MS-CHAP
    // (that broke HotSpot/PAP logins and made reactivation silently fail).
    const del = await c.query(
      "delete from radcheck where username = $1 and isp_id = $2 and attribute = any($3::text[])",
      [username, ru.isp_id, LEGACY_AUTH_ATTRS]
    );
    legacyRemoved = del.rowCount ?? 0;
    for (const row of check) {
      await c.query(
        `insert into radcheck (username, attribute, op, value, isp_id) values ($1,$2,$3,$4,$5)
         on conflict (username, isp_id, attribute) do update set op = excluded.op, value = excluded.value`,
        [row.username, row.attribute, row.op, row.value, row.isp_id]
      );
    }
    // Reply/group rows are replaced wholesale so a removed static IP or a changed
    // plan really disappears from the server.
    await c.query("delete from radreply where username = $1 and isp_id = $2", [username, ru.isp_id]);
    for (const row of reply) {
      await c.query(
        `insert into radreply (username, attribute, op, value, isp_id) values ($1,$2,$3,$4,$5)
         on conflict (username, isp_id, attribute) do update set op = excluded.op, value = excluded.value`,
        [row.username, row.attribute, row.op, row.value, row.isp_id]
      );
    }
    await c.query("delete from radusergroup where username = $1 and isp_id = $2", [username, ru.isp_id]);
    for (const row of groups) {
      await c.query(
        `insert into radusergroup (username, groupname, priority, isp_id) values ($1,$2,$3,$4)
         on conflict (username, isp_id) do update set groupname = excluded.groupname, priority = excluded.priority`,
        [row.username, row.groupname, row.priority, row.isp_id]
      );
    }
  });

  // The group must exist in radgroupreply, or the user authorizes without
  // bandwidth/session limits (the classic "wrong speed" bug).
  if (groupName) {
    const { data: g } = await sb.from("radius_groups")
      .select("id, sync_status").eq("isp_id", ru.isp_id).eq("group_name", groupName).maybeSingle();
    if (!g) {
      await warn(sb, job, `group "${groupName}" is not provisioned in the app DB — limits will not apply`);
    } else if (g.sync_status !== "synced") {
      await sb.rpc("enqueue_job", {
        p_kind: "radius-group-sync", p_isp_id: ru.isp_id, p_payload: { group_id: g.id },
      });
    }
  }

  await sb.from("radius_users").update({
    sync_status: "synced", sync_error: null, password_set: true, radius_group: groupName,
  }).eq("id", ru.id);
  return {
    ok: true, username, group: groupName, static_ip: staticIp,
    service_type: ru.service_type, legacy_auth_rows_removed: legacyRemoved,
  };
}

// ---------------------------------------------------------------------------
// Group sync (radius_groups + radius_group_attributes -> radgroupreply)
// ---------------------------------------------------------------------------

// This is the path that carries Mikrotik-Rate-Limit to the router: app DB
// attribute rows -> radgroupreply -> FreeRADIUS authorize_group_reply_query ->
// Access-Accept reply -> MikroTik dynamic rate limit.
export async function radiusGroupSync(sb, job) {
  const { group_id } = job.payload ?? {};
  if (!group_id) throw new Error("group-sync payload missing group_id");
  const { data: group } = await sb.from("radius_groups").select("*").eq("id", group_id).single();
  if (!group) throw new Error("radius group missing");
  const { data: attrs } = await sb.from("radius_group_attributes")
    .select("attribute, op, value").eq("group_id", group.id);
  const { data: pkg } = await sb.from("packages")
    .select("upload_kbps, download_kbps, session_timeout, idle_timeout, simultaneous_users")
    .eq("id", group.package_id).maybeSingle();

  const rows = radgroupreplyRows((attrs ?? []).map((a) => ({ ...a, groupname: group.group_name })));
  // Package columns are the fallback when attribute rows are missing or zero.
  const have = new Set(rows.map((r) => r.attribute));
  const push = (attribute, value) => {
    if (value !== null && !have.has(attribute)) {
      rows.push({ groupname: group.group_name, attribute, op: "=", value: String(value) });
    }
  };
  push("Mikrotik-Rate-Limit", formatRateLimit(pkg?.upload_kbps, pkg?.download_kbps));
  push("Session-Timeout", Number(pkg?.session_timeout) > 0 ? Number(pkg.session_timeout) : null);
  push("Idle-Timeout", Number(pkg?.idle_timeout) > 0 ? Number(pkg.idle_timeout) : null);
  push("Port-Limit", Number(pkg?.simultaneous_users) > 1 ? Number(pkg.simultaneous_users) : null);

  try {
    await tx(async (c) => {
      await c.query("delete from radgroupreply where groupname = $1 and isp_id = $2",
        [group.group_name, group.isp_id]);
      for (const r of rows) {
        await c.query(
          `insert into radgroupreply (groupname, attribute, op, value, isp_id) values ($1,$2,$3,$4,$5)
           on conflict (groupname, isp_id, attribute) do update set op = excluded.op, value = excluded.value`,
          [r.groupname, r.attribute, r.op, r.value, group.isp_id]
        );
      }
    });
    await sb.from("radius_groups").update({
      sync_status: "synced", sync_error: null, last_synced_at: new Date().toISOString(),
    }).eq("id", group.id);
    return { ok: true, group: group.group_name, attributes: rows.map((r) => r.attribute) };
  } catch (e) {
    await sb.from("radius_groups")
      .update({ sync_status: "error", sync_error: String(e?.message ?? e).slice(0, 300) })
      .eq("id", group.id);
    throw e;
  }
}



// ---------------------------------------------------------------------------
// Health probe (real RADIUS Access-Request over UDP — never a TCP connect)
// ---------------------------------------------------------------------------

// Pick the NAS whose identity/secret the probe should use. The probe has to look
// like a real NAS, otherwise the tenant lookup cannot attribute it and the server
// answers Reject regardless of credentials.
// Returns { nas, secret, source } or null.
async function pickProbeNas(sb, { server, nasId, ispId }) {
  const cols = "id, isp_id, shortname, nasname, enabled, auth_port";
  let nasRow = null;
  if (nasId) {
    const { data } = await sb.from("radius_nas").select(cols).eq("id", nasId).maybeSingle();
    if (data && (!ispId || data.isp_id === ispId)) nasRow = data;
  } else {
    const tenant = ispId ?? server.isp_id ?? null;
    let query = sb.from("radius_nas").select(cols).eq("enabled", true)
      .order("created_at", { ascending: true }).limit(10);
    if (tenant) query = query.eq("isp_id", tenant);
    const { data } = await query;
    nasRow = (data ?? [])[0] ?? null;
  }
  if (nasRow) {
    const { data: sec } = await sb.from("radius_nas_secrets")
      .select("encrypted_secret").eq("nas_id", nasRow.id).maybeSingle();
    if (sec?.encrypted_secret) {
      return { nas: nasRow, secret: decryptSecret(sec.encrypted_secret), source: "nas" };
    }
  }
  // Bootstrap fallback: a probe client/account registered directly in FreeRADIUS
  // (optional, documented in docs/FREERADIUS-DEPLOYMENT.md).
  if (process.env.RADIUS_PROBE_SECRET && process.env.RADIUS_PROBE_NAS_IP) {
    return {
      nas: {
        id: null, isp_id: ispId ?? null, shortname: "env-probe",
        nasname: process.env.RADIUS_PROBE_NAS_IP, enabled: true,
      },
      secret: process.env.RADIUS_PROBE_SECRET,
      source: "env",
    };
  }
  return null;
}

// Probe FreeRADIUS for real and report an honest status.
//  online   — server answered with a signed reply (Access-Accept, Access-Challenge,
//             or a Reject for a non-existent probe user, all prove it is serving)
//  degraded — answered but unsigned/unexpected, or rejected a real account
//  offline  — no response at all
export async function radiusHealth(sb, job) {
  const { server_id, nas_id, radius_user_id } = job.payload ?? {};
  if (!server_id) throw new Error("health payload missing server_id");
  const { data: server } = await sb.from("radius_servers")
    .select("id, isp_id, name, host, auth_port, acct_port, protocol").eq("id", server_id).single();
  if (!server) throw new Error("RADIUS server missing");
  if (server.protocol === "radsec") {
    // RadSec is TLS over 2083/tcp: a UDP 1812 probe must not pretend to test it.
    const status = "degraded";
    const detail = { probe: "unsupported", reason: "RadSec uses TCP/2083 — probe over RadSec, not UDP 1812." };
    await sb.from("radius_servers").update({ status, last_check_at: new Date().toISOString() }).eq("id", server.id);
    await sb.from("radius_health_checks").insert({ server_id: server.id, status, latency_ms: 0, detail });
    return { ok: false, status, detail };
  }

  const target = await pickProbeNas(sb, { server, nasId: nas_id, ispId: server.isp_id });
  if (!target) {
    const status = "degraded";
    const detail = { probe: "none", reason: "No enabled NAS with a secret — register a NAS (or set RADIUS_PROBE_*)." };
    await sb.from("radius_servers").update({ status, last_check_at: new Date().toISOString() }).eq("id", server.id);
    await sb.from("radius_health_checks").insert({ server_id: server.id, status, latency_ms: 0, detail });
    await sb.from("system_health").insert({ component: "radius", status, detail: { server_id: server.id, ...detail } });
    return { ok: false, status, detail };
  }

  // Credentials: prefer a real tenant login (proves the whole chain end-to-end),
  // else a throwaway username (a Reject is expected and still proves liveness).
  let username = "netpid-probe";
  let password = `probe-${Date.now()}`;
  let expectAccept = false;
  if (radius_user_id) {
    const { data: ru } = await sb.from("radius_users").select("id, isp_id, username, enabled")
      .eq("id", radius_user_id).maybeSingle();
    // Defence in depth: the login must belong to the tenant that asked for the check.
    const tenantOk = ru && (job.isp_id ? ru.isp_id === job.isp_id
      : (!server.isp_id || server.isp_id === ru.isp_id));
    if (tenantOk) {
      const { data: cred } = await sb.from("radius_user_credentials")
        .select("encrypted_password").eq("radius_user_id", ru.id).maybeSingle();
      if (cred?.encrypted_password) {
        username = bareUsername(ru.username);
        password = decryptSecret(cred.encrypted_password);
        expectAccept = ru.enabled === true;
      }
    }
  } else if (process.env.RADIUS_PROBE_USERNAME) {
    username = process.env.RADIUS_PROBE_USERNAME;
    password = process.env.RADIUS_PROBE_PASSWORD ?? password;
    expectAccept = true;
  }

  const probe = await probeAccess({
    host: server.host, port: server.auth_port ?? 1812, secret: target.secret,
    username, password, nasIp: target.nas.nasname, nasIdentifier: target.nas.shortname,
    timeoutMs: Number(process.env.RADIUS_PROBE_TIMEOUT_MS) || 6000,
  });

  const accepted = probe.code === 2 || probe.code === 11;
  let status;
  if (!probe.ok) status = probe.code === null ? "offline" : "degraded";
  else if (accepted) status = "online";
  else if (probe.code === 3) status = expectAccept ? "degraded" : "online";
  else status = "degraded";

  const detail = {
    probe: "radius-udp", source: target.source, nas: target.nas.shortname,
    nas_ip: target.nas.nasname, username, code: probe.codeName, verified: probe.verified,
    message_authenticator: probe.messageAuthenticator, reply: probe.replyMessage,
    expect_accept: expectAccept, detail: probe.detail,
  };
  await sb.from("radius_servers").update({ status, last_check_at: new Date().toISOString() }).eq("id", server.id);
  await sb.from("radius_health_checks").insert({
    server_id: server.id, status, latency_ms: probe.rttMs, detail,
  });
  await sb.from("system_health").insert({
    component: "radius", status, detail: { server_id: server.id, host: server.host, ...detail },
  });
  if (status !== "online") {
    await warn(sb, job, `radius health ${status}: ${probe.detail} (nas=${target.nas.nasname}, user=${username})`);
  }
  if (expectAccept && !accepted) {
    await sb.from("radius_logs").insert({
      isp_id: job.isp_id ?? server.isp_id ?? null, username,
      event: probe.code === 3 ? "reject" : "test-error",
      nas_ip: String(target.nas.nasname), reply: probe.replyMessage ?? probe.detail,
    });
  }
  return { ok: status === "online", status, latency_ms: probe.rttMs, detail };
}

// ---------------------------------------------------------------------------
// Test authentication (radius-test-auth)
// ---------------------------------------------------------------------------

// A real login test from the RADIUS host: same client stanza (NAS + secret),
// same auth tables and same tenant lookup as a customer, so "TEST accepted" is
// meaningful. The password is decrypted here and never leaves the worker (and is
// never stored in the job payload, logs or results).
export async function radiusTestAuth(sb, job) {
  const ispId = job.isp_id;
  if (!ispId) throw new Error("test-auth missing isp_id");
  const { nas_id, radius_user_id, username } = job.payload ?? {};

  let userQuery = sb.from("radius_users")
    .select("id, isp_id, username, enabled, service_type, radius_group, sync_status");
  if (radius_user_id) userQuery = userQuery.eq("id", radius_user_id);
  else if (username) userQuery = userQuery.eq("username", bareUsername(username));
  else throw new Error("test-auth needs radius_user_id or username");
  const { data: ru } = await userQuery.eq("isp_id", ispId).maybeSingle();
  if (!ru && !radius_user_id && username) {
    // Cross-check: is this username owned by another ISP? Never probe it, and
    // report the collision instead of leaking whether it exists elsewhere.
    const { data: foreign } = await sb.from("radius_users").select("id, isp_id")
      .eq("username", bareUsername(username)).limit(2);
    if (foreign?.length) {
      return { ok: false, result: "ERROR", error: "That login belongs to a different ISP — it will never be tested here." };
    }
  }
  if (!ru) return { ok: false, result: "ERROR", error: "No RADIUS login found for your ISP." };
  if (ru.isp_id !== ispId) return { ok: false, result: "ERROR", error: "Tenant mismatch." };

  const { data: cred } = await sb.from("radius_user_credentials")
    .select("encrypted_password").eq("radius_user_id", ru.id).maybeSingle();
  if (!cred?.encrypted_password) {
    return { ok: false, result: "ERROR", error: "No password is stored for this login yet." };
  }

  const { data: server } = await sb.from("radius_servers")
    .select("id, host, auth_port, isp_id, protocol")
    .or(`isp_id.eq.${ispId},isp_id.is.null`).order("isp_id", { nullsFirst: false })
    .limit(1).maybeSingle();
  if (!server) return { ok: false, result: "ERROR", error: "RADIUS server not connected." };
  if (server.protocol === "radsec") {
    return { ok: false, result: "ERROR", error: "This server uses RadSec — test from a RadSec-capable client." };
  }

  const target = await pickProbeNas(sb, { server, nasId: nas_id, ispId });
  if (!target) return { ok: false, result: "ERROR", error: "Register a NAS with a secret before testing." };

  const probe = await probeAccess({
    host: server.host, port: server.auth_port ?? 1812, secret: target.secret,
    username: bareUsername(ru.username), password: decryptSecret(cred.encrypted_password),
    nasIp: target.nas.nasname, nasIdentifier: target.nas.shortname, timeoutMs: 8000,
  });
  const result = probe.code === 2 || probe.code === 11 ? "SUCCESS"
    : probe.code === 3 ? "REJECT"
      : probe.code === null ? "TIMEOUT" : "ERROR";
  const event = result === "SUCCESS" ? "test-accept" : result === "REJECT" ? "test-reject"
    : result === "TIMEOUT" ? "test-timeout" : "test-error";

  await sb.from("radius_logs").insert({
    isp_id: ispId, username: bareUsername(ru.username), event,
    nas_ip: String(target.nas.nasname), reply: probe.replyMessage ?? `${probe.codeName}: ${probe.detail}`,
  });
  await sb.from("radius_health_checks").insert({
    server_id: server.id,
    status: result === "SUCCESS" ? "online" : result === "TIMEOUT" ? "offline" : "degraded",
    latency_ms: probe.rttMs,
    detail: { test: event, nas: target.nas.shortname, code: probe.codeName, verified: probe.verified },
  });
  return {
    ok: result === "SUCCESS", result, latency_ms: probe.rttMs, code: probe.codeName,
    reply: probe.replyMessage ?? null, nas: target.nas.shortname,
    username: bareUsername(ru.username), group: ru.radius_group,
    user_enabled: ru.enabled, sync_status: ru.sync_status,
    note: result === "REJECT" && !ru.enabled
      ? "Account is disabled/expired — a Reject here is the correct result."
      : undefined,
  };
}

