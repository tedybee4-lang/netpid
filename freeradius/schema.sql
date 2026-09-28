-- NETPID RADIUS schema (runs in radius_db on the VPS — NOT the Supabase app DB).
--
-- Multi-tenant model
--   * every authorization row carries isp_id; the key is always
--     (username|groupname, isp_id, attribute) — never a global username
--   * the tenant of a packet is resolved by netpid_resolve_isp(), which uses the
--     NAS-IP-Address attribute, the UDP source IP and username ownership
--   * `nas` is keyed (isp_id, nasname): two ISPs may share one public IP (CGNAT /
--     shared VPN hub) and each still keeps its own secret + tenant
--
-- Apply order: create the least-privilege roles first (docs/FREERADIUS-DEPLOYMENT.md).
--   psql -f freeradius/schema.sql
--   psql -f freeradius/schema-extras.sql   (optional monitoring views/functions)

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

-- Canonicalize "DOMAIN\user@realm" -> "user" exactly like the app/worker do.
-- chr(92) is a backslash (avoids string-escape confusion).
create or replace function netpid_bare_user(raw text)
returns text language sql immutable as $$
  select split_part(
    case when position(chr(92) in coalesce(raw, '')) > 0
         then substring(coalesce(raw, '') from position(chr(92) in coalesce(raw, '')) + 1)
         else coalesce(raw, '') end,
    '@', 1);
$$;

-- Resolve the tenant (public.isps.id) that owns a RADIUS packet.
--   p_nas_ip    Packet-Src-IP-Address (the UDP peer)
--   p_username  User-Name (realm/domain tolerated)
--   p_nas_attr  NAS-IP-Address attribute when the NAS sends one (CGNAT mode)
-- Precedence: explicit NAS-IP-Address match -> username ownership -> lowest nas id.
-- Returns NULL when nothing matches: callers must then answer Access-Reject
-- instead of falling back to "any tenant".
create or replace function netpid_resolve_isp(p_nas_ip inet, p_username text, p_nas_attr inet default null)
returns uuid language sql stable as $$
  with candidates as (
    select n.id, n.isp_id, n.nasname,
           case when p_username is null then 0
                else (select count(*) from radcheck rc
                       where rc.isp_id = n.isp_id
                         and rc.username = netpid_bare_user(p_username))
           end as owned
    from nas n
    where coalesce(n.enabled, true)
      and n.isp_id is not null
      and (n.nasname = p_nas_ip or (p_nas_attr is not null and n.nasname = p_nas_attr))
  )
  select isp_id
  from candidates
  order by case when p_nas_attr is not null and nasname = p_nas_attr then 0 else 1 end,
           owned desc,
           id
  limit 1;
$$;


-- ---------------------------------------------------------------------------
-- Clients (NAS)
-- ---------------------------------------------------------------------------
create table if not exists nas (
  id serial primary key,
  nasname inet not null,
  shortname text,
  type text default 'other',
  ports integer,
  secret text not null,
  server text,
  community text,
  description text,          -- worker writes 'netpid:<app radius_nas.id>'
  isp_id uuid,
  router_id uuid,
  coa_port integer not null default 3799,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- Tenant-scoped identity: the old global unique index on nasname is removed so
-- two ISPs behind the same public IP can coexist.
drop index if exists uq_nas_name;
alter table nas drop constraint if exists nas_nasname_key;
create unique index if not exists uq_nas_isp_name on nas(isp_id, nasname);
-- FreeRADIUS resolves the client by source IP; keep that fast and deterministic.
create index if not exists idx_nas_name on nas(nasname) where enabled;
create index if not exists idx_nas_isp on nas(isp_id);

-- ---------------------------------------------------------------------------
-- Authorization (tenant-scoped, one row per attribute)
-- ---------------------------------------------------------------------------
create table if not exists radcheck (
  id serial primary key, username text not null, attribute text not null,
  op char(2) not null default ':=', value text not null, isp_id uuid
);
create table if not exists radreply (
  id serial primary key, username text not null, attribute text not null,
  op char(2) not null default '=', value text not null, isp_id uuid
);
create table if not exists radusergroup (
  id serial primary key, username text not null, groupname text not null,
  priority integer not null default 1, isp_id uuid
);
create table if not exists radgroupcheck (
  id serial primary key, groupname text not null, attribute text not null,
  op char(2) not null default ':=', value text not null, isp_id uuid
);
create table if not exists radgroupreply (
  id serial primary key, groupname text not null, attribute text not null,
  op char(2) not null default '=', value text not null, isp_id uuid
);

-- Idempotent sync: the worker upserts on these keys (inside one tenant a user
-- owns exactly one value per attribute — including Cleartext-Password).
create unique index if not exists uq_radcheck_attr on radcheck(username, isp_id, attribute);
create unique index if not exists uq_radreply_attr on radreply(username, isp_id, attribute);
create unique index if not exists uq_radusergroup_user on radusergroup(username, isp_id);
create unique index if not exists uq_radgroupcheck_attr on radgroupcheck(groupname, isp_id, attribute);
create unique index if not exists uq_radgroupreply_attr on radgroupreply(groupname, isp_id, attribute);

create index if not exists idx_radcheck_user on radcheck(username, isp_id);
create index if not exists idx_radreply_user on radreply(username, isp_id);
create index if not exists idx_radusergroup_user on radusergroup(username, isp_id);
create index if not exists idx_radgroupreply_group on radgroupreply(groupname, isp_id);

-- ---------------------------------------------------------------------------
-- Accounting
-- ---------------------------------------------------------------------------
create table if not exists radacct (
  radacctid bigserial primary key,
  acctsessionid text not null,
  acctuniqueid text not null,
  username text,
  realm text,
  nasipaddress inet not null,
  nasportid text,
  nasporttype text,
  acctstarttime timestamptz,
  acctupdatetime timestamptz,
  acctstoptime timestamptz,
  acctinterval integer,
  acctsessiontime integer,
  acctauthentic text,
  connectinfo_start text,
  connectinfo_stop text,
  acctinputoctets bigint default 0,
  acctoutputoctets bigint default 0,
  -- 64-bit counters overflow every 4 GiB: without gigawords usage is wrong.
  acctinputgigawords bigint default 0,
  acctoutputgigawords bigint default 0,
  calledstationid text,
  callingstationid text,
  acctterminatecause text,
  servicetype text,
  framedprotocol text,
  framedipaddress inet,
  isp_id uuid
);
-- Older deployments: add the columns if the table already existed.
alter table radacct add column if not exists acctinputgigawords bigint default 0;
alter table radacct add column if not exists acctoutputgigawords bigint default 0;
alter table radacct add column if not exists isp_id uuid;

-- Duplicate-packet safety per tenant (a shared NAS IP must not collide).
drop index if exists uq_radacct_session;
create unique index if not exists uq_radacct_tenant_unique on radacct(isp_id, acctuniqueid);
create unique index if not exists uq_radacct_tenant_session on radacct(isp_id, acctsessionid, acctuniqueid);
create index if not exists idx_radacct_open on radacct(acctstoptime) where acctstoptime is null;
create index if not exists idx_radacct_tenant on radacct(isp_id, acctstarttime desc);
create index if not exists idx_radacct_update on radacct(acctupdatetime desc);
create index if not exists idx_radacct_user on radacct(isp_id, username);

-- Auth log (rlm_sql postauth_query): tenant-visible accept/reject trail.
create table if not exists radpostauth (
  id bigserial primary key,
  username text not null,
  pass text,
  reply text,
  authdate timestamptz not null default now(),
  isp_id uuid,
  nasipaddress inet,
  class text
);
alter table radpostauth add column if not exists isp_id uuid;
alter table radpostauth add column if not exists nasipaddress inet;
create index if not exists idx_radpostauth_isp on radpostauth(isp_id, authdate desc);

-- ---------------------------------------------------------------------------
-- Monitoring views (tenant-safe, read-only)
-- ---------------------------------------------------------------------------

-- Sessions currently online per tenant (source of truth for "who is online").
create or replace view v_online_sessions as
select r.isp_id, r.username, r.nasipaddress, r.framedipaddress, r.callingstationid,
       r.acctsessionid, r.acctstarttime, r.acctupdatetime,
       (coalesce(r.acctinputoctets, 0) + coalesce(r.acctinputgigawords, 0) * 4294967296) as input_octets,
       (coalesce(r.acctoutputoctets, 0) + coalesce(r.acctoutputgigawords, 0) * 4294967296) as output_octets
from radacct r
where r.acctstoptime is null;

-- Traffic per tenant for the current day (upload/download/total in bytes).
create or replace view v_tenant_traffic_today as
select r.isp_id,
       count(*) as sessions,
       sum(coalesce(r.acctinputoctets, 0) + coalesce(r.acctinputgigawords, 0) * 4294967296) as upload_bytes,
       sum(coalesce(r.acctoutputoctets, 0) + coalesce(r.acctoutputgigawords, 0) * 4294967296) as download_bytes
from radacct r
where r.acctstarttime >= date_trunc('day', now())
group by r.isp_id;

-- Authentications the server answered, per tenant (from radpostauth).
create or replace view v_auth_stats_today as
select isp_id, reply, count(*) as attempts, max(authdate) as last_seen
from radpostauth
where authdate >= date_trunc('day', now())
group by isp_id, reply;

-- Sessions that never received a Stop and stopped refreshing: the worker sweeps
-- these into the app mirror as closed.
create or replace view v_stale_sessions as
select r.isp_id, r.username, r.nasipaddress, r.acctsessionid, r.acctupdatetime
from radacct r
where r.acctstoptime is null
  and coalesce(r.acctupdatetime, r.acctstarttime) < now() - interval '30 minutes';

-- ---------------------------------------------------------------------------
-- Least-privilege grants (roles created in docs/FREERADIUS-DEPLOYMENT.md)
-- ---------------------------------------------------------------------------
-- radius_auth : SELECT on authorization tables + nas, INSERT radpostauth (server)
-- radius_acct : SELECT/INSERT/UPDATE on radacct/radpostauth + nas/radcheck reads
-- radius_sync : write on authorization tables + nas        (the NETPID worker)
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'radius_auth') then
    grant select on nas, radcheck, radreply, radusergroup, radgroupcheck, radgroupreply,
      v_online_sessions, v_tenant_traffic_today, v_auth_stats_today, v_stale_sessions to radius_auth;
    -- post-auth logging runs on the `sql` (auth) instance, which logs in as
    -- radius_auth; the INSERT needs the id sequence too.
    grant insert on radpostauth to radius_auth;
    grant usage, select on all sequences in schema public to radius_auth;
  end if;
  if exists (select 1 from pg_roles where rolname = 'radius_acct') then
    grant select, insert, update on radacct, radpostauth to radius_acct;
    -- netpid_resolve_isp() runs inside EVERY accounting query and is SECURITY
    -- INVOKER: without SELECT on nas + radcheck every accounting write fails
    -- with permission denied and sessions never reach radacct.
    grant select on nas, radcheck to radius_acct;
    grant usage, select on all sequences in schema public to radius_acct;
  end if;
  if exists (select 1 from pg_roles where rolname = 'radius_sync') then
    grant select, insert, update, delete on nas, radcheck, radreply, radusergroup,
      radgroupcheck, radgroupreply to radius_sync;
    grant select, insert, update on radacct, radpostauth to radius_sync;
    grant usage, select on all sequences in schema public to radius_sync;
  end if;
end $$;
