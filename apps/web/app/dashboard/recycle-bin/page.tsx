"use client";
import { useCallback, useEffect, useState } from "react";
import PageShell, { Empty, fmtDateTime } from "@/components/PageShell";

type Row = {
  id: string; table_name: string; row_id: string; label: string | null;
  deleted_at: string; restored_at: string | null;
};

export default function RecycleBinPage() {
  const [items, setItems] = useState<Row[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [showRestored, setShowRestored] = useState(false);

  const load = useCallback(async () => {
    const r = await fetch("/api/recycle-bin");
    if (r.ok) setItems((await r.json()).items ?? []);
  }, []);
  useEffect(() => { load(); }, [load]);

  async function act(id: string, action: "restore" | "purge") {
    setBusy(id); setErr(null);
    const r = await fetch("/api/recycle-bin", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ id, action }),
    });
    const j = await r.json().catch(() => ({}));
    setBusy(null);
    if (!r.ok) { setErr(j.error ?? "That action failed"); return; }
    load();
  }

  const shown = showRestored ? items : items.filter((i) => !i.restored_at);
  const restorable = new Set(["customers", "routers", "packages", "vouchers", "inventory_items"]);

  return (
    <PageShell
      title="Recycle bin"
      description="Deleted customers, routers, packages and vouchers are kept here instead of being destroyed, so a mistake can be undone."
      action={
        <label className="flex items-center gap-2 text-sm text-slate-600">
          <input type="checkbox" checked={showRestored} className="h-4 w-4 accent-indigo-600"
            onChange={(e) => setShowRestored(e.target.checked)} />
          Show already restored
        </label>
      }
    >
      {err && <p className="err-box mb-4">{err}</p>}

      <div className="card-flush overflow-x-auto">
        {!shown.length
          ? <Empty>Nothing in the recycle bin. Deleted records will appear here.</Empty>
          : (
            <table className="table" style={{ minWidth: 760 }}>
              <thead>
                <tr><th>Record</th><th>Type</th><th>Deleted</th><th>State</th><th></th></tr>
              </thead>
              <tbody>
                {shown.map((i) => {
                  const canRestore = restorable.has(i.table_name) && !i.restored_at;
                  return (
                    <tr key={i.id}>
                      <td className="font-semibold text-slate-900">
                        {i.label ?? <span className="font-mono text-xs text-slate-500">{i.row_id.slice(0, 8)}…</span>}
                      </td>
                      <td><span className="badge badge-mute">{i.table_name.replace(/_/g, " ")}</span></td>
                      <td className="text-xs text-slate-500">{fmtDateTime(i.deleted_at)}</td>
                      <td>
                        <span className={`badge ${i.restored_at ? "badge-ok" : "badge-warn"}`}>
                          {i.restored_at ? "restored" : "deleted"}
                        </span>
                      </td>
                      <td className="text-right">
                        {canRestore && (
                          <button className="btn-ghost btn-sm" disabled={busy === i.id}
                            onClick={() => act(i.id, "restore")}>Restore</button>
                        )}
                        <button className="btn-danger btn-sm ml-2" disabled={busy === i.id}
                          onClick={() => act(i.id, "purge")}>Delete forever</button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
      </div>
      <p className="mt-3 text-xs text-slate-500">
        &ldquo;Delete forever&rdquo; is immediate and cannot be undone. Restoring puts the record back with the
        values it had at the moment it was removed.
      </p>
    </PageShell>
  );
}
