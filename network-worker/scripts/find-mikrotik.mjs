/**
 * Find MikroTik routers on the local network.
 *
 * The user asked to connect from WinBox, so this speaks WinBox's own discovery
 * protocol (UDP broadcast 20514) as well as scanning the usual RouterOS service
 * ports. Broadcast discovery only finds routers on the same broadcast domain,
 * so a TCP sweep runs alongside it: a router on a different VLAN still has a
 * reachable IP even when its discovery packets never arrive.
 *
 * Run: node scripts/find-mikrotik.mjs [subnet] [interface]
 */
import dgram from "node:dgram";
import net from "node:net";
import os from "node:os";

/** RouterOS service ports, and what each one tells us. */
const PORTS = [
  [8728, "api"],
  [8291, "winbox"],
  [22, "ssh"],
  [23, "telnet"],
  [80, "webfig"],
  [443, "https"],
  [161, "snmp"],
];

/** MikroTik MAC OUI. RouterBOARDs are 00:0C:42, CHR uses 08:00:27. */
const MIKROTIK_MAC = /^00[-:]?0[cC][-:]?42|^08[-:]?00[-:]?27/;

const subnetArg = process.argv[2];
const ifaceArg = process.argv[3];

function subnets() {
  if (subnetArg) return [subnetArg];
  const out = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family !== "IPv4" || a.internal) continue;
      if (ifaceArg && !name.includes(ifaceArg)) continue;
      const p = a.address.split(".").slice(0, 3).join(".");
      out.push(`${p}.0/24`);
    }
  }
  return [...new Set(out)];
}

/** WinBox discovery: a fixed 10-byte M2 packet, broadcast on UDP 20514. */
function winboxSweep() {
  return new Promise((resolve) => {
    const found = [];
    const socks = [];
    let done = 0;
    for (const s of subnets()) {
      // dgram, not net: UDP discovery has no connection, and net.createSocket
      // does not exist, which is a confusing way to learn that.
      const sock = dgram.createSocket({ type: "udp4", reuseAddr: true });
      socks.push(sock);
      try {
        sock.bind(0);
        sock.setBroadcast(true);
        sock.on("message", (buf, rinfo) => {
          found.push({ ip: rinfo.address, bytes: buf.length,
            hex: buf.toString("hex").slice(0, 60) });
        });
        // M2 discovery request.
        const pkt = Buffer.from([0x01, 0x00, 0x00, 0x00, 0x06, 0x01, 0x00, 0x5b, 0x00, 0x06]);
        sock.send(pkt, 20514, "255.255.255.255");
        const bcast = s.split("/")[0].split(".").slice(0, 3).join(".") + ".255";
        sock.send(pkt, 20514, bcast);
        done++;
      } catch { /* no permission for broadcast on this adapter */ }
    }
    setTimeout(() => {
      for (const s of socks) s.close();
      resolve({ found, tried: done });
    }, 4000);
  });
}

function probe(ip, port) {
  return new Promise((resolve) => {
    const s = net.connect({ host: ip, port, timeout: 700 }, () => {
      s.destroy(); resolve(true);
    });
    s.on("error", () => resolve(false));
    s.on("timeout", () => { s.destroy(); resolve(false); });
  });
}

async function sweep(cidr) {
  const base = cidr.split("/")[0].split(".").slice(0, 3);
  const hosts = [];
  for (let i = 1; i < 255; i++) hosts.push(`${base.join(".")}.${i}`);
  const results = [];
  // A bounded pool: 254 addresses x 7 ports is 1778 sockets otherwise.
  const queue = hosts.flatMap((ip) => PORTS.map(([port, name]) => [ip, port, name]));
  const workers = Array.from({ length: 128 }, async () => {
    while (queue.length) {
      const [ip, port, name] = queue.shift();
      if (await probe(ip, port)) results.push({ ip, port, name });
    }
  });
  await Promise.all(workers);
  return results;
}

console.log("  subnets:", subnets().join(", ") || "(none found)");
const wb = await winboxSweep();
console.log(`  WinBox discovery (UDP 20514): ${wb.found.length} reply/replies`);
for (const f of wb.found) console.log(`    ${f.ip}  ${f.bytes} bytes  ${f.hex}`);

for (const s of subnets()) {
  console.log(`  sweeping ${s} ...`);
  const r = await sweep(s);
  if (!r.length) { console.log("    nothing open"); continue; }
  // Group by host so a router reads as one line.
  const byIp = {};
  for (const x of r) (byIp[x.ip] ??= []).push(`${x.port}/${x.name}`);
  for (const [ip, ports] of Object.entries(byIp)) {
    console.log(`    ${ip}  ${ports.join("  ")}`);
  }
}
