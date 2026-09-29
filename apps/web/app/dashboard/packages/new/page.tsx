"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";

// MikroTik rate pairs are "<upload>/<download>" — upload FIRST. Showing the
// exact string that will reach the router is the difference between an ISP
// that trusts the speed field and one that files a support ticket.
function previewRate(uploadMbps: number, downloadMbps: number): string {
  const up = Math.round(uploadMbps * 1000);
  const down = Math.round(downloadMbps * 1000);
  if (up <= 0 && down <= 0) return "no cap (uncapped)";
  const rx = up > 0 ? up : down;
  const tx = down > 0 ? down : up;
  return `${rx}k/${tx}k`;
}

const PRESETS = [
  { name: "Home 5", down: 5, up: 1 },
  { name: "Home 10", down: 10, up: 2 },
  { name: "Home 20", down: 20, up: 5 },
  { name: "Business 50", down: 50, up: 25 },
  { name: "Uncapped", down: 0, up: 0 },
];

export default function NewPackagePage() {
  const router = useRouter();
  const [form, setForm] = useState({
    name: "", service_type: "pppoe", priceKsh: "200",
    duration_value: 30, duration_unit: "days",
    downloadMbps: "20", uploadMbps: "5", dataCapGb: "", simultaneous_users: 1,
  });
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const set = (k: string, v: string | number) => setForm((f) => ({ ...f, [k]: v }));

  const down = Number(form.downloadMbps) || 0;
  const up = Number(form.uploadMbps) || 0;
  const rate = useMemo(() => previewRate(up, down), [up, down]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    setLoading(true);
    try {
      const res = await fetch("/api/packages", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: form.name, service_type: form.service_type,
          price: Math.round(Number(form.priceKsh) * 100),
          duration_value: Number(form.duration_value), duration_unit: form.duration_unit,
          // Stored in kbps, separately, so the two directions are never lost.
          download_kbps: down > 0 ? Math.round(down * 1000) : null,
          upload_kbps: up > 0 ? Math.round(up * 1000) : null,
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
    <main className="mx-auto max-w-3xl px-4 py-8 sm:px-6">
      <a href="/dashboard/packages" className="text-sm font-semibold text-indigo-600 hover:underline">
        ← Packages
      </a>
      <h1 className="mt-2 text-2xl font-black tracking-tight">New package</h1>
      <p className="mt-1 text-sm text-slate-500">
        Download and upload are capped independently — asymmetric plans are normal on
        a shared uplink.
      </p>

      <form onSubmit={submit} className="card mt-6 space-y-5">
        <div>
          <label className="label" htmlFor="pkg-name">Name</label>
          <input id="pkg-name" className="input" value={form.name} required
            onChange={(e) => set("name", e.target.value)} placeholder="Home 20 Mbps" />
        </div>

        <fieldset className="rounded-2xl border border-slate-200 bg-slate-50/60 p-4">
          <legend className="px-2 text-xs font-bold uppercase tracking-wide text-slate-500">
            Speed cap
          </legend>
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className="label" htmlFor="pkg-down">
                <span className="text-cyan-700">Download</span> (Mbps)
              </label>
              <input id="pkg-down" className="input" inputMode="decimal" value={form.downloadMbps}
                onChange={(e) => set("downloadMbps", e.target.value)} placeholder="20" />
              <p className="hint">How fast the customer downloads. Use 0 for unlimited.</p>
            </div>
            <div>
              <label className="label" htmlFor="pkg-up">
                <span className="text-violet-700">Upload</span> (Mbps)
              </label>
              <input id="pkg-up" className="input" inputMode="decimal" value={form.uploadMbps}
                onChange={(e) => set("uploadMbps", e.target.value)} placeholder="5" />
              <p className="hint">How fast the customer uploads. Usually much lower.</p>
            </div>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <span className="text-xs font-semibold text-slate-500">Presets:</span>
            {PRESETS.map((p) => (
              <button key={p.name} type="button" className="btn-ghost btn-sm"
                onClick={() => setForm((f) => ({
                  ...f, downloadMbps: String(p.down), uploadMbps: String(p.up),
                }))}>
                {p.name}
              </button>
            ))}
            <button type="button" className="btn-ghost btn-sm"
              onClick={() => set("uploadMbps", form.downloadMbps)}>
              Match upload to download
            </button>
          </div>
          <div className="mt-4 rounded-xl border border-slate-200 bg-white p-3">
            <p className="text-xs font-semibold text-slate-500">
              Sent to the router as Mikrotik-Rate-Limit
            </p>
            <code className="mt-1 block text-sm font-bold text-slate-900">{rate}</code>
            <p className="hint">Format is upload/download. A blank side copies the other side.</p>
          </div>
        </fieldset>

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className="label" htmlFor="pkg-service">Service</label>
            <select id="pkg-service" className="input" value={form.service_type}
              onChange={(e) => set("service_type", e.target.value)}>
              <option value="pppoe">PPPoE</option><option value="hotspot">HotSpot</option>
              <option value="voucher">Voucher</option><option value="static">Static IP</option>
            </select>
          </div>
          <div>
            <label className="label" htmlFor="pkg-price">Price (KSh)</label>
            <input id="pkg-price" className="input" inputMode="decimal" value={form.priceKsh}
              onChange={(e) => set("priceKsh", e.target.value)} required />
          </div>
          <div>
            <label className="label" htmlFor="pkg-dur">Duration</label>
            <input id="pkg-dur" className="input" type="number" min={1} value={form.duration_value}
              onChange={(e) => set("duration_value", Number(e.target.value))} />
          </div>
          <div>
            <label className="label" htmlFor="pkg-unit">Unit</label>
            <select id="pkg-unit" className="input" value={form.duration_unit}
              onChange={(e) => set("duration_unit", e.target.value)}>
              <option value="hours">hours</option><option value="days">days</option>
              <option value="weeks">weeks</option><option value="months">months</option>
            </select>
          </div>
          <div>
            <label className="label" htmlFor="pkg-cap">Data cap (GB)</label>
            <input id="pkg-cap" className="input" inputMode="decimal" value={form.dataCapGb}
              onChange={(e) => set("dataCapGb", e.target.value)} placeholder="Blank = uncapped" />
          </div>
          <div>
            <label className="label" htmlFor="pkg-users">Simultaneous logins</label>
            <input id="pkg-users" className="input" type="number" min={1}
              value={form.simultaneous_users}
              onChange={(e) => set("simultaneous_users", Number(e.target.value))} />
          </div>
        </div>

        {err && <p className="err-box">{err}</p>}
        <div className="flex gap-2">
          <button className="btn-primary flex-1" disabled={loading || !form.name}>
            {loading ? "Saving…" : "Create package"}
          </button>
          <a href="/dashboard/packages" className="btn-ghost">Cancel</a>
        </div>
      </form>
    </main>
  );
}
