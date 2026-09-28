"use client";
import { useState } from "react";

export default function ChargeCustomer({ customerId, packages }: {
  customerId: string;
  packages: { id: string; name: string; price: number }[];
}) {
  const [packageId, setPackageId] = useState(packages[0]?.id ?? "");
  const [phone, setPhone] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function charge(e: React.FormEvent) {
    e.preventDefault(); setMsg(null); setLoading(true);
    try {
      const pkg = packages.find((p) => p.id === packageId);
      const res = await fetch("/api/payments/initiate", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({
          customer_id: customerId, package_id: packageId || null,
          amount: pkg?.price ?? 0, phone,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "STK push failed");
      setMsg(json.message);
    } catch (e: unknown) { setMsg(e instanceof Error ? e.message : "Failed."); }
    finally { setLoading(false); }
  }

  if (!packages.length) return <p className="text-sm text-slate-500">Create a package first.</p>;
  return (
    <form onSubmit={charge} className="mt-3 space-y-2">
      <div className="grid gap-2 sm:grid-cols-3">
        <select className="input" value={packageId} onChange={(e) => setPackageId(e.target.value)}>
          {packages.map((p) => <option key={p.id} value={p.id}>{p.name} — KSh {(p.price / 100).toLocaleString()}</option>)}
        </select>
        <input className="input" required placeholder="M-Pesa phone 07…" value={phone} onChange={(e) => setPhone(e.target.value)} />
        <button className="btn-primary" disabled={loading}>{loading ? "Sending…" : "Send STK push"}</button>
      </div>
      {msg && <p className="text-sm text-slate-600">{msg}</p>}
      <p className="text-xs text-slate-500">Service activates only after PayHero confirms payment (verified webhook).</p>
    </form>
  );
}
