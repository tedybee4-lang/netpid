-- NETPID: monthly collection of the platform fee from ISPs.
--
-- Until now NETPID could compute MRR on the admin overview, but there was no
-- artefact representing what an ISP actually owes for a given month and no way
-- to record that they paid. An operator was keeping that ledger in a spreadsheet,
-- which means it cannot answer "who is late" without manual reconciliation.
--
-- One invoice per ISP per month. The unique index is the whole point: raising
-- the same month twice is a double bill, and the database refuses it rather than
-- relying on the UI being careful.
--
-- Deliberately NOT auto-suspending anything when an invoice goes unpaid.
-- Suspending an ISP cuts off live paying subscribers, and that consequence
-- should never be a side effect of a nightly job nobody asked for. Overdue is
-- recorded and surfaced; the decision to act stays with a human.
create table if not exists public.isp_invoices (
  id uuid primary key default extensions.uuid_generate_v4(),
  isp_id uuid not null references public.isps(id) on delete cascade,
  period text not null check (period ~ '^[0-9]{4}-[0-9]{2}$'),
  plan_id uuid references public.netpid_plans(id) on set null,
  amount integer not null check (amount > 0), -- minor units, same as payments
  currency text not null default 'KES',
  status text not null default 'issued'
    check (status in ('issued','paid','void','overdue')),
  due_on date,
  paid_at timestamz,
  payment_reference text,  -- M-Pesa receipt or bank reference, as recorded
  note text,
  issued_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists uq_isp_invoice_period
  on public.isp_invoices (isp_id, period);
create index if not exists idx_isp_invoices_period
  on public.isp_invoices (period desc, status);
drop trigger if exists trg_isp_invoice_touch on public.isp_invoices;
create trigger trg_isp_invoice_touch before update on public.isp_invoices
  for each row execute function public.touch_updated_at();

-- Service-role only: no policies for anon/authenticated, exactly like
-- payment_provider_credentials. The admin console reaches this through the
-- service role behind lib/admin-auth.ts, never as a user session.
alter table public.isp_invoices enable row level security;
