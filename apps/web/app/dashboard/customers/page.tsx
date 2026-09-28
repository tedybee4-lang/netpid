import { createClient } from "@/lib/supabase/server";
import { kes } from "@/lib/isp";

export default async function CustomersPage({ searchParams }: { searchParams: Promise<{ q?: string; status?: string }> }) {
  const sp = await searchParams;
  const supabase = await createClient();
  const { data: memberships } = await supabase.from("isp_users").select("isp_id");
  const ispId = memberships?.[0]?.isp_id as string | undefined;
  let query = supabase.from("customers").select("*, packages(name)")
    .order("created_at", { ascending: false }).limit(100);
  if (ispId) query = query.eq("isp_id", ispId);
  if (sp.status) query = query.eq("status", sp.status);
  if (sp.q) query = query.or(`full_name.ilike.%${sp.q}%,phone.ilike.%${sp.q}%,customer_no.ilike.%${sp.q}%`);
  const { data: customers } = await query;
  const counts = (customers ?? []).reduce<Record<string, number>>((a, c) => {
    a[c.status] = (a[c.status] ?? 0) + 1; return a;
  }, {});

  return (
    <main className="mx-auto max-w-6xl px-4 py-8">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-black">Customers</h1>
        <a className="btn-primary" href="/dashboard/customers/new">Add customer</a>
      </div>
      <form className="mt-4 flex flex-col gap-2 sm:flex-row" method="get">
        <input name="q" defaultValue={sp.q ?? ""} className="input" placeholder="Search name, phone, customer no…" />
        <select name="status" defaultValue={sp.status ?? ""} className="input sm:w-48">
          <option value="">All statuses</option>
          {["pending", "active", "suspended", "expired", "blocked", "terminated"].map((s) => (
            <option key={s} value={s}>{s} ({counts[s] ?? 0})</option>
          ))}
        </select>
        <button className="btn-ghost">Filter</button>
      </form>
      {!customers?.length ? (
        <div className="card mt-4"><p className="font-semibold">No data yet.</p>
        <p className="mt-1 text-sm text-slate-500">Add your first customer, assign a package, then collect payment via M-Pesa.</p></div>
      ) : (
        <div className="card mt-4 overflow-x-auto p-0">
          <table className="w-full min-w-[720px] text-sm">
            <thead><tr className="text-left text-xs uppercase text-slate-500">
              <th className="px-4 py-3">Customer</th><th>Phone</th><th>Package</th><th>Status</th><th>Expiry</th>
            </tr></thead>
            <tbody>{customers.map((c) => (
              <tr key={c.id} className="border-t border-slate-100">
                <td className="px-4 py-3"><a className="font-semibold text-indigo-700 hover:underline" href={`/dashboard/customers/${c.id}`}>{c.full_name}</a>
                <p className="text-xs text-slate-500">{c.customer_no}{c.username ? ` · ${c.username}` : ""}</p></td>
                <td className="px-4 py-3">{c.phone}</td>
                <td className="px-4 py-3">{(c.packages as unknown as { name: string } | null)?.name ?? "—"}</td>
                <td className="px-4 py-3"><span className="badge bg-slate-100 text-slate-700">{c.status}</span></td>
                <td className="px-4 py-3">{c.expiry_date ? new Date(c.expiry_date).toLocaleDateString() : "—"}</td>
              </tr>))}</tbody>
          </table>
        </div>
      )}
      <p className="mt-3 text-xs text-slate-500">Balances in KES minor units · {kes(0)} sample format.</p>
    </main>
  );
}
