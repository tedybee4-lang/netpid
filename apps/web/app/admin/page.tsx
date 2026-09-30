import Link from "next/link";
import { redirect } from "next/navigation";
import { createServiceClient } from "@/lib/supabase/server";
import { isAdmin, clearAdminSession } from "@/lib/admin-auth";
import { deriveStatus } from "@/lib/vps";
import { kes, num } from "@/lib/format";

export const dynamic = "force-dynamic";

function ago(iso: string | null): string {
  if (!iso) return "—";
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

const INFRA = ["supabase", "database", "radius", "radius_db", "worker", "sms"] as const;

const HEALTH_TONE = (h?: { status: string }) =>
  !h ? "border-white/10 bg-white/5 text-slate-500"
  : h.status === "online" ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
  : h.status === "degraded" ? "border-amber-500/30 bg-amber-500/10 text-amber-300"
  : "border-rose-500/30 bg-rose-500/10 text-rose-300";

function Card({ k, v, sub }: { k: string; v: string; sub: string }) {
  return (
    <div className="rounded-2xl border border-white/10 bg-slate-900 p-5">
      <p className="text-xs font-bold uppercase tracking-wide text-slate-400">{k}</p>
      <p className="mt-2 text-2xl font-extrabold tracking-tight">{v}</p>
      <p className="mt-1 text-xs text-slate-500">{sub}</p>
    </div>
  );
}
function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-6 rounded-2xl border border-white/10 bg-slate-900 p-5">
      <h2 className="text-sm font-bold uppercase tracking-wide text-slate-400">{title}</h2>
      <div className="mt-4">{children}</div>
    </section>
  );
}


// NETPID platform console. Authenticated by the fixed admin session cookie,
// NOT by Supabase — see lib/admin-auth.ts for why these are separate paths.
export default async function AdminPage() {
  if (!(await isAdmin())) redirect("/admin-login");
  const svc = createServiceClient();

  const [isps, plans, subs, customers, routers, tickets, health] = await Promise.all([
    svc.from("isps")
      .select("id,name,slug,status,subscription_status,subscription_plan_id,trial_ends_at,created_at,phone,email")
      .order("created_at", { ascending: false }).limit(100),
    svc.from("netpid_plans").select("id,slug,name,price_monthly,is_active").order("price_monthly"),
    svc.from("netpid_subscriptions").select("id,isp_id,status,plan_id,current_period_end"),
    svc.from("customers").select("id", { count: "exact", head: true }),
    svc.from("routers").select("id", { count: "exact", head: true }),
    svc.from("support_tickets").select("id", { count: "exact", head: true }).eq("status", "open"),
    svc.from("system_health")
      .select("component,status,latency_ms,checked_at,detail")
      .in("component", [...INFRA, "admin_login"])
      .order("checked_at", { ascending: false }).limit(40),
  ]);

  // Only the newest row per component — the worker writes one per poll, so the
  // raw list is mostly history.
  const latest = new Map<string, NonNullable<typeof health.data>[number]>();
  for (const h of health.data ?? []) if (!latest.has(h.component)) latest.set(h.component, h);

  const rev = (subs.data ?? []).filter((s) => s.status === "active").length;
  const mrr = (subs.data ?? []).reduce((acc, s) => {
    const p = (plans.data ?? []).find((x) => x.id === s.plan_id);
    return s.status === "active" && p ? acc + p.price_monthly : acc;
  }, 0);

  // Server health is summarised here so an operator sees a problem without
  // having to open the VPS page. Counted from the same deriveStatus() the list
  // view uses, so the two can never disagree.
  const { data: servers } = await svc.from("vps_servers").select("*").limit(200);
  const byStatus = (servers ?? []).reduce<Record<string, number>>((acc, s) => {
    acc[deriveStatus(s.enabled, s.last_heartbeat_at)] = (acc[deriveStatus(s.enabled, s.last_heartbeat_at)] ?? 0) + 1;
    return acc;
  }, {});

  return (
    <>
      <h1 className="text-2xl font-black tracking-tight sm:text-3xl">Platform overview</h1>
      <p className="mt-1 text-sm text-slate-400">
        Every ISP on the platform, with its subscription state.
      </p>

      <section className="mt-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
          <Card k="ISPs" v={num(isps.data?.length ?? 0)} sub="registered" />
          <Card k="Active subscriptions" v={num(rev)} sub="paying" />
          <Card k="MRR" v={kes(mrr)} sub="from active plans" />
          <Card k="Customers" v={num(customers.count ?? 0)} sub="across all ISPs" />
          <Card k="Routers" v={num(routers.count ?? 0)} sub="provisioned" />
      </section>

      <Panel title="VPS infrastructure">
        <div className="flex flex-wrap items-center gap-2">
          {(["online", "delayed", "offline", "unknown", "disabled"] as const).map((s) => (
            <span key={s} className={`rounded-full px-2.5 py-1 text-xs font-semibold ${
              s === "online" ? "bg-emerald-500/15 text-emerald-300"
              : s === "delayed" ? "bg-amber-500/15 text-amber-300"
              : s === "offline" ? "bg-rose-500/15 text-rose-300"
              : "bg-white/10 text-slate-400"}`}>
              {byStatus[s] ?? 0} {s}
            </span>
          ))}
          <Link href="/admin/servers" className="ml-auto text-xs font-semibold text-rose-300 hover:underline">
            Manage servers →
          </Link>
        </div>
        <p className="mt-3 text-xs text-slate-500">
          Status is derived from the worker heartbeat, not from a ping: a host that stops
          reporting for two minutes reads as DELAYED, and only after five as OFFLINE.
        </p>
      </Panel>

        <Panel title="Infrastructure">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {INFRA.map((c) => {
              const h = latest.get(c);
              return (
                <div key={c} className={`rounded-xl border p-3 ${HEALTH_TONE(h)}`}>
                  <div className="flex items-center justify-between gap-2">
                    <p className="font-mono text-xs font-semibold uppercase">{c}</p>
                    {h?.latency_ms != null && <p className="text-xs">{h.latency_ms}ms</p>}
                  </div>
                  <p className="mt-1 text-xs">{h ? h.status : "not reporting"}</p>
                  <p className="mt-0.5 text-[11px] opacity-70">{h ? ago(h.checked_at) : "—"}</p>
                </div>
              );
            })}
          </div>
          <p className="mt-4 text-xs text-slate-500">
            {tickets.count ?? 0} open support ticket{(tickets.count ?? 0) === 1 ? "" : "s"} across all ISPs.
            Statuses come from the last write by the network worker; a component that has never reported
            stays blank rather than being assumed healthy.
          </p>
        </Panel>

        <Panel title="ISPs">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[820px] text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-slate-500">
                  <th className="pb-2">ISP</th><th>Slug</th><th>Contact</th>
                  <th>Status</th><th>Subscription</th><th>Trial ends</th><th>Joined</th>
                </tr>
              </thead>
              <tbody>
                {!isps.data?.length
                  ? <tr><td colSpan={7} className="py-8 text-center text-slate-500">No ISPs registered yet.</td></tr>
                  : isps.data.map((i) => (
                    <tr key={i.id} className="border-t border-white/5">
                      <td className="py-2.5 font-semibold">{i.name}</td>
                      <td className="font-mono text-xs text-slate-400">{i.slug}</td>
                      <td className="text-xs text-slate-400">
                        {i.phone ?? "—"}<br />{i.email ?? ""}
                      </td>
                      <td>
                        <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
                          i.status === "active" ? "bg-emerald-500/15 text-emerald-300" : "bg-white/10 text-slate-300"}`}>
                          {i.status}
                        </span>
                      </td>
                      <td className="text-xs">{i.subscription_status}</td>
                      <td className="text-xs text-slate-400">
                        {i.trial_ends_at ? new Date(i.trial_ends_at).toLocaleDateString("en-KE") : "—"}
                      </td>
                      <td className="text-xs text-slate-400">
                        {new Date(i.created_at).toLocaleDateString("en-KE")}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </Panel>

        <Panel title="Plans">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[520px] text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-slate-500">
                  <th className="pb-2">Plan</th><th>Slug</th><th>Monthly</th><th>State</th>
                </tr>
              </thead>
              <tbody>
                {(plans.data ?? []).map((p) => (
                  <tr key={p.id} className="border-t border-white/5">
                    <td className="py-2.5 font-semibold">{p.name}</td>
                    <td className="font-mono text-xs text-slate-400">{p.slug}</td>
                    <td>{kes(p.price_monthly)}</td>
                    <td>
                      <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
                        p.is_active ? "bg-emerald-500/15 text-emerald-300" : "bg-white/10 text-slate-500"}`}>
                        {p.is_active ? "active" : "retired"}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>

        <p className="mt-6 text-xs text-slate-500">
          Need the ISP-level view?{" "}
          <Link href="/dashboard" className="text-slate-400 underline hover:text-slate-200">
            Open the operator dashboard
          </Link>
        </p>
    </>
  );
}
