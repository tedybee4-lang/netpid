"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { PRESETS, previewRate } from "@/lib/rate-preview";

type Attribute = { id?: string; attribute: string; op: string; value: string };
type Group = { id: string; group_name: string; service_type: string } | null;

type Props = {
  pkg: {
    id: string; name: string; service_type: string; price: number;
    duration_value: number; duration_unit: string;
    download_kbps: number | null; upload_kbps: number | null;
    data_cap_mb: number | null; simultaneous_users: number; enabled: boolean;
  };
  group: Group;
  initialAttributes: Attribute[];
};

const OPS = ["=", ":=", "+=", "!=", "~="];

export default function PackageEditor({ pkg, group, initialAttributes }: Props) {
  const router = useRouter();
  const [form, setForm] = useState({
    name: pkg.name,
    service_type: pkg.service_type,
    priceKsh: String(pkg.price / 100),
    duration_value: pkg.duration_value,
    duration_unit: pkg.duration_unit,
    // Stored as kbps; edited as Mbps — same conversion the create screen uses.
    downloadMbps: pkg.download_kbps ? String(pkg.download_kbps / 1000) : "0",
    uploadMbps: pkg.upload_kbps ? String(pkg.upload_kbps / 1000) : "0",
    dataCapGb: pkg.data_cap_mb ? String(pkg.data_cap_mb / 1024) : "",
    simultaneous_users: pkg.simultaneous_users,
  });
  const [attrs, setAttrs] = useState<Attribute[]>(
    initialAttributes.map((a) => ({ id: a.id, attribute: a.attribute, op: a.op, value: a.value })),
  );
  // Only touch the attribute set when the operator actually edited it — a plain
  // price change must never rewrite RADIUS attributes behind their back.
  const [attrsDirty, setAttrsDirty] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const down = Number(form.downloadMbps) || 0;
  const up = Number(form.uploadMbps) || 0;
  const rate = useMemo(() => previewRate(up, down), [up, down]);
  const set = (k: string, v: string | number) => setForm((f) => ({ ...f, [k]: v }));

  const updAttr = (i: number, k: keyof Attribute, v: string) => {
    setAttrsDirty(true);
    setAttrs((list) => list.map((a, j) => (j === i ? { ...a, [k]: v } : a)));
  };
  const addAttr = () => { setAttrsDirty(true); setAttrs((l) => [...l, { attribute: "", op: "=", value: "" }]); };
  const delAttr = (i: number) => { setAttrsDirty(true); setAttrs((l) => l.filter((_, j) => j !== i)); };

  async function patch(body: Record<string, unknown>) {
    const res = await fetch(`/api/packages/${pkg.id}`, {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error ?? "Failed to save");
    return json;
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setErr(null); setOk(null); setLoading(true);
    try {
      const body: Record<string, unknown> = {
        name: form.name,
        service_type: form.service_type,
        price: Math.round(Number(form.priceKsh) * 100),
        duration_value: Number(form.duration_value),
        duration_unit: form.duration_unit,
        download_kbps: down > 0 ? Math.round(down * 1000) : null,
        upload_kbps: up > 0 ? Math.round(up * 1000) : null,
        data_cap_mb: form.dataCapGb ? Math.round(Number(form.dataCapGb) * 1024) : null,
        simultaneous_users: Number(form.simultaneous_users),
      };
      if (attrsDirty) {
        body.radius_attributes = attrs
          .map((a) => ({ attribute: a.attribute.trim(), op: a.op, value: a.value.trim() }))
          .filter((a) => a.attribute.length > 0 && a.value.length > 0);
      }
      await patch(body);
      setOk("Saved.");
      router.refresh();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : "Failed to save.");
    } finally { setLoading(false); }
  }

  async function toggleArchive() {
    setErr(null); setOk(null); setLoading(true);
    try {
      await patch({ enabled: !pkg.enabled });
      router.refresh();
    } catch (e: unknown) { setErr(e instanceof Error ? e.message : "Failed."); }
    finally { setLoading(false); }
  }

  async function remove() {
    if (!confirm(`Delete "${pkg.name}"? This cannot be undone. Use archive if anything uses it.`)) return;
    setErr(null); setOk(null); setLoading(true);
    try {
      const res = await fetch(`/api/packages/${pkg.id}`, { method: "DELETE" });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) { setErr(json.error ?? "Failed to delete."); return; }
      router.push("/dashboard/packages");
      router.refresh();
    } catch (e: unknown) { setErr(e instanceof Error ? e.message : "Failed to delete."); }
    finally { setLoading(false); }
  }

  return (
    <main className="mx-auto max-w-3xl px-4 py-8 sm:px-6">
      <a href="/dashboard/packages" className="text-sm font-semibold text-indigo-600 hover:underline">
        ← Packages
      </a>

      <div className="mt-2 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-black tracking-tight">{pkg.name}</h1>
          <p className="mt-1 text-sm text-slate-500">
            {pkg.service_type} · per {pkg.duration_value} {pkg.duration_unit}
          </p>
        </div>
        <span className={`badge ${pkg.enabled ? "badge-ok" : "badge-mute"}`}>
          {pkg.enabled ? "Active" : "Archived"}
        </span>
      </div>

      <form onSubmit={save} className="card mt-6 space-y-5">
        <div>
          <label className="label" htmlFor="pkg-name">Name</label>
          <input id="pkg-name" className="input" value={form.name} required
            onChange={(e) => set("name", e.target.value)} />
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
                onChange={(e) => set("downloadMbps", e.target.value)} />
            </div>
            <div>
              <label className="label" htmlFor="pkg-up">
                <span className="text-violet-700">Upload</span> (Mbps)
              </label>
              <input id="pkg-up" className="input" inputMode="decimal" value={form.uploadMbps}
                onChange={(e) => set("uploadMbps", e.target.value)} />
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

        <fieldset className="rounded-2xl border border-slate-200 bg-slate-50/60 p-4">
          <legend className="px-2 text-xs font-bold uppercase tracking-wide text-slate-500">
            RADIUS attributes
          </legend>
          {group ? (
            <>
              <p className="hint">
                Group <code className="font-semibold text-slate-700">{group.group_name}</code> is
                created with this package. Attributes derived from the speed and timeout fields
                above are re-applied by the worker whenever those fields change.
              </p>
              <div className="mt-3 space-y-2">
                {attrs.map((a, i) => (
                  <div key={i} className="grid gap-2 sm:grid-cols-[1.2fr_auto_1.4fr_auto]">
                    <input className="input" value={a.attribute} aria-label="Attribute name"
                      placeholder="Session-Timeout"
                      onChange={(e) => updAttr(i, "attribute", e.target.value)} />
                    <select className="input" value={a.op} aria-label="Operator"
                      onChange={(e) => updAttr(i, "op", e.target.value)}>
                      {OPS.map((o) => <option key={o} value={o}>{o}</option>)}
                    </select>
                    <input className="input" value={a.value} aria-label="Attribute value"
                      placeholder="86400" onChange={(e) => updAttr(i, "value", e.target.value)} />
                    <button type="button" className="btn-ghost btn-sm" onClick={() => delAttr(i)}>
                      Remove
                    </button>
                  </div>
                ))}
                {!attrs.length && <p className="hint">No custom attributes on this group yet.</p>}
              </div>
              <button type="button" className="btn-ghost btn-sm mt-3" onClick={addAttr}>
                + Add attribute
              </button>
            </>
          ) : (
            <p className="hint">
              This package has no RADIUS group, so there is nothing to configure here.
            </p>
          )}
        </fieldset>

        {err && <p className="err-box">{err}</p>}
        {ok && <p className="ok-box">{ok}</p>}

        <div className="flex flex-wrap gap-2">
          <button className="btn-primary" disabled={loading}>
            {loading ? "Saving…" : "Save changes"}
          </button>
          <a href="/dashboard/packages" className="btn-ghost">Cancel</a>
        </div>
      </form>

      <div className="card mt-4">
        <h2 className="panel-title">{pkg.enabled ? "Archive" : "Restore"}</h2>
        <p className="mt-2 text-sm text-slate-500">
          Archiving hides the package from new sign-ups while keeping every customer, receipt and
          RADIUS group attached to it. Nothing is deleted.
        </p>
        <button type="button" className="btn-ghost mt-3" disabled={loading} onClick={toggleArchive}>
          {pkg.enabled ? "Archive package" : "Restore package"}
        </button>
      </div>

      <div className="card mt-4 border-rose-200 bg-rose-50/60">
        <h2 className="panel-title text-rose-900">Delete</h2>
        <p className="mt-2 text-sm text-rose-800">
          Only a package nothing has ever used can be deleted. Anything with customers or payments
          must be archived instead, so financial history keeps a meaningful reference.
        </p>
        <button type="button" disabled={loading} onClick={remove}
          className="mt-3 rounded-xl bg-rose-600 px-4 py-2.5 text-sm font-bold text-white transition hover:bg-rose-700 disabled:opacity-50">
          Delete package
        </button>
      </div>
    </main>
  );
}

