"use client";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import PageShell, { Empty, fmtDateTime } from "@/components/PageShell";
import { buildRouterosSetup } from "@/lib/routeros";

type Router = { id: string; name: string; host: string | null; status: string; ros_version: string | null };
type Diagnostic = {
  id: string; target_id: string; diagnosis: string; suggested_action: string | null;
  severity: string; created_at: string;
};

/** Ordered repair steps. Each one is a command the operator can read first. */
const STEPS: Record<string, { title: string; body: string }[]> = {
  hotspot: [
    {
      title: "1. Confirm the HotSpot service is running",
      body: "/ip hotspot print — the service should read running=yes. If not, the wlan or bridge it is bound to is down.",
    },
    {
      title: "2. Check the AP is bridged into the HotSpot network",
      body: "/interface bridge port print — confirm the wireless interface is a member of the bridge the server profile uses.",
    },
    {
      title: "3. Check the address pool has free addresses",
      body: "/ip hotspot address-pool print — an exhausted pool is the most common cause of 'no available addresses' on the login page.",
    },
    {
      title: "4. Verify RADIUS is reachable from the router",
      body: "/radius incoming print and test the NAS secret. A mismatch shows as authentication failures in the NETPID radius_users view.",
    },
    {
      title: "5. Clear sessions and restart the service",
      body: "/ip hotspot active remove [find] then /ip hotspot service profile refresh. This forces every client to re-authenticate.",
    },
  ],
  pppoe: [
    {
      title: "1. Confirm the PPPoE server is enabled",
      body: "/ppp service print — enabled=yes is required. A freshly imported router defaults this to no.",
    },
    {
      title: "2. Check the RADIUS client secret",
      body: "/radius client print. The secret must match the NAS entry in NETPID exactly; a trailing space is a common cause.",
    },
    {
      title: "3. Verify the RADIUS server is reachable",
      body: "/ip route print dst-address=0.0.0.0/0 and confirm the next hop can reach FreeRADIUS on 1812/udp.",
    },
    {
      title: "4. Check the address pool is not exhausted",
      body: "/ip pool print and /ip pool used print. Sessions that authenticate but never get an address point here.",
    },
    {
      title: "5. One-line repair",
      body: "Re-paste this router's provisioning script from NETPID. It rewrites the PPPoE and RADIUS blocks idempotently and is safe to run twice.",
    },
  ],
};

/**
 * Guided repair for a service that is not coming up. The final step regenerates
 * the operator's OWN provisioning script rather than a generic one — it is
 * per-router because it carries that router's identity, timezone and version.
 */
export default function FixTool({
  kind, title, description,
}: {
  kind: "hotspot" | "pppoe";
  title: string;
  description: string;
}) {
  const [routers, setRouters] = useState<Router[]>([]);
  const [diags, setDiags] = useState<Diagnostic[]>([]);
  const [routerId, setRouterId] = useState("");
  const [script, setScript] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const [r, d] = await Promise.all([
      fetch("/api/modules?module=access").then((x) => x.json()).catch(() => ({ routers: [] })),
      fetch("/api/diagnostics").then((x) => x.json()).catch(() => ({ logs: [] })),
    ]);
    setRouters(r.routers ?? []);
    setDiags(d.logs ?? []);
  }, []);
  useEffect(() => { load(); }, [load]);

  const chosen = routers.find((r) => r.id === routerId) ?? null;

  function generate() {
    if (!chosen) return;
    setBusy(true);
    setScript(buildRouterosSetup({
      shortname: `fix-${chosen.name}`,
      identity: chosen.name,
      // Fall back to 7: a 7.14+ box is the common case and the generated
      // script tells the operator if their box is actually on v6.
      rosVersion: chosen.ros_version ?? "7",
      timezone: "Africa/Nairobi",
    }));
    setBusy(false);
  }

  return (
    <PageShell title={title} description={description}>
      <div className="card mb-5">
        <label className="label" htmlFor="fix-router">Which router is broken?</label>
        <div className="flex flex-wrap gap-2">
          <select id="fix-router" className="input sm:max-w-80" value={routerId}
            onChange={(e) => { setRouterId(e.target.value); setScript(null); }}>
            <option value="">Select a router…</option>
            {routers.map((r) => (
              <option key={r.id} value={r.id}>{r.name} ({r.host ?? "no IP"}) — {r.status}</option>
            ))}
          </select>
          <button className="btn-ghost" onClick={generate} disabled={!routerId || busy}>
            {busy ? "Building…" : "Build repair script"}
          </button>
        </div>
      </div>

      <ol className="space-y-3">
        {STEPS[kind].map((s, i) => (
          <li key={s.title} className="card">
            <p className="font-bold">{s.title}</p>
            <p className="mt-1 text-sm text-slate-600">{s.body}</p>
            {i === STEPS[kind].length - 1 && (
              <p className="mt-2 text-xs text-slate-500">
                Step {i + 1} is handled for you above — the generated script already contains it.
              </p>
            )}
          </li>
        ))}
      </ol>

      {script && (
        <div className="card mt-5">
          <p className="font-bold">Repair script for {chosen?.name}</p>
          <p className="mt-1 text-sm text-slate-600">
            Paste this into the router&apos;s terminal. It is idempotent — safe to run more than once.
          </p>
          <pre className="code-block mt-3 max-h-96 overflow-auto">{script}</pre>
          <div className="mt-3 flex gap-2">
            <button className="btn-ghost btn-sm" onClick={() => navigator.clipboard?.writeText(script)}>
              Copy script
            </button>
            {chosen && (
              <Link href={`/dashboard/network/routers/${chosen.id}`} className="btn-ghost btn-sm">
                Open router page
              </Link>
            )}
          </div>
        </div>
      )}

      <h2 className="mt-8 text-lg font-bold">Recent diagnostics for this service</h2>
      <div className="card-flush mt-2 overflow-x-auto">
        {!diags.length
          ? <Empty>No diagnostics recorded yet. Run the AI assistant for a suggested cause.</Empty>
          : (
            <table className="table" style={{ minWidth: 700 }}>
              <thead>
                <tr><th>When</th><th>Target</th><th>Diagnosis</th><th>Severity</th></tr>
              </thead>
              <tbody>
                {diags.map((d) => (
                  <tr key={d.id}>
                    <td className="text-xs text-slate-500">{fmtDateTime(d.created_at)}</td>
                    <td className="font-mono text-xs">{d.target_id}</td>
                    <td className="max-w-md">
                      <p className="truncate">{d.diagnosis}</p>
                      {d.suggested_action && (
                        <p className="truncate text-xs text-indigo-600">{d.suggested_action}</p>
                      )}
                    </td>
                    <td>
                      <span className={`badge ${["critical", "high"].includes(d.severity) ? "badge-bad"
                        : d.severity === "medium" ? "badge-warn" : "badge-mute"}`}>{d.severity}</span>
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

