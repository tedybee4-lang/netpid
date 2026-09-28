# FreeRADIUS Deployment (Ubuntu VPS) — spec §§8,73,74

FreeRADIUS NEVER runs on Vercel / Supabase Edge / browser. Dedicated persistent VPS.

## 1. Provision
Ubuntu 22.04 LTS VPS, static IP, firewall: allow 1812/udp + 1813/udp ONLY from ISP router public IPs; SSH key-only; unattended-upgrades.

## 2. Install
```bash
sudo apt update && sudo apt install -y freeradius freeradius-postgresql postgresql-client radclient
sudo systemctl enable --now freeradius
```

## 3. RADIUS database + least-privilege roles
`radius_db` is a **derived cache** — the Supabase app DB is the source of truth; the
network-worker mirrors it. Create the roles **before** applying the schema (the
grant block skips roles that do not exist yet):
```sql
create role radius_auth with login password 'STRONG';
create role radius_acct with login password 'STRONG';
create role radius_sync with login password 'STRONG';
grant connect on database radius_db to radius_auth, radius_acct, radius_sync;
```
Then `psql -d radius_db -f freeradius/schema.sql` (+ optional `schema-extras.sql`).
The schema applies the grants itself:
- `radius_auth` — SELECT on `nas`/auth tables/views, INSERT on `radpostauth`
  (post-auth logging), sequence usage. Read-mostly.
- `radius_acct` — SELECT/INSERT/UPDATE on `radacct`/`radpostauth` **plus SELECT on
  `nas` and `radcheck`**: every accounting query calls `netpid_resolve_isp()`,
  which is SECURITY INVOKER and reads those two tables — without the grants every
  accounting write fails with *permission denied*.
- `radius_sync` — write on auth tables + `nas` (the network-worker).

**Tenant resolution contract** (`netpid_resolve_isp(src_ip, username, nas_attr)`):
explicit `NAS-IP-Address` attribute match → UDP source IP match → username-ownership
tiebreak → lowest `nas.id`. **NULL ⇒ reject / write nothing — never "any tenant".**
The function runs inside every query, so `radius_db` is tenant-scoped end to end:
`nas` is unique on `(isp_id, nasname)` (two ISPs may share one public IP), every
auth row carries `isp_id`, `radacct` is unique on `(isp_id, acctuniqueid)`.

## 4. Configure the sql module (tenant-aware)
`freeradius/sql-tenant-aware.conf` **replaces** the stock module file:
```bash
sudo cp freeradius/sql-tenant-aware.conf /etc/freeradius/3.0/mods-available/sql
sudo vi /etc/freeradius/3.0/mods-available/sql   # set both CHANGE_ME_* passwords
sudo ln -sf ../mods-available/sql /etc/freeradius/3.0/mods-enabled/sql
```
Two rlm_sql instances are defined:
- `sql` (login `radius_auth`) — authorize check/reply, group membership/check/reply
  (all tenant-scoped), post-auth audit log (passwords never stored), and
  `read_clients` from the tenant-stamped `nas` table.
- `sql sql_acct` (login `radius_acct`) — the full accounting lifecycle. Queries use
  the stock FreeRADIUS 3 mechanism (`accounting { reference = "%{tolower:type.…}"; type { … } }`);
  the flat v2 items (`accounting_start_query` …) are **not read by rlm_sql 3.x**.

Wire the instances in `sites-enabled/default`:
- `authorize` / `post-auth`: keep `sql` (default).
- `accounting`: replace the `sql` line with `sql_acct`.
Validate with `sudo freeradius -XC` before restarting.

Accounting behaviour: Start inserts (re-Start upserts and reopens); Interim-Update
updates the open row and materializes the session if Start was lost; Stop closes
with final counters (inserting when Start was lost entirely); Accounting-On/-Off
bulk-close that NAS's sessions (`NAS-Reboot`). Counters are stored 64-bit as
`(gigawords << 32) + octets`. An unresolvable tenant affects zero rows — the packet
is recorded nowhere rather than somewhere wrong. Include the shipped MikroTik
dictionary if your NAS vendors non-standard attributes.

## 5. Clients (NAS)
Each router added in NETPID auto-generates a client stanza via sync (never hand-edit per ISP): see `freeradius/clients.conf.example`. Unique secret per router, stored encrypted in app DB, never displayed after creation. DB triggers (supabase migration 0033) enqueue `radius-nas-sync`, `radius-nas-secret-sync`, `radius-user-sync` and `radius-group-sync` whenever a NAS/user/group/customer status changes — reactivation needs no manual step.

**Address modes.** *Static* (one public IP per router): `nas.nasname` = that IP and
the UDP source resolves the tenant directly. *CGNAT / shared hub* (several ISPs
behind one source IP): the router must send `NAS-IP-Address` (MikroTik does by
default on `/radius` entries) — `netpid_resolve_isp` prefers it, and the
`(isp_id, nasname)` key lets each tenant keep its own secret on the shared IP.
If neither matches, username ownership breaks the tie; still nothing ⇒ reject.

## 6. Firewall/TLS
UFW restrict 1812/1813. RadSec (2083/tcp) optional with certs; MikroTik supports RadSec.

## 7. Test
```bash
radtest testuser testpass 127.0.0.1 0 testing123
radclient -x 127.0.0.1 acct testing123 < freeradius/acct-example.txt
```
Then: MikroTik `/radius add service=ppp,hotspot address=<RADIUS_IP> secret=<SECRET>`, `/ppp aaa set use-radius=yes accounting=yes`, HotSpot profile → RADIUS. Verify per session in `radacct`: Start opens the row → Interim-Update refreshes `acctupdatetime` → Stop sets `acctstoptime` + terminate cause. Test disconnect/CoA (`echo Disconnect-Request | radclient -x <NAS>:3799 coa SECRET`). Re-run `network-worker` tests with `node --test network-worker/test/`.

## 8. Monitoring + worker environment
`radwho`, `radstat`, SQL on the `v_*` views, dashboard (never fake ONLINE). The
`accounting-sync` job mirrors `radacct` → app `radius_sessions` (15-min lookback,
30-min stale grace; every close is `is_open=true`-guarded, so kick + sync +
sweep cannot double-close). Worker env:
- `RADIUS_DB_URL` — pool for `radius_db` (unset ⇒ accounting jobs refuse).
- `RADIUS_PROBE_TIMEOUT_MS` (default 5000), `RADIUS_COA_TIMEOUT_MS` (default 5000).
- Probe overrides: `RADIUS_PROBE_SECRET`, `RADIUS_PROBE_NAS_IP`, `RADIUS_PROBE_USERNAME`,
  `RADIUS_PROBE_PASSWORD` — otherwise health probes derive them from synced NAS rows.
  Health is a **real UDP Access-Request**; only RadSec-less/probeless servers report degraded.
