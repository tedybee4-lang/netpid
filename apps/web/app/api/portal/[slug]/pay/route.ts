import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { portalPaySchema } from "@/lib/validation";
import { checkRateLimit } from "@/lib/secrets";
import { getDarajaCreds, getIspPayTarget, normalizeKe } from "@/lib/daraja";
import { sendStkPush } from "@/lib/daraja-push";
import { uidem } from "@/lib/isp";

/**
 * POST /api/portal/[slug]/pay — captive-portal purchase. PUBLIC, no session.
 *
 * This is the only payment entry point that is not gated on an ISP staff
 * membership, so it is deliberately NARROWER than /api/payments/stk:
 *
 *   - The client never names a price. The package is read and priced on the
 *     server, so a tampered body cannot buy a KSh 4,000 bundle for KSh 1.
 *     (This is also why portalPaySchema has no `amount` field.)
 *   - It never activates anything. Daraja activation still happens ONLY in the
 *     verified callback, and a manual receipt claim stays `pending` until an
 *     operator confirms it from the dashboard.
 *   - Unconfigured Daraja is a hard 422 carrying the manual fallback, which is
 *     the same contract the staff STK route already guarantees. The guard is
 *     not relaxed just because the caller is anonymous.
 */

type PkgRow = {
  id: string; name: string; price: number; currency: string | null;
  duration_value: number; duration_unit: string; service_type: string;
};

export async function POST(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const parsed = portalPaySchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  }

  const svc = createServiceClient();
  const { data: isp } = await svc.from("isps").select("id, name").eq("slug", slug).maybeSingle();
  if (!isp) return NextResponse.json({ error: "Unknown portal" }, { status: 404 });
  const ispId = (isp as { id: string }).id;

  // Only published hotspot/voucher packages are purchasable from a public page
  // — exactly the set the portal itself is allowed to read (0026_portal_public).
  const { data: pkgRow } = await svc.from("packages")
    .select("id,name,price,currency,duration_value,duration_unit,service_type")
    .eq("id", parsed.data.package_id)
    .eq("isp_id", ispId)
    .eq("enabled", true)
    .in("service_type", ["hotspot", "voucher"])
    .maybeSingle();
  if (!pkgRow) return NextResponse.json({ error: "Package not available" }, { status: 404 });
  const pkg = pkgRow as PkgRow;

  const phone = normalizeKe(parsed.data.phone);
  if (!phone) {
    return NextResponse.json(
      { error: "Enter a valid Safaricom number (e.g. 0712 345 678)" },
      { status: 400 },
    );
  }

  // Per ISP + phone, not per IP: a hotspot NATs many buyers through one address,
  // so an IP limit would lock out the whole plot while a single number retries.
  const ok = await checkRateLimit(svc, svc, `portal-pay:${ispId}:${phone}`, 6, 3600);
  if (!ok) return NextResponse.json({ error: "Too many attempts. Try again later." }, { status: 429 });

  // Find or open the walk-up account. Service is NOT granted on either path —
  // a new buyer starts at status 'pending'.
  const { data: existingRows } = await svc.from("customers")
    .select("id, customer_no")
    .eq("isp_id", ispId).eq("phone", phone).eq("service_type", "hotspot")
    .order("created_at", { ascending: false }).limit(1);
  const existing = (existingRows?.[0] ?? null) as { id: string; customer_no: string } | null;

  let customerId = existing?.id ?? null;
  let accountRef = existing?.customer_no ?? null;
  if (!customerId) {
    const customerNo = `H-${Date.now().toString(36).toUpperCase()}`;
    const { data: created, error } = await svc.from("customers").insert({
      isp_id: ispId,
      customer_no: customerNo,
      full_name: (parsed.data.full_name ?? "").trim() || `Hotspot ${phone.slice(-4)}`,
      phone,
      service_type: "hotspot",
      status: "pending",
    }).select("id, customer_no").single();
    if (error || !created) {
      return NextResponse.json(
        { error: error?.message ?? "Could not open an account for that number" },
        { status: 400 },
      );
    }
    customerId = (created as { id: string; customer_no: string }).id;
    accountRef = (created as { id: string; customer_no: string }).customer_no;
  }
  const ref = accountRef ?? customerId.slice(0, 12);

  // ---- Path 2: the customer already paid to the Till/PayBill ---------------
  if (parsed.data.kind === "manual") {
    const receipt = (parsed.data.mpesa_receipt ?? "").trim().toUpperCase();
    const { data: dup } = await svc.from("payments").select("id")
      .eq("mpesa_receipt", receipt).maybeSingle();
    if (dup) {
      return NextResponse.json(
        { error: "That M-Pesa receipt has already been submitted", duplicate: true },
        { status: 409 },
      );
    }
    const { data: claim, error } = await svc.from("payments").insert({
      isp_id: ispId,
      customer_id: customerId,
      package_id: pkg.id,
      amount: pkg.price,
      currency: pkg.currency ?? "KES",
      phone,
      // Explicit provider. Never rely on the `payments.provider` column default
      // (historically 'payhero') to label a row.
      provider: "manual",
      provider_tx_id: receipt,
      mpesa_receipt: receipt,
      status: "pending",
      reference: ref,
      idempotency_key: uidem("portal-manual"),
    }).select("id").single();
    if (error || !claim) {
      const msg = String(error?.message ?? "");
      if (msg.includes("uq_payments_mpesa_receipt") || msg.includes("duplicate")) {
        return NextResponse.json(
          { error: "That M-Pesa receipt has already been submitted", duplicate: true },
          { status: 409 },
        );
      }
      return NextResponse.json({ error: msg || "Could not submit the claim" }, { status: 400 });
    }
    return NextResponse.json({
      ok: true,
      status: "pending",
      payment_id: (claim as { id: string }).id,
      account_ref: ref,
      message: "Receipt received. Your account is activated as soon as the operator confirms this payment.",
    }, { status: 201 });
  }

  // ---- Path 1: pay now over STK Push --------------------------------------
  // STK only. There is no manual path on the portal: the number the customer
  // needs is inside the M-Pesa prompt Safaricom sends them, and printing a Till
  // on the page only invited a receipt flow an operator had to confirm by hand.
  //
  // The two ways this can be unavailable are genuinely different problems, so
  // they are reported differently: this ISP has no Till declared (the operator
  // must fix it) versus the platform app is down (temporary, retry later).
  const [creds, target] = await Promise.all([getDarajaCreds(ispId), getIspPayTarget(ispId)]);
  if (!target) {
    return NextResponse.json({
      error: "This network has not set up M-Pesa yet. Please contact the operator.",
      manual_available: false,
    }, { status: 422 });
  }
  if (!creds) {
    return NextResponse.json({
      error: "M-Pesa is temporarily unavailable. Please try again shortly.",
      manual_available: false,
    }, { status: 503 });
  }

  const callbackUrl =
    process.env.DARAJA_CALLBACK_URL
    ?? `${new URL(req.url).origin}/api/payments/daraja-callback`;

  const { data: payment, error } = await svc.from("payments").insert({
    isp_id: ispId,
    customer_id: customerId,
    package_id: pkg.id,
    amount: pkg.price,
    currency: pkg.currency ?? "KES",
    phone,
    provider: "daraja",
    status: "pending",
    idempotency_key: uidem("portal-stk"),
    reference: ref,
  }).select("id").single();
  if (error || !payment) {
    return NextResponse.json({ error: error?.message ?? "Could not create payment" }, { status: 400 });
  }
  const paymentId = (payment as { id: string }).id;

  let stk;
  try {
    stk = await sendStkPush(creds, { phone, amountMinor: pkg.price, accountRef: ref, callbackUrl });
  } catch (e) {
    await svc.from("payments").update({ status: "failed" }).eq("id", paymentId);
    return NextResponse.json({
      error: e instanceof Error ? e.message : "STK push failed. Pay manually and submit your receipt.",
    }, { status: 502 });
  }

  await svc.from("payments").update({
    checkout_request_id: stk.checkoutRequestId,
    merchant_request_id: stk.merchantRequestId || null,
    provider_tx_id: stk.checkoutRequestId,
  }).eq("id", paymentId);

  await svc.from("payment_reconciliation").insert({
    isp_id: ispId,
    payment_id: paymentId,
    expected_amount: pkg.price,
    status: "pending",
  });

  return NextResponse.json({
    ok: true,
    status: "pending",
    payment_id: paymentId,
    checkout_request_id: stk.checkoutRequestId,
    account_ref: ref,
    message: `Enter your M-Pesa PIN on ${phone} to pay KSh ${(pkg.price / 100).toLocaleString("en-KE")}.`,
  }, { status: 201 });
}

/**
 * GET /api/portal/[slug]/pay?payment_id=…&phone=… — status for a waiting buyer.
 *
 * Requires BOTH the row id and the paying phone, so a payment cannot be read by
 * anyone who merely guesses or glimpses an id. Returns nothing but the status,
 * which is all the portal needs to stop polling.
 */
export async function GET(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const url = new URL(req.url);
  const paymentId = url.searchParams.get("payment_id");
  const phone = normalizeKe(url.searchParams.get("phone") ?? "");
  if (!paymentId || !phone) {
    return NextResponse.json({ error: "payment_id and phone are required" }, { status: 400 });
  }
  const svc = createServiceClient();
  const { data: isp } = await svc.from("isps").select("id").eq("slug", slug).maybeSingle();
  if (!isp) return NextResponse.json({ error: "Unknown portal" }, { status: 404 });

  const { data: payment } = await svc.from("payments")
    .select("id,status,amount,mpesa_receipt")
    .eq("id", paymentId)
    .eq("isp_id", (isp as { id: string }).id)
    .eq("phone", phone)
    .maybeSingle();
  if (!payment) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const row = payment as { status: string; amount: number; mpesa_receipt: string | null };
  return NextResponse.json({
    status: row.status,
    amount: row.amount,
    receipt: row.mpesa_receipt,
    settled: row.status === "completed",
  });
}
