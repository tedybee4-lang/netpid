-- NETPID 0041: Daraja payments, manual M-Pesa, router capabilities, VPS migration.
-- ADDITIVE ONLY. No table dropped, no column removed, no CHECK tightened.

alter table public.payment_providers alter column provider drop default;
alter table public.payment_providers alter column provider set default 'daraja';
alter table public.payments alter column provider drop default;
alter table public.payments alter column provider set default 'daraja';
alter table public.payment_webhooks alter column provider drop default;
alter table public.payment_webhooks alter column provider set default 'daraja';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'payment_providers_provider_allowed') then
    alter table public.payment_providers add constraint payment_providers_provider_allowed
      check (provider in ('payhero','daraja','manual'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'payments_provider_allowed') then
    alter table public.payments add constraint payments_provider_allowed
      check (provider in ('payhero','daraja','manual'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'payment_webhooks_provider_allowed') then
    alter table public.payment_webhooks add constraint payment_webhooks_provider_allowed
      check (provider in ('payhero','daraja','manual'));
  end if;
end $$;

alter table public.payments
  add column if not exists checkout_request_id text,
  add column if not exists merchant_request_id text,
  add column if not exists mpesa_receipt text,
  add column if not exists reference text;

create unique index if not exists uq_payments_checkout
  on public.payments (checkout_request_id) where checkout_request_id is not null;
create unique index if not exists uq_payments_mpesa_receipt
  on public.payments (mpesa_receipt) where mpesa_receipt is not null;
alter table public.routers
  add column if not exists arch text,
  add column if not exists cpu text,
  add column if not exists cpu_cores integer,
  add column if not exists ram_mb integer,
  add column if not exists storage_mb integer,
  add column if not exists interfaces_json jsonb not null default '[]'::jsonb,
  add column if not exists has_wireguard boolean,
  add column if not exists has_radius boolean,
  add column if not exists has_pppoe boolean,
  add column if not exists has_hotspot boolean,
  add column if not exists has_vlan boolean,
  add column if not exists has_api_ssl boolean,
  add column if not exists provisioning_profile text,
  add column if not exists capabilities_checked_at timestamptz,
  add column if not exists wan_info text,
  add column if not exists compatibility_notes text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'routers_profile_allowed') then
    alter table public.routers add constraint routers_profile_allowed
      check (provisioning_profile is null
        or provisioning_profile in ('legacy','standard','advanced','enterprise'));
  end if;
end $$;

create index if not exists idx_routers_profile on public.routers(provisioning_profile);

do $$
begin
  if exists (
    select 1 from pg_constraint where conname = 'router_provision_log_action_check'
  ) then
    alter table public.router_provision_log drop constraint router_provision_log_action_check;
  end if;
  alter table public.router_provision_log add constraint router_provision_log_action_check
    check (action in
      ('created','updated','tested','provisioned','speed-applied','deleted',
       'script-generated','capabilities-probed','wireguard_create','wireguard_rotate',
       'wireguard_revoke'));
end $$;

alter table public.vps_servers
  add column if not exists role text not null default 'primary',
  add column if not exists active boolean not null default true,
  add column if not exists replaces_server_id uuid references public.vps_servers(id) on delete set null,
  add column if not exists migration_status text,
  add column if not exists migration_notes text,
  add column if not exists decommissioned_at timestamptz;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'vps_servers_role_allowed') then
    alter table public.vps_servers add constraint vps_servers_role_allowed
      check (role in ('primary','standby','retired'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'vps_servers_no_self_replace') then
    alter table public.vps_servers add constraint vps_servers_no_self_replace
      check (replaces_server_id is null or replaces_server_id <> id);
  end if;
end $$;

create index if not exists idx_vps_servers_active on public.vps_servers(active) where active;

do $$
begin
  if exists (select 1 from pg_constraint where conname = 'platform_audit_log_action_check') then
    alter table public.platform_audit_log drop constraint platform_audit_log_action_check;
  end if;
  alter table public.platform_audit_log add constraint platform_audit_log_action_check
    check (action in
      ('vps_created','vps_updated','vps_deleted','vps_credentials_changed',
       'vps_connection_tested','vps_enabled','vps_disabled',
       'vps_migration_started','vps_switched','vps_decommissioned',
       'worker_action','wireguard_action','radius_action','firewall_action',
       'admin_login','admin_logout'));
end $$;
