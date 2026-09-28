// Minimal MikroTik RouterOS API client (runs in worker / server routes only).
// Binary protocol: word length as variable-length prefix + words; login via
// /login with challenge/response MD5 when required (pre-6.43), plain otherwise.
import net from "node:net";
import tls from "node:tls";
import crypto from "node:crypto";

function encodeLen(len) {
  if (len < 0x80) return Buffer.from([len]);
  if (len < 0x4000) return Buffer.from([(len >> 8) | 0x80, len & 0xff]);
  if (len < 0x200000) return Buffer.from([(len >> 16) | 0xc0, (len >> 8) & 0xff, len & 0xff]);
  const b = Buffer.alloc(5); b[0] = 0xe0;
  b.writeUInt32BE(len, 1); return b;
}

function encodeSentence(words) {
  return Buffer.concat(words.map((w) => Buffer.concat([encodeLen(Buffer.byteLength(w)), Buffer.from(w)])));
}

// Connection handle: { socket, readSentence }
async function readSentence(socket, buf) {
  async function readLen() {
    while (true) {
      if (buf.data.length >= 1) {
        const c = buf.data[0];
        if (c < 0x80) { buf.data = buf.data.subarray(1); return c; }
        const need = c < 0xc0 ? 2 : c < 0xe0 ? 3 : 5;
        if (buf.data.length >= need) {
          let len;
          if (need === 2) len = ((c & 0x3f) << 8) | buf.data[1];
          else if (need === 3) len = ((c & 0x1f) << 16) | (buf.data[1] << 8) | buf.data[2];
          else len = buf.data.readUInt32BE(1);
          buf.data = buf.data.subarray(need); return len;
        }
      }
      await new Promise((res, rej) => {
        const onData = (dd) => { buf.data = Buffer.concat([buf.data, dd]); cleanup(); res(null); };
        const onErr = (ee) => { cleanup(); rej(ee); };
        const cleanup = () => { socket.off("data", onData); socket.off("error", onErr); };
        socket.on("data", onData); socket.on("error", onErr);
      });
    }
  }
  const words = [];
  while (true) {
    const len = await readLen();
    if (len === 0) break;
    while (buf.data.length < len) {
      await new Promise((res2, rej2) => {
        const onData2 = (dd2) => { buf.data = Buffer.concat([buf.data, dd2]); cleanup2(); res2(null); };
        const onErr2 = (ee2) => { cleanup2(); rej2(ee2); };
        const cleanup2 = () => { socket.off("data", onData2); socket.off("error", onErr2); };
        socket.on("data", onData2); socket.on("error", onErr2);
      });
    }
    words.push(buf.data.subarray(0, len).toString());
    buf.data = buf.data.subarray(len);
  }
  return words;
}

export async function mtConnect(opts) {
  const timeoutMs = opts.timeoutMs ?? 8000;
  const socket = opts.ssl
    ? tls.connect({ host: opts.host, port: opts.port, rejectUnauthorized: false, timeout: timeoutMs })
    : net.createConnection({ host: opts.host, port: opts.port, timeout: timeoutMs });
  await new Promise((resolve, reject) => {
    socket.once("connect", () => resolve());
    socket.once("secureConnect", () => resolve());
    socket.once("error", reject);
    socket.once("timeout", () => reject(new Error("Router connection timed out.")));
  });
  const buf = { data: Buffer.alloc(0) };
  socket.on("data", (d) => { buf.data = Buffer.concat([buf.data, d]); });
  const read = () => readSentence(socket, buf);
  const send = (words) => new Promise((resolve, reject) => {
    const sentences = [];
    const onData = () => {
      read().then((w) => {
        sentences.push(w);
        if (w.includes("!done") || w.includes("!fatal") || w.includes("!trap")) {
          socket.off("data", onData); resolve(sentences);
        }
      }).catch(reject);
    };
    socket.on("data", onData);
    socket.write(encodeSentence(words));
    setTimeout(() => { socket.off("data", onData); reject(new Error("Router did not respond.")); }, timeoutMs);
  });
  // Login (challenge/response for old RouterOS, plain for new)
  const loginRes = await send(["/login", `=name=${opts.username}`, `=password=${opts.password}`]);
  const flat = loginRes.flat();
  const chal = flat.find((w) => w.startsWith("=ret="))?.slice(5);
  if (chal) {
    const resp = "00" + crypto.createHash("md5")
      .update(Buffer.concat([Buffer.from([0]), Buffer.from(opts.password), Buffer.from(chal, "hex")])).digest("hex");
    const res2 = await send(["/login", `=name=${opts.username}`, `=response=${resp}`]);
    if (res2.flat().some((w) => w.includes("!trap") || w.includes("!fatal"))) {
      throw new Error("Router login failed (bad username/password).");
    }
  } else if (flat.some((w) => w.includes("!trap") || w.includes("!fatal"))) {
    throw new Error("Router login failed (bad username/password).");
  }
  return { socket, readSentence: read };
}

export async function mtCommand(conn, words) {
  return new Promise((resolve, reject) => {
    const rows = [];
    const onData = () => {
      conn.readSentence().then((w) => {
        if (w.includes("!re")) {
          const row = {};
          for (const part of w) {
            const m = part.match(/^=([^=]+)=(.*)$/);
            if (m) row[m[1]] = m[2];
          }
          rows.push(row);
        } else if (w.includes("!done")) { conn.socket.off("data", onData); resolve(rows); }
        else if (w.includes("!trap") || w.includes("!fatal")) {
          conn.socket.off("data", onData);
          reject(new Error("Router error: " + w.filter((x) => x.startsWith("=message=")).join("; ")));
        }
      }).catch(reject);
    };
    conn.socket.on("data", onData);
    conn.socket.write(encodeSentence(words));
  });
}

export function mtClose(conn) { try { conn.socket.destroy(); } catch { /* noop */ } }
