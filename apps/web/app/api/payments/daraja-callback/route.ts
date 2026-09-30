import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { logSecurity } from "@/lib/payment-security";
import { parseDarajaCallback } from "@/lib/daraja-push";

// POST /api/payments/daraja-callback — Safaricom STK result notification.
// VERIFIED: CheckoutRequestID must match a pending payment we created,
// ResultCode must be 0, amount must equal the row. IDEMPOTENT: a retried
// callback for a completed payment returns ok/duplicate, never re-activates.
export async function POST(req: Request) {
  const raw = await req.text();
  let body: unknown;
  try { body = JSON.parse(raw); }
  catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }

  const cb = parseDarajaCallback(body);
  const svc = createServiceClient();
  const payload = (body ?? {}) as Record<string, unknown>;

  // payment_webhooks is unique on (provider, provider_tx_id). Safaricom retries
  // callbacks, so every audit write here is an ignore-duplicates upsert: the
  // first observation is kept and a retry can never fail the request.
  const record = (row: {
    isp_id: string | null; provider_tx_id: string;
    signature_ok: boolean; status: string; error?: string;
  }) => svc.from("payment_webhooks").upsert(
    { ...row, provider: "daraja", payload },
    { onConflict: "provider,provider_tx_id", ignoreDuplicates: true },
  );

  if (!cb || !cb.checkoutRequestId) {
    await record({
      isp_id: null, provider_tx_id: `unknown-${Date.now()}`,
      signature_ok: false, status: "rejected", error: "unparseable callback",
    });
    return NextResponse.json({ error: "Rejected" }, { status: 400 });
  }

  const { data: payment } = await svc.from("payments")
    .select("id, isp_id, customer_id, package_id, amount, status")
    .eq("checkout_request_id", cb.checkoutRequestId).maybeSingle();
  const p = payment as {
    id: string; isp_id: string; customer_id: string;
    package_id: string | null; amount: number; status: string;
  } | null;

  if (!p) {
    await record({
      isp_id: null, provider_tx_id: cb.checkoutRequestId,
      signature_ok: false, status: "rejected", error: "no matching payment",
    });
    await logSecurity("daraja_unknown_callback", { checkout: cb.checkoutRequestId });
    return NextResponse.json({ error: "Rejected" }, { status: 422 });
  }

  if (p.status === "completed") {
    await record({
      isp_id: p.isp_id, provider_tx_id: cb.checkoutRequestId,
      signature_ok: true, status: "duplicate",
    });
    return NextResponse.json({ ok: true, duplicate: true });
  }

  const success = cb.resultCode === 0;
  const receivedMinor = cb.amount != null ? Math.round(cb.amount * 100) : null;

  if (!success || receivedMinor !== p.amount) {
    await record({
      isp_id: p.isp_id, provider_tx_id: cb.checkoutRequestId,
      signature_ok: true, status: "rejected",
      error: !success ? `ResultCode ${cb.resultCode}: ${cb.resultDesc}` : "amount mismatch",
    });
    // Guarded on 'pending' so a cancelled push can never overwrite a success
    // that a racing callback already committed.
    await svc.from("payments").update({ status: "failed" })
      .eq("id", p.id).eq("status", "pending");
    if (success) {
      // Only a genuine amount disagreement is worth a security signal; a user
      // cancelling the prompt is routine.
      await logSecurity("webhook_amount_mismatch", {
        providerTx: cb.checkoutRequestId, expected: p.amount, received: receivedMinor,
      });
    }
    return NextResponse.json({ error: "Rejected" }, { status: 422 });
  }

  // ATOMIC activation: the conditional update wins the race. `.select()` is
  // required — a 0-row update returns no error, so an empty result set is the
  // only reliable signal that a concurrent callback already activated.
  const now = new Date().toISOString();
  const { data: won } = await svc.from("payments").update({
    status: "completed",
    provider_tx_id: cb.checkoutRequestId,
    mpesa_receipt: cb.mpesaReceipt,
    paid_at: now,
  }).eq("id", p.id).eq("status", "pending").select("id");
  if (!won?.length) {
    await record({
      isp_id: p.isp_id, provider_tx_id: cb.checkoutRequestId,
      signature_ok: true, status: "duplicate",
    });
    return NextResponse.json({ ok: true, duplicate: true });
  }

  let expiry: string | null = null;
  if (p.package_id) {
    const { data: pkg } = await svc.from("packages")
      .select("duration_value, duration_unit").eq("id", p.package_id).maybeSingle();
    expiry = new Date(Date.now() + durationMs(
      (pkg as { duration_value: number } | null)?.duration_value ?? 30,
      (pkg as { duration_unit: string } | null)?.duration_unit ?? "days",
    )).toISOString();
    await svc.from("customers").update({
      status: "active", package_id: p.package_id, expiry_date: expiry,
    }).eq("id", p.customer_id);
  } else {
    await svc.from("customers").update({ status: "active" }).eq("id", p.customer_id);
  }

  const stamp = Date.now().toString(36).toUpperCase();
  await svc.from("receipts").insert({
    isp_id: p.isp_id, payment_id: p.id,
    number: `R-${stamp}`, amount: p.amount, currency: "KES",
  });
  await svc.from("invoices").insert({
    isp_id: p.isp_id, customer_id: p.customer_id,
    number: `INV-${stamp}`, amount: p.amount, currency: "KES",
    status: "paid", paid_at: now,
  });
  await svc.from("payment_reconciliation").update({
    received_amount: receivedMinor, status: "matched", checked_at: now,
  }).eq("payment_id", p.id);
  await record({
    isp_id: p.isp_id, provider_tx_id: cb.checkoutRequestId,
    signature_ok: true, status: "processed",
  });
  await svc.rpc("enqueue_job", {
    p_kind: "post-payment", p_isp_id: p.isp_id,
    p_payload: { payment_id: p.id, customer_id: p.customer_id, event: "payment_received" },
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
