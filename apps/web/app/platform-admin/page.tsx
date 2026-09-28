import { redirect } from "next/navigation";
import { createClient, createServiceClient } from "@/lib/supabase/server";

// Guarded: only platform_admins may view. Enforced server-side via RLS + explicit check.
export default async function PlatformAdminPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  const svc = createServiceClient();
  const { data: admin } = await svc.from("platform_admins")
    .select("id, role").eq("user_id", user.id).eq("is_active", true).maybeSingle();
  if (!admin) redirect("/dashboard");

  const [{ count: ispCount }, { count: subCount }] = await Promise.all([
    svc.from("isps").select("id", { count: "exact", head: true }),
    svc.from("netpid_subscriptions").select("id", { count: "exact", head: true }),
  ]);
  const { data: isps } = await svc.from("isps")
    .select("id,name,slug,status,subscription_status,trial_ends_at,created_at")
    .order("created_at", { ascending: false }).limit(20);

  return (
    <main className="mx-auto max-w-6xl px-4 py-8">
      <p className="badge bg-indigo-100 text-indigo-700">PLATFORM ADMIN · {admin.role}</p>
      <h1 className="mt-2 text-3xl font-black">NETPID Platform</h1>
      <div className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {[["Total ISPs", String(ispCount ?? 0)], ["Subscriptions", String(subCount ?? 0)],
          ["RADIUS infra", "Not connected."], ["Network worker", "Not connected."]].map(([k, v]) => (
          <div key={k} className="card"><p className="text-xs font-bold uppercase text-slate-500">{k}</p>
          <p className="mt-1 text-lg font-extrabold">{v}</p></div>
        ))}
      </div>
      <div className="card mt-4 overflow-x-auto">
        <p className="font-semibold">Latest ISPs</p>
        {!isps?.length ? <p className="mt-2 text-sm text-slate-500">No data yet.</p> : (
          <table className="mt-3 w-full min-w-[640px] text-sm">
            <thead><tr className="text-left text-xs uppercase text-slate-500">
              <th className="py-2">ISP</th><th>Slug</th><th>Status</th><th>Subscription</th><th>Trial ends</th>
            </tr></thead>
            <tbody>{isps.map((i) => (
              <tr key={i.id} className="border-t border-slate-100">
                <td className="py-2 font-semibold">{i.name}</td><td>{i.slug}</td>
                <td>{i.status}</td><td>{i.subscription_status}</td>
                <td>{i.trial_ends_at ? new Date(i.trial_ends_at).toLocaleDateString() : "—"}</td>
              </tr>))}</tbody>
          </table>
        )}
      </div>
      <p className="mt-3 text-xs text-slate-500">
        Full module set (plans, payments, RADIUS infra, SMS usage, support mode, audit logs, feature flags) lands with Phase 1 completion + Phase 3 worker wiring. Support-mode access is logged in support_sessions with a visible banner (to implement in ISP layout).
      </p>
    </main>
  );
}
