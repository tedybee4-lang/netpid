// Recycle bin. Rows are written by soft-deletes elsewhere in the app; this
// route lists them, restores, or purges permanently.
//
// RESTORE is guarded by an allow-list. The table_name comes from the database,
// but a compromised row must not be able to name an arbitrary relation (or
// auth.users) and have a row written back into it.
import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { resolveIsp } from "@/lib/isp";
import { z } from "zod";

const RESTORABLE = new Set(["customers", "routers", "packages", "vouchers", "inventory_items"]);

export async function GET(req: Request) {
  const r = await resolveIsp(req);
  if ("error" in r) return r.error;
  const { data } = await r.supabase
    .from("recycle_bin")
    .select("id,table_name,row_id,label,deleted_at,restored_at,deleted_by")
    .eq("isp_id", r.ispId).order("deleted_at", { ascending: false }).limit(200);
  return NextResponse.json({ items: data ?? [] });
}

export async function POST(req: Request) {
  const r = await resolveIsp(req);
  if ("error" in r) return r.error;
  const parsed = z.object({ id: z.string().uuid(), action: z.enum(["restore", "purge"]) })
    .safeParse(await req.json());
  if (!parsed.success) return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  const { id, action } = parsed.data;
  const svc = createServiceClient();

  const { data: item } = await svc.from("recycle_bin")
    .select("id,table_name,row_id,payload,restored_at")
    .eq("id", id).eq("isp_id", r.ispId).maybeSingle();
  if (!item) return NextResponse.json({ error: "Not found" }, { status: 404 });

  if (action === "purge") {
    await svc.from("recycle_bin").delete().eq("id", id).eq("isp_id", r.ispId);
    return NextResponse.json({ ok: true, purged: true });
  }

  if (!RESTORABLE.has(item.table_name)) {
    return NextResponse.json({ error: `${item.table_name} cannot be restored from here` }, { status: 400 });
  }
  if (item.restored_at) {
    return NextResponse.json({ error: "Already restored" }, { status: 400 });
  }
  // If the row still exists it was never really deleted; refuse rather than
  // clobber live data with the stale payload.
  // The table name comes from the allow-list above, but the Supabase client is
  // typed against a literal table union, so a dynamic name needs the escape
  // hatch. It is deliberately routed through `unknown` — casting a builder
  // directly trips "types do not sufficiently overlap".
  type Loose = {
    select: (cols: string) => { eq: (c: string, v: string) => { maybeSingle: () => PromiseLike<{ data: unknown }> } };
    upsert: (v: Record<string, unknown>) => PromiseLike<{ error: { message: string } | null }>;
  };
  const table = svc.from(item.table_name as never) as unknown as Loose;

  // If the row still exists it was never really deleted; refuse rather than
  // clobber live data with the stale payload.
  const { data: live } = await table.select("id").eq("id", item.row_id).maybeSingle();
  if (live) return NextResponse.json({ error: "That record already exists" }, { status: 409 });

  const { error } = await table.upsert({ id: item.row_id, ...item.payload });
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  await svc.from("recycle_bin").update({ restored_at: new Date().toISOString() })
    .eq("id", id).eq("isp_id", r.ispId);
  return NextResponse.json({ ok: true, restored: item.table_name });
}
