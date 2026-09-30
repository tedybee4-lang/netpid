import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Applying a confirmed payment: extend the customer, then write the paper trail.
 *
 * IMPORTANT: /api/payments/manual carries its own copy of this sequence. That
 * route is verified behaviour (its 201 + expiry response is asserted by the
 * smoke test) so it is deliberately left alone rather than refactored onto this
 * helper. If you change the activation rules here, change them there too — the
 * duplication is a deliberate trade against touching verified code.
 */

export function durationMs(value: number, unit: string): number {
  const v = Math.max(1, value);
  if (unit === "hours") return v * 3600_000;
  if (unit === "weeks") return v * 7 * 86400_000;
  if (unit === "months") return v * 30 * 86400_000;
  return v * 86400_000;
}

export async function applyConfirmedPayment(
  svc: SupabaseClient,
  args: {
    ispId: string;
    paymentId: string;
    customerId: string;
    packageId: string | null;
    amount: number;
  },
): Promise<string | null> {
  const now = new Date().toISOString();
  let expiry: string | null = null;

  if (args.packageId) {
    const { data: pkg } = await svc.from("packages")
      .select("duration_value, duration_unit").eq("id", args.packageId).maybeSingle();
    const row = (pkg ?? null) as { duration_value: number; duration_unit: string } | null;
    expiry = new Date(Date.now() + durationMs(
      row?.duration_value ?? 30, row?.duration_unit ?? "days",
    )).toISOString();
    await svc.from("customers").update({
      status: "active", package_id: args.packageId, expiry_date: expiry,
    }).eq("id", args.customerId);
  } else {
    await svc.from("customers").update({ status: "active" }).eq("id", args.customerId);
  }

  // One stamp for both documents so a receipt and its invoice are obviously a
  // pair when read side by side in the dashboard.
  const stamp = Date.now().toString(36).toUpperCase();
  await svc.from("receipts").insert({
    isp_id: args.ispId, payment_id: args.paymentId,
    number: `R-${stamp}`, amount: args.amount, currency: "KES",
  });
  await svc.from("invoices").insert({
    isp_id: args.ispId, customer_id: args.customerId,
    number: `INV-${stamp}`, amount: args.amount, currency: "KES",
    status: "paid", paid_at: now,
  });
  await svc.from("payment_reconciliation").insert({
    isp_id: args.ispId, payment_id: args.paymentId,
    expected_amount: args.amount, received_amount: args.amount,
    status: "matched", checked_at: now,
  });

  // Idempotent worker job: it re-syncs the RADIUS user for this customer.
  await svc.rpc("enqueue_job", {
    p_kind: "post-payment", p_isp_id: args.ispId,
    p_payload: {
      payment_id: args.paymentId, customer_id: args.customerId,
      event: "payment_received",
    },
  });

  return expiry;
}
