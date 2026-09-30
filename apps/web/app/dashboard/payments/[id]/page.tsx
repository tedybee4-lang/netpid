import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { dateOnly, kes, statusTone } from "@/lib/format";
import PendingClaimActions from "../PendingClaimActions";
import ReconcileStkButton from "../ReconcileStkButton";

// One transaction, plus the receipt and invoice written for it.
//
// Receipts and invoices have been written on every confirmed payment since the
// payments module existed, and were never displayed anywhere in the product.
// This page is where that paper trail finally surfaces.
export default async function PaymentDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: memberships } = await supabase.from("isp_users").select("isp_id").limit(1);
  const ispId = memberships?.[0]?.isp_id as string | undefined;
  if (!ispId) notFound();

  // The URL id is scoped to the caller's ISP — RLS plus this explicit filter, so
  // pasting another tenant's payment id returns 404 rather than their data.
  const { data: payment } = await supabase.from("payments")
    .select("*, customers(id,full_name,phone,customer_no), packages(name,duration_value,duration_unit)")
    .eq("id", id).eq("isp_id", ispId).maybeSingle();
  if (!payment) notFound();

  const customer = payment.customers as unknown as {
    id: string; full_name: string; phone: string; customer_no: string;
  } | null;
  const pkg = payment.packages as unknown as {
    name: string; duration_value: number; duration_unit: string;
  } | null;

  const [receiptRes, invoiceRes, reconRes] = await Promise.all([
    supabase.from("receipts").select("number,amount,currency,created_at")
      .eq("payment_id", id).maybeSingle(),
    supabase.from("invoices").select("number,amount,currency,status,paid_at,created_at")
      .eq("isp_id", ispId).eq("customer_id", payment.customer_id)
      .order("created_at", { ascending: false }).limit(1),
    supabase.from("payment_reconciliation")
      .select("status,expected_amount,received_amount,checked_at")
      .eq("payment_id", id).maybeSingle(),
  ]);
  const receipt = receiptRes.data;
  const invoice = invoiceRes.data?.[0] ?? null;
  const recon = reconRes.data;
  const isClaim = payment.status === "pending" && payment.provider === "manual";
  // A pending Daraja push with a CheckoutRequestID is the only case where an
  // operator can ask Safaricom what happened. Anything else is settled by the
  // callback, or confirmed by hand as a manual claim.
  const canReconcile = payment.status === "pending"
    && payment.provider === "daraja"
    && Boolean(payment.checkout_request_id);

  const rows: { label: string; value: React.ReactNode }[] = [
    { label: "Amount", value: <span className="font-black tnum">{kes(payment.amount)}</span> },
    { label: "Status", value: <span className={`badge ${statusTone(payment.status)}`}>{payment.status}</span> },
    { label: "Provider", value: <span className="badge badge-mute">{payment.provider}</span> },
    { label: "Reference", value: <span className="font-mono text-xs">{payment.reference ?? "—"}</span> },
    { label: "M-Pesa receipt", value: <span className="font-mono text-xs">{payment.mpesa_receipt ?? "—"}</span> },
    { label: "Checkout request ID", value: <span className="font-mono text-xs">{payment.checkout_request_id ?? "—"}</span> },
    { label: "Provider transaction id", value: <span className="font-mono text-xs">{payment.provider_tx_id ?? "—"}</span> },
    { label: "Phone", value: payment.phone },
    { label: "Created", value: dateOnly(payment.created_at) },
    { label: "Paid", value: payment.paid_at ? dateOnly(payment.paid_at) : "—" },
  ];

  return (
    <main className="mx-auto max-w-4xl px-4 py-6 sm:px-6 lg:px-8">
      <Link href="/dashboard/payments"
        className="text-sm font-semibold text-indigo-600 hover:underline">← Payments</Link>

      <header className="mt-2 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-black tracking-tight sm:text-3xl">
            {customer?.full_name ?? "Payment"}
          </h1>
          <p className="mt-1 text-sm text-slate-500">
            {customer ? `${customer.customer_no} · ${customer.phone}` : "Customer removed"}
            {pkg ? ` · ${pkg.name}` : ""}
          </p>
        </div>
        {customer && (
          <Link href={`/dashboard/customers/${customer.id}`} className="btn-ghost">
            Open customer
          </Link>
        )}
      </header>

      {isClaim && (
        <div className="card mt-4 border-amber-300 bg-amber-50">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="font-bold text-amber-900">Awaiting confirmation</p>
              <p className="mt-1 max-w-xl text-sm text-amber-800">
                The customer submitted this M-Pesa receipt from your captive portal. Confirming
                activates the account and issues the receipt and invoice.
              </p>
            </div>
            <PendingClaimActions paymentId={payment.id} />
          </div>
        </div>
      )}

      {canReconcile && (
        <div className="card mt-4 border-sky-300 bg-sky-50">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="font-bold text-sky-900">Waiting on Safaricom</p>
              <p className="mt-1 max-w-xl text-sm text-sky-800">
                This STK push was accepted but its callback has not arrived. You can ask
                Safaricom for the real status — it only reports what Safaricom itself
                recorded, so it cannot invent a payment.
              </p>
            </div>
            <ReconcileStkButton paymentId={payment.id} />
          </div>
        </div>
      )}

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <div className="card">
          <h2 className="panel-title">Transaction</h2>
          <dl className="mt-3 space-y-2 text-sm">
            {rows.map((r) => (
              <div key={r.label} className="flex items-center justify-between gap-3">
                <dt className="shrink-0 text-slate-500">{r.label}</dt>
                <dd className="min-w-0 text-right break-all">{r.value}</dd>
              </div>
            ))}
          </dl>
          {pkg && (
            <p className="mt-3 border-t border-slate-100 pt-3 text-xs text-slate-500">
              Package: <span className="font-semibold text-slate-700">{pkg.name}</span> ·{" "}
              {pkg.duration_value} {pkg.duration_unit}
            </p>
          )}
        </div>

        <div className="space-y-4">
          <div className="card">
            <h2 className="panel-title">Receipt</h2>
            {!receipt ? (
              <p className="mt-2 text-sm text-slate-500">
                {isClaim ? "Issued when you confirm this claim." : "No receipt for this payment yet."}
              </p>
            ) : (
              <dl className="mt-3 space-y-2 text-sm">
                <div className="flex justify-between gap-3">
                  <dt className="text-slate-500">Number</dt>
                  <dd className="font-mono text-xs">{receipt.number}</dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-slate-500">Amount</dt>
                  <dd className="font-semibold tnum">{kes(receipt.amount)}</dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-slate-500">Issued</dt>
                  <dd>{dateOnly(receipt.created_at)}</dd>
                </div>
              </dl>
            )}
          </div>

          <div className="card">
            <h2 className="panel-title">Invoice</h2>
            {!invoice ? (
              <p className="mt-2 text-sm text-slate-500">No invoice raised yet.</p>
            ) : (
              <dl className="mt-3 space-y-2 text-sm">
                <div className="flex justify-between gap-3">
                  <dt className="text-slate-500">Number</dt>
                  <dd className="font-mono text-xs">{invoice.number}</dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-slate-500">Amount</dt>
                  <dd className="font-semibold tnum">{kes(invoice.amount)}</dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-slate-500">Status</dt>
                  <dd>
                    <span className={`badge ${statusTone(invoice.status)}`}>{invoice.status}</span>
                  </dd>
                </div>
              </dl>
            )}
          </div>

          <div className="card">
            <h2 className="panel-title">Reconciliation</h2>
            {!recon ? (
              <p className="mt-2 text-sm text-slate-500">Nothing to reconcile.</p>
            ) : (
              <dl className="mt-3 space-y-2 text-sm">
                <div className="flex justify-between gap-3">
                  <dt className="text-slate-500">Status</dt>
                  <dd>
                    <span className={`badge ${statusTone(recon.status)}`}>{recon.status}</span>
                  </dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-slate-500">Expected</dt>
                  <dd className="tnum">{kes(recon.expected_amount)}</dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-slate-500">Received</dt>
                  <dd className="tnum">
                    {recon.received_amount == null ? "—" : kes(recon.received_amount)}
                  </dd>
                </div>
              </dl>
            )}
          </div>
        </div>
      </div>
    </main>
  );
}
