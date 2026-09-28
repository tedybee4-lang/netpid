"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

export default function NewCustomerPage() {
  const router = useRouter();
  const [packages, setPackages] = useState<{ id: string; name: string }[]>([]);
  const [form, setForm] = useState({
    full_name: "", phone: "", email: "", address: "",
    service_type: "pppoe", package_id: "", username: "", notes: "",
  });
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    fetch("/api/packages").then((r) => r.json()).then((j) => setPackages(j.packages ?? []));
  }, []);
  const set = (k: string, v: string) => setForm((f) => ({ ...f, [k]: v }));

  async function submit(e: React.FormEvent) {
    e.preventDefault(); setErr(null); setLoading(true);
    try {
      const res = await fetch("/api/customers", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...form, package_id: form.package_id || null, username: form.username || null }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Failed to create customer");
      router.push(`/dashboard/customers/${json.customer.id}`);
    } catch (e: unknown) { setErr(e instanceof Error ? e.message : "Failed."); }
    finally { setLoading(false); }
  }

  return (
    <main className="mx-auto max-w-2xl px-4 py-8">
      <h1 className="text-2xl font-black">Add customer</h1>
      <form onSubmit={submit} className="card mt-4 space-y-3">
        <div><label className="label">Full name</label>
        <input className="input" required value={form.full_name} onChange={(e) => set("full_name", e.target.value)} /></div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div><label className="label">Phone (07… / 254…)</label>
          <input className="input" required value={form.phone} onChange={(e) => set("phone", e.target.value)} /></div>
          <div><label className="label">Email (optional)</label>
          <input className="input" type="email" value={form.email} onChange={(e) => set("email", e.target.value)} /></div>
          <div><label className="label">Service</label>
          <select className="input" value={form.service_type} onChange={(e) => set("service_type", e.target.value)}>
            <option value="pppoe">PPPoE</option><option value="hotspot">HotSpot</option>
            <option value="voucher">Voucher</option><option value="static">Static</option>
          </select></div>
          <div><label className="label">Login username (optional)</label>
          <input className="input" value={form.username} onChange={(e) => set("username", e.target.value)} placeholder="brian123" /></div>
        </div>
        <div><label className="label">Package (optional)</label>
        <select className="input" value={form.package_id} onChange={(e) => set("package_id", e.target.value)}>
          <option value="">No package yet</option>
          {packages.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select></div>
        <div><label className="label">Address / notes</label>
        <input className="input" value={form.address} onChange={(e) => set("address", e.target.value)} placeholder="Estate, house, landmark" /></div>
        {err && <p className="rounded-xl bg-red-50 p-3 text-sm text-red-700">{err}</p>}
        <button className="btn-primary w-full" disabled={loading}>{loading ? "Saving…" : "Add customer"}</button>
      </form>
    </main>
  );
}
