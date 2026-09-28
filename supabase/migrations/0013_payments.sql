-- NETPID Phase 2: payments (per-ISP PayHero; never mixed with SaaS billing)
create table if not exists public.payment_providers (
  id uuid primary key default extensions.uuid_generate_v4(),
  isp_id uuid not null references public.isps(id) on delete cascade,
  provider text not null default 'payhero', -- payhero
  account_name text, paybill text, till_number text,
  callback_url text, status text not null default 'active'
    check (status in ('active','disabled')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (isp_id, provider)
);
drop trigger if exists trg_payprov_touch on public.payment_providers;
create trigger trg_payprov_touch before update on public.payment_providers
  for each row execute function public.touch_updated_at();

-- credentials stored ENCRYPTED, service-role only (no RLS read for normal users)
create table if not exists public.payment_provider_credentials (
  provider_id uuid primary key references public.payment_providers(id) on delete cascade,
  encrypted_secret text not null, -- AES-GCM via APP_ENCRYPTION_KEY (server/worker only)
  key_version integer not null default 1,
  updated_at timestamptz not null default now()
);

create table if not exists public.payments (
  id uuid primary key default extensions.uuid_generate_v4(),
  isp_id uuid not null references public.isps(id) on delete cascade,
  customer_id uuid not null references public.customers(id) on delete restrict,
  package_id uuid references public.packages(id) on delete set null,
  amount integer not null check (amount > 0), currency text not null default 'KES',
  phone text not null, provider text not null default 'payhero',
  provider_tx_id text, idempotency_key text not null unique,
  status text not null default 'pending'
    check (status in ('pending','completed','failed','cancelled','refunded')),
  paid_at timestamptz, created_at timestamptz not null default now()
);
create index if not exists idx_payments_isp on public.payments(isp_id, created_at desc);
create index if not exists idx_payments_customer on public.payments(customer_id, created_at desc);

create table if not exists public.payment_webhooks (
  id uuid primary key default extensions.uuid_generate_v4(),
  isp_id uuid references public.isps(id) on delete set null,
  provider text not null default 'payhero',
  provider_tx_id text, payload jsonb not null,
  signature_ok boolean, status text not null default 'received'
    check (status in ('received','processed','duplicate','rejected','error')),
  error text, created_at timestamptz not null default now(),
  unique (provider, provider_tx_id)
);
create table if not exists public.payment_reconciliation (
  id uuid primary key default extensions.uuid_generate_v4(),
  isp_id uuid not null references public.isps(id) on delete cascade,
  payment_id uuid references public.payments(id) on delete set null,
  expected_amount integer not null, received_amount integer,
  status text not null default 'pending'
    check (status in ('pending','matched','mismatch','missing')),
  checked_at timestamptz not null default now()
);

create table if not exists public.invoices (
  id uuid primary key default extensions.uuid_generate_v4(),
  isp_id uuid not null references public.isps(id) on delete cascade,
  customer_id uuid not null references public.customers(id) on delete cascade,
  number text not null, amount integer not null, currency text not null default 'KES',
  status text not null default 'open' check (status in ('open','paid','void','overdue')),
  due_at timestamptz, paid_at timestamptz, created_at timestamptz not null default now(),
  unique (isp_id, number)
);
create table if not exists public.receipts (
  id uuid primary key default extensions.uuid_generate_v4(),
  isp_id uuid not null references public.isps(id) on delete cascade,
  payment_id uuid not null references public.payments(id) on delete cascade,
  number text not null, amount integer not null, currency text not null default 'KES',
  created_at timestamptz not null default now(),
  unique (isp_id, number)
);
