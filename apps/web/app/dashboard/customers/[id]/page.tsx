import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { ago, kes, mbps, speedPair, statusTone } from "@/lib/format";
import ChargeCustomer from "../ChargeCustomer";
import SpeedOverrideForm from "../SpeedOverrideForm";

export default async function CustomerDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: customer } = await supabase.from("customers")
    .select("*, packages(id,name,price,download_kbps,upload_kbps)").eq("id", id).maybeSingle();
  if (!customer) notFound();
  const pkg = customer.packages as unknown as {
    name: string; download_kbps: number | null; upload_kbps: number | null;
  } | null;
  const { data: memberships } = await supabase.from("isp_users").select("isp_id").limit(1);
  const ispId = memberships?.[0]?.isp_id as string | undefined;
  const [{ data: packages }, { data: payments }] = await Promise.all([
    ispId
      ? supabase.from("packages").select("id,name,price").eq("isp_id", ispId).eq("enabled", true)
      : { data: [] },
    supabase.from("payments").select("id,amount,status")
      .eq("customer_id", id).order("created_at", { ascending: false }).limit(20),
  ]);

  return (
    <main className="mx-auto max-w-[1400px] px-4 py-6 sm:px-6 lg:px-8">
      <a className="text-sm font-semibold text-indigo-600 hover:underline" href="/dashboard/customers">← Customers</a>
      <div className="mt-2 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-black tracking-tight sm:text-3xl">{customer.full_name}</h1>
          <p className="mt-1 text-sm text-slate-500">
            {customer.customer_no} · {customer.phone} · last seen {ago(customer.last_seen_at)}
          </p>
        </div>
        <span className={`badge ${statusTone(customer.status)}`}>{customer.status}</span>
      </div>
      <div className="card mt-6">
        <p className="font-bold">Charge / renew (M-Pesa STK)</p>
        <ChargeCustomer customerId={customer.id} packages={packages ?? []} />
      </div>
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <div className="card"><p className="font-bold">Account</p>
          <dl className="mt-2 space-y-1.5 text-sm">
            <div className="flex justify-between"><dt className="text-slate-500">Package</dt><dd className="font-semibold">{pkg?.name ?? "—"}</dd></div>
            <div className="flex justify-between"><dt className="text-slate-500">Plan speed</dt><dd className="font-semibold tnum">{pkg ? speedPair(pkg.download_kbps, pkg.upload_kbps) : "—"}</dd></div>
            <div className="flex justify-between"><dt className="text-slate-500">Override</dt><dd className="font-semibold tnum">{speedPair(customer.download_kbps, customer.upload_kbps)}</dd></div>
            <div className="flex justify-between"><dt className="text-slate-500">Effective</dt><dd className="font-semibold text-indigo-700 tnum">{mbps(customer.download_kbps ?? pkg?.download_kbps)} ↓ · {mbps(customer.upload_kbps ?? pkg?.upload_kbps)} ↑</dd></div>
            <div className="flex justify-between"><dt className="text-slate-500">Expiry</dt><dd>{customer.expiry_date ? new Date(customer.expiry_date).toLocaleString() : "—"}</dd></div>
            <div className="flex justify-between"><dt className="text-slate-500">Balance</dt><dd className="tnum">{kes(customer.balance)}</dd></div>
            <div className="flex justify-between"><dt className="text-slate-500">Login</dt><dd className="font-mono">{customer.username ?? "—"}</dd></div>
          </dl>
          <div className="mt-3 border-t border-slate-100 pt-3">
            <p className="font-bold">Speed override</p>
            <SpeedOverrideForm customerId={customer.id}
              downloadKbps={customer.download_kbps} uploadKbps={customer.upload_kbps} />
          </div>
        </div>
        <div className="card"><p className="font-bold">Payments</p>
          {!payments?.length ? <p className="mt-2 text-sm text-slate-500">No data yet.</p> : (
            <ul className="mt-2 space-y-1 text-sm">{payments.map((p) => (
              <li key={p.id} className="flex justify-between"><span className="tnum">{kes(p.amount)}</span><span className={`badge ${statusTone(p.status)}`}>{p.status}</span></li>))}</ul>)}
        </div>
      </div>
    </main>
  );
}
