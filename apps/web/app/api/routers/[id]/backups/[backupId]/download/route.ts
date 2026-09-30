import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { resolveIsp } from "@/lib/isp";

// GET /api/routers/[id]/backups/[backupId]/download — retrieval control.
//
// WHY THIS CAN ANSWER 409 INSTEAD OF ALWAYS STREAMING A FILE
//   RouterOS writes the .backup onto the router's own disk. The worker records
//   the manifest path where that artifact is *meant* to be mirrored, but no
//   upload happens today — this project has no storage bucket in use anywhere.
//   A route that blindly proxied the path would hand back a 404 dressed up as a
//   download, and an operator would believe a restore point exists off-box when
//   it does not. So: serve the object when it genuinely is in the private
//   bucket, and otherwise say precisely where the bytes are.
//
// Nothing here ever exposes the bucket publicly or returns a signed URL for an
// object we did not verify exists.

const BUCKET = "router-backups";
const PREFIX = "private/router-backups/";

function objectKey(storagePath: string): string {
  if (storagePath.startsWith(PREFIX)) return storagePath.slice(PREFIX.length);
  return storagePath.replace(/^private\//, "");
}

export async function GET(req: Request, { params }: { params: Promise<{ id: string; backupId: string }> }) {
  const { id, backupId } = await params;
  const r = await resolveIsp(req);
  if ("error" in r) return r.error;

  const { data } = await r.supabase.from("router_backups")
    .select("id, router_id, storage_path, size_bytes")
    .eq("id", backupId).eq("router_id", id).eq("isp_id", r.ispId).maybeSingle();
  if (!data) return NextResponse.json({ error: "Backup not found" }, { status: 404 });

  const file = data.storage_path.split("/").pop() ?? data.storage_path;
  const svc = createServiceClient();

  let blob: Blob | null = null;
  try {
    const key = objectKey(data.storage_path);
    const exists = await svc.storage.from(BUCKET).exists(key);
    if (exists) {
      const { data: obj, error: dlErr } = await svc.storage.from(BUCKET).download(key);
      if (!dlErr && obj) blob = obj;
    }
  } catch {
    // Missing bucket, missing permission or offline storage — all three mean the
    // same thing to the caller: not mirrored. Fall through to the 409 below.
    blob = null;
  }

  if (!blob) {
    return NextResponse.json({
      error: "This backup has not been mirrored off the router, so it cannot be downloaded yet.",
      retrievable: false,
      retrieval: "on-router",
      router_file: file,
      storage_path: data.storage_path,
      hint: `The file lives on the router's own disk as "${file}". Retrieve it from the device `
        + `(RouterOS: /file print where name~"netpid-") over FTP/SFTP, or take a fresh backup `
        + `once off-box mirroring is enabled.`,
    }, { status: 409 });
  }

  return new Response(blob, {
    status: 200,
    headers: {
      "content-type": "application/octet-stream",
      "content-length": String(blob.size),
      "content-disposition": `attachment; filename="${file.replace(/"/g, "")}"`,
      "cache-control": "private, no-store",
    },
  });
}
