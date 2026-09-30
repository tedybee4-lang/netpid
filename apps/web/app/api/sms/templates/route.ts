import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { resolveIsp } from "@/lib/isp";
import { smsTemplateSchema } from "@/lib/validation";

// SMS templates: what the queue sends for each event.
//
// Reads are open to any ISP member (matching `smst_member` RLS); writes are
// admin-gated, because changing a template changes what every subscriber receives.

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

// GET /api/sms/templates — every template for this ISP, enabled and disabled.
export async function GET(req: Request) {
  const r = await resolveIsp(req);
  if ("error" in r) return r.error;

  const { data, error } = await r.supabase.from("sms_templates")
    .select("id, event, locale, body, enabled, created_at")
    .eq("isp_id", r.ispId)
    .order("event", { ascending: true });
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });

  return NextResponse.json({ templates: data ?? [] });
}

// POST /api/sms/templates — create a template for an event/locale.
export async function POST(req: Request) {
  const a = await requireAdmin(req);
  if ("error" in a) return a.error;
  const r = a.ok;

  const parsed = smsTemplateSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid input" },
      { status: 400 },
    );
  }

  const svc = createServiceClient();
  const { data, error } = await svc.from("sms_templates").insert({
    isp_id: r.ispId,
    event: parsed.data.event,
    locale: parsed.data.locale,
    body: parsed.data.body,
    enabled: parsed.data.enabled,
  }).select("id, event, locale, body, enabled, created_at").single();

  if (error) {
    // 23505 = unique (isp_id, event, locale). Say what actually collides
    // instead of leaking the constraint name.
    if (error.code === "23505") {
      return NextResponse.json(
        { error: `A "${parsed.data.event}" template already exists for locale "${parsed.data.locale}". Edit that one instead.` },
        { status: 409 },
      );
    }
    return NextResponse.json({ error: error.message }, { status: 400 });
  }

  return NextResponse.json({ template: data }, { status: 201 });
}
