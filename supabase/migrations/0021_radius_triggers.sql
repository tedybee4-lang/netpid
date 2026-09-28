-- NETPID Phase 3: sync triggers + group auto-provision from packages.
-- Chain: payment webhook activates entitlement → Phase-5 trigger queues radius-sync.
-- Here: customer status/username changes mark radius_users pending.

create or replace function public.mark_radius_user_pending()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  update public.radius_users
  set sync_status = 'pending', sync_error = null, updated_at = now()
  where customer_id = coalesce(new.id, old.id);
  return coalesce(new, old);
end $$;
drop trigger if exists trg_customers_radius_sync on public.customers;
create trigger trg_customers_radius_sync after update of status, username, package_id
on public.customers for each row execute function public.mark_radius_user_pending();

-- Package → radius group auto-provision (tenant-isolated group names)
create or replace function public.provision_radius_group()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_slug text; v_group text;
begin
  select slug into v_slug from public.isps where id = new.isp_id;
  v_slug := regexp_replace(lower(coalesce(v_slug, 'isp')), '[^a-z0-9]+', '', 'g');
  v_group := substring(v_slug || '_' || new.service_type || '_' ||
    regexp_replace(lower(new.name), '[^a-z0-9]+', '', 'g') from 1 for 64);
  insert into public.radius_groups (isp_id, package_id, group_name, service_type)
  values (new.isp_id, new.id, v_group, new.service_type)
  on conflict (package_id) do update set group_name = excluded.group_name;
  -- Derive reply attributes from package (never hard-coded in frontend)
  insert into public.radius_group_attributes (group_id, attribute, op, value)
  select g.id, a.attribute, a.op, a.value
  from public.radius_groups g cross join (values
    ('Mikrotik-Rate-Limit', '=', coalesce(new.upload_kbps, 0) || 'k/' || coalesce(new.download_kbps, 0) || 'k'),
    ('Session-Timeout', '=', coalesce(new.session_timeout, 0)),
    ('Idle-Timeout', '=', coalesce(new.idle_timeout, 0)),
    ('Port-Limit', '=', coalesce(new.simultaneous_users, 1))
  ) as a(attribute, op, value)
  where g.package_id = new.id
  on conflict (group_id, attribute) do update
    set value = excluded.value;
  -- Point customer's radius_user at the group
  update public.radius_users set radius_group = v_group, sync_status = 'pending'
  where customer_id in (select id from public.customers where package_id = new.id);
  return new;
end $$;
drop trigger if exists trg_packages_radius_group on public.packages;
create trigger trg_packages_radius_group after insert or update of
  name, service_type, download_kbps, upload_kbps,
  session_timeout, idle_timeout, simultaneous_users
on public.packages for each row execute function public.provision_radius_group();

-- NOTE: Mikrotik-Rate-Limit value is "<up>k/<down>k" (upload first) per MikroTik
-- convention, e.g. '512k/5120k'. Zero means unset — sync service skips zeros.
