import { createClient } from "@/lib/supabase/server";
import { kes } from "@/lib/isp";

export default async function PaymentsPage() {
  const supabase = await createClient();
  const { data: memberships } = await supabase.from("isp_users").select("isp_id");
  const ispId = memberships?.[0]?.isp_id as string | undefined;
  const { data: payments } = ispId
    ? await supabase.from("payments").select("*, customers(full_name)").eq("isp_id", ispId).order("created_at", { ascending: false }).limit(100)
    : { data: [] };
  const collected = (payments ?? []).filter((p) => p.status === "completed").reduce((a, p) => a + p.amount, 0);

  return (
    <main className="mx-auto max-w-6xl px-4 py-8">
      <h1 className="text-3xl font-black">Payments</h1>
      <div className="mt-4 grid gap-4 sm:grid-cols-3">
        <div className="card"><p className="text-xs font-bold uppercase text-slate-500">Collected</p>
        <p className="mt-1 text-xl font-black">{kes(collected)}</p></div>
        <div className="card"><p className="text-xs font-bold uppercase text-slate-500">Transactions</p>
        <p className="mt-1 text-xl font-black">{payments?.length ?? 0}</p></div>
        <div className="card"><p className="text-xs font-bold uppercase text-slate-500">Provider</p>
        <p className="mt-1 text-xl font-black">PayHero M-Pesa</p></div>
      </div>
      {!payments?.length ? (
        <div className="card mt-4"><p className="font-semibold">No data yet.</p>
        <p className="mt-1 text-sm text-slate-500">STK pushes initiated from a customer page appear here after PayHero confirms them.</p></div>
      ) : (
        <div className="card mt-4 overflow-x-auto p-0">
          <table className="w-full min-w-[720px] text-sm">
            <thead><tr className="text-left text-xs uppercase text-slate-500">
              <th className="px-4 py-3">Customer</th><th>Amount</th><th>Status</th><th>Reference</th><th>Date</th>
            </tr></thead>
            <tbody>{payments.map((p) => (
              <tr key={p.id} className="border-t border-slate-100">
                <td className="px-4 py-3">{(p.customers as unknown as { full_name: string } | null)?.full_name ?? "—"}</td>
                <td className="px-4 py-3 font-semibold">{kes(p.amount)}</td>
                <td className="px-4 py-3"><span className="badge bg-slate-100 text-slate-700">{p.status}</span></td>
                <td className="px-4 py-3">{p.provider_tx_id ?? "pending…"}</td>
                <td className="px-4 py-3">{new Date(p.created_at).toLocaleString()}</td>
              </tr>))}</tbody>
          </table>
        </div>
      )}
    </main>
  );
}
