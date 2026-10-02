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

/** One router-reported step, as /status maps it. */
interface Step { step: string; pct: number; at: string; label: string }

/**
 * The order the script reports in, so the operator can see what is still to come
 * instead of only what has happened. `pppoe` is absent from the HotSpot-only
 * run; the server simply never reports it and it drops off the list.
 */
const RUN_STEPS = [
  "start", "interfaces", "bridge", "hotspot",
  "pppoe", "radius", "management", "verify", "done",
] as const;

const STEPS = ["Connect", "Detect", "Configure", "Apply"] as const;
const MODES: Mode[] = ["HOTSPOT", "PPPOE", "HOTSPOT_PPPOE"];
const modeLabel = (m: Mode) =>
  m === "HOTSPOT_PPPOE" ? "HotSpot + PPPoE" : m === "HOTSPOT" ? "HotSpot" : "PPPoE";

/**
 * Prefilled, not blank.
 *
 * The operator's job here is to say which port is the WAN and which carry
 * customers. Every number below is a house default chosen to be valid on a
 * fresh box and to not collide with a LAN the router already has, so making the
 * operator type them is work with no decision in it. They stay editable because
 * an ISP with an existing numbering plan will need to change them, which is why
 * they sit behind "Advanced" rather than being hidden.
 *
 * 10.5.50.0/24 for HotSpot, 100.64.10.0/24 for PPPoE. The PPPoE range is
 * 100.64.0.0/10, the RFC 6598 shared address space, so it cannot clash with
 * RFC 1918 space on the LAN side.
 */
const DEFAULTS: Record<string, string> = {
  hsSubnet: "10.5.50.0/24",
  hsRange: "10.5.50.10-10.5.50.250",
  hsDns: "login.netpid.net",
  pppoePool: "pool-pppoe",
  pppoeRanges: "100.64.10.10-100.64.10.250",
  pppoeLocal: "100.64.10.1",
};

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
  const [hsSubnet, setHsSubnet] = useState(DEFAULTS.hsSubnet);
  const [hsRange, setHsRange] = useState(DEFAULTS.hsRange);
  const [hsDns, setHsDns] = useState(DEFAULTS.hsDns);
  const [pppoePool, setPppePool] = useState(DEFAULTS.pppoePool);
  const [pppoeRanges, setPppoeRanges] = useState(DEFAULTS.pppoeRanges);
  const [pppoeLocal, setPppoeLocal] = useState(DEFAULTS.pppoeLocal);
  const [secret, setSecret] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);

  const [script, setScript] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [progress, setProgress] = useState(0);
  const [steps, setSteps] = useState<Step[]>([]);
  /** The ordered, labelled steps this run will report, from /status. */
  const [plan, setPlan] = useState<Array<{ step: string; label: string }>>([]);
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
      // The router's own account of the run. This is what turns a frozen bar
      // into a checklist the operator can watch move.
      if (Array.isArray(j.steps)) setSteps(j.steps);
      if (Array.isArray(j.plan)) setPlan(j.plan);
      if (Array.isArray(j.interfaces)) {
        setIfaces(j.interfaces);
        setBridges(j.bridges ?? []);
        // Preselect the most likely WAN once, so the common case needs no taps.
        setWan((w) => w || (j.interfaces.find((i: Iface) => i.is_candidate_wan)?.name ?? ""));
      }
      // CONFIGURED is NOT a stopping point any more: that is the status the
      // session sits at while the operator pastes the script and the router
      // works through it. Only a terminal status or the script's own final
      // `done` tick ends the poll.
      const finished = Array.isArray(j.steps) && j.steps.some((s: Step) => s.step === "done");
      if (finished || ["FAILED", "EXPIRED", "CANCELLED", "APPLIED"].includes(j.status)) {
        stopPolling();
      }
    } catch { /* a dropped poll is not fatal; the next retries */ }
  }, [stopPolling]);

  /** Starts (or restarts) the 2s poll. Safe to call more than once. */
  const startPolling = useCallback((t: string) => {
    stopPolling();
    pollRef.current = setInterval(() => poll(t), 2000);
  }, [stopPolling, poll]);

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
      setSteps([]);
      startPolling(j.token);
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
      // Keep polling. The operator has not pasted anything yet, and the moment
      // they do the router starts reporting each step - the wizard has to still
      // be listening then. This used to stop the poll here, which is why the
      // bar could never move again.
      setSteps([]);
      startPolling(token);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : "Could not build the script");
    } finally { setBusy(false); }
  }

  const step = !token ? 0 : status === "CAPABILITIES_DETECTED" ? 2 : script ? 3 : 1;

  // ---- Live run progress -------------------------------------------------
  // The router reports each boundary; these turn that stream into rows the
  // operator can read. The PLAN comes from the server (it knows the step
  // vocabulary and the mode), so pending rows can be shown before the router
  // has reported anything at all.
  const done = new Set(steps.map((s) => s.step));
  const finished = done.has("done");
  // Once the script is on the router its own percentage is the truth; before
  // that the wizard's 70/80 marks are the only numbers there are.
  const livePct = steps.length ? steps[steps.length - 1].pct : progress;

  const shownSteps: Array<{ id: string; label: string; state: "done" | "current" | "pending" }> =
    (plan.length ? plan : RUN_STEPS.map((id) => ({ step: id, label: id })))
      .filter((p) => p.step !== "pppoe" || mode !== "HOTSPOT")
      .map((p) => ({
        id: p.step,
        label: p.label,
        state: done.has(p.step) ? "done" : finished ? "pending"
          : steps.length === 0 ? "pending" : "current",
      }));

  const eth = ifaces.filter((i) => i.type === "ethernet");
  // Wireless can serve customers, so it belongs in the HotSpot picker. It is
  // never a WAN candidate and never a PPPoE port: a radio cannot be enslaved to
  // a bridge, and PPPoE needs a wired endpoint.
  const wireless = ifaces.filter((i) => i.type === "wireless");
  const pickable = [...eth.filter((i) => i.name !== wan), ...wireless];

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
            <>
            <dl className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
              <div><dt className="text-xs text-slate-500">Board</dt><dd className="font-semibold">{board ?? "—"}</dd></div>
              <div><dt className="text-xs text-slate-500">RouterOS</dt><dd className="font-semibold">{version ?? "—"}</dd></div>
              <div><dt className="text-xs text-slate-500">Interfaces</dt><dd className="font-semibold">{ifaces.length}</dd></div>
              <div><dt className="text-xs text-slate-500">Bridges</dt><dd className="font-semibold">{bridges.length}</dd></div>
            </dl>
            {/* The names, not just the count. A count of 1 on a five-port board
                is the kind of wrong that is obvious only if you can see what was
                actually reported, and this is the only place it is visible. */}
            {ifaces.length > 0 && (
              <p className="hint">
                Ports found:{" "}
                <span className="font-mono">{ifaces.map((i) => i.name).join(", ")}</span>
              </p>
            )}
            </>
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
                  {i.in_bridge && (
                    <span className="text-[10px] opacity-80">will leave {i.in_bridge}</span>
                  )}
                </label>
              ))}
            </div>
            <p className="hint">
              A port already in a bridge cannot be the WAN.
              {eth.length === 0 && " No free ethernet port was reported."}
            </p>
          </fieldset>

          {(mode === "HOTSPOT" || mode === "HOTSPOT_PPPOE") && (
            <fieldset className="space-y-2">
              <legend className="label">HotSpot ports</legend>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {pickable.map((i) => (
                  <button key={i.name} type="button"
                    onClick={() => toggle(hsPorts, i.name, setHsPorts)}
                    aria-pressed={hsPorts.includes(i.name)}
                    className={`min-h-[44px] rounded-lg border px-3 text-left text-sm ${hsPorts.includes(i.name) ? "border-emerald-600 bg-emerald-50" : "border-slate-300"}`}>
                    <span className="font-mono font-semibold">{i.name}</span>
                    <span className="ml-1 text-[10px] uppercase text-slate-500">
                      {i.type === "wireless" ? "wifi" : "lan"}
                    </span>
                    {i.in_bridge && <span className="block text-[10px] text-amber-700">currently in {i.in_bridge}</span>}
                  </button>
                ))}
              </div>
              {/* Subnet, range and DNS are prefilled and hidden by default: the
                  operator came here to pick ports, not to type addresses. They
                  stay reachable because an ISP with an existing numbering plan
                  genuinely needs to change them. */}
              {showAdvanced && (
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                  <input className="input" autoComplete="off" spellCheck={false}
                    aria-label="HotSpot subnet" placeholder="HotSpot subnet" value={hsSubnet}
                    onChange={(e) => setHsSubnet(e.target.value)} />
                  <input className="input" autoComplete="off" spellCheck={false}
                    aria-label="HotSpot pool range" placeholder="Pool range" value={hsRange}
                    onChange={(e) => setHsRange(e.target.value)} />
                  <input className="input" autoComplete="off" spellCheck={false}
                    aria-label="Login DNS name" placeholder="Login DNS" value={hsDns}
                    onChange={(e) => setHsDns(e.target.value)} />
                </div>
              )}
            </fieldset>
          )}

          {(mode === "PPPOE" || mode === "HOTSPOT_PPPOE") && (
            <fieldset className="space-y-2">
              <legend className="label">PPPoE ports</legend>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {eth.filter((i) => i.name !== wan && !hsPorts.includes(i.name)).map((i) => (
                  <button key={i.name} type="button"
                    onClick={() => toggle(pppPorts, i.name, setPppPorts)}
                    aria-pressed={pppPorts.includes(i.name)}
                    className={`min-h-[44px] rounded-lg border px-3 text-left text-sm ${pppPorts.includes(i.name) ? "border-emerald-600 bg-emerald-50" : "border-slate-300"}`}>
                    <span className="font-mono font-semibold">{i.name}</span>
                  </button>
                ))}
              </div>
              {showAdvanced && (
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                  <input className="input" autoComplete="off" spellCheck={false}
                    aria-label="PPPoE pool name" placeholder="Pool name" value={pppoePool}
                    onChange={(e) => setPppePool(e.target.value)} />
                  <input className="input" autoComplete="off" spellCheck={false}
                    aria-label="PPPoE range" placeholder="Range" value={pppoeRanges}
                    onChange={(e) => setPppoeRanges(e.target.value)} />
                  <input className="input" autoComplete="off" spellCheck={false}
                    aria-label="PPPoE local address" placeholder="Local address" value={pppoeLocal}
                    onChange={(e) => setPppoeLocal(e.target.value)} />
                </div>
              )}
            </fieldset>
          )}

          <div>
            <button type="button" className="btn-ghost w-full sm:w-auto"
              aria-expanded={showAdvanced}
              onClick={() => setShowAdvanced((v) => !v)}>
              {showAdvanced ? "Hide addressing" : "Change addressing (subnet, range, DNS)"}
            </button>
          </div>

          <div>
            <label className="label" htmlFor="np-secret">RADIUS shared secret (optional)</label>
            <input id="np-secret" type="password" className="input" autoComplete="new-password"
              value={secret} onChange={(e) => setSecret(e.target.value)}
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

          {/* Live progress, reported by the ROUTER as it runs the script.
              Before this the panel showed one frozen caption forever, which was
              identical whether the operator had not pasted yet, was three lines
              in, or had just finished. */}
          <div className="space-y-2" aria-live="polite">
            <div>
              <div className="mb-1 h-2 w-full rounded bg-slate-200">
                <div className="h-2 rounded bg-emerald-600 transition-all"
                  style={{ width: `${Math.max(progress, livePct)}%` }} />
              </div>
              <p className="hint">
                {steps.length === 0
                  ? `${livePct}% — paste the script on the router to start`
                  : `${livePct}% — ${steps[steps.length - 1].label}`}
              </p>
            </div>

            <ol className="space-y-1 text-sm">
              {shownSteps.map((s) => (
                <li key={s.id} className="flex items-start gap-2">
                  <span aria-hidden="true"
                    className={s.state === "done" ? "text-emerald-700"
                      : s.state === "current" ? "text-amber-600" : "text-slate-400"}>
                    {s.state === "done" ? "✓" : s.state === "current" ? "▸" : "·"}
                  </span>
                  <span className={s.state === "pending" ? "text-slate-400" : ""}>
                    {s.label}
                  </span>
                  <span className="sr-only">
                    {s.state === "done" ? "completed" : s.state === "current" ? "in progress" : "not started"}
                  </span>
                </li>
              ))}
            </ol>

            {finished && (
              <p className="hint font-semibold">
                The router finished the script. Read the CONFIGURATION REPORT it
                printed: it lists any property this RouterOS refused, and shows
                which objects it found missing.
              </p>
            )}
            {!finished && steps.length > 0 && (
              <p className="hint">
                These steps mean the router REACHED them. They are not proof the
                objects were created - the report at the end of the script reads
                the router back and prints what actually exists.
              </p>
            )}
          </div>
        </section>
      )}
    </div>
  );
}
