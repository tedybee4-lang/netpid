import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { kes } from "@/lib/isp";

export default async function DashboardPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  const { data: memberships } = await supabase
    .from("isp_users")
    .select("isp_id, isps(id,name,slug,status,subscription_status,onboarding_completed)");
  const first = memberships?.[0];
  const ispId = first?.isp_id as string | undefined;
  const ispName = (first?.isps as unknown as { name: string } | null)?.name ?? "";

  const [{ data: customers }, { data: payments }, { data: smsToday }, { data: onlineSessions }] = ispId ? await Promise.all([
    supabase.from("customers").select("id,status").eq("isp_id", ispId),
    supabase.from("payments").select("amount,status").eq("isp_id", ispId),
    supabase.from("sms_usage").select("sent,failed").eq("isp_id", ispId).eq("day", new Date().toISOString().slice(0, 10)).maybeSingle(),
    supabase.from("radius_sessions").select("username").eq("isp_id", ispId).eq("is_open", true),
  ]) : [{ data: [] }, { data: [] }, { data: null }, { data: [] }];

  const active = (customers ?? []).filter((c) => c.status === "active").length;
  const expired = (customers ?? []).filter((c) => c.status === "expired").length;
  const collected = (payments ?? []).filter((p) => p.status === "completed").reduce((a, p) => a + p.amount, 0);
  const pending = (payments ?? []).filter((p) => p.status === "pending").length;

  return (
    <main className="mx-auto max-w-6xl px-4 py-8">
      <h1 className="text-3xl font-black">ISP Dashboard</h1>
      {!first ? (
        <div className="card mt-5">
          <p className="font-semibold">No ISP yet.</p>
          <p className="mt-1 text-sm text-slate-500">Create your ISP to start managing customers, billing and network.</p>
          <a className="btn-primary mt-4 inline-flex" href="/onboarding">Set up your ISP</a>
        </div>
      ) : (
        <>
          <p className="mt-1 text-sm text-slate-500">{ispName} · Live data from your ISP only (RLS enforced).</p>
          <nav className="mt-4 flex flex-wrap gap-2 text-sm">
            {[["/dashboard/customers", "Customers"], ["/dashboard/packages", "Packages"],
              ["/dashboard/payments", "Payments"], ["/dashboard/sms", "SMS"],
              ["/dashboard/radius", "RADIUS"], ["/dashboard/network", "Network"],
              ["/dashboard/vouchers", "Vouchers"], ["/dashboard/inventory", "Inventory"],
              ["/dashboard/expenses", "Expenses"], ["/dashboard/resellers", "Resellers"],
              ["/dashboard/tr069", "TR-069"], ["/dashboard/topology", "Topology"],
              ["/dashboard/diagnostics", "Diagnostics"],
              ["/dashboard/reports", "Reports"], ["/dashboard/settings", "Settings"]].map(([href, label]) => (
              <a key={href} className="btn-ghost" href={href}>{label}</a>))}
          </nav>
          <div className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {[
              ["Revenue collected", kes(collected)],
              ["Customers", `${active} active · ${(customers ?? []).length} total`],
              ["Expired / pending payments", `${expired} expired · ${pending} pending`],
              ["Online now", `${(onlineSessions ?? []).length} sessions (RADIUS)`],
              ["SMS today", smsToday ? `${smsToday.sent} sent · ${smsToday.failed} failed` : "No data yet."],
            ].map(([k, v]) => (
              <div key={k} className="card"><p className="text-xs font-bold uppercase text-slate-500">{k}</p>
              <p className="mt-1 text-lg font-extrabold">{v}</p></div>
            ))}
          </div>
          <div className="card mt-4">
            <p className="font-semibold">Network</p>
            <p className="mt-1 text-sm text-slate-500">Routers report real health from the worker. Online sessions come only from RADIUS accounting — never inferred from customer status.</p>
          </div>
        </>
      )}
    </main>
  );
}

