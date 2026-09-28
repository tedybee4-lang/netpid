-- NETPID Phase 1: audit logs, security events, support-mode sessions, jobs
create table if not exists public.audit_logs (
  id uuid primary key default extensions.uuid_generate_v4(),
  actor_id uuid references auth.users(id),
  actor_type text not null default 'user'
    check (actor_type in ('user','platform_admin','system','worker')),
  isp_id uuid references public.isps(id) on delete set null,
  action text not null, resource text, resource_id text,
  ip inet, metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists idx_audit_isp on public.audit_logs(isp_id, created_at desc);
create index if not exists idx_audit_action on public.audit_logs(action, created_at desc);
create table if not exists public.security_events (
  id uuid primary key default extensions.uuid_generate_v4(),
  user_id uuid references auth.users(id),
  isp_id uuid references public.isps(id) on delete set null,
  kind text not null, ip inet, detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create table if not exists public.login_attempts (
  id uuid primary key default extensions.uuid_generate_v4(),
  email text not null, ip inet, success boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists idx_login_email on public.login_attempts(email, created_at desc);
-- support mode: platform admin viewing an ISP, fully logged + banner
create table if not exists public.support_sessions (
  id uuid primary key default extensions.uuid_generate_v4(),
  admin_id uuid not null references public.platform_admins(id),
  isp_id uuid not null references public.isps(id) on delete cascade,
  reason text not null, started_at timestamptz not null default now(),
  ended_at timestamptz, actions jsonb not null default '[]'::jsonb
);
-- job queue (worker picks up with FOR UPDATE SKIP LOCKED)
create table if not exists public.network_jobs (
  id uuid primary key default extensions.uuid_generate_v4(),
  isp_id uuid references public.isps(id) on delete cascade,
  kind text not null, payload jsonb not null default '{}'::jsonb,
  status text not null default 'queued'
    check (status in ('queued','running','completed','failed','retrying','cancelled')),
  attempts integer not null default 0, max_attempts integer not null default 5,
  run_after timestamptz not null default now(),
  started_at timestamptz, completed_at timestamptz,
  last_error text, created_at timestamptz not null default now()
);
create index if not exists idx_jobs_poll
  on public.network_jobs(status, run_after, created_at);
create table if not exists public.job_runs (
  id uuid primary key default extensions.uuid_generate_v4(),
  job_id uuid not null references public.network_jobs(id) on delete cascade,
  status text not null, attempt integer not null default 1,
  started_at timestamptz not null default now(),
  completed_at timestamptz, error text
);
create table if not exists public.network_job_logs (
  id uuid primary key default extensions.uuid_generate_v4(),
  job_id uuid not null references public.network_jobs(id) on delete cascade,
  level text not null default 'info', message text not null,
  created_at timestamptz not null default now()
);
-- RLS in 0009_policies.sql. Enqueue helper here (no auth-function dependency).
create or replace function public.enqueue_job(
  p_kind text, p_payload jsonb default '{}'::jsonb, p_isp_id uuid default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  insert into public.network_jobs(kind, payload, isp_id)
  values (p_kind, coalesce(p_payload,'{}'::jsonb), p_isp_id) returning id into v_id;
  return v_id;
end $$;
