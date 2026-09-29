import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { bytes, duration, statusTone } from "@/lib/format";

export default async function SessionsPage() {
  const supabase = await createClient();
  const { data: memberships } = await supabase.from("isp_users").select("isp_id").limit(1);
  const ispId = memberships?.[0]?.isp_id as string | undefined;
  const { data: sessions } = ispId
    ? await supabase.from("radius_sessions").select("*").eq("isp_id", ispId)
        .order("last_update", { ascending: false }).limit(100)
    : { data: [] };
  const open = (sessions ?? []).filter((s) => s.is_open);

  return (
    <main className="mx-auto max-w-[1400px] px-4 py-6 sm:px-6 lg:px-8">
      <Link href="/dashboard/network" className="text-sm font-semibold text-indigo-600 hover:underline">
        ← Network
      </Link>
      <div className="mt-2 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-black tracking-tight sm:text-3xl">
            Sessions <span className="text-indigo-600">({open.length} online)</span>
          </h1>
          <p className="mt-1 text-sm text-slate-500">
            From RADIUS accounting only — never inferred from customer status.
          </p>
        </div>
      </div>

      {!sessions?.length ? (
        <div className="card mt-6">
          <p className="font-semibold">No sessions yet</p>
          <p className="mt-1 text-sm text-slate-500">
            Sessions appear here from RADIUS accounting (Start / Interim-Update / Stop).
            Missing Stop packets are reconciled automatically by the worker.
          </p>
        </div>
      ) : (
        <div className="card-flush mt-6 overflow-x-auto">
          <table className="table min-w-[900px]">
            <thead><tr>
              <th>User</th><th>IP</th><th>Duration</th>
              {/* Upload and download stay separate — a combined "usage"
                  column hides which direction is saturating the link. */}
              <th className="text-right">Download</th>
              <th className="text-right">Upload</th>
              <th>Last update</th><th>State</th>
            </tr></thead>
            <tbody>{sessions.map((s) => (
              <tr key={`${s.acct_session_id}-${s.acct_unique_id}`}>
                <td className="font-semibold text-slate-900">{s.username}</td>
                <td>{String(s.framed_ip ?? "—")}</td>
                <td>{duration(s.session_seconds)}</td>
                <td className="text-right font-semibold tnum text-cyan-700">
                  {bytes(s.output_octets)}
                </td>
                <td className="text-right font-semibold tnum text-violet-700">
                  {bytes(s.input_octets)}
                </td>
                <td className="text-slate-500">
                  {s.last_update ? new Date(s.last_update).toLocaleString() : "—"}
                </td>
                <td>
                  <span className={`badge ${statusTone(s.is_open ? "online" : "offline")}`}>
                    {s.is_open ? "online" : (s.terminate_cause ?? "stopped")}
                  </span>
                </td>
              </tr>))}</tbody>
          </table>
        </div>
      )}
    </main>
  );
}
