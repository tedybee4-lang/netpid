-- NETPID: tables behind the remaining dashboard modules.
--
-- Groups added to the sidebar (Support tickets, Bulk actions, UISP, Social Spot,
-- Escalate, Extras, Recycle bin) need somewhere real to write; these are
-- tenant-scoped and follow the same RLS shape as the rest of the schema.

-- Support tickets raised by staff, mirrored from customer WhatsApp/email.
create table if not exists public.support_tickets (
  id uuid primary key default extensions.uuid_generate_v4(),
  isp_id uuid not null references public.isps(id) on delete cascade,
  customer_id uuid references public.customers(id) on delete set null,
  ticket_no text not null,
  subject text not null,
  body text not null default '',
  channel text not null default 'email' check (channel in ('email','whatsapp','phone','portal')),
  priority text not null default 'normal' check (priority in ('low','normal','high','urgent')),
  status text not null default 'open' check (status in ('open','pending','resolved','closed')),
  assigned_to uuid references auth.users(id) on delete set null,
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (isp_id, ticket_no)
);
drop trigger if exists trg_tickets_touch on public.support_tickets;
create trigger trg_tickets_touch before update on public.support_tickets
  for each row execute function public.touch_updated_at();
create index if not exists idx_tickets_isp on public.support_tickets(isp_id, status, created_at desc);

-- Bulk jobs: one row per submitted batch so the result is auditable.
create table if not exists public.bulk_jobs (
  id uuid primary key default extensions.uuid_generate_v4(),
  isp_id uuid not null references public.isps(id) on delete cascade,
  kind text not null check (kind in ('suspend','resume','expire','extend','sms','rebuild_radius')),
  payload jsonb not null default '{}'::jsonb,
  total integer not null default 0,
  succeeded integer not null default 0,
  failed integer not null default 0,
  status text not null default 'queued' check (status in ('queued','running','done','failed')),
  detail jsonb not null default '{}'::jsonb,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  finished_at timestamptz
);
create index if not exists idx_bulk_jobs_isp on public.bulk_jobs(isp_id, created_at desc);

-- Provider connections (UISP, Social Spot). Secrets stay server-side; only the
-- status and last check are ever returned to the browser.
create table if not exists public.integrations (
  id uuid primary key default extensions.uuid_generate_v4(),
  isp_id uuid not null references public.isps(id) on delete cascade,
  provider text not null check (provider in ('uisp','social_spot','whatsapp_business','sms_alt')),
  enabled boolean not null default false,
  base_url text,
  api_key_encrypted text,
  extra jsonb not null default '{}'::jsonb,
  last_status text,
  last_checked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (isp_id, provider)
);
drop trigger if exists trg_integrations_touch on public.integrations;
create trigger trg_integrations_touch before update on public.integrations
  for each row execute function public.touch_updated_at();

-- Escalations to NETPID platform support.
create table if not exists public.escalations (
  id uuid primary key default extensions.uuid_generate_v4(),
  isp_id uuid not null references public.isps(id) on delete cascade,
  category text not null default 'general',
  summary text not null,
  detail text not null default '',
  diagnostics jsonb not null default '{}'::jsonb,
  status text not null default 'open' check (status in ('open','ack','resolved')),
  raised_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);
create index if not exists idx_escalations_isp on public.escalations(isp_id, created_at desc);

-- HotSpot binding: MAC <-> voucher/customer assignments an operator made.
create table if not exists public.hotspot_bindings (
  id uuid primary key default extensions.uuid_generate_v4(),
  isp_id uuid not null references public.isps(id) on delete cascade,
  mac text not null,
  customer_id uuid references public.customers(id) on delete set null,
  voucher_id uuid references public.vouchers(id) on delete set null,
  ssid text,
  note text,
  created_at timestamptz not null default now(),
  unique (isp_id, mac)
);

-- Pinned favourites, per staff member rather than per ISP so two operators can
-- keep different shortcuts.
create table if not exists public.dashboard_favorites (
  id uuid primary key default extensions.uuid_generate_v4(),
  isp_id uuid not null references public.isps(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  label text not null,
  href text not null,
  position integer not null default 0,
  created_at timestamptz not null default now(),
  unique (user_id, href)
);

-- ---------- RLS (mirrors isp_settings: member read, admin write) ----------
do $$
declare t text;
begin
  foreach t in array array[
    'support_tickets','bulk_jobs','integrations','escalations','hotspot_bindings'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists %I on public.%I', t || '_platform', t);
    execute format(
      'create policy %I on public.%I for all using (public.is_platform_admin()) '
      || 'with check (public.is_platform_admin())', t || '_platform', t);
    execute format('drop policy if exists %I on public.%I', t || '_member', t);
    execute format(
      'create policy %I on public.%I for select using (public.is_isp_member(isp_id))',
      t || '_member', t);
    execute format('drop policy if exists %I on public.%I', t || '_admin', t);
    execute format(
      'create policy %I on public.%I for all using (public.has_isp_role(isp_id,''admin'')) '
      || 'with check (public.has_isp_role(isp_id,''admin''))', t || '_admin', t);
  end loop;
end $$;

alter table public.dashboard_favorites enable row level security;
drop policy if exists fav_platform on public.dashboard_favorites;
create policy fav_platform on public.dashboard_favorites for all
  using (public.is_platform_admin()) with check (public.is_platform_admin());
drop policy if exists fav_own on public.dashboard_favorites;
create policy fav_own on public.dashboard_favorites for all
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create index if not exists idx_fav_user on public.dashboard_favorites(user_id, position);
