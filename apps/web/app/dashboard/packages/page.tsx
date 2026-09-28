import { createClient } from "@/lib/supabase/server";
import { kes } from "@/lib/isp";

async function getIsp() {
  const supabase = await createClient();
  const { data: memberships } = await supabase.from("isp_users").select("isp_id");
  return memberships?.[0]?.isp_id as string | undefined;
}

export default async function PackagesPage() {
  const ispId = await getIsp();
  const supabase = await createClient();
  const { data: packages } = ispId
    ? await supabase.from("packages").select("*").eq("isp_id", ispId).order("created_at", { ascending: false })
    : { data: [] };
  return (
    <main className="mx-auto max-w-6xl px-4 py-8">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-black">Packages</h1>
        <a className="btn-primary" href="/dashboard/packages/new">New package</a>
      </div>
      {!packages?.length ? (
        <div className="card mt-5"><p className="font-semibold">No data yet.</p>
        <p className="mt-1 text-sm text-slate-500">Create PPPoE, HotSpot, voucher or static packages with speeds, caps and timeouts. RADIUS attributes derive from these in Phase 3.</p></div>
      ) : (
        <div className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {packages.map((p) => (
            <div key={p.id} className="card">
              <div className="flex items-center justify-between">
                <p className="font-extrabold">{p.name}</p>
                <span className={`badge ${p.enabled ? "bg-indigo-100 text-indigo-700" : "bg-slate-100 text-slate-500"}`}>{p.service_type}</span>
              </div>
              <p className="mt-1 text-xl font-black">{kes(p.price)}</p>
              <p className="text-xs text-slate-500">per {p.duration_value} {p.duration_unit}</p>
              <p className="mt-2 text-sm text-slate-600">
                {[p.download_kbps ? `${Math.round(p.download_kbps / 1000)} Mbps` : null,
                  p.data_cap_mb ? `${(p.data_cap_mb / 1024).toFixed(1)} GB cap` : "uncapped",
                  p.simultaneous_users > 1 ? `${p.simultaneous_users} users` : null].filter(Boolean).join(" · ")}
              </p>
            </div>
          ))}
        </div>
      )}
    </main>
  );
}
