"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";

export default function NewPackagePage() {
  const router = useRouter();
  const [form, setForm] = useState({
    name: "", service_type: "pppoe", priceKsh: "200",
    duration_value: 30, duration_unit: "days",
    speedMbps: "15", dataCapGb: "", simultaneous_users: 1,
  });
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const set = (k: string, v: string | number) => setForm((f) => ({ ...f, [k]: v }));

  async function submit(e: React.FormEvent) {
    e.preventDefault(); setErr(null); setLoading(true);
    try {
      const mbps = Number(form.speedMbps) || 0;
      const res = await fetch("/api/packages", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: form.name, service_type: form.service_type,
          price: Math.round(Number(form.priceKsh) * 100),
          duration_value: Number(form.duration_value), duration_unit: form.duration_unit,
          download_kbps: mbps ? mbps * 1000 : null,
          upload_kbps: mbps ? mbps * 1000 : null,
          data_cap_mb: form.dataCapGb ? Math.round(Number(form.dataCapGb) * 1024) : null,
          simultaneous_users: Number(form.simultaneous_users), enabled: true,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Failed to create package");
      router.push("/dashboard/packages");
    } catch (e: unknown) { setErr(e instanceof Error ? e.message : "Failed."); }
    finally { setLoading(false); }
  }

  return (
    <main className="mx-auto max-w-2xl px-4 py-8">
      <h1 className="text-2xl font-black">New package</h1>
      <form onSubmit={submit} className="card mt-4 space-y-3">
        <div><label className="label">Name</label>
        <input className="input" value={form.name} onChange={(e) => set("name", e.target.value)} placeholder="Home 15 Mbps" required /></div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div><label className="label">Service</label>
          <select className="input" value={form.service_type} onChange={(e) => set("service_type", e.target.value)}>
            <option value="pppoe">PPPoE</option><option value="hotspot">HotSpot</option>
            <option value="voucher">Voucher</option><option value="static">Static</option>
          </select></div>
          <div><label className="label">Price (KSh)</label>
          <input className="input" inputMode="decimal" value={form.priceKsh} onChange={(e) => set("priceKsh", e.target.value)} required /></div>
          <div><label className="label">Duration</label>
          <input className="input" type="number" min={1} value={form.duration_value} onChange={(e) => set("duration_value", Number(e.target.value))} /></div>
          <div><label className="label">Unit</label>
          <select className="input" value={form.duration_unit} onChange={(e) => set("duration_unit", e.target.value)}>
            <option value="hours">hours</option><option value="days">days</option>
            <option value="weeks">weeks</option><option value="months">months</option>
          </select></div>
          <div><label className="label">Speed (Mbps, symmetric)</label>
          <input className="input" inputMode="decimal" value={form.speedMbps} onChange={(e) => set("speedMbps", e.target.value)} /></div>
          <div><label className="label">Data cap (GB, blank = uncapped)</label>
          <input className="input" inputMode="decimal" value={form.dataCapGb} onChange={(e) => set("dataCapGb", e.target.value)} /></div>
        </div>
        {err && <p className="rounded-xl bg-red-50 p-3 text-sm text-red-700">{err}</p>}
        <button className="btn-primary w-full" disabled={loading}>{loading ? "Saving…" : "Create package"}</button>
      </form>
    </main>
  );
}
