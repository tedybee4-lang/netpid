import { createClient } from "@/lib/supabase/server";

function gb(b: number): string {
  if (!b) return "—";
  return `${(b / 1e9).toFixed(2)} GB`;
}

export default async function NetworkPage() {
  const supabase = await createClient();
  const { data: memberships } = await supabase.from("isp_users").select("isp_id");
  const ispId = memberships?.[0]?.isp_id as string | undefined;
  const [{ data: routers }, { data: openSessions }, { data: aps }] = ispId ? await Promise.all([
    supabase.from("routers").select("id,name,host,status,ros_version,model,last_seen_at,uptime_seconds,cpu_load,mem_used_pct").eq("isp_id", ispId),
    supabase.from("radius_sessions").select("username,nas_ip,framed_ip,start_time,last_update,input_octets,output_octets").eq("isp_id", ispId).eq("is_open", true).order("last_update", { ascending: false }).limit(50),
    supabase.from("access_points").select("id,name,ssid,status,clients").eq("isp_id", ispId),
  ]) : [{ data: [] }, { data: [] }, { data: [] }];

  return (
    <main className="mx-auto max-w-6xl px-4 py-8">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-black">Network</h1>
        <a className="btn-primary" href="/dashboard/network/routers/new">Add router</a>
      </div>
      <section className="mt-4 grid gap-4 lg:grid-cols-2">
        <div className="card">
          <p className="font-semibold">Routers ({routers?.length ?? 0})</p>
          {!routers?.length ? <p className="mt-2 text-sm text-slate-500">Not connected. Add your first MikroTik router — a RADIUS NAS client is auto-provisioned.</p> : (
            <ul className="mt-2 space-y-2 text-sm">{routers.map((r) => (
              <li key={r.id} className="flex items-center justify-between gap-2">
                <span><a className="font-semibold text-indigo-700 hover:underline" href={`/dashboard/network/routers/${r.id}`}>{r.name}</a>
                <span className="text-slate-500"> · {String(r.host)}{r.ros_version ? ` · ROS ${r.ros_version}` : ""}</span></span>
                <span className="badge bg-slate-100 text-slate-700">{r.status}</span>
              </li>))}</ul>)}
        </div>
        <div className="card">
          <p className="font-semibold">Online now: {openSessions?.length ?? 0}</p>
          <p className="text-xs text-slate-500">From RADIUS accounting only — never inferred from customer status.</p>
          {!openSessions?.length ? <p className="mt-2 text-sm text-slate-500">No data yet.</p> : (
            <ul className="mt-2 space-y-1 text-sm">{openSessions.slice(0, 10).map((s, i) => (
              <li key={i} className="flex justify-between"><span>{s.username} · {String(s.framed_ip ?? s.nas_ip ?? "")}</span>
              <span>{gb((s.input_octets ?? 0) + (s.output_octets ?? 0))}</span></li>))}</ul>)}
          <a className="mt-3 inline-flex text-sm text-indigo-600 hover:underline" href="/dashboard/network/sessions">All sessions →</a>
        </div>
      </section>
      <div className="card mt-4">
        <p className="font-semibold">Access points ({aps?.length ?? 0})</p>
        {!aps?.length ? <p className="mt-1 text-sm text-slate-500">No data yet.</p> : (
          <ul className="mt-2 space-y-1 text-sm">{aps.map((a) => (
            <li key={a.id} className="flex justify-between"><span>{a.name}{a.ssid ? ` · ${a.ssid}` : ""}</span>
            <span className="badge bg-slate-100 text-slate-700">{a.status} · {a.clients} clients</span></li>))}</ul>)}
      </div>
    </main>
  );
}
