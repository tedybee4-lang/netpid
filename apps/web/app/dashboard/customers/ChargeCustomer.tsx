"use client";
import { useState } from "react";

export default function ChargeCustomer({ customerId, packages }: {
  customerId: string;
  packages: { id: string; name: string; price: number }[];
}) {
  const [packageId, setPackageId] = useState(packages[0]?.id ?? "");
  const [phone, setPhone] = useState("");
  const [receipt, setReceipt] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [mode, setMode] = useState<"stk" | "manual">("stk");

  async function charge(e: React.FormEvent) {
    e.preventDefault(); setMsg(null); setLoading(true);
    try {
      const pkg = packages.find((p) => p.id === packageId);
      if (mode === "stk") {
        const res = await fetch("/api/payments/stk", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({
            customer_id: customerId, package_id: packageId || null,
            amount: pkg?.price ?? 0, phone,
          }),
        });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error ?? "STK push failed");
        setMsg(json.message);
      } else {
        if (!receipt.trim()) throw new Error("Enter the M-Pesa receipt (e.g. QHX…7K).");
        const res = await fetch("/api/payments/manual", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({
            customer_id: customerId, package_id: packageId || null,
            amount: pkg?.price ?? 0, phone, mpesa_receipt: receipt.trim(),
          }),
        });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error ?? "Could not record payment");
        setMsg(`Manual payment recorded — service active until ${json.expiry ? new Date(json.expiry).toLocaleDateString() : "updated"}.`);
        setReceipt("");
      }
    } catch (e: unknown) { setMsg(e instanceof Error ? e.message : "Failed."); }
    finally { setLoading(false); }
  }

  if (!packages.length) return <p className="text-sm text-slate-500">Create a package first.</p>;
  return (
    <form onSubmit={charge} className="mt-3 space-y-2">
      <div className="flex gap-2 text-sm">
        <button type="button" onClick={() => setMode("stk")}
          className={mode === "stk" ? "btn-primary btn-sm" : "btn-ghost btn-sm"}>STK push</button>
        <button type="button" onClick={() => setMode("manual")}
          className={mode === "manual" ? "btn-primary btn-sm" : "btn-ghost btn-sm"}>Manual M-Pesa</button>
      </div>
      <div className="grid gap-2 sm:grid-cols-3">
        <select className="input" value={packageId} onChange={(e) => setPackageId(e.target.value)}>
          {packages.map((p) => <option key={p.id} value={p.id}>{p.name} — KSh {(p.price / 100).toLocaleString()}</option>)}
        </select>
        <input className="input" required placeholder="M-Pesa phone 07…" value={phone} onChange={(e) => setPhone(e.target.value)} />
        {mode === "stk" ? (
          <button className="btn-primary" disabled={loading}>{loading ? "Sending…" : "Send STK push"}</button>
        ) : (
          <input className="input" required placeholder="M-Pesa receipt e.g. QHX…7K" value={receipt} onChange={(e) => setReceipt(e.target.value.toUpperCase())} />
        )}
      </div>
      {mode === "manual" && (
        <button className="btn-primary" disabled={loading}>{loading ? "Recording…" : "Record manual payment & activate"}</button>
      )}
      {msg && <p className="text-sm text-slate-600">{msg}</p>}
      <p className="text-xs text-slate-500">
        {mode === "stk"
          ? "Direct Safaricom Daraja. Service activates only after Safaricom confirms payment (verified callback)."
          : "Customer already paid to your Till/PayBill. Recording the receipt activates service immediately."}
      </p>
    </form>
  );
}
