-- NETPID: multi-tenant RADIUS hardening (pre-production remediation).
--
-- Context: the RADIUS tables are tenant-scoped (isp_id) and the same username may
-- exist in two ISPs. These triggers make authorization state changes reach
-- FreeRADIUS (via worker jobs) without every caller having to remember to enqueue
-- anything: activation, expiry, reactivation, package change and grouping.

-- ---------------------------------------------------------------------------
-- Group sync bookkeeping (mirrors radius_nas/radius_users.sync_status)
-- ---------------------------------------------------------------------------
alter table public.radius_groups
  add column if not exists sync_status text not null default 'pending'
    check (sync_status in ('pending','synced','error')),
  add column if not exists sync_error text,
  add column if not exists last_synced_at timestamptz;

alter table public.radius_group_attributes
  add column if not exists updated_at timestamptz not null default now();

drop trigger if exists trg_radius_group_attrs_touch on public.radius_group_attributes;
create trigger trg_radius_group_attrs_touch before update on public.radius_group_attributes
  for each row execute function public.touch_updated_at();

create index if not exists idx_radius_groups_sync on public.radius_groups(isp_id, sync_status);

-- Group attributes are the source of truth for Mikrotik-Rate-Limit / timeouts:
-- any change re-syncs the group AND every user that inherits it.
create or replace function public.queue_radius_group_sync()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_group record;
begin
  select g.id, g.isp_id, g.group_name into v_group
  from public.radius_groups g
  where g.id = coalesce(new.group_id, old.group_id);
  if v_group.id is null then return coalesce(new, old); end if;

  update public.radius_groups
  set sync_status = 'pending', sync_error = null
  where id = v_group.id;

  perform public.enqueue_job('radius-group-sync',
    jsonb_build_object('group_id', v_group.id), v_group.isp_id);

  -- Users inheriting the group must be pushed again too (group pointer, framed
  -- pool / static IP stay per user).
  perform public.enqueue_job('radius-user-sync',
    jsonb_build_object('radius_user_id', ru.id), ru.isp_id)
  from public.radius_users ru
  where ru.isp_id = v_group.isp_id and ru.radius_group = v_group.group_name;

  return coalesce(new, old);
end $$;

drop trigger if exists trg_group_attrs_queue_sync on public.radius_group_attributes;
create trigger trg_group_attrs_queue_sync
after insert or update or delete on public.radius_group_attributes
for each row execute function public.queue_radius_group_sync();


-- ---------------------------------------------------------------------------
-- Authorization state changes -> worker jobs (one place, idempotent)
-- ---------------------------------------------------------------------------

-- A login is authorized only while the customer is active. Disabling deletes the
-- radcheck/radreply/radusergroup rows in the worker; enabling re-creates them
-- (payment/reactivation). Compares OLD/NEW values so a redundant write by the
-- worker itself cannot re-queue forever.
create or replace function public.queue_radius_user_sync()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    if new.enabled then
      perform public.enqueue_job('radius-user-sync',
        jsonb_build_object('radius_user_id', new.id), new.isp_id);
    end if;
    return new;
  end if;

  if (new.enabled is distinct from old.enabled)
     or (new.username is distinct from old.username)
     or (new.radius_group is distinct from old.radius_group)
  then
    update public.radius_users
    set sync_status = 'pending', sync_error = null
    where id = new.id;
    perform public.enqueue_job('radius-user-sync',
      jsonb_build_object('radius_user_id', new.id), new.isp_id);
  end if;
  return new;
end $$;

drop trigger if exists trg_radius_users_queue_sync on public.radius_users;
create trigger trg_radius_users_queue_sync
after insert or update of enabled, username, radius_group on public.radius_users
for each row execute function public.queue_radius_user_sync();

-- Customer lifecycle -> mirror onto radius_users.enabled. The radius_users
-- trigger above then does the queueing (single source of queueing logic).
create or replace function public.sync_radius_user_enabled()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_enabled boolean;
begin
  v_enabled := (coalesce(new.status, old.status) = 'active');
  update public.radius_users
  set enabled = v_enabled,
      sync_status = 'pending',
      sync_error = null,
      updated_at = now()
  where customer_id = coalesce(new.id, old.id)
    and (enabled is distinct from v_enabled or sync_status <> 'pending');
  return coalesce(new, old);
end $$;

drop trigger if exists trg_customers_radius_sync on public.customers;
create trigger trg_customers_radius_sync
after insert or update of status, username, package_id on public.customers
for each row execute function public.sync_radius_user_enabled();

-- A NAS that changes IP/state must be re-pushed to the FreeRADIUS client list.
create or replace function public.queue_radius_nas_sync()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op <> 'INSERT'
     and (new.nasname is distinct from old.nasname
          or new.enabled is distinct from old.enabled
          or new.coa_port is distinct from old.coa_port)
  then
    update public.radius_nas set sync_status = 'pending', sync_error = null where id = new.id;
    perform public.enqueue_job('radius-nas-sync',
      jsonb_build_object('nas_id', new.id), new.isp_id);
  end if;
  return new;
end $$;

drop trigger if exists trg_radius_nas_queue_sync on public.radius_nas;
create trigger trg_radius_nas_queue_sync
after update of nasname, enabled, coa_port on public.radius_nas
for each row execute function public.queue_radius_nas_sync();

-- Rotating a secret must reach FreeRADIUS too: the previous secret stays valid at
-- the server until the sync runs, so never rotate without a following sync.
create or replace function public.queue_radius_nas_secret_sync()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_isp uuid;
begin
  select isp_id into v_isp from public.radius_nas where id = coalesce(new.nas_id, old.nas_id);
  if v_isp is not null then
    perform public.enqueue_job('radius-nas-sync',
      jsonb_build_object('nas_id', coalesce(new.nas_id, old.nas_id)), v_isp);
  end if;
  return coalesce(new, old);
end $$;

drop trigger if exists trg_radius_nas_secret_queue_sync on public.radius_nas_secrets;
create trigger trg_radius_nas_secret_queue_sync
after insert or update on public.radius_nas_secrets
for each row execute function public.queue_radius_nas_secret_sync();
