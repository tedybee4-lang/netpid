import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { ago, speedPair, statusTone } from "@/lib/format";

const PAGE_SIZE = 25;
const ALL_STATUSES = ["pending", "active", "suspended", "expired", "blocked", "terminated"];

/** Builds a customers URL that preserves the current filters. */
function linkTo(page: number, q?: string, status?: string): string {
  const p = new URLSearchParams();
  if (q) p.set("q", q);
  if (status) p.set("status", status);
  if (page > 1) p.set("page", String(page));
  const s = p.toString();
  return `/dashboard/customers${s ? `?${s}` : ""}`;
}

export default async function CustomersPage({ searchParams }: {
  searchParams: Promise<{ q?: string; status?: string; page?: string }>;
}) {
  const sp = await searchParams;
  const page = Math.max(1, Number(sp.page) || 1);
  const from = (page - 1) * PAGE_SIZE;

  // The search value is interpolated into .or()'s filter grammar, where a stray
  // "," or ")" would change what the filter means. Strip them so a search box can
  // never rewrite the query it is part of.
  const q = (sp.q ?? "").replace(/[,()%]/g, "").trim();

  const supabase = await createClient();
  const { data: memberships } = await supabase.from("isp_users").select("isp_id").limit(1);
  const ispId = memberships?.[0]?.isp_id as string | undefined;

  // Counts come from one exact count PER STATUS across the whole ISP, never from
  // the page below. The old in-page tally meant filtering to "suspended" showed
  // "(0)" beside every other status in the dropdown, which looks like customers
  // have vanished.
  const statusCounts = await Promise.all(ALL_STATUSES.map(async (s) => {
    let c = supabase.from("customers").select("id", { count: "exact", head: true }).eq("status", s);
    if (ispId) c = c.eq("isp_id", ispId);
    const { count } = await c;
    return count ?? 0;
  }));
  const counts: Record<string, number> = Object.fromEntries(
    ALL_STATUSES.map((s, i) => [s, statusCounts[i]]),
  );

  let query = supabase.from("customers")
    .select("*, packages(name,download_kbps,upload_kbps)", { count: "exact" })
    .order("created_at", { ascending: false })
    .range(from, from + PAGE_SIZE - 1);
  if (ispId) query = query.eq("isp_id", ispId);
  if (sp.status) query = query.eq("status", sp.status);
  if (q) query = query.or(`full_name.ilike.%${q}%,phone.ilike.%${q}%,customer_no.ilike.%${q}%`);
  const { data: customers, count: total } = await query;
  const pages = Math.max(1, Math.ceil((total ?? 0) / PAGE_SIZE));

  return (
    <main className="mx-auto max-w-[1400px] px-4 py-6 sm:px-6 lg:px-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-black tracking-tight sm:text-3xl">Customers</h1>
          <p className="mt-1 text-sm text-slate-500">
            {total ?? 0} customer(s) · last seen comes from RADIUS, never from billing status.
          </p>
        </div>
        <Link className="btn-primary" href="/dashboard/customers/new">Add customer</Link>
      </div>
      <form className="mt-4 flex flex-col gap-2 sm:flex-row" method="get">
        <input name="q" defaultValue={q} className="input" placeholder="Search name, phone, customer no…" />
        <select name="status" defaultValue={sp.status ?? ""} className="input sm:w-48">
          <option value="">All statuses</option>
          {["pending", "active", "suspended", "expired", "blocked", "terminated"].map((s) => (
            <option key={s} value={s}>{s} ({counts[s] ?? 0})</option>
          ))}
        </select>
        <button className="btn-ghost">Filter</button>
        {(sp.q || sp.status) && (
          <Link href="/dashboard/customers"
            className="self-center text-sm font-semibold text-slate-500 hover:underline sm:self-auto sm:pb-2">
            Clear
          </Link>
        )}
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
      <nav className="mt-4 flex flex-wrap items-center justify-between gap-3" aria-label="Pagination">
        <p className="text-xs text-slate-500">
          Page {page} of {pages} · {total ?? 0} total
        </p>
        <div className="flex gap-2">
          {page > 1 ? (
            <Link className="btn-ghost btn-sm" href={linkTo(page - 1, q, sp.status)}>← Previous</Link>
          ) : (
            <span className="btn-ghost btn-sm opacity-40">← Previous</span>
          )}
          {page < pages ? (
            <Link className="btn-ghost btn-sm" href={linkTo(page + 1, q, sp.status)}>Next →</Link>
          ) : (
            <span className="btn-ghost btn-sm opacity-40">Next →</span>
          )}
        </div>
      </nav>
    </main>
  );
}
