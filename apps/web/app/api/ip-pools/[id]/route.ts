import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { resolveIsp } from "@/lib/isp";
import { ipPoolUpdateSchema } from "@/lib/validation";
import { parseIpPoolRanges, addressCount, overlapsAny, type ParsedRange } from "@/lib/ip-pools";

// PATCH/DELETE /api/ip-pools/[id].
//
// Two guards exist because the pool is referenced by NAME, not by id:
//   • renaming a pool that packages or PPPoE accounts point at would strand
//     every one of them on a name that no longer exists — so that is refused
//     while the pool is in use;
//   • deleting an in-use pool would do the same, so it is refused too and the
//     caller is told what is holding it.

type Ctx = { params: Promise<{ id: string }> };
type Svc = ReturnType<typeof createServiceClient>;

async function load(supabase: Svc, ispId: string, id: string) {
  const { data } = await supabase.from("ip_pools")
    .select("id, name, ranges").eq("id", id).eq("isp_id", ispId).maybeSingle();
  return data as { id: string; name: string; ranges: string } | null;
}

async function usage(supabase: Svc, ispId: string, name: string) {
  const [{ count: packages }, { count: accounts }] = await Promise.all([
    supabase.from("packages")
      .select("id", { count: "exact", head: true })
      .eq("isp_id", ispId).eq("ip_pool", name),
    supabase.from("pppoe_accounts")
      .select("id", { count: "exact", head: true })
      .eq("isp_id", ispId).eq("ip_pool", name),
  ]);
  return { packages: packages ?? 0, accounts: accounts ?? 0, total: (packages ?? 0) + (accounts ?? 0) };
}

export async function PATCH(req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const r = await resolveIsp(req);
  if ("error" in r) return r.error;

  const pool = await load(r.supabase, r.ispId, id);
  if (!pool) return NextResponse.json({ error: "Pool not found" }, { status: 404 });

  const parsed = ipPoolUpdateSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid input" },
      { status: 400 },
    );
  }

  const nextName = parsed.data.name ?? pool.name;
  const nextRanges = parsed.data.ranges ?? pool.ranges;
  const renaming = nextName !== pool.name;

  const use = await usage(r.supabase, r.ispId, pool.name);
  if (renaming && use.total > 0) {
    return NextResponse.json({
      error: `Cannot rename "${pool.name}": ${use.packages} package(s) and ${use.accounts} PPPoE account(s) point at this name. Update them first.`,
      usage: use,
    }, { status: 409 });
  }

  if (parsed.data.ranges !== undefined) {
    const { ranges, errors } = parseIpPoolRanges(nextRanges);
    if (errors.length) return NextResponse.json({ error: errors[0], errors }, { status: 400 });

    const { data: others } = await r.supabase.from("ip_pools")
      .select("id, name, ranges").eq("isp_id", r.ispId).neq("id", id);
    for (const other of (others ?? []) as { name: string; ranges: string }[]) {
      const hit = overlapsAny(ranges, parseIpPoolRanges(other.ranges).ranges) as ParsedRange | null;
      if (hit) {
        return NextResponse.json(
          { error: `This range overlaps "${other.name}" at ${hit.label}. Pools must not share addresses.` },
          { status: 409 },
        );
      }
    }
  }

  const { data, error } = await r.supabase.from("ip_pools")
    .update({ name: nextName, ranges: nextRanges })
    .eq("id", id).eq("isp_id", r.ispId)
    .select("id, name, ranges, created_at")
    .single();
  if (error) {
    if (error.code === "23505") {
      return NextResponse.json({ error: `A pool named "${nextName}" already exists.` }, { status: 409 });
    }
    return NextResponse.json({ error: error.message }, { status: 400 });
  }

  return NextResponse.json({ pool: data, addresses: addressCount(parseIpPoolRanges(nextRanges).ranges) });
}

export async function DELETE(req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const r = await resolveIsp(req);
  if ("error" in r) return r.error;

  const pool = await load(r.supabase, r.ispId, id);
  if (!pool) return NextResponse.json({ error: "Pool not found" }, { status: 404 });

  const use = await usage(r.supabase, r.ispId, pool.name);
  if (use.total > 0) {
    return NextResponse.json({
      error: `Cannot delete "${pool.name}" while it is in use by ${use.packages} package(s) and ${use.accounts} PPPoE account(s). Clear ip_pool on those first.`,
      usage: use,
    }, { status: 409 });
  }

  const svc = createServiceClient();
  const { error } = await svc.from("ip_pools").delete().eq("id", id).eq("isp_id", r.ispId);
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });

  await svc.from("audit_logs").insert({
    actor_id: r.user.id, actor_type: "user", isp_id: r.ispId,
    action: "ip_pool_deleted", resource: "ip_pools", resource_id: id,
    metadata: { name: pool.name, ranges: pool.ranges },
  });

  return NextResponse.json({ ok: true, message: `Deleted pool "${pool.name}".` });
}
