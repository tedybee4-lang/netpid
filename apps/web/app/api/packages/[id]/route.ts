import { NextResponse } from "next/server";
import { z } from "zod";
import { resolveIsp } from "@/lib/isp";

/**
 * Package edit / archive / delete, plus the RADIUS attributes for its group.
 *
 * WHY THIS SCHEMA HAS NO DEFAULTS
 * The obvious shortcut would be `createPackageSchema.partial()`, but Zod still
 * applies a field's `.default()` when that key is ABSENT from a partial parse.
 * A PATCH of `{ name }` would therefore quietly rewrite duration_value to 30,
 * duration_unit to 'days' and enabled to true — silently resetting a package's
 * billing period. So the patch fields are declared explicitly, with no defaults,
 * and only the keys actually sent are written.
 *
 * RADIUS groups are NOT editable here: a trigger (migrations 0021/0034) owns
 * `radius_groups.package_id -> group_name` and would overwrite any name we set.
 * This route only touches the attributes hanging off the group.
 */
const attributeSchema = z.object({
  attribute: z.string().min(2).max(64),
  op: z.string().min(1).max(8).default("="),
  value: z.string().min(1).max(200),
});

const patchSchema = z.object({
  name: z.string().min(2).max(120).optional(),
  service_type: z.enum(["pppoe", "hotspot", "voucher", "static"]).optional(),
  price: z.number().int().min(0).optional(),
  duration_value: z.number().int().min(1).optional(),
  duration_unit: z.enum(["hours", "days", "weeks", "months"]).optional(),
  download_kbps: z.number().int().positive().nullable().optional(),
  upload_kbps: z.number().int().positive().nullable().optional(),
  data_cap_mb: z.number().int().positive().nullable().optional(),
  session_timeout: z.number().int().positive().nullable().optional(),
  idle_timeout: z.number().int().positive().nullable().optional(),
  simultaneous_users: z.number().int().min(1).optional(),
  ip_pool: z.string().max(64).nullable().optional(),
  enabled: z.boolean().optional(),
  // Replace-the-set semantics: whatever is sent becomes the full attribute list.
  radius_attributes: z.array(attributeSchema).max(20).optional(),
}).refine((v) => Object.keys(v).length > 0, { message: "Nothing to update" });

type Ctx = { params: Promise<{ id: string }> };

// GET /api/packages/[id] — the package, its RADIUS group and that group's
// attributes. The group row is created automatically with the package.
export async function GET(req: Request, ctx: Ctx) {
  const r = await resolveIsp(req);
  if ("error" in r) return r.error;
  const { id } = await ctx.params;

  const { data: pkg } = await r.supabase.from("packages")
    .select("*").eq("id", id).eq("isp_id", r.ispId).maybeSingle();
  if (!pkg) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const { data: group } = await r.supabase.from("radius_groups")
    .select("id,group_name,service_type").eq("package_id", id).maybeSingle();
  const attributes = group
    ? (await r.supabase.from("radius_group_attributes")
      .select("id,attribute,op,value").eq("group_id", group.id).order("attribute")).data ?? []
    : [];

  return NextResponse.json({ package: pkg, radius_group: group, attributes });
}

// PATCH /api/packages/[id] — edit fields and/or replace the RADIUS attribute set.
export async function PATCH(req: Request, ctx: Ctx) {
  const r = await resolveIsp(req);
  if ("error" in r) return r.error;
  const { id } = await ctx.params;

  const parsed = patchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  }
  const { radius_attributes, ...fields } = parsed.data;
  if (!Object.keys(fields).length && !radius_attributes) {
    return NextResponse.json({ error: "Nothing to update" }, { status: 400 });
  }

  const { data: exists } = await r.supabase.from("packages")
    .select("id").eq("id", id).eq("isp_id", r.ispId).maybeSingle();
  if (!exists) return NextResponse.json({ error: "Not found" }, { status: 404 });

  let updated: Record<string, unknown> = {};
  if (Object.keys(fields).length) {
    const { data, error } = await r.supabase.from("packages")
      .update(fields).eq("id", id).eq("isp_id", r.ispId).select("*").single();
    if (error) return NextResponse.json({ error: error.message }, { status: 400 });
    updated = data ?? {};
  }

  if (radius_attributes) {
    const { data: group } = await r.supabase.from("radius_groups")
      .select("id").eq("package_id", id).maybeSingle();
    // The group is created by a trigger alongside the package, so a missing one
    // is an inconsistency — not an empty list. Say so rather than drop the edit.
    if (!group) {
      return NextResponse.json(
        { error: "This package has no RADIUS group, so its attributes cannot be saved." },
        { status: 409 },
      );
    }
    const { error: delErr } = await r.supabase.from("radius_group_attributes")
      .delete().eq("group_id", group.id);
    if (delErr) return NextResponse.json({ error: delErr.message }, { status: 400 });
    if (radius_attributes.length) {
      const { error: insErr } = await r.supabase.from("radius_group_attributes").insert(
        radius_attributes.map((a) => ({
          group_id: group.id, attribute: a.attribute, op: a.op, value: a.value,
        })),
      );
      if (insErr) return NextResponse.json({ error: insErr.message }, { status: 400 });
    }
  }

  return NextResponse.json({ package: updated });
}

// DELETE /api/packages/[id] — hard delete for a package nothing has used yet.
// Anything with history must be archived (enabled=false) instead, so receipts,
// invoices and RADIUS groups keep pointing at something meaningful.
export async function DELETE(req: Request, ctx: Ctx) {
  const r = await resolveIsp(req);
  if ("error" in r) return r.error;
  const { id } = await ctx.params;

  const { data: pkg } = await r.supabase.from("packages")
    .select("id,name").eq("id", id).eq("isp_id", r.ispId).maybeSingle();
  if (!pkg) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // payments.package_id may be ON DELETE SET NULL, in which case Postgres would
  // let this through and quietly drop the package link from historical payments.
  // So we check the two tables where losing the link actually hurts.
  const [cust, pay] = await Promise.all([
    r.supabase.from("customers").select("id", { count: "exact", head: true }).eq("package_id", id),
    r.supabase.from("payments").select("id", { count: "exact", head: true }).eq("package_id", id),
  ]);
  const nCust = cust.count ?? 0;
  const nPay = pay.count ?? 0;
  if (nCust || nPay) {
    return NextResponse.json({
      in_use: true,
      error: `In use by ${nCust} customer(s) and ${nPay} payment(s). Archive it instead — archiving keeps history intact.`,
    }, { status: 409 });
  }

  const { error } = await r.supabase.from("packages").delete()
    .eq("id", id).eq("isp_id", r.ispId);
  if (error) {
    // We only checked the obvious tables, so a rarer reference (data_usage,
    // pppoe_accounts, customer_packages…) can still block. Translate the FK
    // violation rather than leaking SQL at the operator.
    const fk = error.code === "23503";
    return NextResponse.json({
      in_use: fk,
      error: fk ? "Package is still referenced by other records. Archive it instead." : error.message,
    }, { status: fk ? 409 : 400 });
  }
  return NextResponse.json({ ok: true });
}
