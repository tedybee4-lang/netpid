-- NETPID Phase 6: Resellers, Referrals, Inventory, Expenses, Loyalty Points

-- 1. Resellers / Agents
create table if not exists public.resellers (
  id uuid primary key default extensions.uuid_generate_v4(),
  isp_id uuid not null references public.isps(id) on delete cascade,
  user_id uuid references auth.users(id) on delete set null,
  name text not null,
  phone text not null,
  email text,
  commission_percentage numeric(5,2) not null default 10.00 check (commission_percentage >= 0 and commission_percentage <= 100),
  balance_minor bigint not null default 0,
  status text not null default 'active' check (status in ('active','suspended','inactive')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 2. Referrals
create table if not exists public.referrals (
  id uuid primary key default extensions.uuid_generate_v4(),
  isp_id uuid not null references public.isps(id) on delete cascade,
  referrer_customer_id uuid not null references public.customers(id) on delete cascade,
  referred_customer_id uuid references public.customers(id) on delete set null,
  status text not null default 'pending' check (status in ('pending','converted','rewarded','expired')),
  reward_amount_minor integer not null default 0,
  rewarded_at timestamptz,
  created_at timestamptz not null default now()
);

-- 3. Hardware & Inventory
create table if not exists public.inventory_items (
  id uuid primary key default extensions.uuid_generate_v4(),
  isp_id uuid not null references public.isps(id) on delete cascade,
  item_type text not null check (item_type in ('onu','router','cable','switch','antenna','accessory','other')),
  model text not null,
  serial_number text,
  mac_address text,
  status text not null default 'in_stock' check (status in ('in_stock','assigned','faulty','retired')),
  assigned_customer_id uuid references public.customers(id) on delete set null,
  assigned_router_id uuid references public.routers(id) on delete set null,
  purchase_cost_minor integer not null default 0,
  purchase_date date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_inv_serial on public.inventory_items(isp_id, serial_number);

-- 4. Operating Expenses
create table if not exists public.expenses (
  id uuid primary key default extensions.uuid_generate_v4(),
  isp_id uuid not null references public.isps(id) on delete cascade,
  category text not null check (category in ('upstream_bandwidth','rent','power','transport','maintenance','salaries','hardware','other')),
  title text not null,
  amount_minor integer not null check (amount_minor > 0),
  expense_date date not null default current_date,
  receipt_url text,
  notes text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists idx_expenses_date on public.expenses(isp_id, expense_date desc);

-- 5. Customer Loyalty Points
create table if not exists public.loyalty_ledger (
  id uuid primary key default extensions.uuid_generate_v4(),
  isp_id uuid not null references public.isps(id) on delete cascade,
  customer_id uuid not null references public.customers(id) on delete cascade,
  points integer not null, -- positive for earn, negative for redeem
  reason text not null,
  payment_id uuid references public.payments(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists idx_loyalty_customer on public.loyalty_ledger(customer_id);

alter table public.customers add column if not exists loyalty_points integer not null default 0;
