// In-process FreeRADIUS stand-in: answers Access-Request / Disconnect-Request
// with correctly signed RADIUS replies, so worker probes can be tested for real.
import crypto from "node:crypto";
import dgram from "node:dgram";

function encodePairs(attributes) {
  return Buffer.concat(attributes.map(([type, value]) => {
    const val = Buffer.isBuffer(value) ? value : Buffer.from(String(value), "utf8");
    const out = Buffer.alloc(2 + val.length);
    out[0] = type; out[1] = 2 + val.length; val.copy(out, 2);
    return out;
  }));
}

// Exported for reuse in assertions.
export function parseAttributes(packet) {
  const out = [];
  let off = 20;
  while (off + 2 <= packet.length) {
    const type = packet[off];
    const len = packet[off + 1];
    if (len < 2) break;
    out.push({ type, value: packet.subarray(off + 2, off + len) });
    off += len;
  }
  return out;
}

export function attributeText(packet, type) {
  const hit = parseAttributes(packet).find((a) => a.type === type);
  return hit ? hit.value.toString("utf8") : null;
}

export function buildSignedResponse({ code, id, requestAuthenticator, secret, attributes = [] }) {
  const attrs = encodePairs(attributes);
  const header = Buffer.alloc(20);
  header[0] = code; header[1] = id; header.writeUInt16BE(20 + attrs.length, 2);
  Buffer.from(requestAuthenticator).copy(header, 4);
  const body = Buffer.concat([header, attrs]);
  crypto.createHash("md5")
    .update(Buffer.concat([body, Buffer.from(secret, "utf8")])).digest()
    .copy(body, 4);
  return body;
}

// respond(requestPacket, rinfo) -> { code, attributes }
export function startFakeRadiusServer(secret, respond) {
  return new Promise((resolve) => {
    const seen = [];
    const server = dgram.createSocket("udp4");
    server.on("message", (msg, rinfo) => {
      seen.push(msg);
      const verdict = respond ? respond(msg, rinfo) : { code: 2 };
      if (!verdict) return; // simulate a silent server
      const reply = buildSignedResponse({
        code: verdict.code ?? 2, id: msg[1], requestAuthenticator: msg.subarray(4, 20),
        secret: verdict.secret ?? secret, attributes: verdict.attributes ?? [],
      });
      server.send(reply, rinfo.port, rinfo.address);
    });
    server.bind(0, "127.0.0.1", () => resolve({
      server, port: server.address().port, seen, close: () => server.close(),
    }));
  });
}

// A definitely-closed local UDP port (no listener -> no reply).
export function closedUdpPort() {
  return new Promise((resolve) => {
    const sock = dgram.createSocket("udp4");
    sock.bind(0, "127.0.0.1", () => {
      const port = sock.address().port;
      sock.close(() => resolve(port));
    });
  });
}
