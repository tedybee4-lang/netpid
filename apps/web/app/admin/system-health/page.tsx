import { redirect } from "next/navigation";
import { createServiceClient } from "@/lib/supabase/server";
import { isAdmin } from "@/lib/admin-auth";
import { deriveStatus } from "@/lib/vps";

export const dynamic = "force-dynamic";

const INFRA = ["supabase", "database", "radius", "radius_db", "worker", "sms"] as const;

function ago(iso: string | null) {
  if (!iso) return "never";
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 90) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
const TONE: Record<string, string> = {
  online: "bg-emerald-500/15 text-emerald-300",
  delayed: "bg-amber-500/15 text-amber-300",
  offline: "bg-rose-500/15 text-rose-300",
  disabled: "bg-white/10 text-slate-400",
  unknown: "bg-white/10 text-slate-400",
};

const HEAD = "text-left text-xs uppercase tracking-wide text-slate-500";

// Super Admin → System Health. Platform components, then per-server detail.
export default async function SystemHealthPage() {
  if (!(await isAdmin())) redirect("/admin-login");
  const svc = createServiceClient();

  const [{ data: health }, { data: servers }, { data: events }] = await Promise.all([
    svc.from("system_health")
      .select("component,status,latency_ms,checked_at,detail")
      .in("component", [...INFRA, "admin_login"])
      .order("checked_at", { ascending: false }).limit(80),
    svc.from("vps_servers")
      .select("id,name,status,enabled,last_heartbeat_at,cpu_percent,mem_percent,disk_percent")
      .limit(200),
    svc.from("vps_health_events")
      .select("id,server_id,status,source,error,recorded_at,vps_servers(name)")
      .order("recorded_at", { ascending: false }).limit(40),
  ]);

  // Only the newest row per component — the worker writes one per poll, so the
  // raw list is mostly history.
  const latest = new Map<string, NonNullable<typeof health>[number]>();
  for (const h of health ?? []) if (!latest.has(h.component)) latest.set(h.component, h);

  return (
    <>
      <h1 className="text-2xl font-black tracking-tight sm:text-3xl">System Health</h1>
      <p className="mt-1 max-w-2xl text-sm text-slate-400">
        Platform components and per-server state. A component that has never reported is shown as
        such rather than assumed healthy.
      </p>

      <section className="mt-6 rounded-2xl border border-white/10 bg-slate-900 p-5">
        <h2 className="text-sm font-bold uppercase tracking-wide text-slate-400">Components</h2>
        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {INFRA.map((c) => {
            const h = latest.get(c);
            const tone = !h
              ? "border-white/10 bg-white/5 text-slate-500"
              : h.status === "online" ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
              : h.status === "degraded" ? "border-amber-500/30 bg-amber-500/10 text-amber-300"
              : "border-rose-500/30 bg-rose-500/10 text-rose-300";
            return (
              <div key={c} className={`rounded-xl border p-3 ${tone}`}>
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
      </section>

      <section className="mt-6 rounded-2xl border border-white/10 bg-slate-900 p-5">
        <h2 className="text-sm font-bold uppercase tracking-wide text-slate-400">Servers</h2>
        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[720px] text-sm">
            <thead>
              <tr className={HEAD}>
                <th className="pb-2">Server</th><th>Status</th><th>CPU</th><th>RAM</th>
                <th>Disk</th><th>Last heartbeat</th>
              </tr>
            </thead>
            <tbody>
              {!(servers ?? []).length
                ? <tr><td colSpan={6} className="py-6 text-center text-slate-500">No servers registered.</td></tr>
                : (servers ?? []).map((s) => {
                  const st = deriveStatus(s.enabled, s.last_heartbeat_at);
                  return (
                    <tr key={s.id} className="border-t border-white/5">
                      <td className="py-2.5 font-semibold">{s.name}</td>
                      <td>
                        <span className={`rounded-full px-2 py-0.5 text-xs font-semibold uppercase ${TONE[st]}`}>
                          {st}
                        </span>
                      </td>
                      <td className="font-mono text-xs">{s.cpu_percent == null ? "—" : `${s.cpu_percent}%`}</td>
                      <td className="font-mono text-xs">{s.mem_percent == null ? "—" : `${s.mem_percent}%`}</td>
                      <td className="font-mono text-xs">{s.disk_percent == null ? "—" : `${s.disk_percent}%`}</td>
                      <td className="text-xs text-slate-400">{ago(s.last_heartbeat_at)}</td>
                    </tr>
                  );
                })}
            </tbody>
          </table>
        </div>
      </section>

      <section className="mt-6 rounded-2xl border border-white/10 bg-slate-900 p-5">
        <h2 className="text-sm font-bold uppercase tracking-wide text-slate-400">Health events</h2>
        <p className="mt-1 text-xs text-slate-500">
          Transitions only. A steady server does not add rows.
        </p>
        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm">
            <thead>
              <tr className={HEAD}>
                <th className="pb-2">When</th><th>Server</th><th>Status</th><th>Source</th><th>Error</th>
              </tr>
            </thead>
            <tbody>
              {!(events ?? []).length
                ? <tr><td colSpan={5} className="py-6 text-center text-slate-500">No health events yet.</td></tr>
                : (events ?? []).map((e) => (
                  <tr key={e.id} className="border-t border-white/5">
                    <td className="py-2.5 text-xs text-slate-400">{ago(e.recorded_at)}</td>
                    <td className="font-semibold">
                      {(e.vps_servers as unknown as { name: string } | null)?.name ?? "—"}
                    </td>
                    <td className="uppercase text-xs">{e.status}</td>
                    <td className="text-xs text-slate-400">{e.source}</td>
                    <td className="max-w-72 truncate text-xs text-rose-400">{e.error ?? "—"}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}

 
