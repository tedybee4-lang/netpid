"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";

export default function NewRouterPage() {
  const router = useRouter();
  const [form, setForm] = useState({
    name: "", host: "", api_username: "netpid", api_password: "",
    api_port: 8728, api_ssl_port: 8729, use_ssl: true, nas_shortname: "",
  });
  const [result, setResult] = useState<{ secret_once?: string; setup_preview?: string[] } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const set = (k: string, v: string | number | boolean) => setForm((f) => ({ ...f, [k]: v }));

  async function submit(e: React.FormEvent) {
    e.preventDefault(); setErr(null); setLoading(true);
    try {
      const res = await fetch("/api/routers", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(form),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? "Failed");
      setResult(j);
      setTimeout(() => router.push("/dashboard/network"), 4000);
    } catch (e: unknown) { setErr(e instanceof Error ? e.message : "Failed."); }
    finally { setLoading(false); }
  }

  return (
    <main className="mx-auto max-w-2xl px-4 py-8">
      <h1 className="text-2xl font-black">Add MikroTik router</h1>
      <form onSubmit={submit} className="card mt-4 space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <div><label className="label">Name</label>
          <input className="input" required value={form.name} onChange={(e) => set("name", e.target.value)} placeholder="Nairobi Core 1" /></div>
          <div><label className="label">Management IP</label>
          <input className="input" required value={form.host} onChange={(e) => set("host", e.target.value)} placeholder="196.201.214.10" /></div>
          <div><label className="label">API username</label>
          <input className="input" value={form.api_username} onChange={(e) => set("api_username", e.target.value)} /></div>
          <div><label className="label">API password (stored encrypted)</label>
          <input className="input" type="password" required value={form.api_password} onChange={(e) => set("api_password", e.target.value)} /></div>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={form.use_ssl} onChange={(e) => set("use_ssl", e.target.checked)} /> Use API-SSL (port 8729, recommended)
        </label>
        {err && <p className="rounded-xl bg-red-50 p-3 text-sm text-red-700">{err}</p>}
        <button className="btn-primary w-full" disabled={loading}>{loading ? "Adding…" : "Add router + auto-provision NAS"}</button>
      </form>
      {result?.secret_once && (
        <div className="card mt-4 border-amber-300 bg-amber-50">
          <p className="font-semibold">RADIUS secret (once — copy now):</p>
          <code className="mt-1 block break-all rounded bg-white p-2 text-sm">{result.secret_once}</code>
          {(result.setup_preview ?? []).map((line) => (
            <code key={line} className="mt-1 block rounded bg-slate-900 p-2 text-xs text-green-300">{line}</code>))}
          <p className="mt-2 text-xs">Preview only — verify in the setup assistant before applying. Health check queued.</p>
        </div>
      )}
    </main>
  );
}
