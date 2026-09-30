import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { resolveIsp } from "@/lib/isp";
import { checkRateLimit } from "@/lib/secrets";

// Router backups — real backend integration.
//
// WHAT IS REAL HERE: the worker's `router-backup` job connects to the router,
// runs `/system/backup/save`, and only then writes a `router_backups` row. A row
// existing therefore MEANS the save succeeded. `network_jobs.status` carries the
// live state of a job that has not finished yet (queued/running/completed/failed).
//
// WHAT IS NOT YET REAL: the file itself. RouterOS writes it to the router's own
// disk; the recorded `storage_path` is the manifest's intended private-bucket
// destination, and nothing in this codebase uploads it (there is no storage
// bucket in use anywhere). Rather than offer a download link that would 404,
// `retrievable` says false and the download route explains where the bytes are.

type BackupRow = {
  id: string;
  created_at: string;
  size_bytes: number | null;
  storage_path: string;
};

/** Basename of the manifest path = the file name RouterOS created. */
function routerFile(path: string): string {
  return path.split("/").pop() ?? path;
}

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const r = await resolveIsp(req);
  if ("error" in r) return r.error;

  // Scoped by both the URL id and the caller's ISP: pasting another tenant's
  // router id returns 404 rather than their manifest.
  const { data: router } = await r.supabase.from("routers")
    .select("id, name").eq("id", id).eq("isp_id", r.ispId).maybeSingle();
  if (!router) return NextResponse.json({ error: "Router not found" }, { status: 404 });

  const [{ data: backupRows }, { data: jobRows }] = await Promise.all([
    r.supabase.from("router_backups")
      .select("id, created_at, size_bytes, storage_path")
      .eq("router_id", id)
      .eq("isp_id", r.ispId)
      .order("created_at", { ascending: false })
      .limit(50),
    r.supabase.from("network_jobs")
      .select("id, status, last_error, attempts, created_at, completed_at, payload")
      .eq("isp_id", r.ispId)
      .eq("kind", "router-backup")
      .order("created_at", { ascending: false })
      .limit(25),
  ]);

  // `payload.router_id` is matched in application code: the column path filter
  // PostgREST would need here is not portable across versions, and 25 rows is
  // nothing to scan.
  const jobs = (jobRows ?? [])
    .filter((j) => (j.payload as { router_id?: string } | null)?.router_id === id)
    .map(({ payload: _payload, ...j }) => j);

  const backups = ((backupRows ?? []) as BackupRow[]).map((b) => ({
    id: b.id,
    created_at: b.created_at,
    size_bytes: b.size_bytes,
    router_file: routerFile(b.storage_path),
    storage_path: b.storage_path,
    retrievable: false,
  }));

  return NextResponse.json({
    router: { id: router.id, name: router.name },
    backups,
    jobs,
    // The newest job tells the UI whether a save is still in flight — a backup
    // row does not exist until the job finishes, so the list alone would look
    // frozen while one is running.
    in_flight: jobs.some((j) => j.status === "queued" || j.status === "running" || j.status === "retrying"),
    storage: "on-router",
  });
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const r = await resolveIsp(req);
  if ("error" in r) return r.error;

  const { data: router } = await r.supabase.from("routers")
    .select("id, name").eq("id", id).eq("isp_id", r.ispId).maybeSingle();
  if (!router) return NextResponse.json({ error: "Router not found" }, { status: 404 });

  const svc = createServiceClient();
  const limited = await checkRateLimit(svc, svc, `router-backup:${r.ispId}`, 5, 600);
  if (!limited) return NextResponse.json({ error: "Rate limited." }, { status: 429 });

  const { data: job, error } = await svc.rpc("enqueue_job", {
    p_kind: "router-backup",
    p_isp_id: r.ispId,
    p_payload: { router_id: id },
  });
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }

  return NextResponse.json({
    job_id: job,
    message: "Backup queued. The file is written on the router; the manifest row appears when it finishes.",
  }, { status: 202 });
}
