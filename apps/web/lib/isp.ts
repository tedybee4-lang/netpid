import { createClient } from "@/lib/supabase/server";
import { NextResponse } from "next/server";

// Resolve the caller's ISP from membership. Optional ?isp=<id> is validated,
// never trusted blindly.
export async function resolveIsp(req: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  const { data: memberships, error } = await supabase
    .from("isp_users").select("isp_id").eq("user_id", user.id).eq("is_active", true);
  if (error) return { error: NextResponse.json({ error: error.message }, { status: 400 }) };
  if (!memberships?.length) return { error: NextResponse.json({ error: "No ISP membership" }, { status: 403 }) };
  const ids = memberships.map((m) => m.isp_id as string);
  const want = new URL(req.url).searchParams.get("isp");
  const ispId = want && ids.includes(want) ? want : ids[0];
  return { supabase, user, ispId };
}

export function kes(minor: number | null | undefined): string {
  if (minor == null) return "—";
  return `KSh ${(minor / 100).toLocaleString("en-KE", { maximumFractionDigits: 2 })}`;
}

export function uidem(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}
