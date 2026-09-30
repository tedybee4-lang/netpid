import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { bytes, kes, mbps } from "@/lib/format";

// MikroTik pairs are upload/download — upload first. Identical rule to
// ratePair() in network-worker/src/routeros.mjs.
function ratePair(uploadKbps: number | null, downloadKbps: number | null): string {
  const up = Number(uploadKbps ?? 0);
  const down = Number(downloadKbps ?? 0);
  if (up <= 0 && down <= 0) return "uncapped";
  return `${up > 0 ? up : down}k/${down > 0 ? down : up}k`;
}

const SERVICE_TONE: Record<string, string> = {
  pppoe: "badge-info", hotspot: "badge-warn", voucher: "bg-violet-100 text-violet-700",
  static: "badge-mute",
};

export default async function PackagesPage() {
  const supabase = await createClient();
  const { data: memberships } = await supabase.from("isp_users").select("isp_id").limit(1);
  const ispId = memberships?.[0]?.isp_id as string | undefined;
  const { data: packages } = ispId
    ? await supabase.from("packages").select("*").eq("isp_id", ispId)
        .order("created_at", { ascending: false })
    : { data: [] };

  return (
    <main className="mx-auto max-w-[1400px] px-4 py-6 sm:px-6 lg:px-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-black tracking-tight sm:text-3xl">Packages &amp; speeds</h1>
          <p className="mt-1 text-sm text-slate-500">
            Download and upload are capped separately and pushed to every router as
            Mikrotik-Rate-Limit.
          </p>
        </div>
        <Link href="/dashboard/packages/new" className="btn-primary">New package</Link>
      </div>

      {!packages?.length ? (
        <div className="card mt-6">
          <p className="font-semibold">No packages yet</p>
          <p className="mt-1 text-sm text-slate-500">
            Create PPPoE, HotSpot, voucher or static packages. Each one becomes a RADIUS
            group, so changing a speed here immediately re-limits every customer on it.
          </p>
          <Link href="/dashboard/packages/new" className="btn-primary mt-4">Create your first package</Link>
        </div>
      ) : (
        <div className="mt-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {packages.map((p) => (
            <div key={p.id} className="card flex flex-col">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <Link href={`/dashboard/packages/${p.id}`}
                    className="truncate font-extrabold text-slate-900 hover:text-indigo-600 hover:underline">
                    {p.name}
                  </Link>
                  <p className="text-xs text-slate-500">
                    per {p.duration_value} {p.duration_unit}
                    {p.simultaneous_users > 1 ? ` · ${p.simultaneous_users} logins` : ""}
                  </p>
                </div>
                <span className={`badge ${SERVICE_TONE[p.service_type] ?? "badge-mute"}`}>
                  {p.service_type}
                </span>
              </div>

              <p className="mt-3 text-2xl font-black tracking-tight">{kes(p.price)}</p>

              {/* The two directions get their own row — never a single
                  "speed" line that hides which way the cap applies. */}
              <dl className="mt-4 grid grid-cols-2 gap-3">
                <div className="rounded-xl bg-cyan-50 px-3 py-2">
                  <dt className="text-[11px] font-bold uppercase tracking-wide text-cyan-700">
                    Download
                  </dt>
                  <dd className="text-lg font-black text-cyan-900 tnum">
                    {mbps(p.download_kbps)}
                  </dd>
                </div>
                <div className="rounded-xl bg-violet-50 px-3 py-2">
                  <dt className="text-[11px] font-bold uppercase tracking-wide text-violet-700">
                    Upload
                  </dt>
                  <dd className="text-lg font-black text-violet-900 tnum">
                    {mbps(p.upload_kbps)}
                  </dd>
                </div>
              </dl>

              <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-slate-500">
                <code className="rounded bg-slate-100 px-2 py-1 font-semibold text-slate-700">
                  {ratePair(p.upload_kbps, p.download_kbps)}
                </code>
                {p.data_cap_mb ? <span className="badge badge-mute">{bytes(p.data_cap_mb * 1024 * 1024)} cap</span> : null}
                {!p.enabled && <span className="badge badge-bad">disabled</span>}
              </div>

              <Link href={`/dashboard/packages/${p.id}`} className="btn-ghost btn-sm mt-4 self-start">
                Edit package
              </Link>
            </div>
          ))}
        </div>
      )}
    </main>
  );
}

