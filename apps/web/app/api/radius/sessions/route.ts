import { NextResponse } from "next/server";
import { resolveIsp } from "@/lib/isp";

// GET /api/radius/sessions — online + recent sessions from the accounting mirror.
// Source of truth for "online now" (§78). Never inferred from customer status.
export async function GET(req: Request) {
  const r = await resolveIsp(req);
  if ("error" in r) return r.error;
  const url = new URL(req.url);
  const open = url.searchParams.get("open");
  let q = r.supabase.from("radius_sessions")
    .select("username,nas_ip,framed_ip,calling_station,start_time,last_update,stop_time,session_seconds,input_octets,output_octets,is_open")
    .eq("isp_id", r.ispId).order("last_update", { ascending: false }).limit(100);
  if (open === "1") q = q.eq("is_open", true);
  const { data, error } = await q;
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  const online = (data ?? []).filter((s) => s.is_open).length;
  return NextResponse.json({ online, sessions: data ?? [] });
}
