// Worker RADIUS job tests: tenant scoping of the sync SQL, reactivation,
// disable=reject, group/rate-limit propagation and honest health statuses.
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

import { createFakePool, createFakeSupabase } from "./helpers/fakes.js";
import { attributeText, closedUdpPort, startFakeRadiusServer } from "./helpers/fake-radius-server.js";

const KEY_B64 = Buffer.alloc(32, 7).toString("base64");
process.env.APP_ENCRYPTION_KEY = KEY_B64;
process.env.RADIUS_DB_URL = ""; // force the lazy `pg` import to stay dormant
process.env.RADIUS_PROBE_TIMEOUT_MS = "400"; // keep the offline test fast

const { radiusGroupSync, radiusHealth, radiusNasSync, radiusTestAuth, radiusUserSync, __setRadiusPoolForTests }
  = await import("../src/radius.js");

const ISP_A = "11111111-1111-1111-1111-111111111111";
const ISP_B = "22222222-2222-2222-2222-222222222222";
const NAS_A_ID = "aaaaaaaa-0000-0000-0000-000000000001";
const SECRET = "shared-secret-a";

// Same v1 AES-256-GCM envelope format the app uses (independent implementation
// so this also verifies the envelope contract).
function encrypt(plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", Buffer.from(KEY_B64, "base64"), iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return `v1:${iv.toString("base64")}:${ct.toString("base64")}:${cipher.getAuthTag().toString("base64")}`;
}

const openSession = (isp, username, id) => ({
  isp_id: isp, username, is_open: true, acct_session_id: id, acct_unique_id: "",
});

function baseSeed(overrides = {}) {
  return {
    radius_users: [{
      id: "ru-1", isp_id: ISP_A, customer_id: "c-1", username: "kevin",
      service_type: "pppoe", radius_group: null, enabled: true,
      password_set: true, sync_status: "pending",
    }],
    radius_user_credentials: [{ radius_user_id: "ru-1", encrypted_password: encrypt("P@ssw0rd") }],
    customers: [{ id: "c-1", isp_id: ISP_A, package_id: "p-1" }],
    radius_groups: [{
      id: "g-1", isp_id: ISP_A, group_name: "ispa_pppoe_home", package_id: "p-1", sync_status: "synced",
    }],
    radius_group_attributes: [
      { group_id: "g-1", attribute: "Mikrotik-Rate-Limit", op: "=", value: "0k/0k" },
      { group_id: "g-1", attribute: "Session-Timeout", op: "=", value: "0" },
    ],
    packages: [{
      id: "p-1", upload_kbps: 512, download_kbps: 5120,
      session_timeout: 0, idle_timeout: 300, simultaneous_users: 2,
    }],
    pppoe_accounts: [{ customer_id: "c-1", static_ip: "10.20.30.40", ip_pool: null, enabled: true }],
    radius_nas: [{
      id: NAS_A_ID, isp_id: ISP_A, shortname: "ispa-core", nasname: "41.90.64.10",
      enabled: true, auth_port: 1812, coa_port: 3799, coa_enabled: true, sync_status: "pending",
    }],
    radius_nas_secrets: [{ nas_id: NAS_A_ID, encrypted_secret: encrypt(SECRET) }],
    radius_servers: [{
      id: "srv-1", isp_id: null, name: "global", host: "127.0.0.1",
      auth_port: 1812, acct_port: 1813, protocol: "udp", status: "unknown",
    }],
    radius_sessions: [],
    ...overrides,
  };
}

function withPool(sb) {
  const pool = createFakePool();
  __setRadiusPoolForTests(pool);
  return { sb, pool, sql: () => pool.statements };
}

function inserted(pool, table) {
  return pool.statements.filter((s) => new RegExp(`^insert into ${table}\\b`, "i").test(s.sql));
}

function deleted(pool, table) {
  return pool.statements.filter((s) => new RegExp(`^delete from ${table}\\b`, "i").test(s.sql));
}

test("enabled user sync writes one protocol-agnostic credential and removes legacy MS-CHAP rows", async () => {
  const sb = createFakeSupabase(baseSeed());
  const { pool } = withPool(sb);
  const out = await radiusUserSync(sb, { id: "job-1", isp_id: ISP_A, payload: { radius_user_id: "ru-1" } });

  const check = inserted(pool, "radcheck");
  assert.equal(check.length, 1);
  assert.deepEqual(check[0].params, ["kevin", "Cleartext-Password", ":=", "P@ssw0rd", ISP_A]);
  // No INSERT may reintroduce a forced auth module (breaks PAP/HotSpot).
  assert.equal(check.some((s) => s.params.includes("Auth-Type")), false);

  const legacyDelete = deleted(pool, "radcheck")[0];
  assert.deepEqual(legacyDelete.params[2], ["Auth-Type"], "legacy forced-auth rows are purged");
  assert.deepEqual(legacyDelete.params.slice(0, 2), ["kevin", ISP_A], "purge is tenant-scoped");

  const reply = inserted(pool, "radreply").map((s) => s.params);
  assert.deepEqual(
    reply.find((p) => p[1] === "Framed-IP-Address"),
    ["kevin", "Framed-IP-Address", "=", "10.20.30.40", ISP_A]
  );
  assert.deepEqual(
    reply.find((p) => p[1] === "Framed-Protocol"),
    ["kevin", "Framed-Protocol", "=", "PPP", ISP_A]
  );

  assert.deepEqual(inserted(pool, "radusergroup")[0].params, ["kevin", "ispa_pppoe_home", 1, ISP_A]);
  assert.equal(out.group, "ispa_pppoe_home");
  assert.equal(out.static_ip, "10.20.30.40");
  const updated = sb.rows("radius_users")[0];
  assert.equal(updated.sync_status, "synced");
  assert.equal(updated.radius_group, "ispa_pppoe_home");
  // Every statement that names a username also carries the tenant.
  for (const s of pool.statements) {
    if (s.params.includes("kevin")) assert.ok(s.params.includes(ISP_A), `tenant leak: ${s.sql}`);
  }
});

test("reactivation of a previously disabled login re-creates authorization", async () => {
  const seed = baseSeed();
  seed.radius_users[0].enabled = true;
  seed.radius_users[0].sync_status = "disabled";
  const sb = createFakeSupabase(seed);
  const { pool } = withPool(sb);

  await radiusUserSync(sb, { id: "job-2", isp_id: ISP_A, payload: { radius_user_id: "ru-1" } });

  assert.equal(inserted(pool, "radcheck").length, 1, "credential restored on payment/reactivation");
  assert.equal(sb.rows("radius_users")[0].sync_status, "synced");
  assert.equal(sb.rows("radius_users")[0].password_set, true);
});

test("disabled login loses every authorization row and its live session is kicked", async () => {
  const seed = baseSeed({
    radius_users: [{
      id: "ru-1", isp_id: ISP_A, customer_id: "c-1", username: "kevin",
      service_type: "pppoe", enabled: false, sync_status: "synced",
    }],
    radius_sessions: [
      openSession(ISP_A, "kevin", "sess-a"),
      openSession(ISP_B, "kevin", "sess-b"), // same username, other ISP: untouched
    ],
  });
  const sb = createFakeSupabase(seed);
  const { pool } = withPool(sb);
  const out = await radiusUserSync(sb, { id: "job-3", isp_id: ISP_A, payload: { radius_user_id: "ru-1" } });

  for (const table of ["radcheck", "radreply", "radusergroup"]) {
    const del = deleted(pool, table);
    assert.equal(del.length, 1, `${table} must be cleared`);
    assert.deepEqual(del[0].params, ["kevin", ISP_A]);
  }
  assert.equal(inserted(pool, "radcheck").length, 0);
  assert.equal(out.disabled, true);
  assert.equal(out.kicked_open_session, true, "open session of a disabled account is terminated");
  const kick = sb.log.rpcs.find((r) => r.args?.p_kind === "session-kick");
  assert.ok(kick, "session-kick job queued");
  assert.equal(kick.args.p_isp_id, ISP_A);
  assert.deepEqual(kick.args.p_payload, { username: "kevin" });
  assert.equal(sb.rows("radius_users")[0].sync_status, "disabled");

  // No statement may carry ISP_B or the other tenant's session id.
  for (const s of pool.statements) {
    assert.equal(s.params.includes(ISP_B), false);
    assert.equal(s.params.includes("sess-b"), false);
  }
});

test("a login without a stored password is reported, not retried forever or half-synced", async () => {
  const seed = baseSeed({ radius_user_credentials: [] });
  const sb = createFakeSupabase(seed);
  const { pool } = withPool(sb);
  const out = await radiusUserSync(sb, { id: "job-4", isp_id: ISP_A, payload: { radius_user_id: "ru-1" } });

  assert.equal(out.ok, false);
  assert.equal(out.skipped, "no-credential");
  assert.equal(pool.statements.length, 0, "no partial rows are written");
  const ru = sb.rows("radius_users")[0];
  assert.equal(ru.sync_status, "error");
  assert.equal(ru.password_set, false);
  assert.match(ru.sync_error, /no radius password stored/i);
  assert.ok(sb.log.inserts.some((i) => i.table === "network_job_logs"), "operator-visible warning logged");
});

test("pending group is synced from the user-sync path so limits always land", async () => {
  const seed = baseSeed();
  seed.radius_groups[0].sync_status = "pending";
  const sb = createFakeSupabase(seed);
  withPool(sb);
  await radiusUserSync(sb, { id: "job-5", isp_id: ISP_A, payload: { radius_user_id: "ru-1" } });
  const g = sb.log.rpcs.find((r) => r.args?.p_kind === "radius-group-sync");
  assert.ok(g, "group sync queued when the group is not synced yet");
  assert.equal(g.args.p_isp_id, ISP_A);
  assert.deepEqual(g.args.p_payload, { group_id: "g-1" });
});

test("group sync propagates Mikrotik-Rate-Limit and drops zero/empty limits", async () => {
  const sb = createFakeSupabase(baseSeed());
  const { pool } = withPool(sb);
  const out = await radiusGroupSync(sb, { id: "job-6", isp_id: ISP_A, payload: { group_id: "g-1" } });

  const rows = inserted(pool, "radgroupreply").map((s) => s.params);
  const rate = rows.find((p) => p[1] === "Mikrotik-Rate-Limit");
  assert.deepEqual(rate, ["ispa_pppoe_home", "Mikrotik-Rate-Limit", "=", "512k/5120k", ISP_A],
    "package bandwidth falls back to the group when the attribute row is 0k/0k");
  assert.equal(rows.some((p) => p[1] === "Session-Timeout"), false,
    "Session-Timeout = 0 would kill the session instantly — never synced");
  assert.deepEqual(rows.find((p) => p[1] === "Idle-Timeout"), ["ispa_pppoe_home", "Idle-Timeout", "=", "300", ISP_A]);
  assert.deepEqual(rows.find((p) => p[1] === "Port-Limit"), ["ispa_pppoe_home", "Port-Limit", "=", "2", ISP_A]);
  assert.equal(deleted(pool, "radgroupreply")[0].params[1], ISP_A, "replace is tenant-scoped");
  assert.equal(out.group, "ispa_pppoe_home");
  const group = sb.rows("radius_groups")[0];
  assert.equal(group.sync_status, "synced");
  assert.ok(group.last_synced_at);
});

test("nas sync upserts by (isp_id, nasname) and cleans up its own stale client", async () => {
  const sb = createFakeSupabase(baseSeed());
  const { pool } = withPool(sb);
  const out = await radiusNasSync(sb, { id: "job-7", isp_id: ISP_A, payload: { nas_id: NAS_A_ID } });

  const upsert = pool.statements.find((s) => /^insert into nas\b/i.test(s.sql));
  assert.match(upsert.sql, /on conflict \(isp_id, nasname\) do update/);
  assert.deepEqual(upsert.params, ["41.90.64.10", "ispa-core", SECRET, `netpid:${NAS_A_ID}`,
    ISP_A, null, 3799, true]);
  const ghost = pool.statements.find((s) => /^delete from nas\b/i.test(s.sql));
  assert.match(ghost.sql, /description = \$1/);
  assert.equal(ghost.params[0], `netpid:${NAS_A_ID}`);
  assert.equal(out.enabled, true);
  assert.equal(sb.rows("radius_nas")[0].sync_status, "synced");
});

test("health probe reports offline when nothing answers (never a fake ONLINE)", async () => {
  const seed = baseSeed();
  const port = await closedUdpPort();
  seed.radius_servers[0].auth_port = port;
  const sb = createFakeSupabase(seed);
  const out = await radiusHealth(sb, { id: "job-8", isp_id: ISP_A, payload: { server_id: "srv-1" } });

  assert.equal(out.ok, false);
  assert.equal(out.status, "offline");
  assert.equal(sb.rows("radius_servers")[0].status, "offline");
  const check = sb.rows("radius_health_checks")[0];
  assert.equal(check.status, "offline");
  assert.equal(check.detail.probe, "radius-udp");
  assert.equal(sb.rows("system_health")[0].status, "offline");
});

test("health probe is online on a signed reply, degraded when a real account is rejected", async () => {
  const accept = await startFakeRadiusServer(SECRET, () => ({ code: 2 }));
  const seed = baseSeed();
  seed.radius_servers[0].auth_port = accept.port;
  const sb = createFakeSupabase(seed);
  const ok = await radiusHealth(sb, {
    id: "job-9", isp_id: ISP_A,
    payload: { server_id: "srv-1", radius_user_id: "ru-1" },
  });
  assert.equal(ok.status, "online", JSON.stringify(ok.detail));
  assert.equal(ok.detail.code, "Access-Accept");
  assert.equal(ok.detail.nas, "ispa-core");
  // The probe must carry the NAS identity so the tenant can be resolved.
  assert.equal(attributeText(accept.seen[0], 4) !== null, true);
  accept.close();

  const reject = await startFakeRadiusServer(SECRET, () => ({
    code: 3, attributes: [[18, "no such user"]],
  }));
  const seed2 = baseSeed();
  seed2.radius_servers[0].auth_port = reject.port;
  const sb2 = createFakeSupabase(seed2);
  const bad = await radiusHealth(sb2, {
    id: "job-10", isp_id: ISP_A,
    payload: { server_id: "srv-1", radius_user_id: "ru-1" },
  });
  assert.equal(bad.status, "degraded", "an enabled customer being rejected is a real fault");
  assert.equal(bad.detail.reply, "no such user");
  assert.equal(sb2.rows("radius_logs")[0].event, "reject");
  reject.close();
});

test("health probe treats a Reject for a throwaway probe user as alive", async () => {
  const server = await startFakeRadiusServer(SECRET, () => ({ code: 3 }));
  const seed = baseSeed();
  seed.radius_servers[0].auth_port = server.port;
  const sb = createFakeSupabase(seed);
  const out = await radiusHealth(sb, { id: "job-11", isp_id: ISP_A, payload: { server_id: "srv-1" } });
  assert.equal(out.status, "online");
  assert.equal(out.detail.expect_accept, false);
  server.close();
});

test("health probe refuses to fake RadSec health over UDP", async () => {
  const seed = baseSeed();
  seed.radius_servers[0].protocol = "radsec";
  const sb = createFakeSupabase(seed);
  const out = await radiusHealth(sb, { id: "job-12", isp_id: ISP_A, payload: { server_id: "srv-1" } });
  assert.equal(out.ok, false);
  assert.equal(out.status, "degraded");
  assert.match(out.detail.reason, /RadSec/);
});

test("test-auth never probes a login owned by another ISP", async () => {
  const seed = baseSeed({
    radius_users: [{
      id: "ru-foreign", isp_id: ISP_B, customer_id: "c-9", username: "kevin",
      service_type: "pppoe", enabled: true, sync_status: "synced",
    }],
  });
  const sb = createFakeSupabase(seed);
  withPool(sb);
  const out = await radiusTestAuth(sb, {
    id: "job-13", isp_id: ISP_A, payload: { username: "kevin" },
  });
  assert.equal(out.ok, false);
  assert.match(out.error, /different ISP/);
  assert.equal(sb.rows("radius_logs").length, 0, "nothing is logged or probed for the other tenant");
});

test("test-auth accepts a tenant login end-to-end and records the result", async () => {
  const server = await startFakeRadiusServer(SECRET, (msg) => ({
    code: attributeText(msg, 1) === "kevin" ? 2 : 3,
    attributes: [[18, "Welcome"]],
  }));
  const seed = baseSeed();
  seed.radius_servers[0].auth_port = server.port;
  const sb = createFakeSupabase(seed);
  withPool(sb);

  const out = await radiusTestAuth(sb, {
    id: "job-14", isp_id: ISP_A, payload: { nas_id: NAS_A_ID, radius_user_id: "ru-1" },
  });
  assert.equal(out.result, "SUCCESS", JSON.stringify(out));
  assert.equal(out.ok, true);
  assert.equal(out.username, "kevin");
  const log = sb.rows("radius_logs")[0];
  assert.equal(log.event, "test-accept");
  assert.equal(log.isp_id, ISP_A);
  assert.equal(log.nas_ip, "41.90.64.10");
  assert.equal(sb.rows("radius_health_checks")[0].status, "online");
  // The stored credential (not the request) is what gets tested.
  assert.equal(attributeText(server.seen[0], 1), "kevin");
  server.close();
});

test("test-auth on a disabled account reports the Reject as the correct outcome", async () => {
  const server = await startFakeRadiusServer(SECRET, () => ({ code: 3 }));
  const seed = baseSeed();
  seed.radius_users[0].enabled = false;
  seed.radius_servers[0].auth_port = server.port;
  const sb = createFakeSupabase(seed);
  withPool(sb);

  const out = await radiusTestAuth(sb, {
    id: "job-15", isp_id: ISP_A, payload: { nas_id: NAS_A_ID, radius_user_id: "ru-1" },
  });
  assert.equal(out.result, "REJECT");
  assert.match(out.note, /disabled\/expired/i);
  assert.equal(sb.rows("radius_logs")[0].event, "test-reject");
  server.close();
});
