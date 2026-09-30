import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { resolveIsp } from "@/lib/isp";
import { smsTemplateUpdateSchema } from "@/lib/validation";

// PATCH/DELETE /api/sms/templates/[id] — admin only.
//
// `enabled: false` is the ARCHIVE control: the template stops being used but
// stays on record so the wording an operator wrote is not lost. DELETE removes
// the row entirely, after which the worker falls back to its built-in default.

async function requireAdmin(req: Request) {
  const r = await resolveIsp(req);
  if ("error" in r) return { error: r.error as NextResponse };
  const { data, error } = await r.supabase.rpc("has_isp_role", {
    p_isp_id: r.ispId, p_role: "admin",
  });
  if (error) return { error: NextResponse.json({ error: error.message }, { status: 400 }) };
  if (data !== true) return { error: NextResponse.json({ error: "Admin access required" }, { status: 403 }) };
  return { ok: r };
}

type Ctx = { params: Promise<{ id: string }> };

export async function PATCH(req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const a = await requireAdmin(req);
  if ("error" in a) return a.error;
  const r = a.ok;

  const parsed = smsTemplateUpdateSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid input" },
      { status: 400 },
    );
  }

  const svc = createServiceClient();
  // Scoped by id AND isp_id so a guessed id from another tenant is a 404, not a
  // silent cross-tenant write.
  const { data: existing } = await svc.from("sms_templates")
    .select("id").eq("id", id).eq("isp_id", r.ispId).maybeSingle();
  if (!existing) return NextResponse.json({ error: "Template not found" }, { status: 404 });

  const { data, error } = await svc.from("sms_templates")
    .update(parsed.data)
    .eq("id", id)
    .eq("isp_id", r.ispId)
    .select("id, event, locale, body, enabled, created_at")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });

  return NextResponse.json({ template: data });
}

export async function DELETE(req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const a = await requireAdmin(req);
  if ("error" in a) return a.error;
  const r = a.ok;

  const svc = createServiceClient();
  const { data: existing } = await svc.from("sms_templates")
    .select("id, event").eq("id", id).eq("isp_id", r.ispId).maybeSingle();
  if (!existing) return NextResponse.json({ error: "Template not found" }, { status: 404 });

  const { error } = await svc.from("sms_templates")
    .delete().eq("id", id).eq("isp_id", r.ispId);
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });

  return NextResponse.json({
    ok: true,
    message: `Deleted. "${existing.event}" now falls back to the built-in wording until you create another template.`,
  });
}
