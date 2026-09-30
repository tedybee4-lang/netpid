import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { resolveIsp, uidem } from "@/lib/isp";
import { checkRateLimit } from "@/lib/secrets";
import { normalizeKe } from "@/lib/daraja";
import { z } from "zod";

// POST /api/payments/manual — record a manual M-Pesa payment (customer paid
// to the ISP's Till/PayBill out-of-band). The ISP operator records the
// M-Pesa receipt; the row is created COMPLETED with receipt + reconciliation
// matched, and service activates immediately. Idempotent on mpesa_receipt.
const schema = z.object({
  customer_id: z.string().uuid(),
  package_id: z.string().uuid().nullable().optional(),
  amount: z.number().int().positive(),
  phone: z.string().min(7).max(20),
  mpesa_receipt: z.string().min(4).max(32),
  reference: z.string().max(64).optional().or(z.literal("")),
});

function durationMs(value: number, unit: string): number {
  const v = Math.max(1, value);
  if (unit === "hours") return v * 3600_000;
  if (unit === "weeks") return v * 7 * 86400_000;
  if (unit === "months") return v * 30 * 86400_000;
  return v * 86400_000;
}

export async function POST(req: Request) {
  const r = await resolveIsp(req);
  if ("error" in r) return r.error;

  const parsed = schema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  }
  const svc = createServiceClient();
  const ok = await checkRateLimit(svc, svc, `manual-pay:${r.ispId}`, 60, 3600);
  if (!ok) return NextResponse.json({ error: "Rate limited." }, { status: 429 });

  const { data: customer } = await svc.from("customers")
    .select("id, isp_id, customer_no").eq("id", parsed.data.customer_id).maybeSingle();
  if (!customer || (customer as { isp_id: string }).isp_id !== r.ispId) {
    return NextResponse.json({ error: "Customer not found in your ISP" }, { status: 404 });
  }
  const phone = normalizeKe(parsed.data.phone);
  if (!phone) return NextResponse.json({ error: "Enter a valid Safaricom number" }, { status: 400 });

  const receipt = parsed.data.mpesa_receipt.trim().toUpperCase();
  const { data: dup } = await svc.from("payments").select("id")
    .eq("mpesa_receipt", receipt).maybeSingle();
  if (dup) {
    return NextResponse.json({ error: "That M-Pesa receipt was already recorded", duplicate: true }, { status: 409 });
  }

  const now = new Date().toISOString();
  const { data: payment, error } = await svc.from("payments").insert({
    isp_id: r.ispId,
    customer_id: parsed.data.customer_id,
    package_id: parsed.data.package_id ?? null,
    amount: parsed.data.amount,
    currency: "KES",
    phone,
    provider: "manual",
    provider_tx_id: receipt,
    mpesa_receipt: receipt,
    status: "completed",
    paid_at: now,
    idempotency_key: uidem("manual"),
    reference: parsed.data.reference || (customer as { customer_no: string }).customer_no || null,
  }).select("id").single();
  if (error || !payment) {
    const msg = String(error?.message ?? "");
    if (msg.includes("uq_payments_mpesa_receipt") || msg.includes("duplicate")) {
      return NextResponse.json({ error: "That M-Pesa receipt was already recorded", duplicate: true }, { status: 409 });
    }
    return NextResponse.json({ error: error?.message ?? "Could not record payment" }, { status: 400 });
  }
  const pid = (payment as { id: string }).id;

  let expiry: string | null = null;
  if (parsed.data.package_id) {
    const { data: pkg } = await svc.from("packages")
      .select("duration_value, duration_unit").eq("id", parsed.data.package_id).maybeSingle();
    expiry = new Date(Date.now() + durationMs(
      (pkg as { duration_value: number } | null)?.duration_value ?? 30,
      (pkg as { duration_unit: string } | null)?.duration_unit ?? "days",
    )).toISOString();
    await svc.from("customers").update({
      status: "active", package_id: parsed.data.package_id, expiry_date: expiry,
    }).eq("id", parsed.data.customer_id);
  } else {
    await svc.from("customers").update({ status: "active" }).eq("id", parsed.data.customer_id);
  }

  const stamp = Date.now().toString(36).toUpperCase();
  await svc.from("receipts").insert({
    isp_id: r.ispId, payment_id: pid,
    number: `R-${stamp}`, amount: parsed.data.amount, currency: "KES",
  });
  await svc.from("invoices").insert({
    isp_id: r.ispId, customer_id: parsed.data.customer_id,
    number: `INV-${stamp}`, amount: parsed.data.amount, currency: "KES",
    status: "paid", paid_at: now,
  });
  await svc.from("payment_reconciliation").insert({
    isp_id: r.ispId, payment_id: pid,
    expected_amount: parsed.data.amount, received_amount: parsed.data.amount,
    status: "matched", checked_at: now,
  });
  await svc.rpc("enqueue_job", {
    p_kind: "post-payment", p_isp_id: r.ispId,
    p_payload: { payment_id: pid, customer_id: parsed.data.customer_id, event: "payment_received" },
  });

  return NextResponse.json({ ok: true, payment_id: pid, expiry }, { status: 201 });
}
