"use client";

import { useEffect, useState } from "react";

interface IspInfo {
  slug: string; name: string; logo_url: string | null;
  support_phone: string | null; support_whatsapp: string | null;
  phone: string | null; email: string | null; location: string | null;
}
interface PortalSettings {
  brand_color: string;
  portal_title: string | null;
  portal_terms: string | null;
  portal_privacy: string | null;
  payment_instructions: string | null;
  coverage_info: string | null;
}

const EMPTY: PortalSettings = {
  brand_color: "#4F46E5", portal_title: "", portal_terms: "",
  portal_privacy: "", payment_instructions: "", coverage_info: "",
};

/**
 * Ready-made starting points.
 *
 * Asking an operator to pick a hex code is how you get #808080 portals. These
 * are ordered so the first few are the ones that actually read well on a cheap
 * phone screen over a weak connection: high contrast, dark text on light
 * ground, nothing that relies on a gradient being visible.
 */
const PORTAL_THEMES: { name: string; color: string; note: string }[] = [
  { name: "Indigo", color: "#4F46E5", note: "NETPID default" },
  { name: "M-Pesa green", color: "#047857", note: "Matches Safaricom" },
  { name: "Ocean", color: "#0E7490", note: "Cool and calm" },
  { name: "Sunset", color: "#C2410C", note: "Warm, high contrast" },
  { name: "Plum", color: "#7E22CE", note: "Distinctive" },
  { name: "Graphite", color: "#1F2937", note: "Neutral, serious" },
  { name: "Forest", color: "#166534", note: "Deep green" },
  { name: "Royal", color: "#1D4ED8", note: "Trustworthy blue" },
];

export default function PageBuilderPage() {
  const [isp, setIsp] = useState<IspInfo | null>(null);
  const [form, setForm] = useState<PortalSettings>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    fetch("/api/settings")
      .then(async (r) => {
        const j = await r.json();
        if (!r.ok) throw new Error(j.error ?? "Failed to load");
        setIsp(j.isp);
        const s = j.settings as PortalSettings;
        setForm({
          brand_color: s.brand_color ?? "#4F46E5",
          portal_title: s.portal_title ?? "",
          portal_terms: s.portal_terms ?? "",
          portal_privacy: s.portal_privacy ?? "",
          payment_instructions: s.payment_instructions ?? "",
          coverage_info: s.coverage_info ?? "",
        });
      })
      .catch((e: unknown) => setErr(e instanceof Error ? e.message : "Failed to load"))
      .finally(() => setLoading(false));
  }, []);

  const set = (k: keyof PortalSettings, v: string) => {
    setForm((f) => ({ ...f, [k]: v }));
    setSaved(false);
  };

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setErr(null); setSaved(false); setSaving(true);
    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(form),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? "Save failed");
      setSaved(true);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return <main className="mx-auto max-w-4xl px-4 py-8 text-slate-400">Loading page builder…</main>;
  }

  // Live preview driven by the UNSAVED form state, so the operator sees the
  // result of a colour swap before committing it. A "Preview portal" link that
  // only ever shows the last saved state forces save-then-check, which is how a
  // portal gets left looking wrong for an hour.
  const previewBrand = /^#[0-9a-fA-F]{6}$/.test(form.brand_color) ? form.brand_color : "#4F46E5";
  const previewTitle = (form.portal_title ?? "").trim()
    || (isp ? `${isp.name} internet` : "Your ISP internet");

  return (
    <main className="mx-auto max-w-4xl px-4 py-6 sm:px-6 lg:px-8">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-black tracking-tight sm:text-3xl">Page builder</h1>
          <p className="mt-1 text-sm text-slate-500">
            Content on your public portal — {isp ? `/portal/${isp.slug}` : "portal"}.
            Packages you publish appear automatically.
          </p>
        </div>
        {isp && (
          <a className="btn-ghost" href={`/portal/${isp.slug}`} target="_blank" rel="noreferrer">
            Preview portal ↗
          </a>
        )}
      </header>

      {err && <p className="err-box mt-4">{err}</p>}
      {saved && <p className="ok-box mt-4">Saved. The public portal updates immediately.</p>}

      <div className="mt-4 grid items-start gap-4 lg:grid-cols-3">
      <form onSubmit={save} className="space-y-4 lg:col-span-2">
        <section className="card space-y-3">
          <h2 className="panel-title">Branding</h2>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="label" htmlFor="pb-color">Brand colour</label>
              <div className="flex gap-2">
                <input id="pb-color" type="color" className="h-10 w-14 cursor-pointer rounded-lg border border-slate-200"
                  value={form.brand_color} onChange={(e) => set("brand_color", e.target.value)} />
                <input className="input font-mono" pattern="^#[0-9A-Fa-f]{6}$"
                  value={form.brand_color} onChange={(e) => set("brand_color", e.target.value)}
                  aria-label="Brand colour hex" />
              </div>
            </div>
            <div>
              <label className="label" htmlFor="pb-title">Portal headline</label>
              <input id="pb-title" className="input" maxLength={160}
                placeholder="Fast, affordable internet. Pay with M-Pesa."
                value={form.portal_title ?? ""}
                onChange={(e) => set("portal_title", e.target.value)} />
            </div>
          </div>

          <div>
            <p className="label">Start from a theme</p>
            <div className="flex flex-wrap gap-2">
              {PORTAL_THEMES.map((t) => {
                const active = form.brand_color.toLowerCase() === t.color.toLowerCase();
                return (
                  <button
                    key={t.name}
                    type="button"
                    onClick={() => set("brand_color", t.color)}
                    title={t.note}
                    aria-pressed={active}
                    className={`flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-xs font-semibold transition ${
                      active
                        ? "border-slate-900 bg-slate-900 text-white"
                        : "border-slate-200 bg-white text-slate-700 hover:border-slate-400"
                    }`}
                  >
                    <span
                      aria-hidden="true"
                      className="h-4 w-4 rounded-full border border-black/10"
                      style={{ backgroundColor: t.color }}
                    />
                    {t.name}
                  </button>
                );
              })}
            </div>
            <p className="hint">Pick one to set the colour, then fine-tune it with the swatch above.</p>
          </div>
        </section>

        <section className="card space-y-3">
          <h2 className="panel-title">Customer information</h2>
          <div>
            <label className="label" htmlFor="pb-pay">Payment instructions</label>
            <textarea id="pb-pay" className="input min-h-[96px]" maxLength={4000}
              placeholder={"1. Dial M-Pesa Lipa Na M-Pesa, Paybill 123456.\n2. Use your account number (phone).\n3. Funds reflect instantly."}
              value={form.payment_instructions ?? ""}
              onChange={(e) => set("payment_instructions", e.target.value)} />
          </div>
          <div>
            <label className="label" htmlFor="pb-cov">Coverage information</label>
            <textarea id="pb-cov" className="input min-h-[96px]" maxLength={4000}
              placeholder="We cover Kasoa, Weija, Tuba and surrounding areas…"
              value={form.coverage_info ?? ""}
              onChange={(e) => set("coverage_info", e.target.value)} />
          </div>
        </section>

        <section className="card space-y-3">
          <h2 className="panel-title">Legal</h2>
          <div>
            <label className="label" htmlFor="pb-terms">Terms of service</label>
            <textarea id="pb-terms" className="input min-h-[96px]" maxLength={8000}
              placeholder="Fair-use policy, acceptable conduct, suspension rules…"
              value={form.portal_terms ?? ""}
              onChange={(e) => set("portal_terms", e.target.value)} />
          </div>
          <div>
            <label className="label" htmlFor="pb-priv">Privacy policy</label>
            <textarea id="pb-priv" className="input min-h-[96px]" maxLength={8000}
              placeholder="What data you collect from subscribers and why…"
              value={form.portal_privacy ?? ""}
              onChange={(e) => set("portal_privacy", e.target.value)} />
          </div>
        </section>

        <div className="flex gap-2">
          <button className="btn-primary" disabled={saving}>{saving ? "Saving…" : "Save page"}</button>
          {isp && <a className="btn-ghost" href={`/portal/${isp.slug}`} target="_blank" rel="noreferrer">Preview ↗</a>}
        </div>
      </form>

        {/* A phone-shaped mock of what the customer will actually see. Sized and
            proportioned like a handset on purpose: a desktop-width preview
            hides the exact problem that matters here, which is text and buttons
            being cramped on a small screen. */}
        <aside className="space-y-3 lg:sticky lg:top-6">
          <div className="card p-3">
            <p className="label">Live preview · not saved yet</p>
            <div className="mt-2 overflow-hidden rounded-2xl border border-slate-300">
              <div
                className="px-4 py-4 text-white"
                style={{ backgroundColor: previewBrand }}
              >
                <p className="text-[10px] font-bold uppercase tracking-widest opacity-80">
                  {isp?.name ?? "Your ISP"}
                </p>
                <p className="mt-0.5 text-sm font-black leading-tight">{previewTitle}</p>
              </div>
              <div className="space-y-2 bg-slate-50 p-3">
                <div className="rounded-lg border border-slate-200 bg-white p-2">
                  <p className="text-[10px] font-semibold text-slate-500">Hotspot 5 Mbps</p>
                  <p className="text-sm font-black tnum">KSh 1,200 <span className="text-[10px] font-medium text-slate-500">/ month</span></p>
                </div>
                <div className="rounded-lg border border-slate-200 bg-white p-2">
                  <p className="text-[10px] font-semibold text-slate-500">Hotspot 10 Mbps</p>
                  <p className="text-sm font-black tnum">KSh 2,000 <span className="text-[10px] font-medium text-slate-500">/ month</span></p>
                </div>
                <div
                  className="rounded-lg py-2 text-center text-xs font-black text-white"
                  style={{ backgroundColor: previewBrand }}
                >
                  Buy with M-Pesa
                </div>
                <p className="pt-1 text-center text-[10px] text-slate-500">
                  {isp ? "Pay to your M-Pesa Till/PayBill" : "Support: —"}
                </p>
              </div>
            </div>
            <p className="hint">
              Package names and prices shown are placeholders — they are rendered
              from the real published packages on your live portal.
            </p>
          </div>
          {isp && (
            <a className="btn-ghost w-full justify-center" href={`/portal/${isp.slug}`} target="_blank" rel="noreferrer">
              Open the real portal ↗
            </a>
          )}
        </aside>
      </div>
    </main>
  );
}
