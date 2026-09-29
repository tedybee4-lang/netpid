import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { requireAdmin, getServer, readCredential, deriveStatus } from "@/lib/vps";
import { probeServer } from "@/lib/vps-probe";
import { audit } from "@/lib/platform-audit";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

// POST /api/admin/vps/[id]/test — open one SSH connection, report safe state.
//
// Returns ONLY operational facts. The credential, the private key and the
// encryption key never appear in the response, in any code path, including the
// failure path.
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const denied = await requireAdmin();
  if ("error" in denied) return denied.error;

  const { id } = await params;
  const row = await getServer(id);
  if (!row) return NextResponse.json({ error: "Server not found" }, { status: 404 });

  const credential = await readCredential(row);
  const result = await probeServer(row, credential);

  const svc = createServiceClient();
  const now = new Date().toISOString();

  if (result.ok) {
    // A successful probe is authoritative about the host's real state; it
    // refreshes the cached metrics so the list view is accurate immediately,
    // without waiting for the next heartbeat.
    await svc.from("vps_servers").update({
      os_name: row.os_name ?? undefined,
      os_version: result.os ?? row.os_name,
      kernel: result.kernel,
      cpu_percent: result.cpuPercent,
      mem_percent: result.memPercent,
      mem_total_mb: result.memTotalMb,
      disk_percent: result.diskPercent,
      disk_total_gb: result.diskTotalGb,
      uptime_seconds: result.uptimeSeconds,
      load_avg_1: result.load1,
      worker_status: result.worker === "active" ? "running"
        : result.worker === "inactive" || result.worker === "failed" ? "stopped" : "unknown",
      radius_status: result.radius === "active" ? "running"
        : result.radius === "inactive" || result.radius === "failed" ? "stopped" : "unknown",
      wireguard_status: result.wireguard === "active" ? "active" : "inactive",
      firewall_status: result.firewall === "active" ? "active" : "inactive",
      status: "online",
      last_health_check_at: now,
      last_health_error: null,
      // A reachable server with a stored credential is one we can now trust.
      credential_status: row.credential_status === "missing" ? row.credential_status : "active",
    }).eq("id", id);
  } else {
    await svc.from("vps_servers").update({
      last_health_check_at: now,
      last_health_error: (result.error ?? "probe failed").slice(0, 500),
    }).eq("id", id);
  }

  await svc.from("vps_health_events").insert({
    server_id: id,
    source: "ssh_test",
    status: result.ok ? "online" : deriveStatus(row.enabled, row.last_heartbeat_at),
    detail: result.ok
      ? { os: result.os, worker: result.worker, radius: result.radius,
          wireguard: result.wireguard, firewall: result.firewall,
          duration_ms: result.durationMs }
      : { duration_ms: result.durationMs },
    error: result.ok ? null : (result.error ?? "probe failed").slice(0, 500),
  });

  await audit({
    action: "vps_connection_tested",
    targetType: "vps_server", targetId: id, targetLabel: row.name,
    outcome: result.ok ? "ok" : "failed",
    detail: { duration_ms: result.durationMs ?? null },
  });

  return NextResponse.json({ result });
}
