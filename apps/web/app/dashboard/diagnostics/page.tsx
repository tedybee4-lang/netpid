"use client";

import { useState } from "react";

export default function DiagnosticsPage() {
  const [targetType, setTargetType] = useState<"customer" | "router">("customer");
  const [targetId, setTargetId] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<{
    diagnosis: string;
    suggested_action: string;
    severity: string;
  } | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const runDiagnostics = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setErrorMsg(null);
    setResult(null);

    try {
      const res = await fetch("/api/ai/diagnostics", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ target_type: targetType, target_id: targetId }),
      });
      const data = await res.json();
      if (!res.ok) {
        setErrorMsg(data.error || "Failed to run diagnostics");
      } else {
        setResult(data);
      }
    } catch (err: any) {
      setErrorMsg(err.message || "Network error");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="p-8 max-w-5xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">AI Network Diagnostics & Checklist</h1>
        <p className="text-sm text-muted-foreground">Heuristic automated diagnosis for offline PPPoE sessions, fiber degradation, and router outages.</p>
      </div>

      <div className="p-5 border rounded bg-card space-y-4">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">Run Diagnostic Scan</h2>
        <form onSubmit={runDiagnostics} className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="text-xs text-muted-foreground block mb-1">Target Element</label>
              <select
                value={targetType}
                onChange={(e) => {
                  setTargetType(e.target.value as any);
                  setTargetId("");
                  setResult(null);
                }}
                className="w-full text-sm border rounded p-2 bg-background"
              >
                <option value="customer">Customer PPPoE / Hotspot</option>
                <option value="router">MikroTik Router</option>
              </select>
            </div>
            <div>
              <label className="text-xs text-muted-foreground block mb-1">Target UUID</label>
              <input
                required
                placeholder={targetType === "customer" ? "Customer UUID..." : "Router UUID..."}
                value={targetId}
                onChange={(e) => setTargetId(e.target.value)}
                className="w-full text-sm border rounded p-2 bg-background font-mono"
              />
            </div>
          </div>
          <button
            type="submit"
            disabled={loading}
            className="px-4 py-2 text-xs font-semibold rounded bg-primary text-primary-foreground disabled:opacity-50"
          >
            {loading ? "Analyzing Network Telemetry..." : "Run AI Diagnosis"}
          </button>
        </form>
      </div>

      {errorMsg && (
        <div className="p-4 border rounded bg-rose-50 text-rose-700 dark:bg-rose-950/50 dark:text-rose-300 text-sm">
          {errorMsg}
        </div>
      )}

      {result && (
        <div className="p-5 border rounded bg-card space-y-4 border-l-4 border-l-primary">
          <div className="flex items-center justify-between">
            <h3 className="font-semibold text-base">Diagnostic Result</h3>
            <span className={`px-2 py-0.5 text-xs font-bold rounded uppercase ${
              result.severity === "critical" ? "bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-400" :
              result.severity === "high" ? "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-400" :
              "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-400"
            }`}>
              {result.severity}
            </span>
          </div>
          <div>
            <p className="text-xs uppercase text-muted-foreground font-semibold">Diagnosis</p>
            <p className="text-sm mt-1">{result.diagnosis}</p>
          </div>
          <div>
            <p className="text-xs uppercase text-muted-foreground font-semibold">Suggested Action</p>
            <p className="text-sm mt-1 text-primary font-medium">{result.suggested_action}</p>
          </div>
        </div>
      )}
    </div>
  );
}
