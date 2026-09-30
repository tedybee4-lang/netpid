// Worker-side twin of apps/web/lib/profiles.ts (worker is plain Node ESM,
// cannot import the Next.js tree). Keep selectProfile + capabilitySummary in
// sync with the web copy: same thresholds, same notes.
export function selectProfile(caps = {}) {
  const notes = [];
  const ros = String(caps.ros_version ?? "").trim();
  const isRos6 = ros === "6" || ros.startsWith("6.");
  if (isRos6 || caps.has_wireguard === false) {
    if (isRos6) notes.push("RouterOS 6 has no WireGuard — using the legacy profile. Upgrade to RouterOS 7 for a WireGuard management tunnel.");
    else notes.push("WireGuard not available on this router — using the legacy profile with the simplest compatible management method.");
    if (caps.has_radius === false) notes.push("RADIUS not available — authentication stays local on the router.");
    return { profile: "legacy", notes };
  }
  const ram = Number(caps.ram_mb ?? 0);
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

export function capabilitySummary(caps = {}) {
  const line = (label, v) => `${label}: ${v == null ? "unknown" : v ? "yes" : "no"}`;
  return [
    line("WireGuard", caps.has_wireguard),
    line("RADIUS", caps.has_radius),
    line("PPPoE", caps.has_pppoe),
    line("HotSpot", caps.has_hotspot),
    line("VLAN", caps.has_vlan),
    line("API-SSL", caps.has_api_ssl),
  ];
}
