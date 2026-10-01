import Link from "next/link";
import { loadDashboard } from "@/lib/dashboard";
import { AreaChart, BarChart, Donut, RankedBars } from "@/components/Charts";
import { Metric } from "@/components/PageShell";
import { ago, bytes, duration, kes, num, statusTone } from "@/lib/format";

function delta(now: number, before: number): { text: string; bad: boolean } {
  if (!before) return { text: "No prior month to compare", bad: false };
  const pct = Math.round(((now - before) / before) * 100);
  if (pct === 0) return { text: "Flat vs last month", bad: false };
  return { text: `${pct > 0 ? "+" : ""}${pct}% vs last month`, bad: pct < 0 };
}

/**
 * Operations-first shortcuts. Every one of these is a link to a route that
 * already exists — nothing here invents a new destination, and nothing is
 * duplicated from the sidebar. Ordered by how often an operator reaches for it,
 * not alphabetically.
 */
const ACTIONS = [
  { href: "/dashboard/customers/new", label: "Add customer" },
  { href: "/dashboard/payments", label: "Verify payment" },
  { href: "/dashboard/network/routers/new", label: "Add router" },
  { href: "/dashboard/packages/new", label: "New package" },
  { href: "/dashboard/network/ip-pools", label: "IP pools" },
  { href: "/dashboard/sms", label: "Send SMS" },
  { href: "/dashboard/settings/mpesa", label: "Payment method" },
  { href: "/dashboard/page-builder", label: "Branding" },
] as const;

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

  // Every alert below is derived from a value loadDashboard() already returned.
  // Nothing is hardcoded and nothing is inferred: if a number is not in the
  // payload, there is no alert for it.
  const alerts: { text: string; href: string; tone: "bad" | "warn" }[] = [];
  if (d.kpi.routersTotal === 0) {
    alerts.push({ text: "No routers yet — customers cannot connect", href: "/dashboard/network/routers/new", tone: "bad" });
  } else if (d.kpi.routersOnline < d.kpi.routersTotal) {
    alerts.push({
      text: `${num(d.kpi.routersTotal - d.kpi.routersOnline)} of ${num(d.kpi.routersTotal)} routers are not reporting`,
      href: "/dashboard/network", tone: "bad",
    });
  }
  if (d.kpi.pendingPayments > 0) {
    alerts.push({
      text: `${num(d.kpi.pendingPayments)} payment${d.kpi.pendingPayments === 1 ? "" : "s"} awaiting M-Pesa confirmation`,
      href: "/dashboard/payments", tone: "warn",
    });
  }
  if (d.kpi.expiringSoon > 0) {
    alerts.push({
      text: `${num(d.kpi.expiringSoon)} customer${d.kpi.expiringSoon === 1 ? "" : "s"} expire within 7 days`,
      href: "/dashboard/customers?status=active", tone: "warn",
    });
  }
  if (d.kpi.smsFailed > 0) {
    alerts.push({ text: `${num(d.kpi.smsFailed)} SMS failed today`, href: "/dashboard/sms", tone: "bad" });
  }

  const networkOk = d.kpi.routersTotal > 0 && d.kpi.routersOnline === d.kpi.routersTotal;

  return (
    <main className="mx-auto max-w-[1400px] px-4 py-5 sm:px-6 lg:px-8">
      {/* Identity + live service status first. An operator opening this on a
          phone needs to know whose account this is and whether the network is
          up, without scrolling. */}
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-xl font-extrabold tracking-tight text-slate-900 sm:text-2xl">
            {d.isp.name}
          </h1>
          <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-slate-500">
            <span>Dashboard</span>
            <span aria-hidden="true" className="text-slate-300">·</span>
            <span className={`badge ${networkOk ? "badge-ok" : "badge-warn"}`}>
              {d.kpi.routersTotal === 0 ? "No routers"
                : networkOk ? "Network healthy" : "Network degraded"}
            </span>
          </p>
        </div>
        <div className="flex gap-2">
          <Link href="/dashboard/network/routers/new" className="btn-ghost">Add router</Link>
          <Link href="/dashboard/customers/new" className="btn-primary">Add customer</Link>
        </div>
      </header>

      {/* Alerts, rendered only when something is genuinely wrong, so a healthy
          account sees none rather than a row of reassuring green. */}
      {alerts.length > 0 && (
        <section aria-label="Needs attention" className="mt-4 grid gap-2 sm:grid-cols-2">
          {alerts.map((a) => (
            <Link key={a.text} href={a.href}
              className={`flex items-center gap-2 rounded-lg border px-3 py-2.5 text-sm font-medium transition hover:underline ${
                a.tone === "bad"
                  ? "border-red-200 bg-red-50 text-red-800"
                  : "border-amber-200 bg-amber-50 text-amber-900"}`}>
              <span aria-hidden="true" className="font-black">{a.tone === "bad" ? "!" : "▲"}</span>
              {a.text}
            </Link>
          ))}
        </section>
      )}

      {/* Operations-first shortcuts, all pointing at routes that already exist.
          Horizontal scroll on a phone rather than wrap: eight wrapped buttons
          push every metric below two screens. */}
      <nav aria-label="Common actions" className="mt-4 -mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
        <ul className="flex w-max gap-2 sm:w-auto sm:flex-wrap">
          {ACTIONS.map((a) => (
            <li key={a.href}>
              <Link href={a.href} className="btn-ghost btn-sm whitespace-nowrap">{a.label}</Link>
            </li>
          ))}
        </ul>
      </nav>

      <section className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Metric label="Collected today" value={kes(d.kpi.revenueToday)}
          sub={d.kpi.pendingPayments ? `${num(d.kpi.pendingPayments)} payments pending` : "No pending payments"}
          tone="ok" href="/dashboard/payments" />
        <Metric label="Collected this month" value={kes(d.kpi.revenueMonth)} sub={rev.text}
          tone={rev.bad ? "bad" : "brand"} href="/dashboard/payments" />
        <Metric label="Active customers" value={num(d.kpi.activeCustomers)}
          sub={`${num(d.kpi.totalCustomers)} total · ${num(d.kpi.expiredCustomers)} expired`}
          tone={d.kpi.expiredCustomers > 0 ? "warn" : "default"} href="/dashboard/customers" />
        <Metric label="Online right now" value={num(d.kpi.onlineNow)}
          sub="From RADIUS accounting only" tone="ok" href="/dashboard/network/sessions" />
      </section>

      <section className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Metric label="Routers online" value={`${d.kpi.routersOnline} / ${d.kpi.routersTotal}`}
          sub={d.kpi.routersTotal ? "Health reported by the worker" : "No routers yet"}
          tone={d.kpi.routersTotal === 0 ? "warn"
            : d.kpi.routersOnline === d.kpi.routersTotal ? "ok" : "warn"}
          href="/dashboard/network" />
        <Metric label="Expiring in 7 days" value={num(d.kpi.expiringSoon)}
          sub="Renew or they will be disconnected" tone={d.kpi.expiringSoon ? "warn" : "default"}
          href="/dashboard/customers?status=active" />
        <Metric label="SMS today" value={num(d.kpi.smsSent)}
          sub={d.kpi.smsFailed ? `${num(d.kpi.smsFailed)} failed` : "None failed"}
          tone={d.kpi.smsFailed ? "bad" : "default"} href="/dashboard/sms" />
        <Metric label="Pending payments" value={num(d.kpi.pendingPayments)}
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
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
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
      <section className="mt-4 grid gap-4 lg:grid-cols-2">
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


