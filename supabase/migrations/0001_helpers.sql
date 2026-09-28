-- NETPID Phase 1: extensions + updated_at trigger
create extension if not exists "uuid-ossp";
create extension if not exists pgcrypto;

create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;
