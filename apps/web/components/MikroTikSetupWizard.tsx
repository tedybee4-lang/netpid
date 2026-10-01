"use client";

/**
 * MikroTik Setup Wizard — the two-phase interactive provisioning flow.
 *
 * Phase 1 is a single command the operator pastes into the router terminal.
 * Phase 2 is a port plan built against the interfaces the router REPORTED,
 * not against a guess.
 *
 * Mobile-first: an operator doing this is standing at a rack, usually on a
 * phone, usually on a poor connection. Every control is a full-width tap
 * target and the layout collapses to one column below sm.
 *
 * This is a NEW component. QuickAddRouter is untouched: the static installer
 * flow still works, and an operator whose router cannot reach NETPID still
 * needs it.
 */
import { useCallback, useEffect, useRef, useState } from "react";

type Mode = "HOTSPOT" | "PPPOE" | "HOTSPOT_PPPOE";

interface Iface {
  name: string;
  type: string;
  in_bridge: string | null;
  is_candidate_wan: boolean;
}
interface Bridge { name: string; ports: string[] }
interface Capability { supported: boolean; reason: string }
interface Caps { wireguard?: Capability; rosMajor?: number | null }

const STEPS = ["Connect", "Detect", "Configure", "Apply"] as const;
const MODES: Mode[] = ["HOTSPOT", "PPPOE", "HOTSPOT_PPPOE"];
const modeLabel = (m: Mode) =>
  m === "HOTSPOT_PPPOE" ? "HotSpot + PPPoE" : m === "HOTSPOT" ? "HotSpot" : "PPPoE";

export default function MikroTikSetupWizard({
  routerId,
  radiusSecret = "",
}: {
  /**
   * Binds the session to the router record, so every object the configure
   * script creates is tagged with a real router id and the stored RADIUS
   * secret is found automatically. Omit it to run discovery standalone.
   */
  routerId?: string | null;
  /**
   * The secret shown once at router creation. Passed in so the operator does
   * not retype it; it is sent with the configure call and never stored here.
   */
  radiusSecret?: string;
} = {}) {
  const [token, setToken] = useState("");
  const [command, setCommand] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const [status, setStatus] = useState<string | null>(null);
  const [board, setBoard] = useState<string | null>(null);
  const [version, setVersion] = useState<string | null>(null);
  const [caps, setCaps] = useState<Caps | null>(null);
  const [ifaces, setIfaces] = useState<Iface[]>([]);
  const [bridges, setBridges] = useState<Bridge[]>([]);
  const [detectError, setDetectError] = useState<string | null>(null);

  const [mode, setMode] = useState<Mode>("HOTSPOT");
  const [wan, setWan] = useState("");
  const [hsPorts, setHsPorts] = useState<string[]>([]);
  const [pppPorts, setPppPorts] = useState<string[]>([]);
  const [hsSubnet, setHsSubnet] = useState("");
  const [hsRange, setHsRange] = useState("");
  const [hsDns, setHsDns] = useState("");
  const [pppoePool, setPppoePool] = useState("");
  const [pppoeRanges, setPppoeRanges] = useState("");
  const [pppoeLocal, setPppoeLocal] = useState("");
  const [secret, setSecret] = useState("");

  const [script, setScript] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [progress, setProgress] = useState(0);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPolling = useCallback(() => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
  }, []);
  useEffect(() => stopPolling, [stopPolling]);

  // Poll every 2s with plain fetch rather than SSE: the router is often on a
  // LAN that cannot hold an EventSource open, and a dead stream would leave
  // the operator watching a wizard that never advances.
  const poll = useCallback(async (t: string) => {
    try {
      const res = await fetch(`/api/provision/mikrotik/status/${t}`, { cache: "no-store" });
      if (!res.ok) return;
      const j = await res.json();
      setStatus(j.status);
      setBoard(j.board_name);
      setVersion(j.routeros_version);
      setCaps(j.capabilities ?? null);
      setDetectError(j.error_message ?? null);
      setProgress(j.progress_pct ?? 0);
      if (Array.isArray(j.interfaces)) {
        setIfaces(j.interfaces);
        setBridges(j.bridges ?? []);
        // Preselect the most likely WAN once, so the common case needs no taps.
        setWan((w) => w || (j.interfaces.find((i: Iface) => i.is_candidate_wan)?.name ?? ""));
      }
      if (j.status === "CONFIGURED" || j.status === "FAILED") stopPolling();
    } catch { /* a dropped poll is not fatal; the next retries */ }
  }, [stopPolling]);

  async function start() {
    setBusy(true); setErr(null);
    try {
      const res = await fetch("/api/provision/mikrotik/generate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(routerId ? { router_id: routerId } : {}),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? "Could not start provisioning");
      setToken(j.token);
      setCommand(j.command);
      setProgress(10);
      stopPolling();
      pollRef.current = setInterval(() => poll(j.token), 2000);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : "Could not start provisioning");
    } finally { setBusy(false); }
  }

  function toggle(list: string[], v: string, set: (x: string[]) => void) {
    set(list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  }
  async function configure() {
    if (!token) return;
    setBusy(true); setErr(null);
    try {
      const res = await fetch(`/api/provision/mikrotik/configure/${token}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          mode, wan_interface: wan,
          hotspot_interfaces: hsPorts, pppoe_interfaces: pppPorts,
          hotspot_subnet: hsSubnet, hotspot_range: hsRange, hotspot_dns: hsDns,
          pppoe_pool: pppoePool, pppoe_ranges: pppoeRanges, pppoe_local: pppoeLocal,
          // The secret from router creation is used automatically; the field
          // stays empty unless the operator needs to override it.
          radius_secret: secret || radiusSecret,
        }),
      });
      const j = await res.json();
      if (!res.ok) {
        setErr([...(j.errors ?? []), ...(j.warnings ?? [])].join(" ") || j.error || "Rejected");
        return;
      }
      setScript(j.script);
      setWarnings(j.warnings ?? []);
      if (j.heartbeat_note) setWarnings((w) => [...w, j.heartbeat_note]);
      setProgress(80);
      setStatus("CONFIGURED");
      stopPolling();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : "Could not build the script");
    } finally { setBusy(false); }
  }

  const step = !token ? 0 : status === "CAPABILITIES_DETECTED" ? 2 : script ? 3 : 1;
  const eth = ifaces.filter((i) => i.type === "ethernet");

  return (
    <div className="space-y-4">
      <ol className="flex flex-wrap gap-2 text-xs" aria-label="Provisioning steps">
        {STEPS.map((s, i) => (
          <li key={s}
            className={`rounded-full px-3 py-1 ${i === step ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-600"}`}
            aria-current={i === step ? "step" : undefined}>
            {i + 1}. {s}
          </li>
        ))}
      </ol>

      {err && <p className="err-box" role="alert">{err}</p>}

      {/* ---- Step 1 ---- */}
      <section className="card space-y-3">
        <h2 className="panel-title">1. Connect the router</h2>
        <p className="hint">
          Paste this into the MikroTik <em>Terminal</em>. It only READS the
          hardware and reports it back. Nothing is configured yet.
        </p>
        {!command ? (
          <button className="btn-primary w-full sm:w-auto" onClick={start} disabled={busy}>
            {busy ? "Starting…" : "Generate connect command"}
          </button>
        ) : (
          <>
            <pre className="code-block break-all text-xs">{command}</pre>
            <button className="btn-ghost w-full sm:w-auto"
              onClick={() => {
                navigator.clipboard.writeText(command);
                setCopied(true); setTimeout(() => setCopied(false), 1500);
              }}>
              {copied ? "Copied" : "Copy command"}
            </button>
            <p className="hint" aria-live="polite">
              {status === "PENDING" ? "Connecting…" : status ?? ""}
            </p>
          </>
        )}
      </section>

      {/* ---- Step 2 ---- */}
      {status && status !== "PENDING" && (
        <section className="card space-y-2" aria-live="polite">
          <h2 className="panel-title">2. Router detected</h2>
          {detectError ? (
            <p className="err-box">{detectError}</p>
          ) : (
            <dl className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
              <div><dt className="text-xs text-slate-500">Board</dt><dd className="font-semibold">{board ?? "—"}</dd></div>
              <div><dt className="text-xs text-slate-500">RouterOS</dt><dd className="font-semibold">{version ?? "—"}</dd></div>
              <div><dt className="text-xs text-slate-500">Interfaces</dt><dd className="font-semibold">{ifaces.length}</dd></div>
              <div><dt className="text-xs text-slate-500">Bridges</dt><dd className="font-semibold">{bridges.length}</dd></div>
            </dl>
          )}
          {caps?.wireguard && !caps.wireguard.supported && (
            <p className="hint text-amber-700">{caps.wireguard.reason}</p>
          )}
        </section>
      )}
      {/* ---- Step 3 ---- */}
      {ifaces.length > 0 && !script && (
        <section className="card space-y-4">
          <h2 className="panel-title">3. Configure</h2>

          <fieldset>
            <legend className="label">Mode</legend>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              {MODES.map((m) => (
                <label key={m}
                  className={`flex min-h-[44px] cursor-pointer items-center justify-center rounded-lg border px-3 text-sm font-medium ${mode === m ? "border-slate-900 bg-slate-900 text-white" : "border-slate-300"}`}>
                  <input type="radio" name="np-mode" value={m} checked={mode === m}
                    onChange={() => setMode(m)} className="sr-only" />
                  {modeLabel(m)}
                </label>
              ))}
            </div>
          </fieldset>

          <fieldset>
            <legend className="label">WAN port</legend>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {eth.map((i) => (
                <label key={i.name}
                  className={`flex min-h-[44px] cursor-pointer items-center gap-2 rounded-lg border px-3 text-sm ${wan === i.name ? "border-slate-900 bg-slate-900 text-white" : "border-slate-300"}`}>
                  <input type="radio" name="np-wan" checked={wan === i.name}
                    onChange={() => setWan(i.name)} className="sr-only" />
                  <span className="font-mono font-semibold">{i.name}</span>
                  {i.in_bridge && <span className="text-[10px] opacity-80">in {i.in_bridge}</span>}
                </label>
              ))}
            </div>
            <p className="hint">A port already in a bridge cannot be the WAN.</p>
          </fieldset>

          {(mode === "HOTSPOT" || mode === "HOTSPOT_PPPOE") && (
            <fieldset className="space-y-2">
              <legend className="label">HotSpot ports</legend>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {eth.filter((i) => i.name !== wan).map((i) => (
                  <button key={i.name} type="button"
                    onClick={() => toggle(hsPorts, i.name, setHsPorts)}
                    className={`min-h-[44px] rounded-lg border px-3 text-left text-sm ${hsPorts.includes(i.name) ? "border-emerald-600 bg-emerald-50" : "border-slate-300"}`}>
                    <span className="font-mono font-semibold">{i.name}</span>
                    {i.in_bridge && <span className="block text-[10px] text-amber-700">currently in {i.in_bridge}</span>}
                  </button>
                ))}
              </div>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                <input className="input" placeholder="HotSpot subnet 10.5.50.0/24" value={hsSubnet}
                  onChange={(e) => setHsSubnet(e.target.value)} />
                <input className="input" placeholder="Pool range 10.5.50.10-10.5.50.250" value={hsRange}
                  onChange={(e) => setHsRange(e.target.value)} />
                <input className="input" placeholder="Login DNS login.isp.net" value={hsDns}
                  onChange={(e) => setHsDns(e.target.value)} />
              </div>
            </fieldset>
          )}

          {(mode === "PPPOE" || mode === "HOTSPOT_PPPOE") && (
            <fieldset className="space-y-2">
              <legend className="label">PPPoE ports</legend>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {eth.filter((i) => i.name !== wan && !hsPorts.includes(i.name)).map((i) => (
                  <button key={i.name} type="button"
                    onClick={() => toggle(pppPorts, i.name, setPppPorts)}
                    className={`min-h-[44px] rounded-lg border px-3 text-left text-sm ${pppPorts.includes(i.name) ? "border-emerald-600 bg-emerald-50" : "border-slate-300"}`}>
                    <span className="font-mono font-semibold">{i.name}</span>
                  </button>
                ))}
              </div>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                <input className="input" placeholder="Pool name pool-pppoe" value={pppoePool}
                  onChange={(e) => setPppoePool(e.target.value)} />
                <input className="input" placeholder="Range 100.64.10.2-100.64.10.250" value={pppoeRanges}
                  onChange={(e) => setPppoeRanges(e.target.value)} />
                <input className="input" placeholder="Local address 100.64.10.1" value={pppoeLocal}
                  onChange={(e) => setPppoeLocal(e.target.value)} />
              </div>
            </fieldset>
          )}

          <div>
            <label className="label" htmlFor="np-secret">RADIUS shared secret (optional)</label>
            <input id="np-secret" type="password" className="input" value={secret}
              onChange={(e) => setSecret(e.target.value)}
              placeholder="blank = use the secret already stored for this router" />
            <p className="hint">Never stored here. Used to build the script, then discarded.</p>
          </div>

          <button className="btn-primary w-full sm:w-auto" onClick={configure} disabled={busy}>
            {busy ? "Building…" : "Build configuration script"}
          </button>
        </section>
      )}
      {/* ---- Step 4 ---- */}
      {script && (
        <section className="card space-y-2">
          <h2 className="panel-title">4. Apply on the router</h2>
          {warnings.map((w) => <p key={w} className="hint text-amber-700">{w}</p>)}
          <pre className="code-block max-h-96 overflow-auto text-xs">{script}</pre>
          <button className="btn-ghost w-full sm:w-auto"
            onClick={() => navigator.clipboard.writeText(script)}>
            Copy script
          </button>
          <p className="hint font-semibold">
            Pasted does not mean online. NETPID marks this router ONLINE only
            after a RouterOS API health check succeeds over the management path.
          </p>
          <div>
            <div className="mb-1 h-2 w-full rounded bg-slate-200">
              <div className="h-2 rounded bg-emerald-600 transition-all" style={{ width: `${progress}%` }} />
            </div>
            <p className="hint" aria-live="polite">{progress}% — script generated</p>
          </div>
        </section>
      )}
    </div>
  );
}