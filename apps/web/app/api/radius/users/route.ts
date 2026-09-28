import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { resolveIsp } from "@/lib/isp";
import { encryptSecret, checkRateLimit } from "@/lib/secrets";
import { z } from "zod";

const userSchema = z.object({
  customer_id: z.string().uuid(),
  username: z.string().min(2).max(64).regex(/^[a-zA-Z0-9._-]+$/),
  password: z.string().min(6).max(128),
  service_type: z.enum(["pppoe", "hotspot", "voucher", "static"]).default("pppoe"),
});

// GET /api/radius/users — list (passwords never returned)
export async function GET(req: Request) {
  const r = await resolveIsp(req);
  if ("error" in r) return r.error;
  const { data, error } = await r.supabase.from("radius_users")
    .select("id,username,service_type,radius_group,enabled,password_set,sync_status,sync_error,customer_id,customers(full_name)")
    .eq("isp_id", r.ispId).order("created_at", { ascending: false });
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ users: data });
}

// POST /api/radius/users — create/update login (unique per ISP, §10).
// Disabled customers stay enabled=false → authorization rejects (TEST 3).
export async function POST(req: Request) {
  const r = await resolveIsp(req);
  if ("error" in r) return r.error;
  const parsed = userSchema.safeParse(await req.json());
  if (!parsed.success) return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  const svc = createServiceClient();
  const ok = await checkRateLimit(svc, svc, `radius-user:${r.ispId}`, 60, 3600);
  if (!ok) return NextResponse.json({ error: "Rate limited." }, { status: 429 });
  const { data: customer } = await svc.from("customers")
    .select("id, isp_id, status").eq("id", parsed.data.customer_id).maybeSingle();
  if (!customer || customer.isp_id !== r.ispId) {
    return NextResponse.json({ error: "Customer not found in your ISP" }, { status: 404 });
  }
  const enabled = customer.status === "active";
  const { data: ru, error } = await svc.from("radius_users").upsert({
    isp_id: r.ispId, customer_id: parsed.data.customer_id,
    username: parsed.data.username, service_type: parsed.data.service_type,
    enabled, password_set: true, sync_status: enabled ? "pending" : "disabled",
  }, { onConflict: "isp_id,username" }).select("id,username,enabled").single();
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  await svc.from("radius_user_credentials").upsert({
    radius_user_id: ru.id, encrypted_password: encryptSecret(parsed.data.password),
  }, { onConflict: "radius_user_id" });
  await svc.from("customers").update({ username: parsed.data.username })
    .eq("id", parsed.data.customer_id);
  if (enabled) {
    await svc.rpc("enqueue_job", {
      p_kind: "radius-user-sync", p_isp_id: r.ispId, p_payload: { radius_user_id: ru.id },
    });
  }
  return NextResponse.json({ user: ru }, { status: 201 });
}
