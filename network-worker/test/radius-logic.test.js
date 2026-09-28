// Tenant isolation, accounting lifecycle and reactivation logic.
import test from "node:test";
import assert from "node:assert/strict";

import {
  GIGAWORD, bareUsername, formatRateLimit, groupNeedsSync, indexNasByName,
  indexUsernameOwners, isEnabledForStatus, isStaleOpenSession, isValidUsername,
  mapAccountingRow, octetsWithGigawords, pickIspId, radcheckRows, radgroupreplyRows,
  radreplyRows, radusergroupRows, resolvePacketTenant, staleCutoffIso,
} from "../src/radius-logic.js";

const ISP_A = "11111111-1111-1111-1111-111111111111";
const ISP_B = "22222222-2222-2222-2222-222222222222";

// Two ISPs behind the SAME public IP (CGNAT / shared VPN hub) each have a
// "kevin". The packet must be attributed to the ISP that owns the username.
const sharedNas = [
  { id: "b-nas", isp_id: ISP_B, nasname: "41.90.64.10", shortname: "ispb-core" },
  { id: "a-nas", isp_id: ISP_A, nasname: "41.90.64.10", shortname: "ispa-core" },
];
const radiusUsers = [
  { username: "kevin", isp_id: ISP_B },
  { username: "alice", isp_id: ISP_A },
];

test("nasname is looked up per tenant, never globally", () => {
  const idx = indexNasByName(sharedNas);
  assert.equal(idx.get("41.90.64.10").length, 2);
  assert.equal(pickIspId(idx.get("41.90.64.10"), new Set([ISP_B])), ISP_B);
  assert.equal(pickIspId(idx.get("41.90.64.10"), new Set([ISP_A])), ISP_A);
  // Unknown owner -> deterministic (lowest nas id), never random.
  assert.equal(pickIspId(idx.get("41.90.64.10"), new Set()), ISP_A);
  assert.equal(pickIspId(undefined, new Set([ISP_A])), null);
});

test("username ownership wins over NAS ordering (IPv4-mapped inet values)", () => {
  const owners = indexUsernameOwners(radiusUsers);
  const idx = indexNasByName(sharedNas);
  assert.equal(
    resolvePacketTenant({ nasIndex: idx, ownerIndex: owners, nasIp: "::ffff:41.90.64.10", username: "kevin" }),
    ISP_B,
  );
  assert.equal(
    resolvePacketTenant({ nasIndex: idx, ownerIndex: owners, nasIp: "41.90.64.10", username: "nobody" }),
    ISP_A,
  );
});

test("NAS-IP-Address attribute is used when the source IP is a NAT address", () => {
  const owners = indexUsernameOwners(radiusUsers);
  const idx = indexNasByName([{ id: "a-nas", isp_id: ISP_A, nasname: "10.10.0.2" }]);
  assert.equal(
    resolvePacketTenant({ nasIndex: idx, ownerIndex: owners, nasIp: "196.201.9.9", nasIpAttr: "10.10.0.2", username: "alice" }),
    ISP_A,
  );
  assert.equal(
    resolvePacketTenant({ nasIndex: idx, ownerIndex: owners, nasIp: "196.201.9.9", username: "alice" }),
    null,
    "unknown NAS must never be guessed into a tenant",
  );
});

test("usernames are normalised and validated", () => {
  assert.equal(bareUsername("ACME\\kevin@isp-a.co.ke"), "kevin");
  assert.equal(bareUsername("  kevin@isp-a.co.ke "), "kevin");
  assert.equal(bareUsername("kevin"), "kevin");
  assert.equal(isValidUsername("kevin"), true);
  assert.equal(isValidUsername("bad user"), false);
  assert.equal(isValidUsername("x"), false);
test("auth rows are protocol-agnostic (no forced MS-CHAP)", () => {
  const rows = radcheckRows("kevin@isp-a.co.ke", "P@ssw0rd", ISP_A);
  assert.deepEqual(rows, [{
    username: "kevin", attribute: "Cleartext-Password", op: ":=", value: "P@ssw0rd", isp_id: ISP_A,
  }]);
  assert.equal(rows.some((r) => r.attribute === "Auth-Type"), false);
  assert.deepEqual(radcheckRows("kevin", "", ISP_A), [], "no stored password -> no auth row at all");
});

test("group membership and per-user reply rows carry the tenant", () => {
  assert.deepEqual(radusergroupRows("kevin", "HOME-10M", ISP_A), [
    { username: "kevin", groupname: "HOME-10M", priority: 1, isp_id: ISP_A },
  ]);
  assert.deepEqual(radusergroupRows("kevin", null, ISP_A), []);
  const staticPppoe = radreplyRows({
    username: "kevin", ispId: ISP_A, serviceType: "static", staticIp: "10.20.30.40",
  });
  assert.equal(staticPppoe.find((r) => r.attribute === "Framed-IP-Address").value, "10.20.30.40");
  assert.equal(staticPppoe.find((r) => r.attribute === "Framed-Protocol").value, "PPP");
  // HotSpot users get no per-user IP/protocol override — the group decides.
  assert.equal(radreplyRows({ username: "h", ispId: ISP_A, serviceType: "hotspot" }).length, 0);
});

test("MikroTik-Rate-Limit / group attributes are validated and zero-safe", () => {
  assert.equal(formatRateLimit(512, 5120), "512k/5120k");
  assert.equal(formatRateLimit(0, 5120), "5120k/5120k");
  assert.equal(formatRateLimit(0, 0), null);
  const rows = radgroupreplyRows([
    { groupname: "HOME-10M", attribute: "Mikrotik-Rate-Limit", value: "1024k/10240k", op: "=" },
    { groupname: "HOME-10M", attribute: "Session-Timeout", value: "0" },
    { groupname: "HOME-10M", attribute: "Idle-Timeout", value: "" },
    { groupname: "HOME-10M", attribute: "not a radius attr!", value: "x" },
    { groupname: "HOME-10M", attribute: "Framed-Pool", value: "pppoe-pool", op: "bogus-op" },
  ]);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], {
    groupname: "HOME-10M", attribute: "Mikrotik-Rate-Limit", op: "=", value: "1024k/10240k",
  });
  assert.equal(rows[1].op, "=", "unknown operators are normalised to =");
});

test("subscription status drives RADIUS authorization", () => {
  assert.equal(isEnabledForStatus("active"), true);
  assert.equal(isEnabledForStatus("ACTIVE"), true);
  for (const s of ["pending", "expired", "suspended", "blocked", "terminated", "", null, undefined]) {
    assert.equal(isEnabledForStatus(s), false, `${s} must not authorize`);
  }
});

test("group sync is required for new, failed or re-limited groups", () => {
  const now = Date.now();
  assert.equal(groupNeedsSync({ group_name: "G", sync_status: "pending" }, [], now), true);
  assert.equal(groupNeedsSync({
    group_name: "G", sync_status: "synced", last_synced_at: new Date(now).toISOString(),
  }, [], now), false);
  assert.equal(groupNeedsSync({
    group_name: "G", sync_status: "synced", last_synced_at: new Date(now - 60_000).toISOString(),
  }, [{ updated_at: new Date(now).toISOString() }], now), true, "raised limit must re-sync");
  assert.equal(groupNeedsSync({ sync_status: "pending" }, [], now), false);
});

test("accounting rows carry gigawords, canonical username and lifecycle flags", () => {
  const open = mapAccountingRow({
    acctsessionid: "8f2b", acctuniqueid: "u-1", username: "ACME\\kevin@isp-a.co.ke",
    nasipaddress: "41.90.64.10", framedipaddress: "10.20.30.40", callingstationid: "AA:BB:CC:DD:EE:FF",
    acctstarttime: "2026-01-01T10:00:00Z", acctupdatetime: "2026-01-01T11:00:00Z",
    acctinputoctets: 10, acctinputgigawords: 2, acctoutputoctets: 5, acctoutputgigawords: 0,
    acctsessiontime: 3600,
  }, ISP_A);
  assert.equal(open.is_open, true);
  assert.equal(open.stop_time, null);
  assert.equal(open.input_octets, 10 + 2 * GIGAWORD);
  assert.equal(open.output_octets, 5);
  assert.equal(open.username, "kevin");
  assert.equal(open.isp_id, ISP_A);
  assert.equal(open.session_seconds, 3600);

  const stopped = mapAccountingRow({
    acctsessionid: "8f2b", username: "kevin", acctstarttime: "2026-01-01T10:00:00Z",
    acctstoptime: "2026-01-01T12:00:00Z", acctterminatecause: "User-Request",
  }, ISP_A);
  assert.equal(stopped.is_open, false);
  assert.equal(stopped.stop_time, "2026-01-01T12:00:00Z");
  assert.equal(stopped.terminate_cause, "User-Request");
  assert.equal(stopped.acct_unique_id, "");
});

test("octet math never loses the low word and never goes negative", () => {
  assert.equal(octetsWithGigawords(0, 0), 0);
  assert.equal(octetsWithGigawords(4294967295, 1), 4294967295 + GIGAWORD);
  assert.equal(octetsWithGigawords(-5, 1), 0);
  assert.equal(octetsWithGigawords(undefined, undefined), 0);
});

test("unstopped sessions are swept after the grace window", () => {
  const now = Date.parse("2026-01-01T12:00:00Z");
  assert.equal(isStaleOpenSession("2026-01-01T11:59:00Z", now, 30), false);
  assert.equal(isStaleOpenSession("2026-01-01T11:00:00Z", now, 30), true);
  assert.equal(isStaleOpenSession(null, now, 30), true);
  assert.equal(staleCutoffIso(now, 30), "2026-01-01T11:30:00.000Z");
});

});
