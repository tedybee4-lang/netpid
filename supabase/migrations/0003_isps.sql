-- NETPID Phase 1: ISP tenancy core tables
create table if not exists public.isps (
  id uuid primary key default extensions.uuid_generate_v4(),
  name text not null, slug text not null unique,
  logo_url text, phone text, email text,
  location text, support_phone text, support_whatsapp text,
  currency text not null default 'KES',
  timezone text not null default 'Africa/Nairobi',
  status text not null default 'trial'
    check (status in ('trial','active','suspended','cancelled')),
  subscription_status text not null default 'trialing'
    check (subscription_status in
      ('trialing','active','past_due','grace','suspended','cancelled','expired')),
  trial_ends_at timestamptz, grace_until timestamptz,
  onboarding_step integer not null default 0,
  onboarding_completed boolean not null default false,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
drop trigger if exists trg_isps_touch on public.isps;
create trigger trg_isps_touch before update on public.isps
  for each row execute function public.touch_updated_at();
create table if not exists public.isp_settings (
  isp_id uuid primary key references public.isps(id) on delete cascade,
  brand_color text not null default '#4F46E5',
  portal_title text, portal_terms text, portal_privacy text,
  payment_instructions text, coverage_info text, sms_sender_id text,
  billing_settings jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
drop trigger if exists trg_isp_settings_touch on public.isp_settings;
create trigger trg_isp_settings_touch before update on public.isp_settings
  for each row execute function public.touch_updated_at();
create table if not exists public.isp_roles (
  id uuid primary key default extensions.uuid_generate_v4(),
  slug text not null unique, name text not null,
  description text, permissions jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);
create table if not exists public.isp_users (
  id uuid primary key default extensions.uuid_generate_v4(),
  isp_id uuid not null references public.isps(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  full_name text, phone text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (isp_id, user_id)
);
drop trigger if exists trg_isp_users_touch on public.isp_users;
create trigger trg_isp_users_touch before update on public.isp_users
  for each row execute function public.touch_updated_at();
create index if not exists idx_isp_users_user on public.isp_users(user_id);
create table if not exists public.isp_user_roles (
  isp_user_id uuid not null references public.isp_users(id) on delete cascade,
  role_id uuid not null references public.isp_roles(id) on delete restrict,
  created_at timestamptz not null default now(),
  primary key (isp_user_id, role_id)
);
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'isp_feature_flags_isp_fk') then
    alter table public.isp_feature_flags
      add constraint isp_feature_flags_isp_fk foreign key (isp_id)
      references public.isps(id) on delete cascade;
  end if;
end $$;
