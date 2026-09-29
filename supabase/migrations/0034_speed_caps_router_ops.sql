-- NETPID Phase 8 — per-customer bandwidth caps (download AND upload), router
-- operations metadata, and a provisioning audit trail shared by the dashboard
-- UI and the headless provisioning CLI.
--
-- Why this migration exists: NETPID could only cap bandwidth per PACKAGE.
--   * radius_groups.package_id was NOT NULL UNIQUE, so a customer could never
--     own a group of their own and therefore could not be re-limited alone;
--   * the only UI control was one symmetric "Speed (Mbps)" box, so an
--     asymmetric cap (e.g. 20 Mbps down / 5 Mbps up) was impossible.
-- A technician had to invent a throwaway package to slow one customer down.

-- ---------------------------------------------------------------------------
-- 1. One place that renders a MikroTik rate-limit string
-- ---------------------------------------------------------------------------
-- Mirrors network-worker/src/radius-logic.js -> formatRateLimit():
-- upload FIRST, download second -> "512k/5120k". A zero on one side means
-- "same as the other side"; 0k/0k means "no cap" and is never written, because
-- MikroTik reads a literal 0 rate as an undefined limit rather than unlimited.
create or replace function public.netpid_rate_limit(p_upload integer, p_download integer)
returns text language sql immutable as $$
  select case
    when coalesce(p_upload, 0) <= 0 and coalesce(p_download, 0) <= 0 then null
    else (case when coalesce(p_upload, 0) > 0 then p_upload else p_download end)::text || 'k/'
      ||  (case when coalesce(p_download, 0) > 0 then p_download else p_upload end)::text || 'k'
  end $$;
comment on function public.netpid_rate_limit(integer, integer) is
  'Mikrotik-Rate-Limit value "<upload>k/<download>k"; NULL = uncapped.';

-- ---------------------------------------------------------------------------
-- 2. Per-customer speed override (NULL on both = inherit the package)
-- ---------------------------------------------------------------------------
alter table public.customers
  add column if not exists download_kbps integer,
  add column if not exists upload_kbps integer;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'customers_speed_override_range') then
    alter table public.customers add constraint customers_speed_override_range
      check ((download_kbps is null or download_kbps > 0)
         and (upload_kbps   is null or upload_kbps   > 0));
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 3. A RADIUS group may now belong to a CUSTOMER instead of a package
-- ---------------------------------------------------------------------------
-- package_id becomes nullable so a per-customer group can exist. The UNIQUE
-- constraint stays (one group per package); NULLs are distinct in Postgres, so
-- package groups are unaffected. A full (non-partial) unique index is required
-- so ON CONFLICT (customer_id) can use it as an arbiter.
alter table public.radius_groups alter column package_id drop not null;
alter table public.radius_groups
  add column if not exists customer_id uuid references public.customers(id) on delete cascade;
create unique index if not exists uq_radius_groups_customer on public.radius_groups(customer_id);
create index if not exists idx_radius_groups_package on public.radius_groups(package_id);

-- ---------------------------------------------------------------------------
-- 4. The package group renders its rate limit through netpid_rate_limit() and
--    must never clobber a customer that owns an override group.
-- ---------------------------------------------------------------------------
create or replace function public.provision_radius_group()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_slug  text;
  v_group text;
  v_limit text;
begin
  select slug into v_slug from public.isps where id = new.isp_id;
  v_slug := regexp_replace(lower(coalesce(v_slug, 'isp')), '[^a-z0-9]+', '', 'g');
  v_group := substring(v_slug || '_' || new.service_type || '_' ||
    regexp_replace(lower(new.name), '[^a-z0-9]+', '', 'g') from 1 for 64);

  insert into public.radius_groups (isp_id, package_id, group_name, service_type)
  values (new.isp_id, new.id, v_group, new.service_type)
  on conflict (package_id) do update set group_name = excluded.group_name;

  v_limit := public.netpid_rate_limit(new.upload_kbps, new.download_kbps);

  -- Rate limit: replace the attribute, or remove it when the package is uncapped.
  if v_limit is null then
    delete from public.radius_group_attributes
     where group_id in (select id from public.radius_groups where package_id = new.id)
       and attribute = 'Mikrotik-Rate-Limit';
  else
    insert into public.radius_group_attributes (group_id, attribute, op, value)
    select g.id, 'Mikrotik-Rate-Limit', '=', v_limit
      from public.radius_groups g where g.package_id = new.id
    on conflict (group_id, attribute) do update
      set value = excluded.value, op = excluded.op;
  end if;

  insert into public.radius_group_attributes (group_id, attribute, op, value)
  select g.id, a.attribute, '=', a.value
    from public.radius_groups g cross join (values
      ('Session-Timeout', coalesce(new.session_timeout, 0)::text),
      ('Idle-Timeout',    coalesce(new.idle_timeout, 0)::text),
      ('Port-Limit',      coalesce(new.simultaneous_users, 1)::text)
    ) as a(attribute, value)
   where g.package_id = new.id
  on conflict (group_id, attribute) do update
    set value = excluded.value, op = excluded.op;

  -- A customer group overrides only the SPEED; its timeout / port-limit still
  -- come from the package, so re-derive them when the package changes.
  update public.radius_group_attributes ra
     set value = x.value
    from public.radius_groups g,
         (values ('Session-Timeout', coalesce(new.session_timeout, 0)::text),
                ('Idle-Timeout',    coalesce(new.idle_timeout, 0)::text),
                ('Port-Limit',      coalesce(new.simultaneous_users, 1)::text)
         ) as x(attribute, value)
   where g.package_id = new.id and g.customer_id is not null
     and ra.group_id = g.id and ra.attribute = x.attribute;

  -- Point package customers at the package group — but never at customers who
  -- own an override group (that would silently discard their custom speed).
  update public.radius_users ru
     set radius_group = v_group, sync_status = 'pending', updated_at = now()
    from public.customers c
   where c.id = ru.customer_id and c.package_id = new.id and ru.isp_id = new.isp_id
     and not exists (select 1 from public.radius_groups g where g.customer_id = c.id);

  return new;
end $$;

-- ---------------------------------------------------------------------------
-- 5. Per-customer override -> its own RADIUS group
-- ---------------------------------------------------------------------------
create or replace function public.provision_customer_rate_group()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_slug      text;
  v_group     text;
  v_pkg_group text;
  v_group_id  uuid;
  v_limit     text;
begin
  select regexp_replace(lower(coalesce(slug, 'isp')), '[^a-z0-9]+', '', 'g')
    into v_slug from public.isps where id = new.isp_id;

  -- Group the customer would inherit from their package (the fallback).
  v_pkg_group := null;
  if new.package_id is not null then
    select substring(v_slug || '_' || p.service_type || '_' ||
             regexp_replace(lower(p.name), '[^a-z0-9]+', '', 'g') from 1 for 64)
      into v_pkg_group
      from public.packages p where p.id = new.package_id;
  end if;

  v_limit := public.netpid_rate_limit(new.upload_kbps, new.download_kbps);

  if v_limit is null then
    -- Override cleared: repoint the login at the package group, drop ours.
    if exists (select 1 from public.radius_groups where customer_id = new.id) then
      update public.radius_users
         set radius_group = v_pkg_group,
             sync_status  = case when v_pkg_group is null then sync_status else 'pending' end,
             updated_at   = now()
       where customer_id = new.id and isp_id = new.isp_id;
      delete from public.radius_groups where customer_id = new.id;
    end if;
    return new;
  end if;

  v_group := substring(v_slug || '_cust_' ||
    regexp_replace(lower(new.customer_no), '[^a-z0-9]+', '', 'g') from 1 for 64);

  insert into public.radius_groups (isp_id, package_id, customer_id, group_name, service_type)
  values (new.isp_id, new.package_id, new.id, v_group, new.service_type)
  on conflict (customer_id) do update
    set group_name   = excluded.group_name,
        package_id   = excluded.package_id,
        service_type = excluded.service_type,
        sync_status  = 'pending',
        sync_error   = null;

  select id into v_group_id from public.radius_groups where customer_id = new.id;

  -- The group must carry the override AND the package's remaining limits,
  -- otherwise a speed change would quietly drop the timeout / login count.
  insert into public.radius_group_attributes (group_id, attribute, op, value) values
    (v_group_id, 'Mikrotik-Rate-Limit', '=', v_limit),
    (v_group_id, 'Session-Timeout', '=',
      coalesce((select p.session_timeout   from public.packages p where p.id = new.package_id), 0)::text),
    (v_group_id, 'Idle-Timeout', '=',
      coalesce((select p.idle_timeout      from public.packages p where p.id = new.package_id), 0)::text),
    (v_group_id, 'Port-Limit', '=',
      coalesce((select p.simultaneous_users from public.packages p where p.id = new.package_id), 1)::text)
  on conflict (group_id, attribute) do update
    set value = excluded.value, op = excluded.op;

  update public.radius_users
     set radius_group = v_group, sync_status = 'pending', updated_at = now()
   where customer_id = new.id and isp_id = new.isp_id;

  return new;
end $$;

drop trigger if exists trg_customers_rate_group on public.customers;
create trigger trg_customers_rate_group
  after insert or update of download_kbps, upload_kbps, package_id, service_type
  on public.customers for each row execute function public.provision_customer_rate_group();

-- ---------------------------------------------------------------------------
-- 6. Router operations metadata
-- ---------------------------------------------------------------------------
alter table public.routers
  add column if not exists site text,
  add column if not exists notes text,
  add column if not exists last_health_error text,
  add column if not exists provisioned_via text not null default 'ui',
  add column if not exists radius_server_host text;

create index if not exists idx_routers_isp_status on public.routers(isp_id, status);

-- Provisioning audit trail (UI adds, script-only CLI adds, worker actions).
create table if not exists public.router_provision_log (
  id uuid primary key default extensions.uuid_generate_v4(),
  isp_id uuid not null references public.isps(id) on delete cascade,
  router_id uuid references public.routers(id) on delete set null,
  action text not null check (action in
    ('created','updated','tested','provisioned','speed-applied','deleted','script-generated')),
  source text not null default 'ui' check (source in ('ui','script','api','worker')),
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists idx_router_provision_log_isp
  on public.router_provision_log(isp_id, created_at desc);

alter table public.router_provision_log enable row level security;
drop policy if exists rpl_platform on public.router_provision_log;
create policy rpl_platform on public.router_provision_log for all
  using (public.is_platform_admin()) with check (public.is_platform_admin());
drop policy if exists rpl_member on public.router_provision_log;
create policy rpl_member on public.router_provision_log for select
  using (public.is_isp_member(isp_id));

-- ---------------------------------------------------------------------------
-- 7. Dashboard read paths
-- ---------------------------------------------------------------------------
create index if not exists idx_customers_isp_created on public.customers(isp_id, created_at desc);
create index if not exists idx_data_usage_isp_day on public.data_usage(isp_id, day desc);
create index if not exists idx_payments_isp_paid
  on public.payments(isp_id, paid_at desc) where status = 'completed';
create index if not exists idx_sessions_isp_open
  on public.radius_sessions(isp_id, last_update desc) where is_open;
