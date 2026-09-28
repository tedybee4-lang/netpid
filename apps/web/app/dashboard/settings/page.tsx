import { createClient } from "@/lib/supabase/server";

export default async function SettingsPage() {
  const supabase = await createClient();
  const { data: memberships } = await supabase.from("isp_users").select("isp_id");
  const ispId = memberships?.[0]?.isp_id as string | undefined;
  const [{ data: provider }, { data: smsProvider }, { data: settings }] = ispId ? await Promise.all([
    supabase.from("payment_providers").select("provider,account_name,paybill,till_number,status").eq("isp_id", ispId).maybeSingle(),
    supabase.from("sms_providers").select("sender_id,status").eq("isp_id", ispId).maybeSingle(),
    supabase.from("sms_settings").select("daily_limit,monthly_limit,enabled").eq("isp_id", ispId).maybeSingle(),
  ]) : [{ data: null }, { data: null }, { data: null }];

  return (
    <main className="mx-auto max-w-4xl px-4 py-8">
      <h1 className="text-3xl font-black">Settings</h1>
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <div className="card"><p className="font-semibold">PayHero (M-Pesa)</p>
          {!provider ? <p className="mt-2 text-sm text-slate-500">Not connected. Add credentials server-side (encrypted), then set paybill/till here via support.</p> : (
            <dl className="mt-2 space-y-1 text-sm">
              <div className="flex justify-between"><dt className="text-slate-500">Paybill</dt><dd>{provider.paybill ?? "—"}</dd></div>
              <div className="flex justify-between"><dt className="text-slate-500">Till</dt><dd>{provider.till_number ?? "—"}</dd></div>
              <div className="flex justify-between"><dt className="text-slate-500">Status</dt><dd>{provider.status}</dd></div>
            </dl>)}
          <p className="mt-2 text-xs text-slate-500">Webhook: /api/payments/webhook · signature verified, idempotent.</p>
        </div>
        <div className="card"><p className="font-semibold">TOPSPEED SMS</p>
          {!smsProvider && !settings ? <p className="mt-2 text-sm text-slate-500">Not connected.</p> : (
            <dl className="mt-2 space-y-1 text-sm">
              <div className="flex justify-between"><dt className="text-slate-500">Sender</dt><dd>{smsProvider?.sender_id ?? "—"}</dd></div>
              <div className="flex justify-between"><dt className="text-slate-500">Limits</dt><dd>{settings ? `${settings.daily_limit}/day · ${settings.monthly_limit}/mo` : "—"}</dd></div>
            </dl>)}
          <a className="mt-3 inline-flex text-sm text-indigo-600 hover:underline" href="/dashboard/sms">Manage SMS →</a>
        </div>
      </div>
    </main>
  );
}
