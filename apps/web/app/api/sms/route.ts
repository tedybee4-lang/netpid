import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { resolveIsp } from "@/lib/isp";
import { smsSettingsSchema } from "@/lib/validation";

// GET /api/sms?isp= — recent logs + today usage
export async function GET(req: Request) {
  const r = await resolveIsp(req);
  if ("error" in r) return r.error;
  const [{ data: logs }, { data: settings }, { data: usage }] = await Promise.all([
    r.supabase.from("sms_logs").select("id,to_phone,event,status,created_at")
      .eq("isp_id", r.ispId).order("created_at", { ascending: false }).limit(50),
    r.supabase.from("sms_settings").select("*").eq("isp_id", r.ispId).maybeSingle(),
    r.supabase.from("sms_usage").select("*").eq("isp_id", r.ispId)
      .order("day", { ascending: false }).limit(7),
  ]);
  return NextResponse.json({ logs: logs ?? [], settings: settings ?? null, usage: usage ?? [] });
}

// POST /api/sms — update settings (admin). Secrets are set via support/seed, never here.
export async function POST(req: Request) {
  const r = await resolveIsp(req);
  if ("error" in r) return r.error;
  const parsed = smsSettingsSchema.safeParse(await req.json());
  if (!parsed.success) return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  const svc = createServiceClient();
  await svc.from("sms_settings").upsert({
    isp_id: r.ispId, daily_limit: parsed.data.daily_limit,
    monthly_limit: parsed.data.monthly_limit, enabled: parsed.data.enabled,
  }, { onConflict: "isp_id" });
  if (parsed.data.sender_id) {
    await svc.from("sms_providers").upsert({
      isp_id: r.ispId, provider: "topspeed", sender_id: parsed.data.sender_id, status: "active",
    }, { onConflict: "isp_id,provider" });
  }
  return NextResponse.json({ ok: true });
}
