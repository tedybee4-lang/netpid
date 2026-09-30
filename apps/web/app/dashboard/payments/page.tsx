import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { dateOnly, kes, num, statusTone } from "@/lib/format";
import PendingClaimActions from "./PendingClaimActions";

const PAGE_SIZE = 25;
const STATUSES = ["pending", "completed", "failed", "cancelled", "refunded"];
const PROVIDERS = ["daraja", "manual"];

// Payments. Three things this page has to get right:
//   1. A manual claim submitted from the captive portal sits at 'pending' until
//      an operator confirms it, so those are surfaced first with one-click
//      confirm/reject — otherwise a paying customer waits forever.
//   2. Money totals are computed for the CURRENT MONTH from their own bounded
//      query, not from whatever rows happen to be on this page. Counting one
//      page and calling it "Collected" became a lie the moment pagination
//      arrived.
//   3. The Daraja-not-configured state stays visible and keeps pointing at the
//      manual fallback instead of hiding the problem.
export default async function PaymentsPage({ searchParams }: {
  searchParams: Promise<{ q?: string; status?: string; provider?: string; page?: string }>;
}) {
  const sp = await searchParams;
  const page = Math.max(1, Number(sp.page ?? 1) || 1);
  const from = (page - 1) * PAGE_SIZE;

  const supabase = await createClient();
  const { data: memberships } = await supabase.from("isp_users").select("isp_id").limit(1);
  const ispId = memberships?.[0]?.isp_id as string | undefined;

  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);

  let listQuery = supabase.from("payments")
    .select(
      "id,amount,status,provider,provider_tx_id,mpesa_receipt,created_at,paid_at,reference,phone,customers(full_name,customer_no)",
      { count: "exact" },
    )
    .order("created_at", { ascending: false })
    .range(from, from + PAGE_SIZE - 1);
  if (ispId) listQuery = listQuery.eq("isp_id", ispId);
  if (sp.status) listQuery = listQuery.eq("status", sp.status);
  if (sp.provider) listQuery = listQuery.eq("provider", sp.provider);
  if (sp.q) {
    // Strip the characters that would otherwise break out of the PostgREST
    // `or=(...)` grammar. Spaces are fine.
    const term = sp.q.replace(/[%,()]/g, "");
    listQuery = listQuery.or(
      `reference.ilike.%${term}%,mpesa_receipt.ilike.%${term}%,`
      + `provider_tx_id.ilike.%${term}%,phone.ilike.%${term}%`,
    );
  }

  const [listRes, monthRes, claimsRes, providerRes] = ispId
    ? await Promise.all([
      listQuery,
      supabase.from("payments").select("amount,status")
        .eq("isp_id", ispId).gte("created_at", monthStart.toISOString()).limit(5000),
      // Claims awaiting a human. Oldest first, so the customer who has waited
      // longest sits at the top of the list.
      supabase.from("payments")
        .select("id,amount,mpesa_receipt,reference,created_at,phone,customers(full_name,customer_no)")
        .eq("isp_id", ispId).eq("status", "pending").eq("provider", "manual")
        .order("created_at", { ascending: true }).limit(50),
      supabase.from("payment_providers").select("provider,status").eq("isp_id", ispId),
    ])
    : [{ data: [], count: 0 }, { data: [] }, { data: [] }, { data: [] }];

  const payments = listRes.data ?? [];
  const total = listRes.count ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const month = monthRes.data ?? [];
  const collectedMonth = month.filter((p) => p.status === "completed")
    .reduce((a, p) => a + Number(p.amount ?? 0), 0);
  const monthCount = month.length;
  const failedMonth = month.filter((p) => p.status === "failed").length;

  const provs = (providerRes.data ?? []) as { provider: string; status: string }[];
  const daraja = provs.some((x) => x.provider === "daraja" && x.status === "active");
  const claims = claimsRes.data ?? [];

  // Build a filtered link so paging never silently drops the active filters.
  const qs = (over: Record<string, string | number | undefined>) => {
    const u = new URLSearchParams();
    const merged: Record<string, string | number | undefined> =
      { q: sp.q, status: sp.status, provider: sp.provider, ...over };
    for (const [k, v] of Object.entries(merged)) {
      if (v !== undefined && v !== null && v !== "") u.set(k, String(v));
    }
    const s = u.toString();
    return `/dashboard/payments${s ? `?${s}` : ""}`;
  };

  return (
    <main className="mx-auto max-w-[1400px] px-4 py-6 sm:px-6 lg:px-8">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-black tracking-tight sm:text-3xl">Payments</h1>
          <p className="mt-1 text-sm text-slate-500">
            Direct Safaricom Daraja, manual M-Pesa receipts and portal claims.
          </p>
        </div>
        <Link href="/dashboard/settings/mpesa" className="btn-ghost">M-Pesa settings</Link>
      </header>

      <section className="mt-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <div className="stat">
          <p className="stat-label">Collected this month</p>
          <p className="stat-value">{kes(collectedMonth)}</p>
          <p className="stat-sub">{num(monthCount)} transactions</p>
        </div>
        <div className="stat">
          <p className="stat-label">Awaiting confirmation</p>
          <p className="stat-value">{num(claims.length)}</p>
          <p className="stat-sub">{claims.length ? "Manual M-Pesa claims" : "Nothing pending"}</p>
        </div>
        <div className="stat">
          <p className="stat-label">Failed this month</p>
          <p className="stat-value">{num(failedMonth)}</p>
          <p className="stat-sub">Includes failed STK pushes</p>
        </div>
        <div className="stat">
          <p className="stat-label">M-Pesa</p>
          <p className="stat-value text-lg">{daraja ? "Daraja connected" : "Not connected"}</p>
          <p className="stat-sub">Manual receipts always available</p>
        </div>
      </section>

      {!daraja && (
        <div className="card mt-4 border-amber-300 bg-amber-50">
          <p className="font-bold text-amber-900">Direct Safaricom Daraja is not configured</p>
          <p className="mt-1 text-sm text-amber-800">
            STK Push returns 422 until credentials are added — that guard is deliberate, not a bug.
            Until then customers can pay to your Till/PayBill, submit the receipt from your captive
            portal, and you confirm it below. Manual M-Pesa stays fully available.{" "}
            <Link href="/dashboard/settings/mpesa" className="font-semibold underline">
              Add Daraja credentials →
            </Link>
          </p>
        </div>
      )}

      {claims.length > 0 && (
        <section className="card-flush mt-4">
          <div className="border-b border-slate-100 px-5 py-4">
            <h2 className="panel-title">Claims awaiting confirmation ({claims.length})</h2>
            <p className="mt-1 max-w-3xl text-xs text-slate-500">
              Submitted by customers on your portal. Confirming activates the account and issues the
              receipt and invoice. Only manual claims appear here — an STK payment is activated by
              Safaricom&apos;s verified callback, never by hand.
            </p>
          </div>
          <div className="overflow-x-auto">
            <table className="table min-w-[780px]">
              <thead><tr>
                <th>Customer</th><th>Amount</th><th>Receipt</th><th>Reference</th>
                <th>Submitted</th><th className="text-right">Action</th>
              </tr></thead>
              <tbody>
                {claims.map((c) => (
                  <tr key={c.id}>
                    <td className="font-semibold text-slate-900">
                      {(c.customers as unknown as { full_name: string } | null)?.full_name ?? "—"}
                      <p className="text-xs text-slate-500">{c.phone}</p>
                    </td>
                    <td className="font-semibold tnum">{kes(c.amount)}</td>
                    <td className="font-mono text-xs">{c.mpesa_receipt ?? "—"}</td>
                    <td className="font-mono text-xs text-slate-500">{c.reference ?? "—"}</td>
                    <td className="text-slate-500">{dateOnly(c.created_at)}</td>
                    <td className="text-right">
                      <PendingClaimActions paymentId={c.id} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <form method="get" className="card mt-4 flex flex-col gap-2 sm:flex-row sm:items-end">
        <div className="min-w-0 flex-1">
          <label className="label" htmlFor="q">Search</label>
          <input id="q" name="q" defaultValue={sp.q ?? ""} className="input"
            placeholder="Receipt, reference, transaction id or phone…" />
        </div>
        <div>
          <label className="label" htmlFor="status">Status</label>
          <select id="status" name="status" defaultValue={sp.status ?? ""} className="input sm:w-40">
            <option value="">All statuses</option>
            {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
        <div>
          <label className="label" htmlFor="provider">Provider</label>
          <select id="provider" name="provider" defaultValue={sp.provider ?? ""} className="input sm:w-36">
            <option value="">All providers</option>
            {PROVIDERS.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        </div>
        <button className="btn-ghost">Filter</button>
        {(sp.q || sp.status || sp.provider) && (
          <Link href="/dashboard/payments"
            className="text-sm font-semibold text-slate-500 hover:underline sm:pb-2">
            Clear
          </Link>
        )}
      </form>

      {!payments.length ? (
        <div className="card mt-4">
          <p className="font-bold">No payments to show</p>
          <p className="mt-1 text-sm text-slate-500">
            {sp.q || sp.status || sp.provider
              ? "Nothing matches those filters. Clear them to see every transaction."
              : "STK pushes, manual receipts and portal claims all appear here once recorded."}
          </p>
        </div>
      ) : (
        <div className="card-flush mt-4 overflow-x-auto">
          <table className="table min-w-[1000px]">
            <thead><tr>
              <th>Customer</th><th>Amount</th><th>Provider</th><th>Status</th>
              <th>Reference</th><th>Transaction</th><th>Date</th><th></th>
            </tr></thead>
            <tbody>{payments.map((p) => (
              <tr key={p.id}>
                <td className="font-semibold text-slate-900">
                  {(p.customers as unknown as { full_name: string } | null)?.full_name ?? "—"}
                  <p className="text-xs text-slate-500">{p.phone}</p>
                </td>
                <td className="font-semibold tnum">{kes(p.amount)}</td>
                <td><span className="badge badge-mute">{p.provider}</span></td>
                <td><span className={`badge ${statusTone(p.status)}`}>{p.status}</span></td>
                <td className="font-mono text-xs text-slate-500">{p.reference ?? "—"}</td>
                <td className="font-mono text-xs">
                  {p.mpesa_receipt ?? p.provider_tx_id
                    ?? <span className="text-slate-400">pending…</span>}
                </td>
                <td className="text-slate-500">{dateOnly(p.created_at)}</td>
                <td className="text-right">
                  <Link href={`/dashboard/payments/${p.id}`}
                    className="font-semibold text-indigo-600 hover:underline">View</Link>
                </td>
              </tr>))}</tbody>
          </table>
        </div>
      )}

      {pages > 1 && (
        <nav className="mt-4 flex items-center justify-between gap-3" aria-label="Pagination">
          <p className="text-sm text-slate-500">
            Page {page} of {pages} · {num(total)} transactions
          </p>
          <div className="flex gap-2">
            {page > 1
              ? <Link className="btn-ghost btn-sm" href={qs({ page: page - 1 })}>← Newer</Link>
              : <span className="btn-ghost btn-sm pointer-events-none opacity-40">← Newer</span>}
            {page < pages
              ? <Link className="btn-ghost btn-sm" href={qs({ page: page + 1 })}>Older →</Link>
              : <span className="btn-ghost btn-sm pointer-events-none opacity-40">Older →</span>}
          </div>
        </nav>
      )}
    </main>
  );
}
