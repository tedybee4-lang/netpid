"use client";
import { useCallback, useEffect, useState } from "react";
import PageShell, { Empty, StatGrid, fmtDateTime } from "@/components/PageShell";

type Row = { id: string; points: number; reason: string; created_at: string;
  customers: { customer_no: string; full_name: string; status: string; loyalty_points: number } | null };
type Cust = { id: string; customer_no: string; full_name: string; status: string; loyalty_points: number; balance: number };

// 100 points = KSh 1 of credit, so an operator can see the money value too.
const KES_PER_POINT = 0.01;

export default function LoyaltyPage() {
  const [ledger, setLedger] = useState<Row[]>([]);
  const [customers, setCustomers] = useState<Cust[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<"balances" | "ledger">("balances");

  const load = useCallback(async () => {
    setLoading(true);
    const r = await fetch("/api/modules?module=loyalty");
    if (r.ok) { const j = await r.json(); setLedger(j.ledger ?? []); setCustomers(j.customers ?? []); }
    setLoading(false);
  }, []);
  useEffect(() => { load(); }, [load]);

  const outstanding = customers.reduce((a, c) => a + c.loyalty_points, 0);
  const top = customers[0]?.loyalty_points ?? 0;

  return (
    <PageShell
      title="Loyalty points"
      description="Points accrue on successful payments and are redeemable against future bills. One point is worth KSh 0.01 of credit."
    >
      <StatGrid items={[
        { label: "Points outstanding", value: outstanding.toLocaleString("en-KE"), sub: `≈ KSh ${(outstanding * KES_PER_POINT).toLocaleString("en-KE")} of credit` },
        { label: "Customers earning", value: customers.filter((c) => c.loyalty_points > 0).length, sub: "With a positive balance" },
        { label: "Top balance", value: top.toLocaleString("en-KE"), sub: customers[0]?.full_name ?? "—"},
        { label: "Ledger entries", value: ledger.length, sub: "Most recent 200" },
      ]} />

      <div className="mb-4 flex gap-1 rounded-xl border border-slate-200 bg-white p-1 sm:w-fit">
        {(["balances", "ledger"] as const).map((t) => (
          <button key={t} onClick={() => setTab(t)}
            className={`flex-1 rounded-lg px-4 py-1.5 text-xs font-bold capitalize transition sm:flex-none ${
              tab === t ? "bg-indigo-600 text-white" : "text-slate-600 hover:bg-slate-50"
            }`}>
            {t === "balances" ? "Balances" : "Ledger"}
          </button>
        ))}
      </div>

      <div className="card-flush overflow-x-auto">
        {loading
          ? <Empty>Loading…</Empty>
          : tab === "balances"
            ? !customers.length ? <Empty>No customers yet.</Empty> : (
              <table className="table" style={{ minWidth: 680 }}>
                <thead><tr><th>Customer</th><th>Status</th><th>Points</th><th>Credit value</th><th>Account balance</th></tr></thead>
                <tbody>
                  {customers.map((c) => (
                    <tr key={c.id}>
                      <td>
                        <p className="font-semibold text-slate-900">{c.full_name}</p>
                        <p className="text-xs text-slate-400">{c.customer_no}</p>
                      </td>
                      <td><span className={`badge ${c.status === "active" ? "badge-ok" : "badge-mute"}`}>{c.status}</span></td>
                      <td className={`font-bold ${c.loyalty_points > 0 ? "text-emerald-600" : c.loyalty_points < 0 ? "text-red-600" : ""}`}>
                        {c.loyalty_points.toLocaleString("en-KE")}
                      </td>
                      <td>KSh {(c.loyalty_points * KES_PER_POINT).toLocaleString("en-KE")}</td>
                      <td>KSh {(c.balance / 100).toLocaleString("en-KE")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )
            : !ledger.length ? <Empty>No points have been awarded yet.</Empty> : (
              <table className="table" style={{ minWidth: 680 }}>
                <thead><tr><th>When</th><th>Customer</th><th>Reason</th><th>Points</th></tr></thead>
                <tbody>
                  {ledger.map((l) => (
                    <tr key={l.id}>
                      <td>{fmtDateTime(l.created_at)}</td>
                      <td>{l.customers ? `${l.customers.full_name} · ${l.customers.customer_no}` : "—"}</td>
                      <td className="max-w-md truncate">{l.reason}</td>
                      <td className={`font-bold ${l.points >= 0 ? "text-emerald-600" : "text-red-600"}`}>
                        {l.points > 0 ? "+" : ""}{l.points}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
      </div>

      <p className="mt-4 text-xs text-slate-500">
        Points are written by the network worker when an M-Pesa callback confirms a payment, and can be
        adjusted by an admin from the customer's profile. Redemptions are stored as negative entries.
      </p>
    </PageShell>
  );
}
