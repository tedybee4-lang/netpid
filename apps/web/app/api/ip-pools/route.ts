import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { resolveIsp } from "@/lib/isp";
import { ipPoolSchema } from "@/lib/validation";
import { parseIpPoolRanges, addressCount, overlapsAny, type ParsedRange } from "@/lib/ip-pools";

// IP pools — list + create.
//
// `ip_pools` stores `ranges` as free text and carries no capacity or usage
// counters, so both are COMPUTED on read: capacity from the parsed ranges,
// usage from the tables that reference the pool by name (packages.ip_pool and
// pppoe_accounts.ip_pool). Nothing is cached, so the numbers cannot drift.

type PoolRow = { id: string; name: string; ranges: string; created_at: string };
type Svc = ReturnType<typeof createServiceClient>;

async function withUsage(supabase: Svc, ispId: string, pools: PoolRow[]) {
  const [{ data: pkgs }, { data: accts }] = await Promise.all([
    supabase.from("packages").select("id, ip_pool").eq("isp_id", ispId).not("ip_pool", "is", null),
    supabase.from("pppoe_accounts").select("id, ip_pool").eq("isp_id", ispId).not("ip_pool", "is", null),
  ]);

  const used = new Map<string, { packages: number; accounts: number }>();
  for (const p of pools) used.set(p.name, { packages: 0, accounts: 0 });
  for (const p of pkgs ?? []) {
    const k = p.ip_pool as string;
    const cur = used.get(k);
    if (cur) cur.packages++;
  }
  for (const a of accts ?? []) {
    const k = a.ip_pool as string;
    const cur = used.get(k);
    if (cur) cur.accounts++;
  }

  return pools.map((p) => {
    const { ranges, errors } = parseIpPoolRanges(p.ranges);
    const u = used.get(p.name) ?? { packages: 0, accounts: 0 };
    return {
      id: p.id,
      name: p.name,
      ranges: p.ranges,
      created_at: p.created_at,
      addresses: addressCount(ranges),
      entries: ranges.map((r) => r.label),
      parse_errors: errors,
      packages: u.packages,
      accounts: u.accounts,
      in_use: u.packages + u.accounts > 0,
    };
  });
}

// GET /api/ip-pools — this ISP's pools with computed capacity and live usage.
export async function GET(req: Request) {
  const r = await resolveIsp(req);
  if ("error" in r) return r.error;

  const { data, error } = await r.supabase.from("ip_pools")
    .select("id, name, ranges, created_at")
    .eq("isp_id", r.ispId)
    .order("name", { ascending: true });
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });

  return NextResponse.json({
    pools: await withUsage(r.supabase, r.ispId, (data ?? []) as PoolRow[]),
  });
}

// POST /api/ip-pools — create. Validates the ranges themselves, the uniqueness
// of the name, and that the new pool does not claim addresses another pool of
// this ISP already owns.
export async function POST(req: Request) {
  const r = await resolveIsp(req);
  if ("error" in r) return r.error;

  const parsed = ipPoolSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid input" },
      { status: 400 },
    );
  }

  const { ranges, errors } = parseIpPoolRanges(parsed.data.ranges);
  if (errors.length) return NextResponse.json({ error: errors[0], errors }, { status: 400 });

  const { data: others } = await r.supabase.from("ip_pools")
    .select("id, name, ranges").eq("isp_id", r.ispId);
  const rows = (others ?? []) as { id: string; name: string; ranges: string }[];

  if (rows.some((p) => p.name.toLowerCase() === parsed.data.name.toLowerCase())) {
    return NextResponse.json(
      { error: `A pool named "${parsed.data.name}" already exists.` },
      { status: 409 },
    );
  }

  for (const other of rows) {
    const parsedOther = parseIpPoolRanges(other.ranges);
    const hit = overlapsAny(ranges, parsedOther.ranges);
    if (hit) {
      return NextResponse.json(
        { error: `This range overlaps "${other.name}" at ${hit.label}. Pools must not share addresses.` },
        { status: 409 },
      );
    }
  }

  const { data, error } = await r.supabase.from("ip_pools")
    .insert({ isp_id: r.ispId, name: parsed.data.name, ranges: parsed.data.ranges })
    .select("id, name, ranges, created_at")
    .single();
  if (error) {
    if (error.code === "23505") {
      return NextResponse.json({ error: `A pool named "${parsed.data.name}" already exists.` }, { status: 409 });
    }
    return NextResponse.json({ error: error.message }, { status: 400 });
  }

  return NextResponse.json({ pool: data }, { status: 201 });
}
