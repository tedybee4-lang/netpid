-- NETPID: per-router WireGuard management tunnel + job hardening.
--
-- Why a tunnel per router
-- -----------------------
-- Until now a router was reachable only over its API port on the open
-- internet. This adds an encrypted management path that INDEPENDENTLY carries
-- the router's RADIUS traffic, so the router does not need a publicly exposed
-- management port at all.
--
-- One tunnel per managed router, keys generated server-side. The private keys
-- are encrypted with APP_ENCRYPTION_KEY exactly like every other credential in
-- NETPID (router_credentials, radius_nas_secrets) and are NEVER returned by a
-- read path.
--
-- A /30 is used per router: this is a point-to-point management link, not a
-- customer-facing network, so a large subnet would only widen the blast radius.

create table if not exists public.router_tunnels (
  id uuid primary key default extensions.uuid_generate_v4(),
  isp_id uuid not null references public.isps(id) on delete cascade,
  router_id uuid not null unique references public.routers(id) on delete cascade,

  -- /30 carved from 10.90.0.0/16. The VPS holds .1, the router .2.
  tunnel_subnet cidr not null,
  vps_tunnel_ip inet not null,
  router_tunnel_ip inet not null,

  -- Public half of the key pair. Safe to display, safe to ship to the router.
  server_public_key text not null,
  -- Private half. Encrypted at rest, write-only, never selected into a response.
  server_private_key_encrypted text not null,

  -- Filled in when the operator pastes the router's public key.
  router_public_key text,

  listen_port integer not null default 51820
    check (listen_port between 1 and 65535),

  status text not null default 'pending'
    check (status in ('pending','provisioned','connected','unreachable','revoked')),
  last_handshake_at timestamptz,
  last_endpoint text,
  last_rx_bytes bigint,
  last_tx_bytes bigint,
  last_checked_at timestamptz,

  notes text check (notes is null or length(notes) <= 2000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- A tunnel subnet must be unique across the platform: two routers sharing a
-- subnet would black-hole each other's traffic.
create unique index if not exists uq_router_tunnels_subnet
  on public.router_tunnels (tunnel_subnet);
create index if not exists idx_router_tunnels_isp
  on public.router_tunnels (isp_id);
create index if not exists idx_router_tunnels_status
  on public.router_tunnels (status);

drop trigger if exists trg_router_tunnels_touch on public.router_tunnels;
create trigger trg_router_tunnels_touch before update on public.router_tunnels
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- RLS. Same shape as routers/router_credentials: Super Admin governs the
-- infrastructure, an ISP admin may only ever see and change its own tunnels.
-- ---------------------------------------------------------------------------
alter table public.router_tunnels enable row level security;

drop policy if exists rt_platform on public.router_tunnels;
create policy rt_platform on public.router_tunnels for all
  using (public.is_platform_admin()) with check (public.is_platform_admin());

drop policy if exists rt_member_read on public.router_tunnels;
create policy rt_member_read on public.router_tunnels for select
  using (public.is_isp_member(isp_id));

drop policy if exists rt_admin_write on public.router_tunnels;
create policy rt_admin_write on public.router_tunnels for all
  using (public.has_isp_role(isp_id,'admin'))
  with check (public.has_isp_role(isp_id,'admin'));

-- ---------------------------------------------------------------------------
-- Job hardening (spec §11/§12): every command must be attributable to a router
-- and carry its result, and re-enqueueing the same logical command must not
-- execute it twice.
-- ---------------------------------------------------------------------------
alter table public.network_jobs add column if not exists router_id uuid
  references public.routers(id) on delete cascade;
alter table public.network_jobs add column if not exists result jsonb;
-- Operator-supplied. NULL means "not idempotent" (legacy rows keep working).
alter table public.network_jobs add column if not exists idempotency_key text;

-- Partial unique index: two live jobs cannot share a key, but a completed one
-- does not block a legitimate re-run later.
create unique index if not exists uq_network_jobs_idempotency
  on public.network_jobs (idempotency_key)
  where idempotency_key is not null and status in ('queued','running','retrying');

create index if not exists idx_network_jobs_router on public.network_jobs(router_id);

-- Enqueue an idempotent job. Returns the EXISTING job id when one is already
-- live with the same key, so a double-clicked button or a retried webhook
-- cannot queue the same MikroTik command twice.
create or replace function public.enqueue_job_once(
  p_kind text, p_payload jsonb default '{}'::jsonb,
  p_isp_id uuid default null, p_router_id uuid default null,
  p_key text default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  if p_key is not null then
    select id into v_id from public.network_jobs
     where idempotency_key = p_key
       and status in ('queued','running','retrying')
     limit 1;
    if v_id is not null then return v_id; end if;
  end if;

  insert into public.network_jobs(kind, payload, isp_id, router_id, idempotency_key)
  values (p_kind, coalesce(p_payload,'{}'::jsonb), p_isp_id, p_router_id, p_key)
  returning id into v_id;
  return v_id;
end $$;
