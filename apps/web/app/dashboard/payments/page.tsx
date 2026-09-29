import { createClient } from "@/lib/supabase/server";
import { dateOnly, kes, num, statusTone } from "@/lib/format";

export default async function PaymentsPage() {
  const supabase = await createClient();
  const { data: memberships } = await supabase.from("isp_users").select("isp_id").limit(1);
  const ispId = memberships?.[0]?.isp_id as string | undefined;
  const { data: payments } = ispId
    ? await supabase.from("payments").select("id,amount,status,provider_tx_id,created_at,customers(full_name)").eq("isp_id", ispId).order("created_at", { ascending: false }).limit(100)
    : { data: [] };
  const collected = (payments ?? []).filter((p) => p.status === "completed").reduce((a, p) => a + Number(p.amount ?? 0), 0);

  return (
    <main className="mx-auto max-w-[1400px] px-4 py-6 sm:px-6 lg:px-8">
      <h1 className="text-2xl font-black tracking-tight sm:text-3xl">Payments</h1>
      <div className="mt-4 grid gap-4 sm:grid-cols-3">
        <div className="stat"><p className="stat-label">Collected</p>
        <p className="stat-value">{kes(collected)}</p></div>
        <div className="stat"><p className="stat-label">Transactions</p>
        <p className="stat-value">{num(payments?.length ?? 0)}</p></div>
        <div className="stat"><p className="stat-label">Provider</p>
        <p className="stat-value text-lg">PayHero M-Pesa</p></div>
      </div>
      {!payments?.length ? (
        <div className="card mt-4"><p className="font-bold">No payments yet</p>
        <p className="mt-1 text-sm text-slate-500">STK pushes initiated from a customer page appear here after PayHero confirms them.</p></div>
      ) : (
        <div className="card-flush mt-4 overflow-x-auto">
          <table className="table min-w-[720px]">
            <thead><tr>
              <th>Customer</th><th>Amount</th><th>Status</th><th>Reference</th><th>Date</th>
            </tr></thead>
            <tbody>{payments.map((p) => (
              <tr key={p.id}>
                <td>{(p.customers as unknown as { full_name: string } | null)?.full_name ?? "—"}</td>
                <td className="font-semibold tnum">{kes(p.amount)}</td>
                <td><span className={`badge ${statusTone(p.status)}`}>{p.status}</span></td>
                <td className="font-mono text-xs">{p.provider_tx_id ?? "pending…"}</td>
                <td className="text-slate-500">{dateOnly(p.created_at)}</td>
              </tr>))}</tbody>
          </table>
        </div>
      )}
    </main>
  );
}
