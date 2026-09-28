-- NETPID Phase 2: SMS (TOPSPEED) + notifications (tables; policies in 0015)
create table if not exists public.sms_providers (
  id uuid primary key default uuid_generate_v4(),
  isp_id uuid not null references public.isps(id) on delete cascade,
  provider text not null default 'topspeed',
  endpoint text not null default 'https://api.topspeed.example/sms',
  sender_id text, status text not null default 'active'
    check (status in ('active','disabled')),
  created_at timestamptz not null default now(),
  unique (isp_id, provider)
);
create table if not exists public.sms_settings (
  isp_id uuid primary key references public.isps(id) on delete cascade,
  daily_limit integer not null default 500,
  monthly_limit integer not null default 5000,
  enabled boolean not null default true,
  updated_at timestamptz not null default now()
);
create table if not exists public.sms_credentials (
  provider_id uuid primary key references public.sms_providers(id) on delete cascade,
  encrypted_secret text not null, key_version integer not null default 1,
  updated_at timestamptz not null default now()
);
create table if not exists public.sms_templates (
  id uuid primary key default uuid_generate_v4(),
  isp_id uuid not null references public.isps(id) on delete cascade,
  event text not null, -- welcome|payment_received|package_activated|...
  locale text not null default 'en', body text not null,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  unique (isp_id, event, locale)
);
create table if not exists public.sms_logs (
  id uuid primary key default uuid_generate_v4(),
  isp_id uuid not null references public.isps(id) on delete cascade,
  to_phone text not null, body text not null, event text,
  status text not null default 'queued'
    check (status in ('queued','sent','failed','skipped')),
  attempts integer not null default 0,
  provider_response jsonb, error text,
  created_at timestamptz not null default now()
);
create index if not exists idx_sms_logs_isp on public.sms_logs(isp_id, created_at desc);
create table if not exists public.sms_usage (
  isp_id uuid not null references public.isps(id) on delete cascade,
  day date not null, sent integer not null default 0,
  failed integer not null default 0,
  primary key (isp_id, day)
);
create table if not exists public.notifications (
  id uuid primary key default uuid_generate_v4(),
  isp_id uuid not null references public.isps(id) on delete cascade,
  recipient_user_id uuid references auth.users(id) on delete set null,
  customer_id uuid references public.customers(id) on delete set null,
  type text not null, title text not null, message text not null,
  read boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists idx_notif_user on public.notifications(recipient_user_id, created_at desc);
