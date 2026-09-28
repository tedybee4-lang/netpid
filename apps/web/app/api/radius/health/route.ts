import { NextResponse } from "next/server";
import { resolveIsp } from "@/lib/isp";

// GET /api/radius/health — server status from real health checks, never faked.
// Online sessions are NOT reported here (no accounting mirror yet — Phase 4).
export async function GET(req: Request) {
  const r = await resolveIsp(req);
  if ("error" in r) return r.error;
  const [{ data: servers }, { data: nas }, { data: pending }] = await Promise.all([
    r.supabase.from("radius_servers").select("id,name,host,auth_port,protocol,status,last_check_at")
      .or(`isp_id.eq.${r.ispId},isp_id.is.null`),
    r.supabase.from("radius_nas").select("id,shortname,enabled,sync_status").eq("isp_id", r.ispId),
    r.supabase.from("radius_users").select("id").eq("isp_id", r.ispId).eq("sync_status", "pending"),
  ]);
  const health = servers?.length
    ? await r.supabase.from("radius_health_checks").select("server_id,status,latency_ms,detail,checked_at")
        .in("server_id", servers.map((s) => s.id)).order("checked_at", { ascending: false }).limit(servers.length)
    : { data: [] };
  return NextResponse.json({
    servers: servers ?? [],
    latest_checks: health.data ?? [],
    nas_total: nas?.length ?? 0,
    nas_unsynced: (nas ?? []).filter((n) => n.sync_status !== "synced").length,
    users_pending_sync: pending?.length ?? 0,
    online_sessions: null, // Phase 4: mirrored from RADIUS accounting
    note: "Statuses come from real checks only. Unchecked servers report unknown.",
  });
}
