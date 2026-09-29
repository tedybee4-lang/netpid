"use client";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import PageShell, { Empty } from "@/components/PageShell";

type Fav = { id: string; label: string; href: string; position: number };

// A curated set of the links an ISP actually reaches for, so the picker offers
// real destinations instead of a free-text field that can 404.
const SUGGESTED = [
  { label: "Add a router", href: "/dashboard/network/routers/new" },
  { label: "New customer", href: "/dashboard/customers/new" },
  { label: "Blocked customers", href: "/dashboard/customers?status=blocked" },
  { label: "Expiring this week", href: "/dashboard/activation" },
  { label: "Routers offline", href: "/dashboard/network" },
  { label: "Unredeemed vouchers", href: "/dashboard/vouchers" },
  { label: "Today's revenue", href: "/dashboard/payments" },
  { label: "Monthly report", href: "/dashboard/reports" },
];

export default function FavoritesPage() {
  const [favs, setFavs] = useState<Fav[]>([]);
  const [label, setLabel] = useState("");
  const [href, setHref] = useState(SUGGESTED[0].href);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const r = await fetch("/api/favorites");
    if (r.ok) setFavs((await r.json()).favorites ?? []);
  }, []);
  useEffect(() => { load(); }, [load]);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setMsg(null);
    const r = await fetch("/api/favorites", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ label, href }),
    });
    const j = await r.json().catch(() => ({}));
    setBusy(false);
    if (!r.ok) { setMsg(j.error ?? "Could not pin that"); return; }
    setLabel(""); load();
  }
  async function remove(id: string) {
    setBusy(true);
    await fetch(`/api/favorites?id=${id}`, { method: "DELETE" });
    setBusy(false); load();
  }

  return (
    <PageShell
      title="Favorites"
      description="Your pinned shortcuts. Each card links straight into the module and only ever shows this ISP's data."
    >
      <form onSubmit={add} className="card mb-5 grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
        <div>
          <label className="label" htmlFor="fav-label">Label</label>
          <input id="fav-label" className="input" required maxLength={60} value={label}
            onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Blocked customers" />
        </div>
        <div>
          <label className="label" htmlFor="fav-href">Destination</label>
          <select id="fav-href" className="input" value={href} onChange={(e) => setHref(e.target.value)}>
            {SUGGESTED.map((s) => <option key={s.href} value={s.href}>{s.label}</option>)}
          </select>
        </div>
        <button className="btn-primary" type="submit" disabled={busy}>Pin</button>
      </form>
      {msg && <p className="err-box mb-4">{msg}</p>}

      <div className="card-flush">
        {!favs.length
          ? <Empty>Nothing pinned yet. Pick a destination above to pin it here.</Empty>
          : (
            <ul className="divide-y divide-slate-100">
              {favs.map((f) => (
                <li key={f.id} className="flex items-center justify-between gap-3 px-4 py-3">
                  <Link href={f.href} className="min-w-0">
                    <p className="truncate text-sm font-bold text-slate-900 hover:text-indigo-600">{f.label}</p>
                    <p className="truncate text-xs text-slate-500">{f.href}</p>
                  </Link>
                  <button className="btn-ghost btn-sm shrink-0" onClick={() => remove(f.id)} disabled={busy}>
                    Unpin
                  </button>
                </li>
              ))}
            </ul>
          )}
      </div>
    </PageShell>
  );
}
