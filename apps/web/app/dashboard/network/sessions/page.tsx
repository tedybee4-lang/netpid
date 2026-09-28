import { createClient } from "@/lib/supabase/server";

function fmtDur(sec: number): string {
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60);
  return h ? `${h}h ${m}m` : `${m}m`;
}
function fmtGb(b: number): string { return `${(b / 1e9).toFixed(2)} GB`; }

export default async function SessionsPage() {
  const supabase = await createClient();
  const { data: memberships } = await supabase.from("isp_users").select("isp_id");
  const ispId = memberships?.[0]?.isp_id as string | undefined;
  const { data: sessions } = ispId
    ? await supabase.from("radius_sessions").select("*").eq("isp_id", ispId).order("last_update", { ascending: false }).limit(100)
    : { data: [] };
  const open = (sessions ?? []).filter((s) => s.is_open);

  return (
    <main className="mx-auto max-w-6xl px-4 py-8">
      <a className="text-sm text-indigo-600 hover:underline" href="/dashboard/network">← Network</a>
      <h1 className="mt-2 text-3xl font-black">Sessions ({open.length} online)</h1>
      {!sessions?.length ? (
        <div className="card mt-4"><p className="font-semibold">No data yet.</p>
        <p className="mt-1 text-sm text-slate-500">Sessions appear here from RADIUS accounting (Start / Interim-Update / Stop). Missing Stop packets are reconciled automatically.</p></div>
      ) : (
        <div className="card mt-4 overflow-x-auto p-0">
          <table className="w-full min-w-[820px] text-sm">
            <thead><tr className="text-left text-xs uppercase text-slate-500">
              <th className="px-4 py-3">User</th><th>IP</th><th>Duration</th><th>Up/Down</th><th>Last update</th><th>State</th>
            </tr></thead>
            <tbody>{sessions.map((s) => (
              <tr key={`${s.acct_session_id}-${s.acct_unique_id}`} className="border-t border-slate-100">
                <td className="px-4 py-2 font-semibold">{s.username}</td>
                <td className="px-4 py-2">{String(s.framed_ip ?? "—")}</td>
                <td className="px-4 py-2">{fmtDur(s.session_seconds ?? 0)}</td>
                <td className="px-4 py-2">{fmtGb((s.input_octets ?? 0) + (s.output_octets ?? 0))}</td>
                <td className="px-4 py-2">{s.last_update ? new Date(s.last_update).toLocaleString() : "—"}</td>
                <td className="px-4 py-2"><span className="badge bg-slate-100 text-slate-700">{s.is_open ? "online" : (s.terminate_cause ?? "stopped")}</span></td>
              </tr>))}</tbody>
          </table>
        </div>
      )}
    </main>
  );
}
