"use client";

import { useCallback, useEffect, useState } from "react";
import { kes } from "@/lib/format";

// Super Admin: collect the monthly platform fee from ISPs.
//
// Raising a bill is a deliberate act, not a cron job — see the note in
// /api/admin/billing about why nothing here is automatic and nothing suspends
// an ISP on its own.

type Invoice = {
  id: string; isp_id: string; isp_name: string; period: string;
  amount: number; currency: string; status: string;
  due_on: string | null; paid_at: string | null; payment_reference: string | null;
};
type Totals = {
  billed: number; collected: number; outstanding: number;
  overdue_count: number; overdue_value: number;
};

const nowMonth = () => new Date().toISOString().slice(0, 7);

export default function AdminBillingPage() {
  const [rows, setRows] = useState<Invoice[]>([]);
  const [totals, setTotals] = useState<Totals | null>(null);
  const [period, setPeriod] = useState(nowMonth());
  const [dueOn, setDueOn] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [refs, setRefs] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`/api/admin/billing?period=${period}`);
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? "Failed to load");
      setRows(j.invoices ?? []);
      setTotals(j.totals ?? null);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, [period]);

  useEffect(() => { load(); }, [load]);

  async function raise() {
    setBusy(true); setErr(null); setMsg(null);
    try {
      const r = await fetch("/api/admin/billing", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ period, due_on: dueOn }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? "Could not raise bills");
      const skipped = (j.skipped ?? []).length;
      setMsg(`Raised ${(j.raised ?? []).length} bill(s) for ${period}`
        + (skipped ? `; ${skipped} skipped (already billed or no billable usage).` : "."));
      load();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : "Could not raise bills");
    } finally { setBusy(false); }
  }

  async function markPaid(id: string) {
    const ref = (refs[id] ?? "").trim();
    if (!ref) { setErr("Enter the M-Pesa receipt or bank reference first."); return; }
    setBusy(true); setErr(null); setMsg(null);
    try {
      const r = await fetch("/api/admin/billing", {
        method: "PATCH", headers: { "content-type": "application/json" },
        body: JSON.stringify({ id, payment_reference: ref }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? "Could not record payment");
      setMsg("Payment recorded.");
      setRefs((s) => { const n = { ...s }; delete n[id]; return n; });
      load();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : "Could not record payment");
    } finally { setBusy(false); }
  }

  const stat = (label: string, value: number, tone = "text-slate-900") => (
    <div className="card p-3">
      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</p>
      <p className={`mt-0.5 text-lg font-black tnum ${tone}`}>{kes(value)}</p>
    </div>
  );

  return (
    <main className="mx-auto max-w-5xl px-4 py-6 sm:px-6">
      <h1 className="text-2xl font-black tracking-tight">Monthly collections</h1>
      <p className="mt-1 text-sm text-slate-500">
        Platform fees owed by each ISP, computed from their real router and
        subscriber counts. Nothing is charged automatically and no ISP is
        suspended automatically.
      </p>

      {err && <p className="err-box mt-4">{err}</p>}
      {msg && <p className="ok-box mt-4">{msg}</p>}

      {totals && (
        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {stat("Billed", totals.billed)}
          {stat("Collected", totals.collected, "text-emerald-700")}
          {stat("Outstanding", totals.outstanding, "text-amber-700")}
          {stat("Overdue", totals.overdue_value, totals.overdue_count ? "text-red-700" : "text-slate-900")}
        </div>
      )}

      <div className="card mt-4 space-y-3">
        <h2 className="panel-title">Raise bills for a month</h2>
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label className="label" htmlFor="b-period">Period</label>
            <input id="b-period" type="month" className="input" value={period}
              onChange={(e) => setPeriod(e.target.value)} />
          </div>
          <div>
            <label className="label" htmlFor="b-due">Due date (optional)</label>
            <input id="b-due" type="date" className="input" value={dueOn}
              onChange={(e) => setDueOn(e.target.value)} />
          </div>
          <button className="btn-primary" onClick={raise} disabled={busy}>
            {busy ? "Working…" : "Raise bills"}
          </button>
        </div>
        <p className="hint">
          Each ISP is billed once per period. Re-running a month recalculates the
          amount from current usage instead of issuing a second bill.
        </p>
      </div>

      <div className="card mt-4 overflow-x-auto">
        {loading ? <p className="p-4 text-sm text-slate-500">Loading…</p>
          : rows.length === 0 ? (
            <p className="p-4 text-sm text-slate-500">No invoices for {period} yet.</p>
          ) : (
            <table className="w-full min-w-[640px] text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
                  <th className="p-3">ISP</th>
                  <th className="p-3">Amount</th>
                  <th className="p-3">Due</th>
                  <th className="p-3">Status</th>
                  <th className="p-3">Record payment</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-b border-slate-100 last:border-0">
                    <td className="p-3 font-semibold">{r.isp_name}</td>
                    <td className="p-3 tnum font-black">{kes(r.amount)}</td>
                    <td className="p-3 text-slate-500">{r.due_on ?? "—"}</td>
                    <td className="p-3">
                      <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
                        r.status === "paid" ? "bg-emerald-100 text-emerald-800"
                          : r.status === "void" ? "bg-slate-100 text-slate-500"
                          : r.status === "overdue" ? "bg-red-100 text-red-800"
                          : "bg-amber-100 text-amber-800"}`}>
                        {r.status}
                      </span>
                      {r.payment_reference && (
                        <p className="mt-0.5 text-[11px] text-slate-500">ref {r.payment_reference}</p>
                      )}
                    </td>
                    <td className="p-3">
                      {r.status === "issued" ? (
                        <div className="flex gap-2">
                          <input className="input py-1 text-xs" placeholder="M-Pesa / bank ref"
                            value={refs[r.id] ?? ""}
                            onChange={(e) => setRefs((s) => ({ ...s, [r.id]: e.target.value }))} />
                          <button className="btn-ghost btn-sm" onClick={() => markPaid(r.id)} disabled={busy}>
                            Mark paid
                          </button>
                        </div>
                      ) : <span className="text-xs text-slate-400">—</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
      </div>
    </main>
  );
}
