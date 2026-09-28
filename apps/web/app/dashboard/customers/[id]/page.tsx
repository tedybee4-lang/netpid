import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { kes } from "@/lib/isp";
import ChargeCustomer from "./ChargeCustomer";

export default async function CustomerDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: customer } = await supabase.from("customers")
    .select("*, packages(id,name,price)").eq("id", id).maybeSingle();
  if (!customer) notFound();
  const { data: memberships } = await supabase.from("isp_users").select("isp_id");
  const ispId = memberships?.[0]?.isp_id as string | undefined;
  const { data: packages } = ispId
    ? await supabase.from("packages").select("id,name,price").eq("isp_id", ispId).eq("enabled", true)
    : { data: [] };
  const { data: payments } = await supabase.from("payments").select("*")
    .eq("customer_id", id).order("created_at", { ascending: false }).limit(20);
  const { data: receipts } = await supabase.from("receipts").select("*")
    .eq("isp_id", customer.isp_id).order("created_at", { ascending: false }).limit(20);

  return (
    <main className="mx-auto max-w-4xl px-4 py-8">
      <a className="text-sm text-indigo-600 hover:underline" href="/dashboard/customers">← Customers</a>
      <h1 className="mt-2 text-3xl font-black">{customer.full_name}</h1>
      <p className="text-sm text-slate-500">{customer.customer_no} · {customer.phone} · <span className="badge bg-slate-100 text-slate-700">{customer.status}</span></p>
      <div className="card mt-4">
        <p className="font-semibold">Charge / renew (M-Pesa STK)</p>
        <ChargeCustomer customerId={customer.id} packages={packages ?? []} />
      </div>
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <div className="card"><p className="font-semibold">Account</p>
          <dl className="mt-2 space-y-1 text-sm">
            <div className="flex justify-between"><dt className="text-slate-500">Package</dt><dd>{(customer.packages as unknown as { name: string } | null)?.name ?? "—"}</dd></div>
            <div className="flex justify-between"><dt className="text-slate-500">Expiry</dt><dd>{customer.expiry_date ? new Date(customer.expiry_date).toLocaleString() : "—"}</dd></div>
            <div className="flex justify-between"><dt className="text-slate-500">Balance</dt><dd>{kes(customer.balance)}</dd></div>
            <div className="flex justify-between"><dt className="text-slate-500">Login</dt><dd>{customer.username ?? "—"}</dd></div>
          </dl></div>
        <div className="card"><p className="font-semibold">Payments</p>
          {!payments?.length ? <p className="mt-2 text-sm text-slate-500">No data yet.</p> : (
            <ul className="mt-2 space-y-1 text-sm">{payments.map((p) => (
              <li key={p.id} className="flex justify-between"><span>{kes(p.amount)}</span><span className="badge bg-slate-100 text-slate-700">{p.status}</span></li>))}</ul>)}
        </div>
      </div>
      <div className="card mt-4"><p className="font-semibold">Receipts</p>
        {!receipts?.length ? <p className="mt-2 text-sm text-slate-500">No data yet.</p> : (
          <ul className="mt-2 space-y-1 text-sm">{receipts.map((r) => (
            <li key={r.id} className="flex justify-between"><span>{r.number}</span><span>{kes(r.amount)}</span></li>))}</ul>)}
      </div>
    </main>
  );
}
