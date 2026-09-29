import { redirect } from "next/navigation";
import { createServiceClient } from "@/lib/supabase/server";
import { isAdmin } from "@/lib/admin-auth";
import { deriveStatus, DELAYED_AFTER_MS, OFFLINE_AFTER_MS } from "@/lib/vps";

export const dynamic = "force-dynamic";

function ago(iso: string | null) {
  if (!iso) return "never";
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 90) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
function uptime(sec: number | null) {
  if (sec == null) return "—";
  const d = Math.floor(sec / 86400);
  return d > 0 ? `${d}d ${Math.floor((sec % 86400) / 3600)}h` : `${Math.floor(sec / 3600)}h`;
}
const TONE: Record<string, string> = {
  online: "bg-emerald-500/15 text-emerald-300",
  delayed: "bg-amber-500/15 text-amber-300",
  offline: "bg-rose-500/15 text-rose-300",
  disabled: "bg-white/10 text-slate-400",
  unknown: "bg-white/10 text-slate-400",
};

function Tile({ k, v }: { k: string; v: string }) {
  return (
    <div className="rounded-xl border border-white/5 bg-white/5 p-3">
      <dt className="text-[11px] font-bold uppercase tracking-wide text-slate-500">{k}</dt>
      <dd className="mt-1 font-mono text-sm font-semibold text-slate-200">{v}</dd>
    </div>
  );
}

function Flag({ label, on }: { label: string; on: boolean | null | undefined }) {
  return (
    <span>
      {label}:{" "}
      <span className={on ? "text-emerald-400" : "text-rose-400"}>
        {on == null ? "unknown" : on ? "yes" : "no"}
      </span>
    </span>
  );
}

// Super Admin → Network Workers. One card per server, newest beat per server.
export default async function WorkersPage() {
  if (!(await isAdmin())) redirect("/admin-login");
  const svc = createServiceClient();

  const [{ data: servers }, { data: beats }] = await Promise.all([
    svc.from("vps_servers").select("*").order("name").limit(200),
    svc.from("worker_heartbeats")
      .select("*").order("reported_at", { ascending: false }).limit(200),
  ]);

  // The newest beat per server wins. Earlier beats only matter for the
  // collision count and the "beats kept" figure.
  const latest = new Map<string, NonNullable<typeof beats>[number]>();
  const countByServer = new Map<string, number>();
  for (const b of beats ?? []) {
    countByServer.set(b.server_id, (countByServer.get(b.server_id) ?? 0) + 1);
    if (!latest.has(b.server_id)) latest.set(b.server_id, b);
  }

  return (
    <>
      <h1 className="text-2xl font-black tracking-tight sm:text-3xl">Network Workers</h1>
      <p className="mt-1 max-w-2xl text-sm text-slate-400">
        One NETPID worker per server, reporting on a 45-second heartbeat. Two workers reporting
        for the same server is a fault, not a duplicate — they would fight over the same routers.
      </p>

      <div className="mt-6 space-y-4">
        {!(servers ?? []).length && (
          <p className="rounded-2xl border border-dashed border-white/10 p-8 text-center text-sm text-slate-500">
            No servers yet. Register one under VPS / Servers.
          </p>
        )}

        {(servers ?? []).map((s) => {
          const b = latest.get(s.id);
          const status = deriveStatus(s.enabled, s.last_heartbeat_at);
          // A second worker id inside the DELAYED window is a live collision.
          const colliding = (beats ?? []).filter(
            (x) => x.server_id === s.id
              && x.worker_id !== b?.worker_id
              && Date.now() - new Date(x.reported_at).getTime() < DELAYED_AFTER_MS,
          );
          return (
            <article key={s.id} className="rounded-2xl border border-white/10 bg-slate-900 p-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h2 className="text-lg font-bold">{s.name}</h2>
                  <p className="mt-0.5 font-mono text-xs text-slate-400">
                    {b?.worker_id ?? "no worker reporting"} · v{b?.worker_version ?? "?"}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {colliding.length > 0 && (
                    <span className="rounded-full bg-rose-500/15 px-2.5 py-0.5 text-xs font-semibold text-rose-300">
                      {colliding.length} competing worker{colliding.length === 1 ? "" : "s"}
                    </span>
                  )}
                  <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold uppercase ${TONE[status]}`}>
                    {status}
                  </span>
                </div>
              </div>

              <dl className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
                <Tile k="Last beat" v={b ? ago(b.reported_at) : "never"} />
                <Tile k="Reported" v={b?.status ?? "—"} />
                <Tile k="CPU" v={b?.cpu_percent == null ? "—" : `${b.cpu_percent}%`} />
                <Tile k="RAM" v={b?.mem_percent == null ? "—" : `${b.mem_percent}%`} />
                <Tile k="Uptime" v={uptime(b?.uptime_seconds ?? null)} />
                <Tile k="Jobs" v={b?.jobs_processed == null ? "—" : b.jobs_processed.toLocaleString("en-KE")} />
                <Tile k="Beats kept" v={(countByServer.get(s.id) ?? 0).toLocaleString("en-KE")} />
              </dl>

              <div className="mt-3 flex flex-wrap gap-4 text-xs text-slate-400">
                <Flag label="FreeRADIUS" on={b?.radius_running} />
                <Flag label="WireGuard" on={b?.wireguard_active} />
                <Flag label="Firewall" on={b?.firewall_active} />
              </div>
            </article>
          );
        })}
      </div>

      <p className="mt-6 text-xs text-slate-500">
        ONLINE within {DELAYED_AFTER_MS / 1000}s of the last beat, DELAYED within{" "}
        {OFFLINE_AFTER_MS / 1000}s, OFFLINE beyond that. Heartbeats carry resource metrics only —
        the endpoint accepts no credential field.
      </p>
    </>
  );
}

 
