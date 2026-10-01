/**
 * Reach the router through WebFig, which tunnels the RouterOS API over a
 * WebSocket.
 *
 * Why this path and not the obvious ones:
 *   - 8728 (API)      closed on this router
 *   - 8291 (WinBox)   open, but encrypted and undocumented
 *   - 22/23 (ssh/tel) closed
 *   - 80  (WebFig)    open, and /webfig/ upgrades to a WebSocket carrying the
 *                     same length-prefixed sentences the API uses
 *
 * RouterOS 7 WebFig is normally driven from a browser: the login form only
 * stashes the password in sessionStorage and redirects, so there is no form to
 * post and no cookie to keep. The credential exchange has to be spoken directly.
 *
 * Run: node scripts/webfig-socket.mjs login [user] [password]
 *     node scripts/webfig-socket.mjs exec "/system/resource/print"
 */
import http from "node:http";
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";

export const HOST = process.env.NETPID_ROUTER ?? "192.168.8.2";

/** RouterOS API sentence: 4-byte little-endian length, then words + NUL. */
export function sentence(words) {
  const payload = Buffer.from(words.map((w) => w + " ").join("") + "\0", "utf8");
  const head = Buffer.alloc(4);
  head.writeUInt32LE(payload.length, 0);
  return Buffer.concat([head, payload]);
}

export function decode(buffer) {
  const out = [];
  let off = 0;
  while (off + 4 <= buffer.length) {
    const len = buffer.readUInt32LE(off);
    if (off + 4 + len > buffer.length) break;
    const words = buffer.subarray(off + 4, off + 4 + len).toString("utf8")
      .split(" ").filter(Boolean);
    off += 4 + len;
    if (words.length) out.push(words);
  }
  return { sentences: out, rest: buffer.subarray(off) };
}

/** Minimal RFC 6455 client: binary frames, masked as clients must send. */
class WsSocket {
  constructor(raw) {
    this.raw = raw;
    this.buf = Buffer.alloc(0);
    this.handlers = [];
    raw.on("data", (c) => {
      this.buf = Buffer.concat([this.buf, c]);
      this.pump();
    });
  }
  pump() {
    for (;;) {
      if (this.buf.length < 2) return;
      const opcode = this.buf[0] & 0x0f;
      const masked = (this.buf[1] & 0x80) !== 0;
      let len = this.buf[1] & 0x7f;
      let off = 2;
      if (len === 126) {
        if (this.buf.length < 4) return;
        len = this.buf.readUInt16BE(2); off = 4;
      } else if (len === 127) {
        if (this.buf.length < 10) return;
        len = Number(this.buf.readBigUInt64BE(2)); off = 10;
      }
      if (masked) off += 4;
      if (this.buf.length < off + len) return;
      const payload = this.buf.subarray(off, off + len);
      this.buf = this.buf.subarray(off + len);
      const h = this.handlers.shift();
      if (h && (opcode === 1 || opcode === 2)) h(payload);
    }
  }
  send(buf) {
    const mask = crypto.randomBytes(4);
    const masked = Buffer.from(buf);
    for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i % 4];
    const head = [0x82];                              // FIN + binary
    if (masked.length < 126) head.push(0x80 | masked.length);
    else if (masked.length < 65536) {
      head.push(0x80 | 126);
      const l = Buffer.alloc(2); l.writeUInt16BE(masked.length); head.push(l);
    } else {
      head.push(0x80 | 127);
      const l = Buffer.alloc(8); l.writeBigUInt64BE(BigInt(masked.length)); head.push(l);
    }
    this.raw.write(Buffer.concat([Buffer.from(head), mask, masked]));
  }
  next(timeoutMs = 15_000) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("no frame received")), timeoutMs);
      this.handlers.push((p) => { clearTimeout(t); resolve(p); });
    });
  }
  close() { this.raw.destroy(); }
}

export function openSocket(path = "/webfig/", host = HOST) {
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString("base64");
    const req = http.request({
      host, port: 80, path, method: "GET", timeout: 20_000,
      headers: {
        Connection: "Upgrade", Upgrade: "websocket",
        "Sec-WebSocket-Key": key, "Sec-WebSocket-Version": "13",
        Origin: `http://${host}`, Host: host,
      },
    });
    req.on("upgrade", (res, socket) => {
      const accept = crypto.createHash("sha1")
        .update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
      if (res.headers["sec-websocket-accept"] !== accept) {
        socket.destroy();
        return reject(new Error("bad Sec-WebSocket-Accept"));
      }
      resolve(new WsSocket(socket));
    });
    req.on("response", (res) => {
      let body = "";
      res.on("data", (c) => { body += c; });
      res.on("end", () => reject(new Error(
        `upgrade refused: HTTP ${res.statusCode} ${body.slice(0, 160)}`)));
    });
    req.on("error", reject);
    req.end();
  });
}

/** Log in and return the session cookie, or throw with the router's reason. */
export async function login(user, pass) {
  const ws = await openSocket();
  try {
    ws.send(sentence(["/login", `=name=${user}`, `=password=${pass}`]));
    const { sentences } = decode(Buffer.from(await ws.next()));
    const trap = sentences.find((s) => s[0]?.startsWith("!trap") || s[0]?.startsWith("!fatal"));
    if (trap) throw new Error(trap.slice(1).join(" "));
    const done = sentences.find((s) => s[0]?.startsWith("!done"));
    if (!done) throw new Error(`unexpected login reply: ${JSON.stringify(sentences)}`);
    return { ws, cookie: done[1] ?? "", raw: sentences };
  } catch (e) {
    ws.close();
    throw e;
  }
}

/** Run one command, returning its reply lines. */
export async function call(ws, cookie, cmd) {
  ws.send(sentence([...cmd.split(/\s+/), `=${cookie}`]));
  const out = [];
  for (;;) {
    const { sentences } = decode(Buffer.from(await ws.next()));
    const finished = sentences.some((s) => s[0]?.startsWith("!done"));
    for (const s of sentences) {
      if (s[0] === "!done") continue;
      out.push(s[0]?.startsWith("!")
        ? `ERROR: ${s.slice(1).join(" ")}`
        : s.join(" "));
    }
    if (finished) return out;
  }
}

/** CLI entry point. */
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const mode = process.argv[2] ?? "login";
  const user = process.argv[3] ?? "admin";
  const pass = process.argv[4] ?? process.env.NETPID_ROUTER_PASS ?? "";

  if (mode === "login") {
    try {
      const { cookie, raw } = await login(user, pass);
      console.log(`  logged in as ${user}, session ${cookie.slice(0, 8)}...`);
      console.log(`  login reply: ${JSON.stringify(raw)}`);
      process.exit(0);
    } catch (e) {
      console.log(`  FAILED: ${e.message}`);
      process.exit(1);
    }
  }

  if (mode === "exec") {
    try {
      const { ws, cookie } = await login(user, pass);
      console.log(`  connected to ${HOST} as ${user}`);
      for (const cmd of process.argv.slice(5)) {
        console.log(`\n  $ ${cmd}`);
        for (const l of await call(ws, cookie, cmd)) console.log(`    ${l}`);
      }
      ws.close();
      process.exit(0);
    } catch (e) {
      console.log(`  FAILED: ${e.message}`);
      process.exit(1);
    }
  }
  console.log("usage: webfig-socket.mjs login [user] [pass] | exec [user] [pass] <cmd>...");
  process.exit(2);
}

