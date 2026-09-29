import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { ago, bytes, duration, statusTone } from "@/lib/format";

export default async function NetworkPage() {
  const supabase = await createClient();
  const { data: memberships } = await supabase.from("isp_users").select("isp_id").limit(1);
  const ispId = memberships?.[0]?.isp_id as string | undefined;
  const [{ data: routers }, { data: sessions }, { data: aps }] = ispId ? await Promise.all([
    supabase.from("routers").select("id,name,host,status,site,model,ros_version,last_seen_at,uptime_seconds,cpu_load,mem_used_pct,provisioned_via").eq("isp_id", ispId).order("name").limit(200),
    supabase.from("radius_sessions").select("username,framed_ip,input_octets,output_octets").eq("isp_id", ispId).eq("is_open", true).order("last_update", { ascending: false }).limit(50),
    supabase.from("access_points").select("id,name,ssid,status,clients").eq("isp_id", ispId).order("name").limit(200),
  ]) : [{ data: [] }, { data: [] }, { data: [] }];

  const online = (routers ?? []).filter((r) => r.status === "online").length;
  const live = sessions ?? [];

  return (
    <main className="mx-auto max-w-[1400px] px-4 py-6 sm:px-6 lg:px-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-black tracking-tight sm:text-3xl">Network</h1>
          <p className="mt-1 text-sm text-slate-500">
            {online}/{routers?.length ?? 0} routers online · {live.length} sessions live
          </p>
        </div>
        <Link href="/dashboard/network/routers/new" className="btn-primary">Add router</Link>
      </div>

      <section className="mt-6">
        <h2 className="panel-title mb-3">Routers</h2>
        {!routers?.length ? (
          <div className="card">
            <p className="font-semibold">Not connected</p>
            <p className="mt-1 text-sm text-slate-500">
              Add your first MikroTik router from the dashboard, or provision one from the
              command line — a RADIUS NAS client is created for you either way.
            </p>
            <Link href="/dashboard/network/routers/new" className="btn-primary mt-4">Add router</Link>
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {routers.map((r) => (
              <Link key={r.id} href={`/dashboard/network/routers/${r.id}`}
                className="stat transition hover:-translate-y-0.5">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate font-bold text-slate-900">{r.name}</p>
                    <p className="truncate text-xs text-slate-500">
                      {String(r.host)}{r.site ? ` · ${r.site}` : ""}{r.ros_version ? ` · ROS ${r.ros_version}` : ""}
                    </p>
                  </div>
                  <span className={`badge shrink-0 ${statusTone(r.status)}`}>{r.status}</span>
                </div>
                <dl className="mt-3 grid grid-cols-4 gap-2 text-center text-xs">
                  <div><dt className="text-slate-400">CPU</dt>
                    <dd className="font-bold tnum">{r.cpu_load != null ? `${r.cpu_load}%` : "—"}</dd></div>
                  <div><dt className="text-slate-400">MEM</dt>
                    <dd className="font-bold tnum">{r.mem_used_pct != null ? `${r.mem_used_pct}%` : "—"}</dd></div>
                  <div><dt className="text-slate-400">UPTIME</dt>
                    <dd className="font-bold tnum">{duration(r.uptime_seconds)}</dd></div>
                  <div><dt className="text-slate-400">ADDED</dt>
                    <dd className="font-bold">{r.provisioned_via === "script" ? "script" : "UI"}</dd></div>
                </dl>
                <p className="mt-2 truncate text-xs text-slate-400">
                  {r.model ? `${r.model} · ` : ""}seen {ago(r.last_seen_at)}
                </p>
              </Link>
            ))}
          </div>
        )}
      </section>

      <section className="mt-6 grid gap-4 lg:grid-cols-2">
        <div className="card-flush">
          <div className="flex items-center justify-between border-b border-slate-100 px-5 py-4">
            <h2 className="panel-title">Online now ({live.length})</h2>
            <Link href="/dashboard/network/sessions" className="text-sm font-semibold
              text-indigo-600 hover:underline">All sessions →</Link>
          </div>
          {!live.length ? (
            <p className="px-5 py-8 text-center text-sm text-slate-400">
              No live sessions. Online now comes only from RADIUS accounting.
            </p>
          ) : (
            <ul className="divide-y divide-slate-100">{live.slice(0, 8).map((s, i) => (
              <li key={i} className="flex items-center justify-between gap-3 px-5 py-2.5 text-sm">
                <span className="min-w-0">
                  <span className="font-semibold text-slate-900">{s.username}</span>
                  <span className="text-slate-500"> · {String(s.framed_ip ?? "—")}</span>
                </span>
                <span className="shrink-0 text-xs text-slate-500 tnum">
                  <span className="font-semibold text-cyan-700">{bytes(s.output_octets)} ↓</span>
                  {" · "}
                  <span className="font-semibold text-violet-700">{bytes(s.input_octets)} ↑</span>
                </span>
              </li>))}</ul>
          )}
        </div>

        <div className="card">
          <h2 className="panel-title">Access points ({aps?.length ?? 0})</h2>
          {!aps?.length ? (
            <p className="mt-2 py-4 text-center text-sm text-slate-400">
              No access points tracked yet.
            </p>
          ) : (
            <ul className="mt-2 divide-y divide-slate-100">{aps.slice(0, 8).map((a) => (
              <li key={a.id} className="flex items-center justify-between gap-3 py-2.5 text-sm">
                <span className="min-w-0">
                  <span className="font-semibold text-slate-900">{a.name}</span>
                  {a.ssid && <span className="text-slate-500"> · {a.ssid}</span>}
                </span>
                <span className={`badge shrink-0 ${statusTone(a.status)}`}>
                  {a.status} · {a.clients ?? 0}
                </span>
              </li>))}</ul>
          )}
        </div>
      </section>
    </main>
  );
}

