import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { ago, kes, speedPair, statusTone } from "@/lib/format";

export default async function CustomersPage({ searchParams }: { searchParams: Promise<{ q?: string; status?: string }> }) {
  const sp = await searchParams;
  const supabase = await createClient();
  const { data: memberships } = await supabase.from("isp_users").select("isp_id").limit(1);
  const ispId = memberships?.[0]?.isp_id as string | undefined;
  let query = supabase.from("customers")
    .select("*, packages(name,download_kbps,upload_kbps)")
    .order("created_at", { ascending: false }).limit(100);
  if (ispId) query = query.eq("isp_id", ispId);
  if (sp.status) query = query.eq("status", sp.status);
  if (sp.q) query = query.or(`full_name.ilike.%${sp.q}%,phone.ilike.%${sp.q}%,customer_no.ilike.%${sp.q}%`);
  const { data: customers } = await query;
  const counts = (customers ?? []).reduce<Record<string, number>>((a, c) => {
    a[c.status] = (a[c.status] ?? 0) + 1; return a;
  }, {});

  return (
    <main className="mx-auto max-w-[1400px] px-4 py-6 sm:px-6 lg:px-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-black tracking-tight sm:text-3xl">Customers</h1>
          <p className="mt-1 text-sm text-slate-500">
            {(customers ?? []).length} shown · last seen comes from RADIUS, never from billing status.
          </p>
        </div>
        <Link className="btn-primary" href="/dashboard/customers/new">Add customer</Link>
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
        <div className="card mt-4"><p className="font-bold">No customers yet</p>
        <p className="mt-1 text-sm text-slate-500">Add your first customer, assign a package, then collect payment via M-Pesa.</p></div>
      ) : (
        <div className="card-flush mt-4 overflow-x-auto">
          <table className="table min-w-[860px]">
            <thead><tr>
              <th>Customer</th><th>Package</th><th>Speed</th><th>Status</th><th>Seen</th>
            </tr></thead>
            <tbody>{customers.map((c) => {
              const pkg = c.packages as unknown as
                { name: string; download_kbps: number | null; upload_kbps: number | null } | null;
              return (
              <tr key={c.id}>
                <td>
                  <Link className="font-semibold text-indigo-700 hover:underline" href={`/dashboard/customers/${c.id}`}>{c.full_name}</Link>
                  <p className="text-xs text-slate-500">{c.customer_no}{c.username ? ` · ${c.username}` : ""}</p>
                </td>
                <td>{pkg?.name ?? "—"}</td>
                {/* Effective speed per row: a customer-level override wins over
                    the package, and the badge shows when that is happening so
                    support can see a capped customer at a glance. */}
                <td className="tnum">
                  {speedPair(c.download_kbps ?? pkg?.download_kbps, c.upload_kbps ?? pkg?.upload_kbps)}
                  {(c.download_kbps != null || c.upload_kbps != null) && (
                    <span className="badge badge-warn ml-2">override</span>
                  )}
                </td>
                <td><span className={`badge ${statusTone(c.status)}`}>{c.status}</span></td>
                <td className="text-slate-500">{ago(c.last_seen_at)}</td>
              </tr>);})}</tbody>
          </table>
        </div>
      )}
      <p className="mt-3 text-xs text-slate-500">Balances in KES minor units · {kes(0)} sample format.</p>
    </main>
  );
}
