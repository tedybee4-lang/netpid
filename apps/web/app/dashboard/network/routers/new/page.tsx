"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import QuickAddRouter from "../QuickAddRouter";
import MikroTikSetupWizard from "@/components/MikroTikSetupWizard";

type Created = {
  router: { id: string; name: string; host: string };
  nas: { id: string; shortname: string } | null;
  secret_once: string | null;
  /**
   * The full NETPID installer. This replaced `routeros_script`, which carried
   * only the RADIUS/PPP plane and configured no LAN, DHCP, NAT, firewall,
   * HotSpot or PPPoE - a short script that looked like a completed setup.
   */
  installer: string;
  /** Site values the operator must supply; NETPID will not invent them. */
  installer_missing: string[];
  warning: string | null;
};

export default function NewRouterPage() {
  const router = useRouter();
  const [form, setForm] = useState({
    name: "", host: "", site: "", notes: "",
    api_username: "netpid", api_password: "",
    api_port: 8728, api_ssl_port: 8729, use_ssl: true,
    nas: true, nas_shortname: "", radius_server: "",
  });
  const [result, setResult] = useState<Created | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const set = (k: string, v: string | number | boolean) => setForm((f) => ({ ...f, [k]: v }));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    setLoading(true);
    try {
      const res = await fetch("/api/routers", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...form,
          site: form.site || null,
          notes: form.notes || null,
          nas_shortname: form.nas_shortname || undefined,
          radius_server: form.radius_server || undefined,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Failed to add the router");
      setResult(json);
    } catch (e: unknown) { setErr(e instanceof Error ? e.message : "Failed."); }
    finally { setLoading(false); }
  }

  async function copyScript() {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(result.installer);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setErr("Clipboard blocked by the browser — select the script and copy manually.");
    }
  }

  function download() {
    if (!result) return;
    const shortname = result.nas?.shortname ?? result.router.name.toLowerCase();
    const blob = new Blob([result.installer], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${shortname}-netpid-installer.rsc`;
    a.click();
    URL.revokeObjectURL(url);
  }

  if (result) {
    return (
      <main className="mx-auto max-w-4xl px-4 py-8 sm:px-6">
        <div className="ok-box">
          <p className="font-bold">Router added — {result.router.name}</p>
          <p className="mt-1 text-sm">
            A health check is queued. Paste the script below on the router to point it
            at NETPID, then reload this page to watch the status change.
          </p>
        </div>

        {result.secret_once && (
          <div className="card mt-4 border-amber-300 bg-amber-50">
            <p className="font-bold text-amber-900">RADIUS secret — shown once, copy it now</p>
            <code className="mt-2 block break-all rounded-lg bg-white p-3 font-mono text-sm
              text-slate-900">
              {result.secret_once}
            </code>
            <p className="mt-2 text-xs text-amber-800">
              It is encrypted at rest and never displayed again. It is also embedded in the
              script below — if you copy the script, you no longer need to read it out.
            </p>
          </div>
        )}

        {/*
          THE WIZARD IS THE PROVISIONING ARTIFACT.
          The static .rsc below cannot know which ports are free, which are
          already bridged, or what RouterOS version is on the box, so it ships
          with blanks and stops on the router. The wizard reads the real
          hardware first and configures against that, so the operator never
          has to edit SECTION A by hand.
        */}
        <div className="mt-4">
          <h2 className="mb-2 text-lg font-bold">Provision this router</h2>
          <MikroTikSetupWizard
            routerId={result.router.id}
            radiusSecret={result.secret_once ?? ""}
          />
        </div>

        <details className="card mt-4">
          <summary className="cursor-pointer font-bold">
            Advanced: static installer script (fallback)
          </summary>
          <p className="hint my-2">
            Use this only if the router cannot reach NETPID &mdash; no DNS, no
            route out, or a firewall blocking outbound HTTPS. The wizard above
            needs the router to make one outbound request. Otherwise prefer the
            wizard: this script ships with your site values blank and stops on
            the router if any is still empty.
          </p>
          {result.installer_missing?.length > 0 && (
            <div className="mb-3 rounded-lg border border-amber-400 bg-amber-50 p-3">
              <p className="font-bold text-amber-900">Fill these in before the script runs</p>
              <ul className="list-disc pl-5 font-mono text-xs text-amber-900">
                {result.installer_missing.map((m) => <li key={m}>{m}</li>)}
              </ul>
            </div>
          )}
          <div className="mb-2 flex flex-wrap gap-2">
            <button className="btn-ghost btn-sm" onClick={copyScript}>
              {copied ? "Copied ✓" : "Copy script"}
            </button>
            <button className="btn-ghost btn-sm" onClick={download}>Download .rsc</button>
          </div>
          <pre className="code-block rsc max-h-96 whitespace-pre">{result.installer}</pre>
        </details>

        <div className="mt-6 flex flex-wrap gap-2">
          <Link href={`/dashboard/network/routers/${result.router.id}`} className="btn-primary">
            Open router
          </Link>
          <Link href="/dashboard/network" className="btn-ghost">Back to network</Link>
          <button className="btn-ghost" onClick={() => { setResult(null); setCopied(false); }}>
            Add another router
          </button>
        </div>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-3xl px-4 py-8 sm:px-6">
      <Link href="/dashboard/network" className="text-sm font-semibold text-indigo-600 hover:underline">
        ← Network
      </Link>
      <h1 className="mt-2 text-2xl font-black tracking-tight">Add MikroTik router</h1>
      <p className="mt-1 text-sm text-slate-500">
        Enter a name. NETPID fills in the management IP, API credentials, RADIUS NAS
        and the shared secret, and generates both a RouterOS 6 and a RouterOS 7 script.
      </p>

      <div className="mt-6">
        <QuickAddRouter />
      </div>

      <details className="card mt-8">
        <summary className="cursor-pointer text-sm font-bold uppercase tracking-wide text-slate-500">
          Advanced: enter the IP and credentials yourself
        </summary>
        <p className="hint mt-2">
          Only needed when the management network differs from your provisioning
          defaults, or you are importing a router that already exists.
        </p>
      </details>

      <form onSubmit={submit} className="card mt-6 space-y-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className="label" htmlFor="r-name">Name</label>
            <input id="r-name" className="input" required value={form.name}
              onChange={(e) => set("name", e.target.value)} placeholder="Nairobi Core 1" />
          </div>
          <div>
            <label className="label" htmlFor="r-site">Site / town</label>
            <input id="r-site" className="input" value={form.site}
              onChange={(e) => set("site", e.target.value)} placeholder="Nairobi" />
          </div>
          <div>
            <label className="label" htmlFor="r-host">Management IP</label>
            <input id="r-host" className="input" required value={form.host}
              onChange={(e) => set("host", e.target.value)} placeholder="196.201.214.10" />
            <p className="hint">Must be reachable from the NETPID worker (VPN or public).</p>
          </div>
          <div>
            <label className="label" htmlFor="r-radius">FreeRADIUS server</label>
            <input id="r-radius" className="input" value={form.radius_server}
              onChange={(e) => set("radius_server", e.target.value)} placeholder="10.0.0.5" />
            <p className="hint">Only used inside the generated script.</p>
          </div>
          <div>
            <label className="label" htmlFor="r-user">API username</label>
            <input id="r-user" className="input" value={form.api_username}
              onChange={(e) => set("api_username", e.target.value)} />
          </div>
          <div>
            <label className="label" htmlFor="r-pass">API password</label>
            <input id="r-pass" className="input" type="password" required value={form.api_password}
              onChange={(e) => set("api_password", e.target.value)} />
            <p className="hint">Stored AES-256-GCM encrypted. Never shown again.</p>
          </div>
        </div>

        <div className="rounded-2xl border border-slate-200 bg-slate-50/60 p-4">
          <label className="flex items-start gap-3">
            <input type="checkbox" className="mt-1 h-4 w-4 rounded border-slate-300
              text-indigo-600 focus:ring-indigo-500"
              checked={form.use_ssl} onChange={(e) => set("use_ssl", e.target.checked)} />
            <span>
              <span className="block text-sm font-semibold">Use API-SSL (recommended)</span>
              <span className="block text-xs text-slate-500">
                Encrypts the session that carries the API password. Requires API-SSL
                enabled on the router.
              </span>
            </span>
          </label>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <div>
              <label className="label" htmlFor="r-port">API port</label>
              <input id="r-port" className="input" type="number" value={form.api_port}
                onChange={(e) => set("api_port", Number(e.target.value))} />
            </div>
            <div>
              <label className="label" htmlFor="r-sslport">API-SSL port</label>
              <input id="r-sslport" className="input" type="number" value={form.api_ssl_port}
                onChange={(e) => set("api_ssl_port", Number(e.target.value))} />
            </div>
          </div>
        </div>

        <div className="rounded-2xl border border-slate-200 bg-slate-50/60 p-4">
          <label className="flex items-start gap-3">
            <input type="checkbox" className="mt-1 h-4 w-4 rounded border-slate-300
              text-indigo-600 focus:ring-indigo-500"
              checked={form.nas} onChange={(e) => set("nas", e.target.checked)} />
            <span>
              <span className="block text-sm font-semibold">Create a RADIUS NAS client</span>
              <span className="block text-xs text-slate-500">
                Registers this router with FreeRADIUS so PPPoE and HotSpot logins authorize
                through NETPID.
              </span>
            </span>
          </label>
          {form.nas && (
            <div className="mt-3">
              <label className="label" htmlFor="r-nas">NAS shortname</label>
              <input id="r-nas" className="input" value={form.nas_shortname}
                onChange={(e) => set("nas_shortname", e.target.value)}
                placeholder={form.name.toLowerCase().replace(/[^a-z0-9]+/g, "-") || "nairobi-core-1"} />
              <p className="hint">Defaults to a slug of the name. Must be unique per ISP.</p>
            </div>
          )}
        </div>

        <div>
          <label className="label" htmlFor="r-notes">Notes</label>
          <input id="r-notes" className="input" value={form.notes}
            onChange={(e) => set("notes", e.target.value)}
            placeholder="Tower A, 5 GHz sector pointing east" />
        </div>

        {err && <p className="err-box">{err}</p>}
        <div className="flex flex-wrap gap-2">
          <button className="btn-primary flex-1" disabled={loading}>
            {loading ? "Adding…" : "Add router & generate setup script"}
          </button>
          <Link href="/dashboard/network" className="btn-ghost">Cancel</Link>
        </div>
      </form>

      <div className="card mt-4 bg-slate-50/70">
        <p className="text-sm font-bold">Prefer the command line?</p>
        <p className="mt-1 text-sm text-slate-600">
          The same provisioning exists as a script, with no dashboard and no browser —
          useful for a batch of towers or a deployment pipeline.
        </p>
        <pre className="code-block mt-3">{`node network-worker/scripts/provision-router.mjs \\
  --isp your-isp-slug --name "Nairobi Core 1" \\
  --host 196.201.214.10 --user netpid --pass '****' \\
  --out ./routers`}</pre>
        <p className="hint">
          Both paths write the same rows and emit the same RouterOS script, so a router added
          either way is configured identically. Add <code>--dry-run</code> to preview.
        </p>
      </div>
    </main>
  );
}
