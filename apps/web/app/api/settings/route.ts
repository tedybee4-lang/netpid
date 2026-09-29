import { NextResponse } from "next/server";
import { resolveIsp } from "@/lib/isp";
import { createServiceClient } from "@/lib/supabase/server";
import { portalSettingsSchema } from "@/lib/validation";

// Page-builder content: the public portal fields on isp_settings plus the
// bits of isps() the builder needs (slug for the preview URL). Admin gated —
// members can read these via RLS, but writes change the public site.

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

// GET /api/settings — current portal content + preview slug.
export async function GET(req: Request) {
  const a = await requireAdmin(req);
  if ("error" in a) return a.error;
  const { ispId } = a.ok;
  const svc = createServiceClient();

  const [{ data: isp }, { data: settings }] = await Promise.all([
    svc.from("isps").select("slug, name, logo_url, support_phone, support_whatsapp, phone, email, location")
      .eq("id", ispId).maybeSingle(),
    svc.from("isp_settings").select("*").eq("isp_id", ispId).maybeSingle(),
  ]);

  return NextResponse.json({
    isp: isp ?? null,
    settings: settings ?? {
      brand_color: "#4F46E5", portal_title: null, portal_terms: null,
      portal_privacy: null, payment_instructions: null, coverage_info: null,
    },
  });
}

// PUT /api/settings — save portal content.
export async function PUT(req: Request) {
  const a = await requireAdmin(req);
  if ("error" in a) return a.error;
  const { ispId } = a.ok;

  const parsed = portalSettingsSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input", issues: parsed.error.flatten() }, { status: 400 });
  }
  const d = parsed.data;
  const svc = createServiceClient();

  const { error } = await svc.from("isp_settings").upsert({
    isp_id: ispId,
    brand_color: d.brand_color,
    portal_title: d.portal_title || null,
    portal_terms: d.portal_terms || null,
    portal_privacy: d.portal_privacy || null,
    payment_instructions: d.payment_instructions || null,
    coverage_info: d.coverage_info || null,
  }, { onConflict: "isp_id" });
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });

  return NextResponse.json({ ok: true });
}