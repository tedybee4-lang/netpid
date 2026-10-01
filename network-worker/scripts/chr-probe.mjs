/**
 * Dump the raw bytes RouterOS sends, so the wire format can be read rather than
 * guessed. Guessing cost three failed attempts at the API client already.
 *
 * Run: node scripts/chr-probe.mjs
 */
import net from "node:net";

const sock = net.connect({ host: "127.0.0.1", port: 8722 });
await new Promise((r, j) => { sock.once("connect", r); sock.once("error", j); });
console.log("  connected");

/** Words are "=name=admin" style, or bare for the command. */
function sentence(words) {
  const payload = words.map((w) => w + " ").join("") + "\0";
  const b = Buffer.from(payload, "utf8");
  const h = Buffer.alloc(4);
  h.writeUInt32LE(b.length, 0);
  return Buffer.concat([h, b]);
}

const chunks = [];
sock.on("data", (c) => chunks.push(c));

sock.write(sentence(["/login", "=name=admin", "=password="]));
await new Promise((r) => setTimeout(r, 3000));
sock.destroy();

const all = Buffer.concat(chunks);
console.log(`  received ${all.length} bytes`);
let off = 0;
while (off + 4 <= all.length) {
  const len = all.readUInt32LE(off);
  if (off + 4 + len > all.length) { console.log("  (incomplete tail)"); break; }
  const body = all.subarray(off + 4, off + 4 + len);
  console.log(`  sentence len=${len} raw=${JSON.stringify(body.toString("utf8"))}`);
  console.log(`    words: ${JSON.stringify(body.toString("utf8").split(" ").filter(Boolean))}`);
  off += 4 + len;
}
