import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { resolveIsp, uidem } from "@/lib/isp";
import { initiatePaymentSchema } from "@/lib/validation";

// POST /api/payments/initiate — STK push request via ISP's PayHero account.
// Creates a pending payment + reconciliation row, enqueues worker job.
// NEVER activates service here — only the verified webhook does that.
export async function POST(req: Request) {
  const r = await resolveIsp(req);
  if ("error" in r) return r.error;

  const parsed = initiatePaymentSchema.safeParse(await req.json());

  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  }

  const svc = createServiceClient();

  const { data: customer } = await svc
    .from("customers")
    .select("id, isp_id")
    .eq("id", parsed.data.customer_id)
    .maybeSingle();

  if (!customer || customer.isp_id !== r.ispId) {
    return NextResponse.json(
      { error: "Customer not found in your ISP" },
      { status: 404 }
    );
  }

  const { data: provider } = await svc
    .from("payment_providers")
    .select("id, provider, status")
    .eq("isp_id", r.ispId)
    .eq("provider", "payhero")
    .maybeSingle();

  if (!provider || provider.status !== "active") {
    return NextResponse.json(
      { error: "Payment provider not connected." },
      { status: 422 }
    );
  }

  const idem = uidem("pay");

  const { data: payment, error } = await svc
    .from("payments")
    .insert({
      isp_id: r.ispId,
      customer_id: parsed.data.customer_id,
      package_id: parsed.data.package_id ?? null,
      amount: parsed.data.amount,
      currency: "KES",
      phone: parsed.data.phone,
      provider: "payhero",
      status: "pending",
      idempotency_key: idem,
    })
    .select("id")
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }

  await svc.from("payment_reconciliation").insert({
    isp_id: r.ispId,
    payment_id: payment.id,
    expected_amount: parsed.data.amount,
    status: "pending",
  });

  await svc.rpc("enqueue_job", {
    p_kind: "payhero-stk",
    p_isp_id: r.ispId,
    p_payload: {
      payment_id: payment.id,
      phone: parsed.data.phone,
      amount: parsed.data.amount,
    },
  });

  return NextResponse.json(
    {
      payment_id: payment.id,
      message:
        "Payment request sent. Enter M-Pesa PIN on your phone. Service activates after confirmed payment.",
    },
    { status: 201 }
  );
}

// GET /api/payments?isp= — payment history, RLS scoped
export async function GET(req: Request) {
  const r = await resolveIsp(req);

  if ("error" in r) return r.error;

  const { data, error } = await r.supabase
    .from("payments")
    .select("*, customers!inner(full_name, phone)")
    .eq("isp_id", r.ispId)
    .order("created_at", { ascending: false })
    .limit(100);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }

  return NextResponse.json({ payments: data });
}
