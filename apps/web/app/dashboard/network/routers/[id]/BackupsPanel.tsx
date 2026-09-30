"use client";
import { useCallback, useEffect, useState } from "react";

// Router backups panel. Everything shown here is read from the API: the
// manifest rows the worker wrote, plus the state of the job that produces them.
// No optimistic "Backup complete" — a row only exists once RouterOS actually
// saved the file.

type Backup = {
  id: string;
  created_at: string;
  size_bytes: number | null;
  router_file: string;
  storage_path: string;
  retrievable: boolean;
};
type Job = {
  id: string;
  status: string;
  last_error: string | null;
  created_at: string;
  completed_at: string | null;
};

export default function BackupsPanel({ routerId }: { routerId: string }) {
  const [backups, setBackups] = useState<Backup[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [inFlight, setInFlight] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    const res = await fetch(`/api/routers/${routerId}/backups`);
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      setLoading(false);
      setError(j.error ?? `Could not load backups (${res.status})`);
      return;
    }
    const j = await res.json();
    setBackups(j.backups ?? []);
    setJobs(j.jobs ?? []);
    setInFlight(Boolean(j.in_flight));
    setLoading(false);
  }, [routerId]);

  useEffect(() => { load(); }, [load]);

  // Poll only while something is queued/running, so an idle page makes one call.
  useEffect(() => {
    if (!inFlight) return;
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, [inFlight, load]);

  async function createBackup() {
    setMsg(null); setError(null);
    const res = await fetch(`/api/routers/${routerId}/backups`, { method: "POST" });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) { setMsg(j.error ?? "Could not queue a backup"); return; }
    setMsg("Backup queued — writing the file on the router…");
    setInFlight(true);
    load();
  }

  async function retrieve(b: Backup) {
    setNote(null);
    const res = await fetch(`/api/routers/${routerId}/backups/${b.id}/download`);
    if (res.ok) {
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = b.router_file;
      a.click();
      URL.revokeObjectURL(url);
      return;
    }
    const j = await res.json().catch(() => ({}));
    setNote(j.hint ?? j.error ?? `Retrieval failed (${res.status})`);
  }

  async function forget(b: Backup) {
    if (!confirm(`Remove "${b.router_file}" from the manifest? The file on the router stays.`)) return;
    setNote(null);
    const res = await fetch(`/api/routers/${routerId}/backups/${b.id}`, { method: "DELETE" });
    const j = await res.json().catch(() => ({}));
    setMsg(res.ok ? "Manifest entry removed." : (j.error ?? "Could not remove entry"));
    if (res.ok) load();
  }

  const lastJob = jobs[0];

  return (
    <div className="card mt-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="panel-title">Backups{backups.length ? ` (${backups.length})` : ""}</h2>
        <button className="btn-primary" onClick={createBackup} disabled={inFlight}>
          {inFlight ? "Backing up…" : "Backup now"}
        </button>
      </div>

      {msg && <p className="mt-3 text-sm text-slate-600">{msg}</p>}
      {error && (
        <div className="mt-3 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800">
          <p className="font-semibold">Could not load backups</p>
          <p className="mt-1">{error}</p>
          <button className="btn-ghost mt-2" onClick={() => { setLoading(true); load(); }}>Retry</button>
        </div>
      )}
      {note && (
        <p className="mt-3 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">{note}</p>
      )}
      {lastJob && lastJob.status === "failed" && (
        <p className="mt-3 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800">
          Last backup job failed{lastJob.last_error ? `: ${lastJob.last_error}` : "."}
        </p>
      )}

      {loading ? (
        <div className="mt-4 space-y-2" aria-busy="true">
          <div className="h-4 w-1/3 animate-pulse rounded bg-slate-200" />
          <div className="h-4 w-1/2 animate-pulse rounded bg-slate-200" />
        </div>
      ) : backups.length === 0 ? (
        <p className="mt-4 text-sm text-slate-500">
          No backups yet{inFlight ? " — the first one is running now." : ". Press “Backup now” to write one on the router."}
        </p>
      ) : (
        <ul className="mt-4 divide-y divide-slate-100">
          {backups.map((b) => (
            <li key={b.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
              <div className="min-w-0">
                <p className="truncate font-mono text-sm font-semibold text-slate-800">{b.router_file}</p>
                <p className="mt-0.5 text-xs text-slate-500">
                  {new Date(b.created_at).toLocaleString()}
                  {b.size_bytes ? ` · ${b.size_bytes} bytes` : ""}
                </p>
              </div>
              <div className="flex shrink-0 gap-2">
                <button
                  className="btn-ghost"
                  onClick={() => retrieve(b)}
                  title={b.retrievable ? "Download" : "Not mirrored off the router — click for details"}
                >
                  {b.retrievable ? "Download" : "On router…"}
                </button>
                <button className="btn-ghost" onClick={() => forget(b)}>Remove</button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <p className="mt-4 text-xs text-slate-500">
        Backups are written by RouterOS on the device itself. NETPID records the manifest and job status;
        the binary file is retrieved from the router, not from cloud storage.
      </p>
    </div>
  );
}
