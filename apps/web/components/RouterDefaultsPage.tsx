"use client";
import { useCallback, useEffect, useState } from "react";
import PageShell from "@/components/PageShell";

type Defaults = {
  mgmt_subnet: string; mgmt_gateway: string; api_username: string;
  api_port: number; api_ssl_port: number; use_ssl: boolean; ros_version: string;
  radius_server: string | null; radius_auth_port: number; radius_acct_port: number;
  radius_coa_port: number; nas_prefix: string; dns_servers: string;
  ntp_servers: string; wifi_ssid: string | null; country_code: string;
};

const FALLBACK: Defaults = {
  mgmt_subnet: "10.10.10.0/24", mgmt_gateway: "10.10.10.1", api_username: "netpid",
  api_port: 8728, api_ssl_port: 8729, use_ssl: true, ros_version: "7",
  radius_server: null, radius_auth_port: 1812, radius_acct_port: 1813,
  radius_coa_port: 3799, nas_prefix: "netpid", dns_servers: "1.1.1.1,8.8.8.8",
  ntp_servers: "pool.ntp.org", wifi_ssid: null, country_code: "Kenya",
};

type Field = { key: keyof Defaults; label: string; kind?: "text" | "number" | "select" | "check"; hint?: string; placeholder?: string; options?: [string, string][] };

/**
 * PPPoE and router-management defaults. Every value here is stamped into each
 * router's provisioning script, so setting them once is what makes name-only
 * router onboarding possible.
 */
export default function RouterDefaultsPage({ title, description, groups }: {
  title: string; description: string;
  groups: { heading: string; blurb?: string; fields: Field[] }[];
}) {
  const [d, setD] = useState<Defaults>(FALLBACK);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    const r = await fetch("/api/router-defaults");
    if (r.ok) {
      const j = await r.json();
      if (j.defaults) setD({ ...FALLBACK, ...j.defaults });
    }
    setLoaded(true);
  }, []);
  useEffect(() => { load(); }, [load]);

  async function save() {
    setBusy(true); setMsg(null);
    const r = await fetch("/api/router-defaults", {
      method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...d, wifi_ssid: d.wifi_ssid ?? "" }),
    });
    const j = await r.json().catch(() => ({}));
    setBusy(false);
    setMsg(r.ok
      ? { ok: true, text: "Saved. New routers will use these values." }
      : { ok: false, text: j.error ?? "Could not save" });
  }

  if (!loaded) {
    return <PageShell title={title}><p className="text-sm text-slate-500">Loading…</p></PageShell>;
  }

  return (
    <PageShell title={title} description={description}>
      <div className="grid gap-4 lg:grid-cols-2">
        {groups.map((g) => (
          <section key={g.heading} className="card">
            <h2 className="text-lg font-black">{g.heading}</h2>
            {g.blurb && <p className="mt-1 text-sm text-slate-600">{g.blurb}</p>}
            <div className="mt-3 space-y-3">
              {g.fields.map((f) => (
                <div key={f.key}>
                  {f.kind === "check" ? (
                    <label className="flex items-center gap-2 text-sm text-slate-700">
                      <input
                        type="checkbox" className="h-4 w-4 accent-indigo-600"
                        checked={Boolean(d[f.key])}
                        onChange={(e) => setD((p) => ({ ...p, [f.key]: e.target.checked }))}
                      />
                      {f.label}
                    </label>
                  ) : (
                    <>
                      <label className="label" htmlFor={`f-${f.key}`}>{f.label}</label>
                      {f.kind === "select" ? (
                        <select
                          id={`f-${f.key}`} className="input" value={String(d[f.key] ?? "")}
                          onChange={(e) => setD((p) => ({ ...p, [f.key]: e.target.value }))}
                        >
                          {f.options?.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                        </select>
                      ) : (
                        <input
                          id={`f-${f.key}`}
                          className={`input ${f.kind === "number" ? "tnum" : "font-mono"}`}
                          type={f.kind === "number" ? "number" : "text"}
                          placeholder={f.placeholder}
                          value={(d[f.key] as string | number | null) ?? ""}
                          onChange={(e) => setD((p) => ({
                            ...p,
                            [f.key]: f.kind === "number" ? Number(e.target.value)
                              : f.key === "wifi_ssid" ? e.target.value || null : e.target.value,
                          }))}
                        />
                      )}
                    </>
                  )}
                  {f.hint && <p className="hint">{f.hint}</p>}
                </div>
              ))}
            </div>
          </section>
        ))}
      </div>

      {msg && <p className={`mt-4 ${msg.ok ? "ok-box" : "err-box"}`}>{msg.text}</p>}
      <div className="mt-4 flex gap-2">
        <button className="btn-primary" onClick={save} disabled={busy}>
          {busy ? "Saving…" : "Save defaults"}
        </button>
        <button className="btn-ghost" onClick={load} disabled={busy}>Reset</button>
      </div>
    </PageShell>
  );
}
