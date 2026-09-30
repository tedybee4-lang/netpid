import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { resolveIsp, uidem } from "@/lib/isp";
import { initiatePaymentSchema } from "@/lib/validation";

// Strict positive-integer query parser. Returns null (not a silent fallback)
// when the caller supplies something that is not a whole number in range, so a
// typo can never be mistaken for a valid window.
function intParam(raw: string | null, fallback: number, max: number): number | null {
  if (raw === null || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > max) return null;
  return n;
}

// LEGACY / DISABLED - do not wire this up.
//
// This POST is the old PayHero initiate. It looks up a payment_providers row
// with provider='payhero', which can no longer exist now that billing runs on
// direct Safaricom Daraja, so it can only ever return 422. It is left in place
// because it fails CLOSED, and deleting a route an untraced caller might still
// hit is a bigger risk than keeping a dead one.
//
// Use /api/payments/stk (staff-initiated STK push) or /api/portal/[slug]/pay
// (public captive-portal checkout) instead. Only GET below is still in use.
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

// GET /api/payments — payment history, RLS scoped, paginated.
//
//   ?page=      1-based page number (default 1)
//   ?per_page=  rows per page, 1..100 (default 100 = the previous hard limit,
//               so an existing caller that sends no params still gets the same
//               window it always did, plus metadata it can ignore)
//
// `payments` stays an array so no existing consumer breaks; the extra keys are
// what a client needs to render paging controls without counting rows itself.
export async function GET(req: Request) {
  const r = await resolveIsp(req);

  if ("error" in r) return r.error;

  const sp = new URL(req.url).searchParams;
  const page = intParam(sp.get("page"), 1, 100_000);
  const perPage = intParam(sp.get("per_page"), 100, 100);
  if (page === null || perPage === null) {
    return NextResponse.json(
      { error: "page must be a positive integer and per_page between 1 and 100" },
      { status: 400 },
    );
  }
  const from = (page - 1) * perPage;

  // PostgREST rejects a Range whose start sits past the end of the result set,
  // so "page 2 of an empty list" would otherwise 416. Count first and clamp the
  // window: an out-of-range page is an EMPTY page, not an error. The count uses
  // the identical select (including the `customers!inner` join) so `total`
  // always describes exactly the set the rows come from.
  const SELECT = "*, customers!inner(full_name, phone)";
  const { count } = await r.supabase
    .from("payments")
    .select(SELECT, { count: "exact", head: true })
    .eq("isp_id", r.ispId);

  const total = count ?? 0;
  const total_pages = Math.max(1, Math.ceil(total / perPage));

  let rows: { id: string }[] = [];
  if (total > 0 && from < total) {
    const { data, error } = await r.supabase
      .from("payments")
      .select(SELECT)
      .eq("isp_id", r.ispId)
      .order("created_at", { ascending: false })
      .range(from, Math.min(from + perPage - 1, total - 1));
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    rows = data ?? [];
  }

  return NextResponse.json({
    payments: rows,
    page,
    per_page: perPage,
    total,
    total_pages,
    has_more: from + rows.length < total,
  });
}
