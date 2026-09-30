"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { parseIpPoolRanges, addressCount, overlapsAny } from "@/lib/ip-pools";

// IP pools. Every number shown is computed server-side per request from the
// ranges themselves and the tables that reference a pool by name, so capacity
// and usage cannot drift from reality. The client-side parse below is the same
// code the API runs — it exists to warn before the round trip, not to replace
// the server check.

type Pool = {
  id: string;
  name: string;
  ranges: string;
  created_at: string;
  addresses: number;
  entries: string[];
  parse_errors: string[];
  packages: number;
  accounts: number;
  in_use: boolean;
};

const EMPTY = { name: "", ranges: "" };

export default function IpPoolsPage() {
  const [pools, setPools] = useState<Pool[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState(EMPTY);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    const res = await fetch("/api/ip-pools");
    const j = await res.json().catch(() => ({}));
    setLoading(false);
    if (!res.ok) { setError(j.error ?? `Could not load IP pools (${res.status})`); return; }
    setPools(j.pools ?? []);
  }, []);

  useEffect(() => { load(); }, [load]);

  // Live preview of what will be saved, using the shared parser.
  const preview = parseIpPoolRanges(form.ranges);

  function startCreate() {
    setEditingId(null); setForm(EMPTY); setFormError(null); setNotice(null);
  }

  function startEdit(p: Pool) {
    setEditingId(p.id);
    setForm({ name: p.name, ranges: p.ranges });
    setFormError(null); setNotice(null);
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);
    if (!form.name.trim()) { setFormError("Name the pool."); return; }
    if (preview.errors.length) { setFormError(preview.errors[0]); return; }

    // Cheap client-side overlap warning. The API re-checks and is authoritative.
    const localHit = pools
      .filter((p) => p.id !== editingId)
      .map((p) => ({ name: p.name, ranges: parseIpPoolRanges(p.ranges).ranges }))
      .find((o) => overlapsAny(preview.ranges, o.ranges));
    if (localHit) { setFormError(`This range overlaps “${localHit.name}”.`); return; }

    setSaving(true);
    try {
      const res = await fetch(editingId ? `/api/ip-pools/${editingId}` : "/api/ip-pools", {
        method: editingId ? "PATCH" : "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(form),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setFormError(j.error ?? "Could not save"); return; }
      setNotice(editingId ? "Pool updated." : "Pool created.");
      setEditingId(null); setForm(EMPTY);
      load();
    } finally {
      setSaving(false);
    }
  }

  async function remove(p: Pool) {
    if (!confirm(`Delete pool “${p.name}”?`)) return;
    setNotice(null);
    const res = await fetch(`/api/ip-pools/${p.id}`, { method: "DELETE" });
    const j = await res.json().catch(() => ({}));
    setNotice(res.ok ? (j.message ?? "Deleted.") : (j.error ?? "Could not delete"));
    if (res.ok) { if (editingId === p.id) startCreate(); load(); }
  }

  return (
    <main className="mx-auto max-w-[1400px] px-4 py-6 sm:px-6 lg:px-8">
      <Link href="/dashboard/network" className="text-sm font-semibold text-indigo-600 hover:underline">
        ← Network
      </Link>
      <header className="mt-2 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-black tracking-tight sm:text-3xl">IP pools</h1>
          <p className="mt-1 text-sm text-slate-500">
            Address ranges packages and PPPoE accounts draw from. A pool is referenced by name, so
            renaming one that is in use is blocked until its users move.
          </p>
        </div>
        <button className="btn-primary" onClick={startCreate}>New pool</button>
      </header>

      {notice && <p className="mt-4 rounded-xl bg-slate-100 p-3 text-sm text-slate-700">{notice}</p>}

      {error && (
        <div className="mt-4 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800" role="alert">
          <p className="font-semibold">Could not load IP pools</p>
          <p className="mt-1">{error}</p>
          <button className="btn-ghost mt-2" onClick={() => { setLoading(true); load(); }}>Retry</button>
        </div>
      )}

      {/* Create / edit */}
      <form onSubmit={save} className="card mt-4">
        <h2 className="panel-title">{editingId ? "Edit pool" : "New pool"}</h2>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <div>
            <label className="label" htmlFor="pool-name">Name</label>
            <input
              id="pool-name"
              className="input"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="residential-dynamic"
              maxLength={64}
            />
            <p className="mt-1 text-xs text-slate-500">Referenced by packages and PPPoE accounts by this exact name.</p>
          </div>
          <div>
            <label className="label" htmlFor="pool-ranges">Ranges</label>
            <input
              id="pool-ranges"
              className="input font-mono"
              value={form.ranges}
              onChange={(e) => setForm({ ...form, ranges: e.target.value })}
              placeholder="10.10.0.10-10.10.0.254, 10.11.0.0/24"
              maxLength={4000}
            />
            <p className="mt-1 text-xs text-slate-500">
              One or more of <code className="font-mono">start-end</code>, <code className="font-mono">cidr</code> or a single address. Separate with commas.
            </p>
          </div>
        </div>

        {form.ranges.trim() !== "" && (
          <div className="mt-3 rounded-xl bg-slate-50 p-3 text-sm">
            {preview.errors.length ? (
              <ul className="list-inside list-disc text-amber-700">
                {preview.errors.map((e) => <li key={e}>{e}</li>)}
              </ul>
            ) : (
              <>
                <p className="font-semibold text-slate-800">
                  {addressCount(preview.ranges).toLocaleString()} addresses
                </p>
                <p className="mt-0.5 text-xs text-slate-500">{preview.ranges.map((r) => r.label).join("  ·  ")}</p>
              </>
            )}
          </div>
        )}

        {formError && (
          <p className="mt-3 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800" role="alert">
            {formError}
          </p>
        )}

        <div className="mt-3 flex flex-wrap gap-2">
          <button className="btn-primary" disabled={saving}>{saving ? "Saving…" : "Save pool"}</button>
          {editingId && <button type="button" className="btn-ghost" onClick={startCreate}>Cancel</button>}
        </div>
      </form>

      {/* List */}
      <section className="mt-6" aria-busy={loading}>
        <h2 className="panel-title">Pools ({pools.length})</h2>

        {loading ? (
          <div className="mt-3 space-y-2">
            <div className="h-16 animate-pulse rounded-xl bg-slate-100" />
            <div className="h-16 animate-pulse rounded-xl bg-slate-100" />
          </div>
        ) : !error && pools.length === 0 ? (
          <div className="card mt-3 text-sm text-slate-500">
            <p className="font-semibold text-slate-700">No IP pools yet.</p>
            <p className="mt-1">
              Add a range to start assigning addresses to packages and PPPoE accounts. Until then,
              nothing is framed from a pool.
            </p>
          </div>
        ) : !error && (
          <ul className="mt-3 space-y-3">
            {pools.map((p) => (
              <li key={p.id} className="card">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="flex flex-wrap items-center gap-2 font-bold text-slate-900">
                      <span className="break-all">{p.name}</span>
                      <span className={`badge ${p.in_use ? "badge-ok" : "bg-slate-200 text-slate-600"}`}>
                        {p.in_use ? "in use" : "unused"}
                      </span>
                    </p>
                    <p className="mt-1 break-all font-mono text-sm text-slate-600">{p.ranges}</p>
                    {p.parse_errors.length > 0 && (
                      <p className="mt-1 text-xs text-amber-700">
                        {p.parse_errors[0]} — capacity shown as 0 until this is corrected.
                      </p>
                    )}
                  </div>
                  <div className="flex shrink-0 gap-2">
                    <button className="btn-ghost" onClick={() => startEdit(p)}>Edit</button>
                    <button className="btn-ghost" onClick={() => remove(p)}>Delete</button>
                  </div>
                </div>

                <dl className="mt-3 grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
                  <div className="rounded-lg bg-slate-50 px-3 py-2">
                    <dt className="text-xs uppercase tracking-wide text-slate-500">Addresses</dt>
                    <dd className="font-bold">{p.addresses.toLocaleString()}</dd>
                  </div>
                  <div className="rounded-lg bg-slate-50 px-3 py-2">
                    <dt className="text-xs uppercase tracking-wide text-slate-500">Packages</dt>
                    <dd className="font-bold">{p.packages}</dd>
                  </div>
                  <div className="rounded-lg bg-slate-50 px-3 py-2">
                    <dt className="text-xs uppercase tracking-wide text-slate-500">PPPoE accounts</dt>
                    <dd className="font-bold">{p.accounts}</dd>
                  </div>
                  <div className="rounded-lg bg-slate-50 px-3 py-2">
                    <dt className="text-xs uppercase tracking-wide text-slate-500">Created</dt>
                    <dd className="font-bold">{new Date(p.created_at).toLocaleDateString()}</dd>
                  </div>
                </dl>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
