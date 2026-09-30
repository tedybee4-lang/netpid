import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { verifyPayheroSignature, logSecurity } from "@/lib/payment-security";

// POST /api/payments/webhook — PayHero callback. ONLY verified webhooks activate service.
// Idempotent: duplicate provider_tx_id → recorded as duplicate, never double-activate.
export async function POST(req: Request) {
  const raw = await req.text();
  const signature = req.headers.get("x-payhero-signature");
  const svc = createServiceClient();
  let body: Record<string, unknown>;
  try { body = JSON.parse(raw); }
  catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }

  const providerTx = String(body.transaction_id ?? body.reference ?? "");
  const ispId = typeof body.isp_id === "string" ? body.isp_id : null;
  const ok = verifyPayheroSignature(raw, signature);
  await svc.from("payment_webhooks").insert({
    isp_id: ispId, provider: "payhero",
    provider_tx_id: providerTx || `unknown-${Date.now()}`,
    payload: body, signature_ok: ok, status: ok ? "received" : "rejected",
    error: ok ? null : "signature verification failed",
  });
  if (!ok || !providerTx || !ispId) {
    await logSecurity("webhook_rejected", { provider: "payhero", signature_ok: ok });
    return NextResponse.json({ error: "Rejected" }, { status: 401 });
  }
  // Idempotency: already processed?
  const { data: existing } = await svc.from("payments")
    .select("id, status").eq("provider_tx_id", providerTx).maybeSingle();
  if (existing?.status === "completed") {
    await svc.from("payment_webhooks").update({ status: "duplicate" }).eq("provider_tx_id", providerTx);
    return NextResponse.json({ ok: true, duplicate: true });
  }
  const amount = Number(body.amount ?? 0);
  const phone = String(body.phone ?? "");
  const customerId = typeof body.customer_id === "string" ? body.customer_id : null;
  const packageId = typeof body.package_id === "string" ? body.package_id : null;
  const success = body.status === "success" || body.status === "completed";

  const { data: payment } = customerId
    ? await svc.from("payments").select("id, amount").eq("customer_id", customerId)
        .eq("isp_id", ispId).eq("status", "pending").order("created_at", { ascending: false }).limit(1).maybeSingle()
    : { data: null };
  if (!payment || !success || payment.amount !== Math.round(amount)) {
    await svc.from("payment_webhooks").update({
      status: "rejected",
      error: !payment ? "no matching pending payment" : !success ? "provider reported failure" : "amount mismatch",
    }).eq("provider_tx_id", providerTx);
    await logSecurity("webhook_amount_mismatch", { providerTx, expected: payment?.amount, received: amount });
    return NextResponse.json({ error: "Rejected" }, { status: 422 });
  }
  // Activate: payment → entitlement → receipt → invoice → notify.
  // RADIUS sync is queued for Phase 3 worker.
  const now = new Date().toISOString();
  await svc.from("payments").update({
    status: "completed", provider_tx_id: providerTx, phone, paid_at: now,
  }).eq("id", payment.id);
  let expiry: string | null = null;
  if (packageId) {
    const { data: pkg } = await svc.from("packages").select("duration_value, duration_unit").eq("id", packageId).maybeSingle();
    const ms = durationMs(pkg?.duration_value ?? 30, pkg?.duration_unit ?? "days");
    expiry = new Date(Date.now() + ms).toISOString();
    await svc.from("customers").update({
      status: "active", package_id: packageId, expiry_date: expiry,
    }).eq("id", customerId);
  }
  const receiptNo = `R-${Date.now().toString(36).toUpperCase()}`;
  await svc.from("receipts").insert({
    isp_id: ispId, payment_id: payment.id, number: receiptNo, amount: payment.amount, currency: "KES",
  });
  await svc.from("invoices").insert({
    isp_id: ispId, customer_id: customerId, number: `INV-${Date.now().toString(36).toUpperCase()}`,
    amount: payment.amount, currency: "KES", status: "paid", paid_at: now,
  });
  await svc.from("payment_reconciliation").update({
    received_amount: Math.round(amount), status: "matched", checked_at: now,
  }).eq("payment_id", payment.id);
  await svc.from("payment_webhooks").update({ status: "processed" }).eq("provider_tx_id", providerTx);
  await svc.rpc("enqueue_job", {
    p_kind: "post-payment", p_isp_id: ispId,
    p_payload: { payment_id: payment.id, customer_id: customerId, event: "payment_received" },
  });
  return NextResponse.json({ ok: true, expiry });
}

function durationMs(value: number, unit: string): number {
  const v = Math.max(1, value);
  if (unit === "hours") return v * 3600_000;
  if (unit === "weeks") return v * 7 * 86400_000;
  if (unit === "months") return v * 30 * 86400_000;
  return v * 86400_000;
}

