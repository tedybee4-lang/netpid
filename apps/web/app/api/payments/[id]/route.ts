import { NextResponse } from "next/server";
import { z } from "zod";
import { createServiceClient } from "@/lib/supabase/server";
import { resolveIsp } from "@/lib/isp";
import { applyConfirmedPayment } from "@/lib/payments-activate";

type PaymentRow = {
  id: string; customer_id: string; package_id: string | null;
  amount: number; provider: string; status: string; mpesa_receipt: string | null;
};

// GET /api/payments/[id] — one payment plus the receipt and invoice written for
// it. The id in the URL is checked against the caller's resolved ISP, so one ISP
// can never read another's transaction by pasting an id.
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const r = await resolveIsp(req);
  if ("error" in r) return r.error;
  const { id } = await ctx.params;
  const svc = createServiceClient();

  const { data: payment } = await svc.from("payments")
    .select("*, customers(full_name,phone,customer_no), packages(name,duration_value,duration_unit)")
    .eq("id", id).eq("isp_id", r.ispId).maybeSingle();
  if (!payment) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const row = payment as PaymentRow;

  const [receipt, invoice, recon] = await Promise.all([
    svc.from("receipts").select("number,amount,currency,created_at")
      .eq("payment_id", id).maybeSingle(),
    svc.from("invoices").select("number,amount,currency,status,paid_at,created_at")
      .eq("isp_id", r.ispId).eq("customer_id", row.customer_id)
      .order("created_at", { ascending: false }).limit(1),
    svc.from("payment_reconciliation").select("status,expected_amount,received_amount,checked_at")
      .eq("payment_id", id).maybeSingle(),
  ]);

  return NextResponse.json({
    payment,
    receipt: receipt.data,
    invoice: invoice.data?.[0] ?? null,
    reconciliation: recon.data,
  });
}

const actionSchema = z.object({ action: z.enum(["confirm", "reject"]) });

// POST /api/payments/[id] — resolve a PENDING payment: confirm a manual claim,
// or reject it.
//
// The state change is a compare-and-set (update … eq status 'pending'), so two
// operators clicking Confirm at the same moment cannot both extend the
// customer's expiry — the second update matches zero rows and we report it as
// already processed. That is what makes this safely idempotent.
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const r = await resolveIsp(req);
  if ("error" in r) return r.error;
  const { id } = await ctx.params;

  const parsed = actionSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "Invalid action" }, { status: 400 });

  const svc = createServiceClient();
  const { data: payment } = await svc.from("payments")
    .select("id,customer_id,package_id,amount,provider,status,mpesa_receipt")
    .eq("id", id).eq("isp_id", r.ispId).maybeSingle();
  if (!payment) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const p = payment as PaymentRow;

  if (p.status === "completed") return NextResponse.json({ ok: true, already: "completed" });
  if (p.status !== "pending") {
    return NextResponse.json(
      { error: `A ${p.status} payment can no longer be changed.` },
      { status: 409 },
    );
  }

  if (parsed.data.action === "reject") {
    const { data: rejected } = await svc.from("payments")
      .update({ status: "failed" }).eq("id", p.id).eq("status", "pending").select("id");
    if (!rejected?.length) return NextResponse.json({ ok: true, already: "processed" });
    return NextResponse.json({ ok: true, status: "failed" });
  }

  // Confirming by hand is only legitimate for a MANUAL claim. A pending Daraja
  // STK row is proof of nothing until Safaricom's signed callback arrives — if
  // we let the UI flip it, the "only the verified callback activates service"
  // guarantee would be a lie. If the callback never came, the operator records
  // the M-Pesa receipt as a manual payment instead.
  if (p.provider !== "manual") {
    return NextResponse.json({
      error: "Only manual M-Pesa claims can be confirmed by hand. An STK payment "
        + "is activated by Safaricom's verified callback; if that never arrived, "
        + "record the M-Pesa receipt as a manual payment instead.",
      provider: p.provider,
    }, { status: 422 });
  }

  const { data: claimed } = await svc.from("payments")
    .update({ status: "completed", paid_at: new Date().toISOString() })
    .eq("id", p.id).eq("status", "pending").select("id");
  if (!claimed?.length) return NextResponse.json({ ok: true, already: "processed" });

  const expiry = await applyConfirmedPayment(svc, {
    ispId: r.ispId,
    paymentId: p.id,
    customerId: p.customer_id,
    packageId: p.package_id,
    amount: p.amount,
  });

  return NextResponse.json({ ok: true, status: "completed", expiry });
}
