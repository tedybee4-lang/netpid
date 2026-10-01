"use client";
import { useCallback, useEffect, useState } from "react";

// Super Admin: NETPID's ONE Daraja app.
//
// This is entered once, by the platform, and is what every ISP's STK push
// authenticates with. Each ISP only declares their own Till; the push names
// that Till as the receiver, so customer money lands in the ISP's account and
// NETPID never holds it.
//
// The values are write-only: they are encrypted with APP_ENCRYPTION_KEY before
// storage and are never sent back to this page.
export default function PlatformDarajaPage() {
  const [form, setForm] = useState({
    consumer_key: "", consumer_secret: "", passkey: "", environment: "production",
  });
  const [state, setState] = useState<{
    configured: boolean; environment: string | null;
    isps_collecting: number; updated_at?: string;
  } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const r = await fetch("/api/admin/daraja");
    if (!r.ok) return;
    setState(await r.json());
  }, []);
  useEffect(() => { load(); }, [load]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null); setMsg(null);
    if (!form.consumer_key || !form.consumer_secret || !form.passkey) {
      setErr("Enter the consumer key, secret and passkey from the Daraja portal.");
      return;
    }
    setBusy(true);
    try {
      const r = await fetch("/api/admin/daraja", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify(form),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? "Could not save");
      setMsg(`Saved (${j.environment}). ${j.activated} network(s) started collecting.`);
      setForm((f) => ({ ...f, consumer_key: "", consumer_secret: "", passkey: "" }));
      load();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : "Could not save");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto max-w-2xl px-4 py-6 sm:px-6">
      <h1 className="text-2xl font-black tracking-tight">M-Pesa (Daraja) — platform app</h1>
      <p className="mt-1 text-sm text-slate-500">
        One Safaricom Daraja app serves every network on NETPID. ISPs never hold
        credentials — they only declare the Till or PayBill they own, and that
        is the number each customer is charged to.
      </p>

      <div className="mt-4 rounded-xl border border-white/10 bg-white/5 p-4 text-sm text-slate-300">
        <p>
          Status:{" "}
          <b>{state?.configured ? "configured" : "not configured"}</b>
          {state?.environment ? <> · environment <b>{state.environment}</b></> : null}
          {" · "}
          <b>{state?.isps_collecting ?? 0}</b> network(s) collecting
        </p>
        {state?.configured && (
          <p className="mt-2 text-xs text-slate-400">
            The credentials are encrypted at rest and cannot be displayed again.
            Re-enter all four fields to replace them.
          </p>
        )}
      </div>

      <form onSubmit={submit} className="card mt-4 space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="label" htmlFor="p-key">Consumer key</label>
            <input id="p-key" className="input" type="password" autoComplete="new-password"
              value={form.consumer_key}
              onChange={(e) => setForm((f) => ({ ...f, consumer_key: e.target.value }))} />
          </div>
          <div>
            <label className="label" htmlFor="p-secret">Consumer secret</label>
            <input id="p-secret" className="input" type="password" autoComplete="new-password"
              value={form.consumer_secret}
              onChange={(e) => setForm((f) => ({ ...f, consumer_secret: e.target.value }))} />
          </div>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="label" htmlFor="p-pass">Passkey</label>
            <input id="p-pass" className="input" type="password" autoComplete="new-password"
              value={form.passkey}
              onChange={(e) => setForm((f) => ({ ...f, passkey: e.target.value }))} />
          </div>
          <div>
            <label className="label" htmlFor="p-env">Environment</label>
            <select id="p-env" className="input" value={form.environment}
              onChange={(e) => setForm((f) => ({ ...f, environment: e.target.value }))}>
              <option value="production">production (real money)</option>
              <option value="sandbox">sandbox (testing — no real money)</option>
            </select>
          </div>
        </div>

        <p className="hint">
          For every ISP&rsquo;s Till to collect, Safaricom must have that Till
          registered as a Receiver on this app. A Till that is not registered is
          rejected by Daraja and the customer sees the failure.
        </p>

        {err && <p className="err-box">{err}</p>}
        {msg && <p className="ok-box">{msg}</p>}
        <button className="btn-primary" disabled={busy}>
          {busy ? "Saving…" : "Save platform app"}
        </button>
      </form>
    </main>
  );
}