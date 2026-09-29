import { redirect } from "next/navigation";
import { createServiceClient } from "@/lib/supabase/server";
import { isAdmin } from "@/lib/admin-auth";

export const dynamic = "force-dynamic";

function ago(iso: string) {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 90) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

const OUTCOME: Record<string, string> = {
  ok: "bg-emerald-500/15 text-emerald-300",
  failed: "bg-rose-500/15 text-rose-300",
  denied: "bg-amber-500/15 text-amber-300",
};

// Super Admin → Audit Logs.
//
// Note what is NOT here: no credential, no key, no token. Callers write only
// field NAMES and coarse facts — a vps_updated row lists which fields changed,
// never their values.
export default async function AuditPage() {
  if (!(await isAdmin())) redirect("/admin-login");
  const { data } = await createServiceClient()
    .from("platform_audit_log")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(300);

  const rows = data ?? [];

  return (
    <>
      <h1 className="text-2xl font-black tracking-tight sm:text-3xl">Audit Logs</h1>
      <p className="mt-1 max-w-2xl text-sm text-slate-400">
        Every privileged action taken in this console. Secrets are never written here — a
        credential change is recorded as a fact and an expiry date, not as a value.
      </p>

      <div className="mt-6 overflow-x-auto rounded-2xl border border-white/10 bg-slate-900">
        {!rows.length ? (
          <p className="p-8 text-center text-sm text-slate-500">No audit events recorded yet.</p>
        ) : (
          <table className="w-full min-w-[860px] text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-slate-500">
                <th className="px-4 py-3">When</th><th>Action</th><th>Target</th>
                <th>Outcome</th><th>Actor</th><th>Detail</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-t border-white/5">
                  <td className="px-4 py-2.5 text-xs text-slate-400">{ago(r.created_at)}</td>
                  <td className="font-mono text-xs">{r.action}</td>
                  <td className="text-xs">
                    {r.target_label ?? "—"}
                    {r.target_id && (
                      <span className="ml-1 font-mono text-slate-500">{r.target_id.slice(0, 8)}</span>
                    )}
                  </td>
                  <td>
                    <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${OUTCOME[r.outcome] ?? OUTCOME.ok}`}>
                      {r.outcome}
                    </span>
                  </td>
                  <td className="text-xs text-slate-400">{r.actor_label ?? r.actor_user_id?.slice(0, 8) ?? "—"}</td>
                  <td className="max-w-72 truncate font-mono text-xs text-slate-500">
                    {Object.keys(r.detail ?? {}).length
                      ? JSON.stringify(r.detail)
                      : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <p className="mt-4 text-xs text-slate-500">Showing the most recent 300 events.</p>
    </>
  );
}
