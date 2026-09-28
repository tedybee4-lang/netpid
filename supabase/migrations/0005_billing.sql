-- NETPID Phase 1: SaaS subscription billing (platform revenue, separate from ISP M-Pesa)
create table if not exists public.netpid_plans (
  id uuid primary key default extensions.uuid_generate_v4(),
  slug text not null unique, name text not null,
  price_monthly integer not null default 0, -- minor units (cents of KES)
  price_yearly integer not null default 0,
  currency text not null default 'KES',
  limits jsonb not null default '{}'::jsonb,
  features jsonb not null default '[]'::jsonb,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);
create table if not exists public.netpid_subscriptions (
  id uuid primary key default extensions.uuid_generate_v4(),
  isp_id uuid not null references public.isps(id) on delete cascade,
  plan_id uuid not null references public.netpid_plans(id),
  status text not null default 'trialing'
    check (status in ('trialing','active','past_due','grace','suspended','cancelled','expired')),
  billing_cycle text not null default 'monthly' check (billing_cycle in ('monthly','yearly')),
  trial_ends_at timestamptz, current_period_start timestamptz,
  current_period_end timestamptz, grace_until timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
drop trigger if exists trg_subs_touch on public.netpid_subscriptions;
create trigger trg_subs_touch before update on public.netpid_subscriptions
  for each row execute function public.touch_updated_at();
create table if not exists public.netpid_subscription_payments (
  id uuid primary key default extensions.uuid_generate_v4(),
  subscription_id uuid not null references public.netpid_subscriptions(id) on delete cascade,
  isp_id uuid not null references public.isps(id) on delete cascade,
  amount integer not null, currency text not null default 'KES',
  provider text not null default 'payhero',
  provider_tx_id text, idempotency_key text not null unique,
  status text not null default 'pending'
    check (status in ('pending','completed','failed','refunded')),
  paid_at timestamptz, created_at timestamptz not null default now()
);
create table if not exists public.netpid_invoices (
  id uuid primary key default extensions.uuid_generate_v4(),
  isp_id uuid not null references public.isps(id) on delete cascade,
  subscription_id uuid references public.netpid_subscriptions(id),
  number text not null unique, amount integer not null,
  currency text not null default 'KES',
  status text not null default 'open'
    check (status in ('open','paid','void','overdue')),
  due_at timestamptz, paid_at timestamptz,
  created_at timestamptz not null default now()
);
-- RLS in 0009_policies.sql.
