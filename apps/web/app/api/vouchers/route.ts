import crypto from "crypto";
import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { voucherBatchSchema } from "@/lib/validation";
import { resolveIsp } from "@/lib/isp";

function genCode(len: number): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = "";
  const bytes = crypto.randomBytes(len);
  for (let i = 0; i < len; i++) s += alphabet[bytes[i] % alphabet.length];
  return s;
}

// GET /api/vouchers?batch= — batches + codes (capped 5000)
export async function GET(req: Request) {
  const r = await resolveIsp(req);
  if ("error" in r) return r.error;
  const batchId = new URL(req.url).searchParams.get("batch");
  const { data: batches } = await r.supabase.from("voucher_batches")
    .select("id,name,quantity,code_length,expires_at,created_at,package_id,packages(name,price)")
    .eq("isp_id", r.ispId).order("created_at", { ascending: false });
  let codes: unknown[] = [];
  if (batchId) {
    const { data } = await r.supabase.from("vouchers").select("code,status,expires_at")
      .eq("batch_id", batchId).eq("isp_id", r.ispId).limit(5000);
    codes = data ?? [];
  }
  return NextResponse.json({ batches: batches ?? [], codes });
}

// POST /api/vouchers — bulk generate (unique per ISP)
export async function POST(req: Request) {
  const r = await resolveIsp(req);
  if ("error" in r) return r.error;
  const parsed = voucherBatchSchema.safeParse(await req.json());
  if (!parsed.success) return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  const svc = createServiceClient();
  const { data: pkg } = await svc.from("packages").select("id")
    .eq("id", parsed.data.package_id).eq("isp_id", r.ispId).maybeSingle();
  if (!pkg) return NextResponse.json({ error: "Package not found" }, { status: 404 });
  const { data: batch, error } = await svc.from("voucher_batches").insert({
    isp_id: r.ispId, name: parsed.data.name, package_id: pkg.id,
    quantity: parsed.data.quantity, code_length: parsed.data.code_length,
    expires_at: parsed.data.expires_at ?? null, created_by: r.user.id,
  }).select("id").single();
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  const codes = new Set<string>();
  while (codes.size < parsed.data.quantity) codes.add(genCode(parsed.data.code_length));
  const rows = [...codes].map((code) => ({
    isp_id: r.ispId, batch_id: batch.id, code,
    expires_at: parsed.data.expires_at ?? null, status: "unused",
  }));
  for (let i = 0; i < rows.length; i += 500) {
    const { error: e } = await svc.from("vouchers").insert(rows.slice(i, i + 500));
    if (e) return NextResponse.json({ error: e.message }, { status: 400 });
  }
  return NextResponse.json({ batch_id: batch.id, codes: [...codes] }, { status: 201 });
}
