"use client";

import { useState } from "react";

export interface IspProfile {
  name: string;
  slug: string;
  phone: string | null;
  email: string | null;
  location: string | null;
  support_phone: string | null;
  support_whatsapp: string | null;
}

// ISP profile editor used by Settings. Writes go through PATCH /api/isp, which
// re-checks membership + admin role server-side; RLS backs it up.
export default function ProfileForm({ initial }: { initial: IspProfile }) {
  const [form, setForm] = useState<IspProfile>(initial);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const set = (k: keyof IspProfile, v: string) => {
    setForm((f) => ({ ...f, [k]: v }));
    setSaved(false);
  };

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setErr(null); setSaved(false); setSaving(true);
    try {
      const res = await fetch("/api/isp", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(form),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? "Save failed");
      setForm(j.isp);
      setSaved(true);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={save} className="card space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="panel-title">ISP profile</h2>
        {saved && <span className="badge badge-ok">Saved</span>}
      </div>
      {err && <p className="err-box">{err}</p>}
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className="label" htmlFor="isp-name">ISP name</label>
          <input id="isp-name" className="input" required value={form.name}
            onChange={(e) => set("name", e.target.value)} />
        </div>
        <div>
          <label className="label" htmlFor="isp-slug">Portal URL slug</label>
          <input id="isp-slug" className="input font-mono" required
            pattern="[a-z0-9-]+" value={form.slug}
            onChange={(e) => set("slug", e.target.value)} />
          <p className="hint">Your public portal is <code>/portal/{form.slug}</code>.</p>
        </div>
        <div>
          <label className="label" htmlFor="isp-phone">Phone</label>
          <input id="isp-phone" className="input" value={form.phone ?? ""}
            onChange={(e) => set("phone", e.target.value)} />
        </div>
        <div>
          <label className="label" htmlFor="isp-email">Email</label>
          <input id="isp-email" className="input" type="email" value={form.email ?? ""}
            onChange={(e) => set("email", e.target.value)} />
        </div>
        <div>
          <label className="label" htmlFor="isp-location">Location</label>
          <input id="isp-location" className="input" value={form.location ?? ""}
            placeholder="Kasoa, Nairobi" onChange={(e) => set("location", e.target.value)} />
        </div>
        <div>
          <label className="label" htmlFor="isp-support">Support phone</label>
          <input id="isp-support" className="input" value={form.support_phone ?? ""}
            onChange={(e) => set("support_phone", e.target.value)} />
        </div>
        <div>
          <label className="label" htmlFor="isp-wa">Support WhatsApp</label>
          <input id="isp-wa" className="input" value={form.support_whatsapp ?? ""}
            onChange={(e) => set("support_whatsapp", e.target.value)} />
        </div>
      </div>
      <button className="btn-primary" disabled={saving}>{saving ? "Saving…" : "Save profile"}</button>
    </form>
  );
}