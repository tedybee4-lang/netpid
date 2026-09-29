"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

interface Result {
  router: { id: string; name: string; host: string };
  detected_version: string;
  secret_once: string;
  api_password_once: string;
  scripts: { v6: string; v7: string };
  defaults_applied: Record<string, string>;
  warning: string;
}

// Both scripts are always returned; these describe what differs between them.
const VERSIONS: { key: "v6" | "v7"; label: string; note: string }[] = [
  { key: "v6", label: "6", note: "Radio stays at /interface/wireless (wlan1). No HttpOnly cookie flag." },
  { key: "v7", label: "7", note: "v7.14+ radio is /interface/wifi (wifi1), and the HotSpot cookie gets HttpOnly." },
];

/**
 * Name-only provisioning. The operator types a router name; NETPID assigns the
 * management IP, API credentials, RADIUS NAS and secret, and hands back BOTH a
 * RouterOS 6 and a RouterOS 7 script so they paste the one that matches.
 */
export default function QuickAddRouter() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [version, setVersion] = useState<"6" | "7">("7");
  const [ssid, setSsid] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [res, setRes] = useState<Result | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null); setRes(null); setBusy(true);
    try {
      const r = await fetch("/api/routers/quick", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, ros_version: version, wifi_ssid: ssid }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? "Could not add router");
      setRes(j);
      setName(""); setSsid("");
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : "Could not add router");
    } finally {
      setBusy(false);
    }
  }

  function download(which: "v6" | "v7", text: string) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
    a.download = `${res?.router.name ?? "router"}-ros${which}.rsc`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  function copy(label: string, text: string) {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(label);
      setTimeout(() => setCopied(null), 1500);
    });
  }

  return (
    <div className="space-y-4">
      <form onSubmit={submit} className="card space-y-3">
        <div>
          <label className="label" htmlFor="q-name">Router name</label>
          <input id="q-name" className="input" required minLength={2} maxLength={120}
            placeholder="Nairobi Core 1" value={name}
            onChange={(e) => setName(e.target.value)} />
          <p className="hint">
            That is all you need. NETPID assigns the management IP, API credentials,
            RADIUS NAS and shared secret from your provisioning defaults.
          </p>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="label" htmlFor="q-ver">RouterOS version</label>
            <select id="q-ver" className="input" value={version}
              onChange={(e) => setVersion(e.target.value as "6" | "7")}>
              <option value="7">RouterOS 7 (7.x, wifiwave2)</option>
              <option value="6">RouterOS 6 (6.x)</option>
            </select>
            <p className="hint">Both scripts are generated; this picks the default tab.</p>
          </div>
          <div>
            <label className="label" htmlFor="q-ssid">Wi-Fi SSID (optional)</label>
            <input id="q-ssid" className="input" maxLength={32}
              placeholder="Lipanet WiFi" value={ssid}
              onChange={(e) => setSsid(e.target.value)} />
            <p className="hint">Leave blank and the script leaves your bridge alone.</p>
          </div>
        </div>
        <button className="btn-primary" disabled={busy || name.trim().length < 2}>
          {busy ? "Provisioning…" : "Add router & generate script"}
        </button>
      </form>

      {err && <p className="err-box">{err}</p>}

      {res && (
        <div className="space-y-3">
          <div className="card">
            <h2 className="panel-title">Applied automatically</h2>
            <dl className="mt-3 grid gap-2 text-sm sm:grid-cols-2">
              {Object.entries(res.defaults_applied).map(([k, v]) => (
                <div key={k} className="flex items-center justify-between gap-2 rounded-lg bg-slate-50 px-3 py-2">
                  <dt className="text-xs uppercase tracking-wide text-slate-500">{k.replace(/_/g, " ")}</dt>
                  <dd className="font-mono text-xs font-semibold">{v}</dd>
                </div>
              ))}
            </dl>
            <div className="mt-3 grid gap-2 sm:grid-cols-2">
              <div className="rounded-lg border border-amber-300 bg-amber-50 p-3">
                <p className="text-xs font-bold uppercase tracking-wide text-amber-800">RADIUS secret (once)</p>
                <p className="mt-1 break-all font-mono text-xs">{res.secret_once}</p>
                <button type="button" className="btn-ghost btn-sm mt-2"
                  onClick={() => copy("secret", res.secret_once)}>
                  {copied === "secret" ? "Copied" : "Copy"}
                </button>
              </div>
              <div className="rounded-lg border border-amber-300 bg-amber-50 p-3">
                <p className="text-xs font-bold uppercase tracking-wide text-amber-800">API password (once)</p>
                <p className="mt-1 break-all font-mono text-xs">{res.api_password_once}</p>
                <button type="button" className="btn-ghost btn-sm mt-2"
                  onClick={() => copy("api", res.api_password_once)}>
                  {copied === "api" ? "Copied" : "Copy"}
                </button>
              </div>
            </div>
            <p className="hint mt-2">{res.warning}</p>
          </div>

          {VERSIONS.map(({ key, label, note }) => (
            <section key={key} className="card">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="panel-title">RouterOS {label} script</h2>
                <div className="flex gap-2">
                  <button type="button" className="btn-ghost btn-sm"
                    onClick={() => copy(key, res.scripts[key])}>
                    {copied === key ? "Copied" : "Copy"}
                  </button>
                  <button type="button" className="btn-ghost btn-sm"
                    onClick={() => download(key, res.scripts[key])}>
                    Download .rsc
                  </button>
                </div>
              </div>
              <p className="hint mt-1">{note}</p>
              <pre className="code-block mt-2 max-h-96 overflow-auto">{res.scripts[key]}</pre>
            </section>
          ))}

          <button className="btn-primary" onClick={() => router.push("/dashboard/network")}>
            Go to routers
          </button>
        </div>
      )}
    </div>
  );
}
