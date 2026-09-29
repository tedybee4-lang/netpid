"use client";
import { useCallback, useEffect, useState } from "react";
import PageShell, { Empty, StatGrid, fmtDate } from "@/components/PageShell";

type Binding = {
  id: string; mac: string; ssid: string | null; note: string | null; created_at: string;
  customer_id: string | null; voucher_id: string | null;
  customers: { customer_no: string; full_name: string } | null;
  vouchers: { code: string; status: string } | null;
};
type Customer = { id: string; customer_no: string; full_name: string; status: string };
type Voucher = { id: string; code: string; status: string };

export default function HotspotBindingPage() {
  const [bindings, setBindings] = useState<Binding[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [vouchers, setVouchers] = useState<Voucher[]>([]);
  const [form, setForm] = useState({ mac: "", customer_id: "", voucher_id: "", ssid: "", note: "" });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    const r = await fetch("/api/hotspot-bindings");
    if (!r.ok) return;
    const j = await r.json();
    setBindings(j.bindings ?? []);
    setCustomers(j.customers ?? []);
    setVouchers(j.vouchers ?? []);
  }, []);
  useEffect(() => { load(); }, [load]);

  async function bind(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setErr(null);
    const r = await fetch("/api/hotspot-bindings", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(form),
    });
    const j = await r.json().catch(() => ({}));
    setBusy(false);
    if (!r.ok) { setErr(j.error ?? "Could not save the binding"); return; }
    setForm({ mac: "", customer_id: "", voucher_id: "", ssid: "", note: "" });
    load();
  }
  async function unbind(id: string) {
    setBusy(true);
    await fetch(`/api/hotspot-bindings?id=${id}`, { method: "DELETE" });
    setBusy(false); load();
  }

  return (
    <PageShell
      title="HotSpot binding"
      description="Tie a device MAC to a customer or a voucher so the network worker pushes the right RADIUS attribute the moment that device connects."
    >
      <StatGrid items={[
        { label: "Bound devices", value: bindings.length, sub: "MACs on record" },
        { label: "To customers", value: bindings.filter((b) => b.customer_id).length, sub: "Named accounts" },
        { label: "To vouchers", value: bindings.filter((b) => b.voucher_id).length, sub: "Prepaid codes" },
        { label: "Unused vouchers", value: vouchers.length, sub: "Available to bind" },
      ]} />

      <form onSubmit={bind} className="card mb-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <div>
          <label className="label" htmlFor="b-mac">Device MAC</label>
          <input id="b-mac" className="input font-mono uppercase" required placeholder="A4:83:E7:1B:22:09"
            value={form.mac} onChange={(e) => setForm({ ...form, mac: e.target.value })} />
          <p className="hint">Hyphens and dots are accepted and normalised.</p>
        </div>
        <div>
          <label className="label" htmlFor="b-cust">Bind to customer</label>
          <select id="b-cust" className="input" value={form.customer_id}
            onChange={(e) => setForm({ ...form, customer_id: e.target.value, voucher_id: "" })}>
            <option value="">None</option>
            {customers.map((c) => <option key={c.id} value={c.id}>{c.customer_no} · {c.full_name}</option>)}
          </select>
        </div>
        <div>
          <label className="label" htmlFor="b-vouch">Bind to voucher</label>
          <select id="b-vouch" className="input" value={form.voucher_id}
            onChange={(e) => setForm({ ...form, voucher_id: e.target.value, customer_id: "" })}>
            <option value="">None</option>
            {vouchers.map((v) => <option key={v.id} value={v.id}>{v.code}</option>)}
          </select>
        </div>
        <div>
          <label className="label" htmlFor="b-ssid">SSID (optional)</label>
          <input id="b-ssid" className="input" placeholder="e.g. Kawangware-Hotspot"
            value={form.ssid} onChange={(e) => setForm({ ...form, ssid: e.target.value })} />
        </div>
        <div>
          <label className="label" htmlFor="b-note">Note (optional)</label>
          <input id="b-note" className="input" placeholder="Front-room tablet"
            value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />
        </div>
        <div className="flex items-end">
          <button className="btn-primary w-full" type="submit" disabled={busy}>
            {busy ? "Saving…" : "Save binding"}
          </button>
        </div>
        {err && <p className="err-box lg:col-span-3">{err}</p>}
      </form>

      <div className="card-flush overflow-x-auto">
        {!bindings.length
          ? <Empty>Nothing bound yet. Add a MAC above.</Empty>
          : (
            <table className="table" style={{ minWidth: 820 }}>
              <thead>
                <tr><th>MAC</th><th>Bound to</th><th>SSID</th><th>Note</th><th>Added</th><th></th></tr>
              </thead>
              <tbody>
                {bindings.map((b) => (
                  <tr key={b.id}>
                    <td className="font-mono text-xs uppercase">{b.mac}</td>
                    <td>
                      {b.customers
                        ? <><span className="badge badge-info">customer</span>{" "}{b.customers.full_name}</>
                        : b.vouchers
                          ? <><span className="badge badge-warn">voucher</span>{" "}
                            <span className="font-mono text-xs">{b.vouchers.code}</span></>
                          : <span className="text-slate-400">Unbound</span>}
                    </td>
                    <td className="font-mono text-xs">{b.ssid ?? "—"}</td>
                    <td className="max-w-56 truncate">{b.note ?? "—"}</td>
                    <td className="text-xs text-slate-500">{fmtDate(b.created_at)}</td>
                    <td className="text-right">
                      <button className="btn-ghost btn-sm" onClick={() => unbind(b.id)} disabled={busy}>
                        Remove
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
      </div>
    </PageShell>
  );
}

