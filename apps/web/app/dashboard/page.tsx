import Link from "next/link";
import { loadDashboard } from "@/lib/dashboard";
import { AreaChart, BarChart, Donut, RankedBars } from "@/components/Charts";
import { ago, bytes, duration, kes, num, statusTone } from "@/lib/format";

function Stat({
  label, value, sub, tone = "default", href,
}: {
  label: string; value: string; sub?: string;
  tone?: "default" | "ok" | "warn" | "bad" | "brand";
  href?: string;
}) {
  const accents: Record<string, string> = {
    default: "before:bg-slate-300", ok: "before:bg-emerald-500",
    warn: "before:bg-amber-500", bad: "before:bg-red-500", brand: "before:bg-indigo-500",
  };
  const body = (
    <div className={`stat before:absolute before:inset-x-5 before:top-0 before:h-1
      before:rounded-full ${accents[tone]}`}>
      <p className="stat-label">{label}</p>
      <p className="stat-value">{value}</p>
      {sub && <p className="stat-sub">{sub}</p>}
    </div>
  );
  return href ? <Link href={href} className="block transition hover:-translate-y-0.5">{body}</Link> : body;
}

function delta(now: number, before: number): { text: string; bad: boolean } {
  if (!before) return { text: "No prior month to compare", bad: false };
  const pct = Math.round(((now - before) / before) * 100);
  if (pct === 0) return { text: "Flat vs last month", bad: false };
  return { text: `${pct > 0 ? "+" : ""}${pct}% vs last month`, bad: pct < 0 };
}

export default async function DashboardPage() {
  const d = await loadDashboard();

  if (!d.isp) {
    return (
      <main className="mx-auto max-w-3xl px-4 py-16">
        <div className="card text-center">
          <h1 className="text-2xl font-black">Set up your ISP</h1>
          <p className="mx-auto mt-2 max-w-md text-sm text-slate-500">
            Create your ISP profile to start managing customers, packages, billing
            and MikroTik routers.
          </p>
          <Link href="/onboarding" className="btn-primary mt-6">Get started</Link>
        </div>
      </main>
    );
  }

  const rev = delta(d.kpi.revenueMonth, d.kpi.revenueLastMonth);

  return (
    <main className="mx-auto max-w-[1400px] px-4 py-6 sm:px-6 lg:px-8">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-black tracking-tight sm:text-3xl">Dashboard</h1>
          <p className="mt-1 text-sm text-slate-500">
            {d.isp.name} · live from your ISP only (RLS enforced)
          </p>
        </div>
        <div className="flex gap-2">
          <Link href="/dashboard/network/routers/new" className="btn-ghost">Add router</Link>
          <Link href="/dashboard/customers/new" className="btn-primary">Add customer</Link>
        </div>
      </header>

      <section className="mt-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label="Collected today" value={kes(d.kpi.revenueToday)}
          sub={d.kpi.pendingPayments ? `${num(d.kpi.pendingPayments)} payments pending` : "No pending payments"}
          tone="ok" href="/dashboard/payments" />
        <Stat label="Collected this month" value={kes(d.kpi.revenueMonth)} sub={rev.text}
          tone={rev.bad ? "bad" : "brand"} href="/dashboard/payments" />
        <Stat label="Customers" value={num(d.kpi.activeCustomers)}
          sub={`${num(d.kpi.totalCustomers)} total · ${num(d.kpi.expiredCustomers)} expired`}
          tone={d.kpi.expiredCustomers > 0 ? "warn" : "default"} href="/dashboard/customers" />
        <Stat label="Online right now" value={num(d.kpi.onlineNow)}
          sub="From RADIUS accounting only" tone="ok" href="/dashboard/network/sessions" />
      </section>

      <section className="mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label="Routers online" value={`${d.kpi.routersOnline} / ${d.kpi.routersTotal}`}
          sub={d.kpi.routersTotal ? "Health reported by the worker" : "No routers yet"}
          tone={d.kpi.routersTotal === 0 ? "warn"
            : d.kpi.routersOnline === d.kpi.routersTotal ? "ok" : "warn"}
          href="/dashboard/network" />
        <Stat label="Expiring in 7 days" value={num(d.kpi.expiringSoon)}
          sub="Renew or they will be disconnected" tone={d.kpi.expiringSoon ? "warn" : "default"}
          href="/dashboard/customers?status=active" />
        <Stat label="SMS today" value={num(d.kpi.smsSent)}
          sub={d.kpi.smsFailed ? `${num(d.kpi.smsFailed)} failed` : "None failed"}
          tone={d.kpi.smsFailed ? "bad" : "default"} href="/dashboard/sms" />
        <Stat label="Pending payments" value={num(d.kpi.pendingPayments)}
          sub="Awaiting M-Pesa confirmation" tone={d.kpi.pendingPayments ? "warn" : "default"}
          href="/dashboard/payments" />
      </section>

      {/* Router view ----------------------------------------------------- */}
      <section className="mt-6">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="panel-title">Router view</h2>
          <Link href="/dashboard/network" className="text-sm font-semibold text-indigo-600
            hover:underline">All network →</Link>
        </div>
        {!d.routers.length ? (
          <div className="card">
            <p className="font-semibold">No routers yet</p>
            <p className="mt-1 text-sm text-slate-500">
              Add a MikroTik router from the dashboard, or provision one from the command
              line with <code className="rounded bg-slate-100 px-1.5 py-0.5 text-xs">
                node network-worker/scripts/provision-router.mjs
              </code>. Either path creates a RADIUS NAS client for you.
            </p>
            <Link href="/dashboard/network/routers/new" className="btn-primary mt-4">
              Add router
            </Link>
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {d.routers.slice(0, 8).map((r) => (
              <Link key={r.id} href={`/dashboard/network/routers/${r.id}`}
                className="stat transition hover:-translate-y-0.5">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate font-bold text-slate-900">{r.name}</p>
                    <p className="truncate text-xs text-slate-500">{String(r.host)}</p>
                  </div>
                  <span className={`badge ${statusTone(r.status)}`}>{r.status}</span>
                </div>
                <dl className="mt-3 grid grid-cols-3 gap-2 text-center text-xs">
                  <div>
                    <dt className="text-slate-400">CPU</dt>
                    <dd className="font-bold tnum">{r.cpu_load != null ? `${r.cpu_load}%` : "—"}</dd>
                  </div>
                  <div>
                    <dt className="text-slate-400">MEM</dt>
                    <dd className="font-bold tnum">{r.mem_used_pct != null ? `${r.mem_used_pct}%` : "—"}</dd>
                  </div>
                  <div>
                    <dt className="text-slate-400">UPTIME</dt>
                    <dd className="font-bold tnum">{duration(r.uptime_seconds)}</dd>
                  </div>
                </dl>
                <p className="mt-2 truncate text-xs text-slate-400">
                  {r.site ? `${r.site} · ` : ""}seen {ago(r.last_seen_at)}
                </p>
              </Link>
            ))}
          </div>
        )}
      </section>

      {/* Charts ---------------------------------------------------------- */}
      <section className="mt-6 grid gap-4 lg:grid-cols-2">
        <div className="card">
          <h2 className="panel-title">Monthly sales</h2>
          <p className="mb-3 mt-1 text-xs text-slate-500">Completed payments per month</p>
          <BarChart data={d.monthlyRevenue} color="#4f46e5" format={(v) => kes(v)} />
        </div>
        <div className="card">
          <h2 className="panel-title">Customer growth</h2>
          <p className="mb-3 mt-1 text-xs text-slate-500">Registrations per month</p>
          <AreaChart data={d.monthlySignups} color="#0ea5e9" format={(v) => num(v)} />
        </div>
      </section>

      <section className="mt-4 grid gap-4 lg:grid-cols-3">
        <div className="card">
          <h2 className="panel-title">Customer insights</h2>
          <p className="mb-3 mt-1 text-xs text-slate-500">Every customer by status</p>
          <Donut data={d.statusMix} centerValue={num(d.kpi.totalCustomers)} centerLabel="customers" />
        </div>
        <div className="card">
          <h2 className="panel-title">Top 5 data users</h2>
          <p className="mb-3 mt-1 text-xs text-slate-500">Last 30 days</p>
          <RankedBars
            data={d.topDownloaders}
            color="bg-cyan-500"
            format={(v) => bytes(v)}
            empty="No usage recorded yet."
            secondary={(_, i) => {
              const row = d.topDownloaders[i];
              return row ? `${bytes(row.download)} down · ${bytes(row.upload)} up` : null;
            }}
          />
        </div>
        <div className="card">
          <h2 className="panel-title">Best selling packages</h2>
          <p className="mb-3 mt-1 text-xs text-slate-500">Sales in the last 30 days</p>
          <RankedBars data={d.topPackages} color="bg-emerald-500"
            format={(v) => `${num(v)} sold`} empty="No sales recorded yet." />
        </div>
      </section>

      {/* Live sessions --------------------------------------------------- */}
      <section className="mt-4">
        <div className="card-flush">
          <div className="flex items-center justify-between border-b border-slate-100 px-5 py-4">
            <h2 className="panel-title">Live sessions</h2>
            <Link href="/dashboard/network/sessions" className="text-sm font-semibold
              text-indigo-600 hover:underline">All sessions →</Link>
          </div>
          {!d.recentSessions.length ? (
            <p className="px-5 py-8 text-center text-sm text-slate-400">
              No one is connected. Sessions appear only from RADIUS accounting packets —
              never inferred from a customer&apos;s status.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="table min-w-[640px]">
                <thead><tr>
                  <th>User</th><th>IP address</th><th>Connected</th>
                  <th className="text-right">Download</th><th className="text-right">Upload</th>
                </tr></thead>
                <tbody>
                  {d.recentSessions.map((s, i) => (
                    <tr key={`${s.username}-${i}`}>
                      <td className="font-semibold text-slate-900">{s.username}</td>
                      <td>{s.framed_ip ?? "—"}</td>
                      <td className="text-slate-500">{ago(s.start_time)}</td>
                      <td className="text-right font-semibold tnum text-cyan-700">{bytes(s.down)}</td>
                      <td className="text-right font-semibold tnum text-violet-700">{bytes(s.up)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>
    </main>
  );
}


