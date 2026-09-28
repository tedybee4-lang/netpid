import { createClient } from "@/lib/supabase/server";

export default async function RadiusPage() {
  const supabase = await createClient();
  const { data: memberships } = await supabase.from("isp_users").select("isp_id");
  const ispId = memberships?.[0]?.isp_id as string | undefined;
  const [{ data: servers }, { data: nas }, { data: users }] = ispId ? await Promise.all([
    supabase.from("radius_servers").select("id,name,host,status,last_check_at").or(`isp_id.eq.${ispId},isp_id.is.null`),
    supabase.from("radius_nas").select("id,shortname,nasname,sync_status,enabled").eq("isp_id", ispId),
    supabase.from("radius_users").select("id,username,enabled,sync_status").eq("isp_id", ispId).limit(100),
  ]) : [{ data: [] }, { data: [] }, { data: [] }];

  return (
    <main className="mx-auto max-w-6xl px-4 py-8">
      <h1 className="text-3xl font-black">RADIUS</h1>
      <p className="mt-1 text-sm text-slate-500">FreeRADIUS runs on your VPS — this page manages authorization data and health. Secrets are never shown.</p>
      <section className="mt-4 grid gap-4 lg:grid-cols-2">
        <div className="card">
          <div className="flex items-center justify-between">
            <p className="font-semibold">Servers</p><a className="btn-ghost" href="/dashboard/radius/test">Test authentication</a>
          </div>
          {!servers?.length ? <p className="mt-2 text-sm text-slate-500">Not connected. Add a row in radius_servers (platform support) pointing at your FreeRADIUS VPS.</p> : (
            <ul className="mt-2 space-y-1 text-sm">{servers.map((s) => (
              <li key={s.id} className="flex justify-between"><span>{s.name} · {s.host}</span>
              <span className="badge bg-slate-100 text-slate-700">{s.status}</span></li>))}</ul>)}
        </div>
        <div className="card">
          <div className="flex items-center justify-between">
            <p className="font-semibold">NAS clients ({nas?.length ?? 0})</p><a className="btn-ghost" href="/dashboard/radius/nas">Manage</a>
          </div>
          {!nas?.length ? <p className="mt-2 text-sm text-slate-500">No data yet. Register each MikroTik router as a NAS client — a unique secret is generated once.</p> : (
            <ul className="mt-2 space-y-1 text-sm">{nas.slice(0, 8).map((n) => (
              <li key={n.id} className="flex justify-between"><span>{n.shortname} · {String(n.nasname)}</span>
              <span className="badge bg-slate-100 text-slate-700">{n.sync_status}</span></li>))}</ul>)}
        </div>
      </section>
      <div className="card mt-4">
        <div className="flex items-center justify-between">
          <p className="font-semibold">RADIUS users ({users?.length ?? 0})</p><a className="btn-ghost" href="/dashboard/radius/users">Manage</a>
        </div>
        <p className="mt-1 text-xs text-slate-500">Same username may exist in different ISPs — authorization is scoped by NAS → ISP. Disabled customers are removed from radcheck so authentication fails.</p>
      </div>
    </main>
  );
}
