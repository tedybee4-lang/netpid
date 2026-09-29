import { NextResponse } from "next/server";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { createIspSchema, updateIspProfileSchema } from "@/lib/validation";

// POST /api/isp — create ISP for the signed-in user (becomes owner).
// Never trust client isp_id: ISP is derived from the new row + auth session.
export async function POST(req: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json();
  const parsed = createIspSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input", issues: parsed.error.flatten() }, { status: 400 });
  }
  const { name, slug, phone, email, location, planSlug } = parsed.data;

  const svc = createServiceClient();
  // guard: slug unique handled by DB; plan must exist
  const { data: plan } = await svc.from("netpid_plans").select("id").eq("slug", planSlug).maybeSingle();
  if (!plan) return NextResponse.json({ error: "Unknown plan" }, { status: 400 });

  const trialEnds = new Date(Date.now() + 14 * 86400_000).toISOString();
  const { data: isp, error: ispErr } = await svc.from("isps").insert({
    name, slug, phone: phone ?? null, email: email || null, location: location ?? null,
    created_by: user.id, status: "trial", subscription_status: "trialing",
    trial_ends_at: trialEnds,
  }).select("id, slug").single();
  if (ispErr) return NextResponse.json({ error: ispErr.message }, { status: 400 });

  await svc.from("isp_settings").insert({ isp_id: isp.id });
  const { data: iu } = await svc.from("isp_users").insert({
    isp_id: isp.id, user_id: user.id,
    full_name: (user.user_metadata as { full_name?: string })?.full_name ?? null,
  }).select("id").single();
  const { data: owner } = await svc.from("isp_roles").select("id").eq("slug", "owner").single();
  if (iu && owner) await svc.from("isp_user_roles").insert({ isp_user_id: iu.id, role_id: owner.id });
  await svc.from("netpid_subscriptions").insert({
    isp_id: isp.id, plan_id: plan.id, status: "trialing", trial_ends_at: trialEnds,
  });

  return NextResponse.json({ isp });
}

// GET /api/isp — ISPs the current user belongs to (RLS enforced).
export async function GET() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { data, error } = await supabase
    .from("isp_users").select("isp_id, isps(id, name, slug, status, subscription_status, onboarding_step, onboarding_completed)");
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ isps: data });
}

// PATCH /api/isp — update the ISP profile from Settings (owner/admin only;
// RLS isps_owner_update enforces the same rule on the write itself).
export async function PATCH(req: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const parsed = updateIspProfileSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input", issues: parsed.error.flatten() }, { status: 400 });
  }

  const { data: memberships } = await supabase
    .from("isp_users").select("isp_id").eq("user_id", user.id).eq("is_active", true).limit(1);
  const ispId = memberships?.[0]?.isp_id as string | undefined;
  if (!ispId) return NextResponse.json({ error: "No ISP membership" }, { status: 403 });

  const { data: isAdmin } = await supabase.rpc("has_isp_role", {
    p_isp_id: ispId, p_role: "admin",
  });
  if (isAdmin !== true) {
    return NextResponse.json({ error: "Admin access required" }, { status: 403 });
  }

  // Empty strings mean "clear this optional field".
  const { name, slug, phone, email, location, support_phone, support_whatsapp } = parsed.data;
  const patch: Record<string, unknown> = {};
  if (name !== undefined) patch.name = name;
  if (slug !== undefined) patch.slug = slug;
  if (phone !== undefined) patch.phone = phone || null;
  if (email !== undefined) patch.email = email || null;
  if (location !== undefined) patch.location = location || null;
  if (support_phone !== undefined) patch.support_phone = support_phone || null;
  if (support_whatsapp !== undefined) patch.support_whatsapp = support_whatsapp || null;

  const { data, error } = await supabase
    .from("isps")
    .update(patch)
    .eq("id", ispId)
    .select("id, name, slug, phone, email, location, support_phone, support_whatsapp")
    .maybeSingle();
  if (error) {
    if (error.code === "23505") {
      return NextResponse.json({ error: "That URL slug is already taken." }, { status: 409 });
    }
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
  if (!data) return NextResponse.json({ error: "Not allowed" }, { status: 403 });
  return NextResponse.json({ isp: data });
}
