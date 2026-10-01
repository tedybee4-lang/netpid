import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { isAdmin } from "@/lib/admin-auth";
import { monthlyEstimate } from "@/lib/pricing";
import { z } from "zod";

// Monthly collection of the platform fee from ISPs. Super Admin only.
//
// The bill is COMPUTED from the ISP's real usage through lib/pricing's
// monthlyEstimate() — the same function the public pricing calculator uses. That
// matters: pricing here is usage-based (routers + subscriber counts, per
// migration 0035), so billing from a flat plan price would invoice ISPs for a
// number unrelated to what they actually use.
//
// What this deliberately does NOT do: suspend or throttle an ISP when an invoice
// goes unpaid. Overdue is recorded and surfaced; cutting off paying subscribers
// is a decision for a human, not a side effect of a billing run.

async function guard() {
  if (!(await isAdmin())) {
    return NextResponse.json({ error: "Admin access required" }, { status: 403 });
  }
  return null;
}

const raiseSchema = z.object({
  period: z.string().regex(/^[0-9]{4}-[0-9]{2}$/, "period must look like 2026-10"),
  due_on: z.string().regex(/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/).optional().or(z.literal("")),
  note: z.string().max(500).optional().or(z.literal("")),
});

const recordSchema = z.object({
  id: z.string().uuid(),
  payment_reference: z.string().min(3).max(64),
});

/** What one ISP owes for a month, derived from its live usage. */
async function usageFor(svc: ReturnType<typeof createServiceClient>, ispId: string) {
  const [routers, pppoe, statics] = await Promise.all([
    svc.from("routers").select("id", { count: "exact", head: true }).eq("isp_id", ispId),
    svc.from("customers").select("id", { count: "exact", head: true })
      .eq("isp_id", ispId).eq("service_type", "pppoe"),
    svc.from("customers").select("id", { count: "exact", head: true })
      .eq("isp_id", ispId).eq("service_type", "static"),
  ]);
  const nRouters = routers.count ?? 0;
  const nPppoe = pppoe.count ?? 0;
  const nStatic = statics.count ?? 0;
  return { nRouters, nPppoe, nStatic, amountMinor: monthlyEstimate(nRouters, nPppoe, nStatic) };
}

// GET — invoices for a period, plus the headline totals.
export async function GET(req: Request) {
  const denied = await guard();
  if (denied) return denied;
  const svc = createServiceClient();
  const period = new URL(req.url).searchParams.get("period");

  let q = svc.from("isp_invoices")
    .select("id, isp_id, period, plan_id, amount, currency, status, due_on, paid_at, payment_reference, note, created_at")
    .order("period", { ascending: false }).order("created_at", { ascending: true })
    .limit(500);
  if (period) q = q.eq("period", period);
  const { data: invoices, error } = await q;
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });

  const { data: isps } = await svc.from("isps").select("id, name, slug, status");
  const byId = new Map((isps ?? []).map((i) => [i.id, i]));

  const rows = (invoices ?? []).map((r) => ({
    ...r,
    isp_name: byId.get(r.isp_id)?.name ?? "Unknown ISP",
    isp_slug: byId.get(r.isp_id)?.slug ?? null,
  }));


  const billable = rows.filter((r) => r.status !== "void");
  const sum = (xs: typeof billable) => xs.reduce((n, r) => n + Number(r.amount ?? 0), 0);
  const today = new Date().toISOString().slice(0, 10);
  const unpaid = billable.filter((r) => r.status === "issued" || r.status === "overdue");
  const overdue = unpaid.filter((r) => r.status === "overdue" || (r.due_on && r.due_on < today));

  return NextResponse.json({
    invoices: rows,
    totals: {
      billed: sum(billable),
      collected: sum(billable.filter((r) => r.status === "paid")),
      outstanding: sum(unpaid),
      overdue_count: overdue.length,
      overdue_value: sum(overdue),
    },
  });
}
// POST — raise a bill for every ISP on a billable subscription.
export async function POST(req: Request) {
  const denied = await guard();
  if (denied) return denied;
  const parsed = raiseSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid input" }, { status: 400 });
  }
  const { period, due_on, note } = parsed.data;
  const svc = createServiceClient();

  // Only ISPs on a real subscription are billable. A trial or cancelled ISP
  // receiving a platform-fee invoice is a billing bug, not a collection tactic.
  const { data: isps } = await svc.from("isps")
    .select("id, name, subscription_status")
    .in("subscription_status", ["active", "past_due", "grace"]);
  if (!isps?.length) {
    return NextResponse.json(
      { error: "No ISPs are on a billable subscription right now." }, { status: 400 });
  }

  const raised: string[] = [];
  const skipped: { isp: string; why: string }[] = [];

  for (const isp of isps) {
    const { amountMinor } = await usageFor(svc, isp.id);
    if (amountMinor <= 0) { skipped.push({ isp: isp.name, why: "no billable usage" }); continue; }
    // onConflict against the unique (isp_id, period) index makes re-running a
    // month an UPDATE, not a second bill. The database is the guard here, not
    // a check in the UI.
    const { error } = await svc.from("isp_invoices").upsert({
      isp_id: isp.id, period, amount: amountMinor,
      due_on: due_on || null, note: note || null, status: "issued",
    }, { onConflict: "isp_id,period" });
    if (error) skipped.push({ isp: isp.name, why: error.message });
    else raised.push(isp.name);
  }

  await svc.from("audit_logs").insert({
    actor_type: "user", action: "isp_invoices_raised",
    resource: "isp_invoices",
    metadata: { period, raised: raised.length, skipped: skipped.length },
  });

  return NextResponse.json({ ok: true, period, raised, skipped });
}

// PATCH — record that an ISP paid. The reference is the receipt or bank
// reference the admin actually saw, mirroring how customer payments are
// confirmed out of band rather than called automatically.
export async function PATCH(req: Request) {
  const denied = await guard();
  if (denied) return denied;
  const parsed = recordSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid input" }, { status: 400 });
  }
  const { id, payment_reference } = parsed.data;
  const svc = createServiceClient();

  // Guarded on status='issued' so a double-click or a retried request cannot
  // mark one bill paid twice.
  const { data, error } = await svc.from("isp_invoices")
    .update({ status: "paid", paid_at: new Date().toISOString(), payment_reference })
    .eq("id", id).eq("status", "issued").select("id, isp_id, amount").single();
  if (error || !data) {
    return NextResponse.json({ error: "That invoice is not awaiting payment." }, { status: 409 });
  }

  await svc.from("audit_logs").insert({
    actor_type: "user", action: "isp_invoice_paid",
    resource: "isp_invoices", resource_id: id,
    metadata: { amount: (data as { amount: number }).amount },
  });
  return NextResponse.json({ ok: true });
}

  // Totals come from the SAME rows the page renders, so the summary can never
  // quietly disagree with the list underneath it.
