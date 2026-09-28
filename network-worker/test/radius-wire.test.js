// RADIUS wire-format tests — run with: node --test (from network-worker/)
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import dgram from "node:dgram";

import {
  ATTR, buildAccessRequest, buildDisconnectRequest, decryptUserPassword,
  encryptUserPassword, parsePacket, probeAccess, randomId, sendDisconnect,
  verifyMessageAuthenticator, verifyResponseAuthenticator, walkAttributes,
} from "../src/radius-wire.js";

const SECRET = "netpid-testing-123";

function md5(buf) {
  return crypto.createHash("md5").update(buf).digest();
}

// Independent response builder (mimics FreeRADIUS) so the client verifier is
// checked against an outside implementation, not against itself.
function buildResponse({ code, id, requestAuthenticator, secret, attributes = [] }) {
  const attrs = Buffer.concat(attributes.map(([t, v]) => {
    const val = Buffer.isBuffer(v) ? v : Buffer.from(String(v), "utf8");
    const out = Buffer.alloc(2 + val.length);
    out[0] = t; out[1] = 2 + val.length; val.copy(out, 2);
    return out;
  }));
  const header = Buffer.alloc(20);
  header[0] = code; header[1] = id; header.writeUInt16BE(20 + attrs.length, 2);
  Buffer.from(requestAuthenticator).copy(header, 4);
  const body = Buffer.concat([header, attrs]);
  md5(Buffer.concat([body, Buffer.from(secret, "utf8")])).copy(body, 4);
  return body;
}

function withFakeServer(code, secret, handler) {
  return new Promise((resolve) => {
    const server = dgram.createSocket("udp4");
    server.on("message", (msg, rinfo) => {
      const reply = buildResponse({
        code, id: msg[1], requestAuthenticator: msg.subarray(4, 20), secret,
        attributes: handler ? handler(msg) : [],
      });
      server.send(reply, rinfo.port, rinfo.address);
    });
    server.bind(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

test("Access-Request encodes the RFC 2865 required attributes", () => {
  const { packet, authenticator } = buildAccessRequest({
    secret: SECRET, username: "joe", password: "s3cret", nasIp: "10.0.0.1",
    nasIdentifier: "netpid-nas-1",
  });
  const parsed = parsePacket(packet);
  assert.equal(parsed.codeName, "Access-Request");
  const names = parsed.attributes.map((a) => a.name);
  assert.ok(names.includes("User-Name"));
  assert.ok(names.includes("NAS-IP-Address"));
  assert.ok(names.includes("Message-Authenticator"));
  // Password is never on the wire in clear text.
  assert.equal(packet.includes(Buffer.from("s3cret", "utf8")), false);
  const nasIp = parsed.attributes.find((a) => a.name === "NAS-IP-Address");
  assert.equal(nasIp.raw.length, 4);
  assert.deepEqual([...nasIp.raw], [10, 0, 0, 1]);
  assert.equal(authenticator.length, 16);
});

test("User-Password encryption round-trips for every block boundary", () => {
  for (const pw of ["a", "0123456789abcdef", "0123456789abcdefg", "x".repeat(128)]) {
    const auth = crypto.randomBytes(16);
    const cipher = encryptUserPassword(pw, SECRET, auth);
    assert.equal(cipher.length % 16, 0);
    const plain = decryptUserPassword(cipher, SECRET, auth);
    assert.equal(plain.subarray(0, Buffer.byteLength(pw)).toString("utf8"), pw);
  }
  assert.throws(() => encryptUserPassword("x".repeat(129), SECRET, crypto.randomBytes(16)));
});

test("Message-Authenticator detects tampering", () => {
  const { packet } = buildAccessRequest({ secret: SECRET, username: "joe", password: "p" });
  assert.equal(verifyMessageAuthenticator(packet, SECRET), true);
  assert.equal(verifyMessageAuthenticator(packet, "wrong-secret"), false);
  const tampered = Buffer.from(packet);
  tampered[22] = 0x41; // flip a User-Name byte
  assert.equal(verifyMessageAuthenticator(tampered, SECRET), false);
});

test("Disconnect-Request is Code 40 with Message-Authenticator + Event-Timestamp", () => {
  const { packet } = buildDisconnectRequest({ secret: SECRET, username: "joe", framedIp: "10.5.0.9" });
  const parsed = parsePacket(packet);
  assert.equal(parsed.code, 40);
  assert.equal(parsed.codeName, "Disconnect-Request");
  const names = parsed.attributes.map((a) => a.name);
  assert.ok(names.includes("Event-Timestamp"));
  assert.ok(names.includes("Message-Authenticator"));
  assert.ok(names.includes("Framed-IP-Address"));
  assert.equal(verifyMessageAuthenticator(packet, SECRET), true);
});

test("parsePacket rejects malformed packets", () => {
  assert.throws(() => parsePacket(Buffer.alloc(10)), /shorter than 20/);
  const { packet } = buildAccessRequest({ secret: SECRET, username: "joe", password: "p" });
  assert.throws(() => walkAttributes(packet.subarray(0, packet.length - 1)), /length mismatch/);
});

test("verifyResponseAuthenticator accepts a correctly signed reply only", () => {
  const auth = crypto.randomBytes(16);
  const id = randomId();
  const ok = buildResponse({ code: 3, id, requestAuthenticator: auth, secret: SECRET });
  assert.equal(verifyResponseAuthenticator(ok, auth, SECRET), true);
  assert.equal(verifyResponseAuthenticator(ok, auth, "other"), false);
  assert.equal(verifyResponseAuthenticator(ok.subarray(0, 19), auth, SECRET), false);
});

test("probeAccess: Access-Accept / Access-Reject are healthy, silence is offline", async () => {
  const accept = await withFakeServer(2, SECRET);
  try {
    const r = await probeAccess({
      host: "127.0.0.1", port: accept.port, secret: SECRET,
      username: "joe", password: "p", nasIp: "10.0.0.1", timeoutMs: 1500,
    });
    assert.equal(r.ok, true, r.detail);
    assert.equal(r.codeName, "Access-Accept");
    assert.equal(r.verified, true);
  } finally { accept.server.close(); }

  const reject = await withFakeServer(3, SECRET, () => [[ATTR["Reply-Message"], "no such user"]]);
  try {
    const r = await probeAccess({
      host: "127.0.0.1", port: reject.port, secret: SECRET,
      username: "ghost", password: "p", timeoutMs: 1500,
    });
    assert.equal(r.ok, true, "a signed Access-Reject proves the server is alive");
    assert.equal(r.codeName, "Access-Reject");
    assert.equal(r.replyMessage, "no such user");
  } finally { reject.server.close(); }

  const wrongSecret = await withFakeServer(2, "a-different-secret");
  try {
    const r = await probeAccess({
      host: "127.0.0.1", port: wrongSecret.port, secret: SECRET,
      username: "joe", password: "p", timeoutMs: 1500,
    });
    assert.equal(r.ok, false, "unsigned/wrong-secret reply must not count as online");
  } finally { wrongSecret.server.close(); }

  // Unreachable port -> no reply at all.
  const silent = dgram.createSocket("udp4");
  const port = await new Promise((res) => silent.bind(0, "127.0.0.1", () => res(silent.address().port)));
  silent.close();
  const r = await probeAccess({
    host: "127.0.0.1", port, secret: SECRET, username: "joe", password: "p", timeoutMs: 300,
  });
  assert.equal(r.ok, false);
  assert.equal(r.codeName, "NO-RESPONSE");
});

test("sendDisconnect: ACK means kicked, NAK and silence do not", async () => {
  const ack = await withFakeServer(41, SECRET);
  try {
    const r = await sendDisconnect({
      host: "127.0.0.1", port: ack.port, secret: SECRET, username: "joe", framedIp: "10.5.0.9",
    });
    assert.equal(r.ok, true, r.detail);
    assert.equal(r.codeName, "Disconnect-ACK");
  } finally { ack.server.close(); }

  const nak = await withFakeServer(42, SECRET, () => [[ATTR["Reply-Message"], "session not found"]]);
  try {
    const r = await sendDisconnect({
      host: "127.0.0.1", port: nak.port, secret: SECRET, username: "joe", timeoutMs: 1500,
    });
    assert.equal(r.ok, false);
    assert.equal(r.codeName, "Disconnect-NAK");
    assert.equal(r.replyMessage, "session not found");
  } finally { nak.server.close(); }
});
