// Capability-aware RouterOS provisioning profiles.
//
// The ISP should not need to understand MikroTik hardware differences.
// NETPID probes the router, picks the safest compatible profile, and says
// plainly what is NOT supported instead of failing silently.

export type RouterCaps = {
  ros_version?: string | null;
  arch?: string | null;
  ram_mb?: number | null;
  has_wireguard?: boolean | null;
  has_radius?: boolean | null;
  has_pppoe?: boolean | null;
  has_hotspot?: boolean | null;
  has_vlan?: boolean | null;
  has_api_ssl?: boolean | null;
};

export type Profile = "legacy" | "standard" | "advanced" | "enterprise";

/**
 * Pick the safest compatible profile from probed capabilities:
 *   legacy     — ROS 6 or no WireGuard (hAP lite/RB941-class, old firmware).
 *                RADIUS where supported, simplest VPN/management, minimal load.
 *   standard   — ROS 7, WireGuard + RADIUS + PPPoE/HotSpot (hEX/hAP/RB series).
 *   advanced   — standard + VLANs, multiple PPPoE/HotSpot services (RB4011/5009).
 *   enterprise — advanced + multi-WAN, advanced routing, richer monitoring
 *                (CCR series, high session counts).
 */
export function selectProfile(caps: RouterCaps): { profile: Profile; notes: string[] } {
  const notes: string[] = [];
  const ros = String(caps.ros_version ?? "").trim();
  const isRos6 = ros === "6" || ros.startsWith("6.");
  if (isRos6 || caps.has_wireguard === false) {
    if (isRos6) notes.push("RouterOS 6 has no WireGuard — using the legacy profile. Upgrade to RouterOS 7 for a WireGuard management tunnel.");
    else notes.push("WireGuard not available on this router — using the legacy profile with the simplest compatible management method.");
    if (caps.has_radius === false) notes.push("RADIUS not available — authentication stays local on the router.");
    return { profile: "legacy", notes };
  }
  const ram = Number(caps.ram_mb ?? 0);
  void caps.arch;
  if (ram >= 1024 && caps.has_vlan !== false) {
    return { profile: "enterprise", notes: ["High-memory platform: VLANs, multi-WAN and richer monitoring enabled."] };
  }
  if ((ram >= 256 && ram < 1024) || caps.has_vlan === true) {
    return { profile: "advanced", notes: ["VLANs and multiple PPPoE/HotSpot services enabled."] };
  }
  if (ram > 0 && ram < 64) {
    notes.push("Low-memory device — keeping configuration lightweight, minimal monitoring.");
  }
  return { profile: "standard", notes };
}

/** Human-readable capability line for the dashboard. */
export function capabilitySummary(caps: RouterCaps): string[] {
  const line = (label: string, v: boolean | null | undefined) =>
    `${label}: ${v == null ? "unknown" : v ? "yes" : "no"}`;
  return [
    line("WireGuard", caps.has_wireguard),
    line("RADIUS", caps.has_radius),
    line("PPPoE", caps.has_pppoe),
    line("HotSpot", caps.has_hotspot),
    line("VLAN", caps.has_vlan),
    line("API-SSL", caps.has_api_ssl),
  ];
}
