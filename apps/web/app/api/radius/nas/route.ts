import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { resolveIsp } from "@/lib/isp";
import { encryptSecret, randomSecret, checkRateLimit } from "@/lib/secrets";
import { z } from "zod";

const nasSchema = z.object({
  shortname: z.string().min(2).max(64),
  nasname: z.string().ip(),
  auth_port: z.number().int().min(1).max(65535).default(1812),
  acct_port: z.number().int().min(1).max(65535).default(1813),
  protocol: z.enum(["udp", "radsec"]).default("udp"),
});

// GET /api/radius/nas — list NAS (secrets never returned)
export async function GET(req: Request) {
  const r = await resolveIsp(req);
  if ("error" in r) return r.error;
  const { data, error } = await r.supabase.from("radius_nas")
    .select("id,shortname,nasname,auth_port,acct_port,protocol,enabled,sync_status,sync_error,created_at")
    .eq("isp_id", r.ispId).order("created_at", { ascending: false });
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ nas: data });
}

// POST /api/radius/nas — register NAS; generates unique secret shown ONCE,
// stored AES-GCM encrypted, then enqueues nas-sync for the worker.
export async function POST(req: Request) {
  const r = await resolveIsp(req);
  if ("error" in r) return r.error;
  const parsed = nasSchema.safeParse(await req.json());
  if (!parsed.success) return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  const svc = createServiceClient();
  const ok = await checkRateLimit(svc, svc, `nas-add:${r.ispId}`, 10, 3600);
  if (!ok) return NextResponse.json({ error: "Rate limited. Try again later." }, { status: 429 });
  const { data: nas, error } = await svc.from("radius_nas").insert({
    isp_id: r.ispId, shortname: parsed.data.shortname, nasname: parsed.data.nasname,
    auth_port: parsed.data.auth_port, acct_port: parsed.data.acct_port,
    protocol: parsed.data.protocol, sync_status: "pending",
  }).select("id,shortname,nasname").single();
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  const secret = randomSecret();
  await svc.from("radius_nas_secrets").insert({
    nas_id: nas.id, encrypted_secret: encryptSecret(secret),
  });
  await svc.rpc("enqueue_job", {
    p_kind: "radius-nas-sync", p_isp_id: r.ispId, p_payload: { nas_id: nas.id },
  });
  return NextResponse.json({
    nas, secret_once: secret,
    warning: "Copy this secret now — it is never displayed again. Add it to the router's /radius entry.",
  }, { status: 201 });
}
