import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { ago, statusTone } from "@/lib/format";

export default async function RadiusPage() {
  const supabase = await createClient();
  const { data: memberships } = await supabase.from("isp_users").select("isp_id").limit(1);
  const ispId = memberships?.[0]?.isp_id as string | undefined;
  const [{ data: servers }, { data: nas }, { data: users }] = ispId ? await Promise.all([
    supabase.from("radius_servers").select("id,name,host,status,last_check_at").or(`isp_id.eq.${ispId},isp_id.is.null`).limit(10),
    supabase.from("radius_nas").select("id,shortname,nasname,sync_status,enabled").eq("isp_id", ispId).order("shortname").limit(100),
    supabase.from("radius_users").select("id,username,enabled,sync_status").eq("isp_id", ispId).neq("sync_status", "synced").order("updated_at", { ascending: false }).limit(50),
  ]) : [{ data: [] }, { data: [] }, { data: [] }];

  return (
    <main className="mx-auto max-w-[1400px] px-4 py-6 sm:px-6 lg:px-8">
      <div>
        <h1 className="text-2xl font-black tracking-tight sm:text-3xl">RADIUS</h1>
        <p className="mt-1 text-sm text-slate-500">FreeRADIUS runs on your VPS — this page manages authorization data and health. Secrets are never shown.</p>
      </div>
      <section className="mt-6 grid gap-4 lg:grid-cols-2">
        <div className="card">
          <div className="flex items-center justify-between gap-2">
            <h2 className="panel-title">Servers ({servers?.length ?? 0})</h2>
            <Link className="btn-ghost btn-sm" href="/dashboard/radius/test">Test authentication</Link>
          </div>
          {!servers?.length ? <p className="mt-2 text-sm text-slate-500">Not connected. Add a row in radius_servers (platform support) pointing at your FreeRADIUS VPS.</p> : (
            <ul className="mt-2 divide-y divide-slate-100 text-sm">{servers.map((s) => (
              <li key={s.id} className="flex items-center justify-between gap-2 py-2">
                <span className="font-semibold">{s.name} · {s.host}</span>
                <span className="shrink-0 text-xs text-slate-500">checked {ago(s.last_check_at)}</span>
              </li>))}</ul>)}
        </div>
        <div className="card">
          <div className="flex items-center justify-between gap-2">
            <h2 className="panel-title">NAS clients ({nas?.length ?? 0})</h2>
            <Link className="btn-ghost btn-sm" href="/dashboard/radius/nas">Manage</Link>
          </div>
          {!nas?.length ? (
            <p className="mt-2 text-sm text-slate-500">
              No NAS yet. Add a router from the{" "}
              <Link href="/dashboard/network/routers/new" className="font-semibold text-indigo-600 hover:underline">UI</Link>{" "}
              or with the script — one is created for you either way.
            </p>
          ) : (
            <ul className="mt-2 divide-y divide-slate-100 text-sm">{nas.slice(0, 8).map((n) => (
              <li key={n.id} className="flex items-center justify-between gap-2 py-2">
                <span className="min-w-0"><span className="font-mono font-semibold">{n.shortname}</span>
                <span className="text-slate-500"> · {String(n.nasname)}</span></span>
                <span className={`badge shrink-0 ${statusTone(n.sync_status)}`}>{n.sync_status}</span>
              </li>))}</ul>)}
        </div>
      </section>
      <div className="card mt-4">
        <div className="flex items-center justify-between gap-2">
          <h2 className="panel-title">Logins waiting to sync ({users?.length ?? 0})</h2>
          <Link className="btn-ghost btn-sm" href="/dashboard/radius/users">Manage</Link>
        </div>
        <p className="mt-1 text-xs text-slate-500">Same username may exist in different ISPs — authorization is scoped by NAS → ISP. Disabled customers are removed from radcheck so authentication fails.</p>
        {!users?.length ? <p className="mt-2 text-sm text-slate-500">Everything is synced.</p> : (
          <ul className="mt-2 divide-y divide-slate-100 text-sm">{users.map((u) => (
            <li key={u.id} className="flex items-center justify-between gap-2 py-2">
              <span className="font-mono">{u.username}</span>
              <span className={`badge ${statusTone(u.sync_status)}`}>{u.sync_status}</span>
            </li>))}</ul>)}
      </div>
    </main>
  );
}
