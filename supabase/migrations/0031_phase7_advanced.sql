-- NETPID Phase 7: TR-069 ACS Devices, Network Topology, AI Diagnostic Logs

-- 1. TR-069 Auto Configuration Server (ACS) CPE Devices
create table if not exists public.tr069_devices (
  id uuid primary key default uuid_generate_v4(),
  isp_id uuid not null references public.isps(id) on delete cascade,
  customer_id uuid references public.customers(id) on delete set null,
  serial_number text not null,
  oui text not null default '',
  product_class text not null default '',
  manufacturer text,
  hardware_version text,
  software_version text,
  connection_request_url text,
  acs_username text,
  acs_password text,
  ip_address inet,
  mac_address text,
  last_inform_at timestamptz,
  status text not null default 'offline' check (status in ('online','offline','provisioning','faulty')),
  parameters jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (isp_id, serial_number)
);
create index if not exists idx_tr069_serial on public.tr069_devices(isp_id, serial_number);

-- 2. Network Topology & Fiber / Wireless Distribution Nodes
create table if not exists public.network_nodes (
  id uuid primary key default uuid_generate_v4(),
  isp_id uuid not null references public.isps(id) on delete cascade,
  parent_node_id uuid references public.network_nodes(id) on delete set null,
  router_id uuid references public.routers(id) on delete set null,
  name text not null,
  node_type text not null check (node_type in ('core_pop','tower','olt','splitter_box','switch','mast','ap')),
  latitude numeric(9,6),
  longitude numeric(9,6),
  address text,
  status text not null default 'operational' check (status in ('operational','degraded','offline','maintenance')),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 3. AI Assistant Diagnostic Logs & Network Health Checks
create table if not exists public.ai_diagnostic_logs (
  id uuid primary key default uuid_generate_v4(),
  isp_id uuid not null references public.isps(id) on delete cascade,
  target_type text not null check (target_type in ('customer','router','pppoe','system')),
  target_id text not null,
  prompt text not null,
  diagnosis text not null,
  suggested_action text,
  severity text not null default 'info' check (severity in ('info','low','medium','high','critical')),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists idx_ai_diag_isp on public.ai_diagnostic_logs(isp_id, created_at desc);
