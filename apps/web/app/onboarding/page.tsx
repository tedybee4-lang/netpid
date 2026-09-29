"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { DEFAULT_PLAN_SLUG, TIERS } from "@/lib/pricing";
import { kes } from "@/lib/format";

const steps = ["ISP profile", "Branding & contacts", "Plan", "Done"];

export default function OnboardingPage() {
  const router = useRouter();
  const [step, setStep] = useState(0);
  const [form, setForm] = useState({ name: "", slug: "", phone: "", email: "", location: "", planSlug: DEFAULT_PLAN_SLUG });
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  function set(k: string, v: string) { setForm((f) => ({ ...f, [k]: v })); }

  async function submit() {
    setErr(null); setLoading(true);
    try {
      const res = await fetch("/api/isp", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify(form),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Failed to create ISP");
      setStep(3);
      setTimeout(() => router.push("/dashboard"), 1200);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : "Failed. Please retry.");
    } finally { setLoading(false); }
  }

  return (
    <main className="mx-auto max-w-2xl px-4 py-10">
      <h1 className="text-3xl font-black">Set up your ISP</h1>
      <p className="mt-1 text-sm text-slate-500">Step {Math.min(step + 1, 4)} of 4 — {steps[step]}</p>
      <div className="mt-3 h-2 overflow-hidden rounded-full bg-slate-200">
        <div className="h-full bg-indigo-600 transition-all" style={{ width: `${((step + 1) / 4) * 100}%` }} />
      </div>
      <div className="card mt-5 space-y-3">
        {step === 0 && (<>
          <div><label className="label">ISP name</label>
          <input className="input" value={form.name} onChange={(e) => set(e.target.name, e.target.value)} name="name" placeholder="LipaNet Internet" /></div>
          <div><label className="label">Slug (portal subdomain)</label>
          <input className="input" value={form.slug} name="slug" onChange={(e) => set("slug", e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""))} placeholder="lipanet" /></div>
          <button className="btn-primary" onClick={() => setStep(1)}>Continue</button>
        </>)}
        {step === 1 && (<>
          <div className="grid gap-3 sm:grid-cols-2">
            <div><label className="label">Phone</label><input className="input" value={form.phone} onChange={(e) => set("phone", e.target.value)} placeholder="0712…" /></div>
            <div><label className="label">Email</label><input className="input" value={form.email} onChange={(e) => set("email", e.target.value)} placeholder="support@…" /></div>
          </div>
          <div><label className="label">Location</label><input className="input" value={form.location} onChange={(e) => set("location", e.target.value)} placeholder="Nairobi, Kenya" /></div>
          <div className="flex gap-2">
            <button className="btn-ghost" onClick={() => setStep(0)}>Back</button>
            <button className="btn-primary" onClick={() => setStep(2)}>Continue</button>
          </div>
        </>)}
        {step === 2 && (<>
          <label className="label">NETPID plan (KES)</label>
          <select className="input" value={form.planSlug} onChange={(e) => set("planSlug", e.target.value)}>
            {TIERS.map((t) => (
              <option key={t.slug} value={t.slug}>
                {t.name} — {t.custom ? "Custom" : `${kes(t.priceMonthly)}/mo`}
              </option>
            ))}
          </select>
          {err && <p className="rounded-xl bg-red-50 p-3 text-sm text-red-700">{err}</p>}
          <div className="flex gap-2">
            <button className="btn-ghost" onClick={() => setStep(1)}>Back</button>
            <button className="btn-primary" disabled={loading || !form.name || !form.slug} onClick={submit}>
              {loading ? "Creating…" : "Create ISP & start trial"}
            </button>
          </div>
        </>)}
        {step === 3 && (
          <div className="py-6 text-center">
            <p className="text-xl font-extrabold">ISP created. Trial started.</p>
            <p className="mt-1 text-sm text-slate-500">Redirecting to your dashboard…</p>
          </div>
        )}
      </div>
      <p className="mt-3 text-xs text-slate-500">Phases 2–4 continue setup: packages, PayHero, SMS, RADIUS, first router.</p>
    </main>
  );
}
