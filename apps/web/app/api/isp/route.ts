import { NextResponse } from "next/server";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { createIspSchema } from "@/lib/validation";

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
