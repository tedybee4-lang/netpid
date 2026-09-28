import { NextResponse } from "next/server";
import { createClient, createServiceClient } from "@/lib/supabase/server";

// GET /api/platform/summary — platform admins only. RLS + explicit role check.
export async function GET() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const svc = createServiceClient();
  const { data: admin } = await svc.from("platform_admins")
    .select("id").eq("user_id", user.id).eq("is_active", true).maybeSingle();
  if (!admin) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const [isps, subs, health] = await Promise.all([
    svc.from("isps").select("id", { count: "exact", head: true }),
    svc.from("netpid_subscriptions").select("id", { count: "exact", head: true }),
    svc.from("system_health").select("component,status,checked_at").order("checked_at", { ascending: false }).limit(20),
  ]);
  return NextResponse.json({
    totalIsps: isps.count ?? 0,
    subscriptions: subs.count ?? 0,
    health: health.data ?? [],
    note: "Live statuses only — unconnected components report unknown/offline, never fake online.",
  });
}
