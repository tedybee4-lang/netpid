import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { resolveIsp, uidem } from "@/lib/isp";
import { initiatePaymentSchema } from "@/lib/validation";
import { checkRateLimit } from "@/lib/secrets";
import { getDarajaCreds, normalizeKe } from "@/lib/daraja";
import { sendStkPush } from "@/lib/daraja-push";

/**
 * POST /api/payments/stk — direct Safaricom Daraja STK Push.
 *
 * Creates a PENDING payment row, sends the push, stores the
 * CheckoutRequestID. NEVER activates service here — only the verified
 * Daraja callback (/api/payments/daraja-callback) does that.
 */
export async function POST(req: Request) {
  const r = await resolveIsp(req);
  if ("error" in r) return r.error;

  const parsed = initiatePaymentSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  }

  const svc = createServiceClient();
  const ok = await checkRateLimit(svc, svc, `stk:${r.ispId}`, 20, 3600);
  if (!ok) return NextResponse.json({ error: "Rate limited. Try again later." }, { status: 429 });

  const { data: customer } = await svc.from("customers")
    .select("id, isp_id, customer_no").eq("id", parsed.data.customer_id).maybeSingle();
  if (!customer || (customer as { isp_id: string }).isp_id !== r.ispId) {
    return NextResponse.json({ error: "Customer not found in your ISP" }, { status: 404 });
  }

  const phone = normalizeKe(parsed.data.phone);
  if (!phone) {
    return NextResponse.json({ error: "Enter a valid Safaricom number (e.g. 0712 345 678)" }, { status: 400 });
  }

  const creds = await getDarajaCreds(r.ispId);
  if (!creds) {
    return NextResponse.json({
      error: "M-Pesa (Daraja) is not connected for this ISP. Add Daraja credentials in Settings, or record a manual M-Pesa payment instead.",
    }, { status: 422 });
  }

  const idem = uidem("stk");
  const accountRef = (customer as { customer_no: string }).customer_no || parsed.data.customer_id.slice(0, 12);
  const callbackUrl =
    process.env.DARAJA_CALLBACK_URL
    ?? `${new URL(req.url).origin}/api/payments/daraja-callback`;

  const { data: payment, error } = await svc.from("payments").insert({
    isp_id: r.ispId,
    customer_id: parsed.data.customer_id,
    package_id: parsed.data.package_id ?? null,
    amount: parsed.data.amount,
    currency: "KES",
    phone,
    provider: "daraja",
    status: "pending",
    idempotency_key: idem,
    reference: accountRef,
  }).select("id").single();
  if (error || !payment) {
    return NextResponse.json({ error: error?.message ?? "Could not create payment" }, { status: 400 });
  }

  let stk;
  try {
    stk = await sendStkPush(creds, {
      phone,
      amountMinor: parsed.data.amount,
      accountRef,
      callbackUrl,
    });
  } catch (e) {
    await svc.from("payments").update({ status: "failed" })
      .eq("id", (payment as { id: string }).id);
    return NextResponse.json({
      error: e instanceof Error ? e.message : "STK push failed. Check Daraja credentials and try again.",
    }, { status: 502 });
  }

  await svc.from("payments").update({
    checkout_request_id: stk.checkoutRequestId,
    merchant_request_id: stk.merchantRequestId || null,
    provider_tx_id: stk.checkoutRequestId,
  }).eq("id", (payment as { id: string }).id);

  await svc.from("payment_reconciliation").insert({
    isp_id: r.ispId,
    payment_id: (payment as { id: string }).id,
    expected_amount: parsed.data.amount,
    status: "pending",
  });

  return NextResponse.json({
    payment_id: (payment as { id: string }).id,
    checkout_request_id: stk.checkoutRequestId,
    message: "STK push sent. Enter your M-Pesa PIN on the phone. Service activates after Safaricom confirms payment.",
  }, { status: 201 });
}
