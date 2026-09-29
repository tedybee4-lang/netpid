import crypto from "crypto";
import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { voucherRedeemSchema } from "@/lib/validation";
import { encryptSecret } from "@/lib/secrets";

// PUT /api/vouchers/redeem — voucher → hotspot login + package activation.
// Called by the captive portal (public). ISP resolved from x-isp-slug header.
export async function PUT(req: Request) {
  const parsed = voucherRedeemSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "Invalid code" }, { status: 400 });
  const svc = createServiceClient();
  const ispSlug = req.headers.get("x-isp-slug");
  if (!ispSlug) return NextResponse.json({ error: "Portal context missing" }, { status: 400 });
  const { data: isp } = await svc.from("isps").select("id").eq("slug", ispSlug).maybeSingle();
  if (!isp) return NextResponse.json({ error: "Unknown portal" }, { status: 404 });
  const code = parsed.data.code.trim().toUpperCase();
  const { data: voucher } = await svc.from("vouchers")
    .select("id,status,expires_at,batch_id,voucher_batches!inner(package_id)")
    .eq("isp_id", isp.id).eq("code", code).maybeSingle();
  if (!voucher || voucher.status !== "unused") {
    return NextResponse.json({ error: "Voucher invalid, used or expired." }, { status: 422 });
  }
  if (voucher.expires_at && new Date(voucher.expires_at) < new Date()) {
    await svc.from("vouchers").update({ status: "expired" }).eq("id", voucher.id);
    return NextResponse.json({ error: "Voucher expired." }, { status: 422 });
  }
  const packageId = (voucher.voucher_batches as unknown as { package_id: string }).package_id;
  const { data: pkg } = await svc.from("packages").select("duration_value,duration_unit").eq("id", packageId).single();
  const ms = pkg ? durationMs(pkg.duration_value, pkg.duration_unit) : 86400_000;
  const expiry = new Date(Date.now() + ms).toISOString();
  const password = crypto.randomBytes(6).toString("base64url");
  const { data: customer } = await svc.from("customers").insert({
    isp_id: isp.id, customer_no: `V-${code}`, full_name: `Voucher ${code}`,
    phone: parsed.data.mac ?? code, service_type: "hotspot",
    package_id: packageId, username: code, status: "active", expiry_date: expiry,
  }).select("id").single();
  if (!customer) return NextResponse.json({ error: "Failed to create voucher account" }, { status: 400 });
  const { data: ru } = await svc.from("radius_users").insert({
    isp_id: isp.id, customer_id: customer.id, username: code,
    service_type: "hotspot", enabled: true, password_set: true, sync_status: "pending",
  }).select("id").single();
  if (!ru) return NextResponse.json({ error: "Failed to create RADIUS user" }, { status: 400 });
  await svc.from("radius_user_credentials").insert({
    radius_user_id: ru.id, encrypted_password: encryptSecret(password),
  });
  await svc.from("vouchers").update({ status: "active", activated_at: new Date().toISOString(), expires_at: expiry }).eq("id", voucher.id);
  await svc.from("hotspot_users").insert({ isp_id: isp.id, customer_id: customer.id, radius_user_id: ru.id, voucher_fk: voucher.id });
  await svc.rpc("enqueue_job", { p_kind: "radius-user-sync", p_isp_id: isp.id, p_payload: { radius_user_id: ru.id } });
  return NextResponse.json({ username: code, password, expiry });
}

function durationMs(value: number, unit: string): number {
  if (unit === "hours") return value * 3600_000;
  if (unit === "weeks") return value * 7 * 86400_000;
  if (unit === "months") return value * 30 * 86400_000;
  return value * 86400_000;
}
