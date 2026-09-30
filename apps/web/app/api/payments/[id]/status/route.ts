import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { resolveIsp } from "@/lib/isp";
import { getDarajaCreds } from "@/lib/daraja";
import {
  queryStkTransactionStatus, statusSucceeded, statusFailed, statusPending,
} from "@/lib/daraja-push";
import { checkRateLimit } from "@/lib/secrets";
import { applyConfirmedPayment } from "@/lib/payments-activate";

// POST /api/payments/[id]/status — reconcile a STK payment whose callback never
// arrived, by asking Safaricom directly.
//
// WHY THIS EXISTS: the callback is the normal path, but it can be lost (handset
// offline at the decisive moment, user walked away, notification dropped). The
// row then sits at 'pending' forever and the customer paid for nothing. A
// direct, authenticated status query against Daraja is the only honest way to
// resolve that — as opposed to an operator typing in a receipt.
//
// WHAT IT DELIBERATELY DOES NOT DO
//   - It never activates a non-Daraja payment, and never touches a row that is
//     not still 'pending'.
//   - It only reaches Daraja with the ISP's OWN credentials, loaded by isp_id.
//   - Activation still goes through applyConfirmedPayment, and the flip to
//     'completed' is the same compare-and-set the callback uses, so a late
//     callback arriving afterwards is recorded as a duplicate and cannot extend
//     the subscription a second time.

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const r = await resolveIsp(req);
  if ("error" in r) return r.error;

  const svc = createServiceClient();
  const { data: row } = await svc.from("payments")
    .select("id, isp_id, customer_id, package_id, amount, provider, status, checkout_request_id")
    .eq("id", id).eq("isp_id", r.ispId).maybeSingle();
  if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const p = row as {
    id: string; isp_id: string; customer_id: string; package_id: string | null;
    amount: number; provider: string; status: string; checkout_request_id: string | null;
  };

  if (p.provider !== "daraja") {
    return NextResponse.json({
      error: "Only Safaricom Daraja STK payments can be reconciled with a status query. "
        + "A manual M-Pesa claim is confirmed from the payments screen instead.",
      provider: p.provider,
    }, { status: 422 });
  }
  if (p.status === "completed") {
    return NextResponse.json({ ok: true, already: "completed" });
  }
  if (p.status !== "pending") {
    return NextResponse.json({ error: `A ${p.status} payment cannot be reconciled.` }, { status: 409 });
  }
  if (!p.checkout_request_id) {
    return NextResponse.json({
      error: "This payment has no CheckoutRequestID, so Daraja cannot be asked about it. "
        + "Record the M-Pesa receipt as a manual payment instead.",
    }, { status: 422 });
  }

  const creds = await getDarajaCreds(r.ispId);
  if (!creds) {
    return NextResponse.json({
      error: "M-Pesa (Daraja) is not connected for this ISP, so its status cannot be queried. "
        + "Add Daraja credentials in Settings, or record a manual M-Pesa payment.",
    }, { status: 422 });
  }

  const limited = await checkRateLimit(svc, svc, `daraja-status:${r.ispId}`, 20, 3600);
  if (!limited) return NextResponse.json({ error: "Rate limited. Try again later." }, { status: 429 });

  let status;
  try {
    status = await queryStkTransactionStatus(creds, { transactionId: p.checkout_request_id });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Could not reach Daraja";
    await svc.from("audit_logs").insert({
      actor_id: r.user.id, actor_type: "user", isp_id: r.ispId,
      action: "payment_status_query_failed", resource: "payments", resource_id: p.id,
      metadata: { error: message },
    });
    return NextResponse.json({ error: message }, { status: 502 });
  }

  const audit = (outcome: string, detail: Record<string, unknown>) => svc.from("audit_logs").insert({
    actor_id: r.user.id, actor_type: "user", isp_id: r.ispId,
    action: "payment_status_query", resource: "payments", resource_id: p.id,
    metadata: { outcome, transaction_status: status.transactionStatus, ...detail },
  });

  if (statusPending(status) || (!statusSucceeded(status) && !statusFailed(status) && !status.transactionStatus)) {
    await audit("still_pending", { result_code: status.resultCode });
    return NextResponse.json({
      ok: true, settled: false,
      transaction_status: status.transactionStatus,
      message: "Daraja has not settled this payment yet. Leave it pending and check again shortly.",
    });
  }

  if (statusFailed(status)) {
    // Guarded on 'pending' for the same reason the callback is: a late
    // successful callback must never be overwritten by a stale query.
    const { data: failed } = await svc.from("payments")
      .update({ status: "failed" })
      .eq("id", p.id).eq("status", "pending").select("id");
    await audit("failed", { result_code: status.resultCode, result_desc: status.resultDesc });
    return NextResponse.json({
      ok: true, settled: false,
      transaction_status: status.transactionStatus,
      already: failed?.length ? null : "processed",
      message: "Daraja reports this payment did not complete. The customer can retry or pay manually.",
    });
  }

  // Completed. Same atomic flip the callback uses, so a callback that lands a
  // moment later loses the race and is recorded as a duplicate.
  const now = new Date().toISOString();
  const { data: won } = await svc.from("payments").update({
    status: "completed", paid_at: now, provider_tx_id: p.checkout_request_id,
  }).eq("id", p.id).eq("status", "pending").select("id");

  if (!won?.length) {
    await audit("duplicate", {});
    return NextResponse.json({ ok: true, settled: true, already: "processed" });
  }

  const expiry = await applyConfirmedPayment(svc, {
    ispId: p.isp_id, paymentId: p.id, customerId: p.customer_id,
    packageId: p.package_id, amount: p.amount,
  });
  await audit("activated", { result_code: status.resultCode, result_desc: status.resultDesc });

  return NextResponse.json({ ok: true, settled: true, transaction_status: status.transactionStatus, expiry });
}

