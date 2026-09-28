-- NETPID Phase 1: platform tables (super admin, flags, audit, health)

-- ---------- platform_admins ----------
create table if not exists public.platform_admins (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null unique references auth.users(id) on delete cascade,
  email text not null,
  full_name text,
  role text not null default 'support' check (role in ('super_admin','admin','support','finance','readonly')),
  is_active boolean not null default true,
  mfa_enforced boolean not null default true,
  last_login_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
drop trigger if exists trg_platform_admins_touch on public.platform_admins;
create trigger trg_platform_admins_touch before update on public.platform_admins
  for each row execute function public.touch_updated_at();

-- RLS policies in 0009_policies.sql (functions must exist first).

-- ---------- feature_flags ----------
create table if not exists public.feature_flags (
  key text primary key,
  name text not null,
  description text,
  enabled_default boolean not null default true,
  created_at timestamptz not null default now()
);
-- RLS policies in 0009_policies.sql.

create table if not exists public.isp_feature_flags (
  isp_id uuid not null,
  flag_key text not null references public.feature_flags(key) on delete cascade,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  primary key (isp_id, flag_key)
);

-- ---------- announcements ----------
create table if not exists public.announcements (
  id uuid primary key default uuid_generate_v4(),
  audience text not null default 'isps' check (audience in ('isps','platform','all')),
  title text not null,
  body text not null,
  published boolean not null default false,
  published_at timestamptz,
  created_by uuid references public.platform_admins(id),
  created_at timestamptz not null default now()
);
-- RLS policies in 0009_policies.sql.

-- ---------- system_settings / health ----------
create table if not exists public.system_settings (
  key text primary key, value jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
-- RLS policies in 0009_policies.sql.

create table if not exists public.system_health (
  id uuid primary key default uuid_generate_v4(),
  component text not null, -- supabase|database|radius|radius_db|worker|payhero|sms|queue|vercel|webhooks
  status text not null default 'unknown' check (status in ('online','degraded','offline','unknown')),
  latency_ms integer, detail jsonb not null default '{}'::jsonb,
  checked_at timestamptz not null default now()
);
create index if not exists idx_system_health_component on public.system_health(component, checked_at desc);
-- RLS policies in 0009_policies.sql.
