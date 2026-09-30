// router-capabilities: probe the box and store what it can actually do.
//
// Dynamic-imported by index.js. Reads /system/resource (arch, cpu, RAM,
// RouterOS version), /system/routerboard (model), /interface print (names),
// and feature presence (wireguard interface type, /ip/hotspot, /interface/vlan).
// NEVER writes config — probe only. The dashboard then picks the safest
// compatible provisioning profile (lib/profiles.ts).
import { mtConnect, mtCommand, mtClose } from "./mikrotik.js";
import { decryptSecret } from "./secrets.js";
import { selectProfile, capabilitySummary } from "./profiles.mjs";

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function mb(v) {
  // RouterOS reports KiB ("262144 KiB" or bare bytes); normalize to MiB.
  const s = String(v ?? "").replace(/,/g, "");
  const m = s.match(/([\d.]+)\s*([KMGT]?i?B)?/i);
  if (!m) return null;
  let kb = Number(m[1]);
  if (!Number.isFinite(kb)) return null;
  const unit = (m[2] || "").toLowerCase();
  if (unit.startsWith("g")) kb *= 1024 * 1024;
  else if (unit.startsWith("m")) kb *= 1024;
  else if (unit === "" || unit === "b") kb /= 1024;
  return Math.max(1, Math.round(kb / 1024));
}

export async function routerCapabilities(sb, job) {
  const { router_id } = job.payload ?? {};
  if (!router_id) throw new Error("router-capabilities missing router_id");
  const { data: router } = await sb.from("routers").select("*").eq("id", router_id).single();
  if (!router) throw new Error("router missing");
  const { data: cred } = await sb.from("router_credentials")
    .select("encrypted_password").eq("router_id", router_id).single();
  if (!cred) throw new Error("router credentials missing");
  const password = decryptSecret(cred.encrypted_password);

  let conn = null;
  const started = Date.now();
  try {
    conn = await mtConnect({
      host: String(router.host),
      port: router.use_ssl ? router.api_ssl_port : router.api_port,
      username: router.api_username, password, ssl: router.use_ssl,
      timeoutMs: 10000,
    });
    const run = (words) => mtCommand(conn, words);
    const [res] = await run(["/system/resource/print"]);
    const [board] = await run(["/system/routerboard/print"]).catch(() => [null]);
    const ifaces = await run(["/interface/print", "=.proplist=.id,name,type"]).catch(() => []);
    const hotspot = await run(["/ip/hotspot/print", "=.proplist=.id"]).catch(() => null);
    const vlan = await run(["/interface/vlan/print", "=.proplist=.id"]).catch(() => null);
    // WireGuard exists as an interface TYPE on ROS 7+ only.
    const wg = await run(["/interface/wireguard/print", "=.proplist=.id"]).catch(() => null);

    const version = String(res?.version ?? "");
    const major = version.startsWith("6.") ? "6" : "7";
    const caps = {
      ros_version: version || null,
      model: res?.["board-name"] ?? board?.model ?? null,
      arch: res?.architecture ?? res?.["cpu"] ?? null,
      cpu: res?.["cpu"] ?? null,
      cpu_cores: num(res?.["cpu-count"]) ?? 1,
      ram_mb: mb(res?.["total-memory"]),
      storage_mb: mb(res?.["total-hdd-space"] ?? res?.["free-hdd-space"]),
      has_wireguard: wg === null ? null : Array.isArray(wg),
      has_radius: true, // /ip/radius exists on every supported ROS
      has_pppoe: true,  // /ppp exists on every supported ROS
      has_hotspot: hotspot === null ? null : true,
      has_vlan: vlan === null ? null : true,
      has_api_ssl: Boolean(router.use_ssl),
    };
    const interfaces = (ifaces ?? []).map((i) => i.name).filter(Boolean).slice(0, 32);
    const { profile, notes } = selectProfile({
      ros_version: major, arch: caps.arch, ram_mb: caps.ram_mb,
      has_wireguard: major === "6" ? false : caps.has_wireguard,
      has_radius: true, has_pppoe: true,
      has_hotspot: caps.has_hotspot, has_vlan: caps.has_vlan,
      has_api_ssl: caps.has_api_ssl,
    });
    const summary = capabilitySummary({
      has_wireguard: major === "6" ? false : caps.has_wireguard,
      has_radius: true, has_pppoe: true,
      has_hotspot: caps.has_hotspot, has_vlan: caps.has_vlan,
      has_api_ssl: caps.has_api_ssl,
    });

    await sb.from("routers").update({
      ros_version: version || router.ros_version,
      model: caps.model ?? router.model,
      arch: caps.arch, cpu: caps.cpu, cpu_cores: caps.cpu_cores,
      ram_mb: caps.ram_mb, storage_mb: caps.storage_mb,
      interfaces_json: interfaces,
      has_wireguard: major === "6" ? false : caps.has_wireguard,
      has_radius: true, has_pppoe: true,
      has_hotspot: caps.has_hotspot, has_vlan: caps.has_vlan,
      has_api_ssl: caps.has_api_ssl,
      provisioning_profile: profile,
      capabilities_checked_at: new Date().toISOString(),
      script_ros_version: major,
      status: "online", last_seen_at: new Date().toISOString(),
      compatibility_notes: notes.join(" ") || null,
    }).eq("id", router_id);

    await sb.from("router_provision_log").insert({
      isp_id: job.isp_id, router_id, action: "capabilities-probed", source: "worker",
      detail: { profile, model: caps.model, ros: version, interfaces: interfaces.length, summary },
    });
    return { ok: true, profile, model: caps.model, ros: version, latency_ms: Date.now() - started };
  } catch (e) {
    throw new Error(`capabilities probe failed: ${String(e?.message ?? e)}`);
  } finally {
    if (conn) mtClose(conn);
  }
}
