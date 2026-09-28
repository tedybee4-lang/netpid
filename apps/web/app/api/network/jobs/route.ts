import { NextResponse } from "next/server";
import { resolveIsp } from "@/lib/isp";

// GET /api/network/jobs?job= — poll worker job status (for test/backup/disconnect UX)
export async function GET(req: Request) {
  const r = await resolveIsp(req);
  if ("error" in r) return r.error;
  const id = new URL(req.url).searchParams.get("job");
  if (!id) return NextResponse.json({ error: "job required" }, { status: 400 });
  const { data: job } = await r.supabase.from("network_jobs")
    .select("id,kind,status,attempts,last_error,created_at,completed_at")
    .eq("id", id).eq("isp_id", r.ispId).maybeSingle();
  if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 });
  const { data: logs } = await r.supabase.from("network_job_logs")
    .select("level,message,created_at").eq("job_id", id).order("created_at", { ascending: true }).limit(20);
  return NextResponse.json({ job, logs: logs ?? [] });
}
