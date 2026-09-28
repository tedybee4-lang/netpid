// Minimal RFC 2865 / RFC 3576 RADIUS client over UDP.
// Used by the worker for real health probes (Access-Request) and for
// CoA/Disconnect (RFC 3576) so NETPID never depends on `radclient` being
// installed, and never does the invalid "TCP connect to UDP 1812" check.
import dgram from "node:dgram";
import crypto from "node:crypto";

export const CODES = {
  1: "Access-Request", 2: "Access-Accept", 3: "Access-Reject", 4: "Accounting-Request",
  5: "Accounting-Response", 11: "Access-Challenge", 40: "Disconnect-Request",
  41: "Disconnect-ACK", 42: "Disconnect-NAK", 43: "CoA-Request", 44: "CoA-ACK", 45: "CoA-NAK",
};

export const ATTR = {
  "User-Name": 1, "User-Password": 2, "NAS-IP-Address": 4, "NAS-Port": 5,
  "Service-Type": 6, "Framed-Protocol": 7, "Framed-IP-Address": 8, "Reply-Message": 18,
  "State": 24, "Class": 25, "Session-Timeout": 27, "Idle-Timeout": 28,
  "Called-Station-Id": 30, "Calling-Station-Id": 31, "NAS-Identifier": 32,
  "Acct-Session-Id": 44, "Event-Timestamp": 55, "NAS-Port-Type": 61,
  "Message-Authenticator": 80,
};

export const ATTR_NAMES = Object.fromEntries(Object.entries(ATTR).map(([k, v]) => [v, k]));

export function radiusCodeName(code) {
  return CODES[code] ?? `Code-${code}`;
}

export function randomId() {
  return crypto.randomBytes(1)[0];
}

function md5(...bufs) {
  const h = crypto.createHash("md5");
  for (const b of bufs) h.update(b);
  return h.digest();
}

function hmacMd5(secret, data) {
  return crypto.createHmac("md5", Buffer.from(String(secret), "utf8")).update(data).digest();
}

function ipBytes(ip) {
  const s = String(ip).trim();
  const parts = s.split(".");
  if (parts.length !== 4) throw new Error(`Not an IPv4 address: ${ip}`);
  const b = Buffer.alloc(4);
  for (let i = 0; i < 4; i++) {
    const n = Number(parts[i]);
    if (!Number.isInteger(n) || n < 0 || n > 255) throw new Error(`Not an IPv4 address: ${ip}`);
    b[i] = n;
  }
  return b;
}

// RFC 2865 §5.2 — User-Password is hidden with an MD5 chain keyed by the shared
// secret and the request authenticator. No password ever leaves the process in
// clear text, and none is written to logs/job payloads.
export function encryptUserPassword(password, secret, authenticator) {
  const pw = Buffer.from(String(password), "utf8");
  if (pw.length > 128) throw new Error("User-Password exceeds 128 octets");
  const len = pw.length ? Math.ceil(pw.length / 16) * 16 : 16;
  const padded = Buffer.alloc(len);
  pw.copy(padded);
  const out = Buffer.alloc(len);
  let prev = Buffer.from(authenticator);
  for (let off = 0; off < len; off += 16) {
    const key = md5(Buffer.from(String(secret), "utf8"), prev);
    for (let i = 0; i < 16; i++) out[off + i] = padded[off + i] ^ key[i];
    prev = out.subarray(off, off + 16);
  }
  return out;
}

// Inverse of encryptUserPassword (used for validation/tests).
export function decryptUserPassword(cipher, secret, authenticator) {
  const out = Buffer.alloc(cipher.length);
  let prev = Buffer.from(authenticator);
  for (let off = 0; off < cipher.length; off += 16) {
    const key = md5(Buffer.from(String(secret), "utf8"), prev);
    for (let i = 0; i < 16; i++) out[off + i] = cipher[off + i] ^ key[i];
    prev = cipher.subarray(off, off + 16);
  }
  return out;
}

function encodeAttr(type, value) {
  const v = Buffer.isBuffer(value) ? value : Buffer.from(String(value), "utf8");
  if (v.length > 253) throw new Error(`Attribute ${type} too long (${v.length})`);
  const out = Buffer.alloc(2 + v.length);
  out[0] = type;
  out[1] = 2 + v.length;
  v.copy(out, 2);
  return out;
}

// Build a complete RADIUS packet. `attributes` is an array of `[type, value]`.
export function buildPacket({ code, id, authenticator, attributes }) {
  const attrs = Buffer.concat((attributes ?? []).map(([t, v]) => encodeAttr(t, v)));
  const header = Buffer.alloc(20);
  header[0] = code;
  header[1] = Number.isInteger(id) ? id : randomId();
  header.writeUInt16BE(20 + attrs.length, 2);
  Buffer.from(authenticator ?? crypto.randomBytes(16)).copy(header, 4);
  return Buffer.concat([header, attrs]);
}

// Message-Authenticator (RFC 2869) = HMAC-MD5 over the whole packet with the
// attribute value zeroed. MikroTik/FreeRADIUS require it for Disconnect-Request
// and when `require_message_authenticator` is set on the client.
export function setMessageAuthenticator(packet, secret) {
  const ma = findAttribute(packet, ATTR["Message-Authenticator"]);
  if (!ma) throw new Error("Packet has no Message-Authenticator attribute to fill");
  const copy = Buffer.from(packet);
  copy.fill(0, ma.valueOffset, ma.valueOffset + 16);
  hmacMd5(secret, copy).copy(copy, ma.valueOffset);
  return copy;
}

export function verifyMessageAuthenticator(packet, secret) {
  const ma = findAttribute(packet, ATTR["Message-Authenticator"]);
  if (!ma) return false;
  const copy = Buffer.from(packet);
  const provided = Buffer.from(copy.subarray(ma.valueOffset, ma.valueOffset + 16));
  copy.fill(0, ma.valueOffset, ma.valueOffset + 16);
  const expected = hmacMd5(secret, copy);
  return provided.length === 16 && crypto.timingSafeEqual(provided, expected);
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

function assertPacket(packet) {
  if (!Buffer.isBuffer(packet) || packet.length < 20) throw new Error("RADIUS packet shorter than 20 octets");
  const declared = packet.readUInt16BE(2);
  if (declared !== packet.length) {
    throw new Error(`RADIUS length mismatch: header=${declared} actual=${packet.length}`);
  }
  return declared;
}

// Low-level attribute walk: returns raw [type, valueOffset, valueLength] entries.
export function walkAttributes(packet) {
  assertPacket(packet);
  const out = [];
  let off = 20;
  while (off < packet.length) {
    if (off + 2 > packet.length) throw new Error("Truncated attribute header");
    const type = packet[off];
    const len = packet[off + 1];
    if (len < 2 || off + len > packet.length) throw new Error(`Invalid attribute length ${len} for type ${type}`);
    out.push({ type, valueOffset: off + 2, valueLength: len - 2 });
    off += len;
  }
  return out;
}

export function findAttribute(packet, type) {
  return walkAttributes(packet).find((a) => a.type === type) ?? null;
}

export function parsePacket(packet) {
  assertPacket(packet);
  const attributes = walkAttributes(packet).map((a) => {
    const raw = packet.subarray(a.valueOffset, a.valueOffset + a.valueLength);
    return { type: a.type, name: ATTR_NAMES[a.type] ?? `Attr-${a.type}`, raw };
  });
  const code = packet[0];
  return {
    code,
    codeName: radiusCodeName(code),
    identifier: packet[1],
    length: packet.length,
    authenticator: packet.subarray(4, 20),
    attributes,
  };
}

export function attrText(parsed, name) {
  const a = parsed?.attributes?.find((x) => x.name === name);
  return a ? a.raw.toString("utf8") : null;
}

// RFC 2865 §3 — Response Authenticator = MD5(Code+ID+Length+RequestAuth+Attrs+Secret)
export function verifyResponseAuthenticator(packet, requestAuthenticator, secret) {
  if (!Buffer.isBuffer(packet) || packet.length < 20) return false;
  const copy = Buffer.from(packet);
  const provided = Buffer.from(copy.subarray(4, 20)); // snapshot: copy() below overwrites it
  Buffer.from(requestAuthenticator).copy(copy, 4);
  const expected = md5(copy, Buffer.from(String(secret), "utf8"));
  return crypto.timingSafeEqual(provided, expected);
}


// ---------------------------------------------------------------------------
// Request builders
// ---------------------------------------------------------------------------

// Real Access-Request used for health probes and test-auth. `nasIp` must be a
// registered NAS in the tenant: the SQL layer resolves the tenant from
// NAS-IP-Address (falling back to the UDP source IP), so a probe is attributed
// to exactly one ISP.
export function buildAccessRequest({
  secret, username, password, nasIp, nasIdentifier, nasPortType = "Ethernet",
  identifier = randomId(), authenticator = crypto.randomBytes(16),
}) {
  const attrs = [
    [ATTR["User-Name"], String(username)],
    [ATTR["Message-Authenticator"], Buffer.alloc(16)],
  ];
  if (password !== undefined && password !== null) {
    attrs.push([ATTR["User-Password"], encryptUserPassword(password, secret, authenticator)]);
  }
  if (nasIp) attrs.push([ATTR["NAS-IP-Address"], ipBytes(nasIp)]);
  if (nasIdentifier) attrs.push([ATTR["NAS-Identifier"], String(nasIdentifier)]);
  if (nasPortType) attrs.push([ATTR["NAS-Port-Type"], String(nasPortType)]);
  attrs.push([ATTR["Service-Type"], Buffer.from([0, 0, 0, 1])]);
  const packet = buildPacket({ code: 1, id: identifier, authenticator, attributes: attrs });
  return { packet: setMessageAuthenticator(packet, secret), id: identifier, authenticator };
}

// RFC 3576 Disconnect-Request. Message-Authenticator and Event-Timestamp are
// mandatory here; MikroTik answers with Disconnect-ACK / Disconnect-NAK.
export function buildDisconnectRequest({
  secret, username, framedIp, acctSessionId, nasIp, identifier = randomId(),
  authenticator = crypto.randomBytes(16),
}) {
  const attrs = [
    [ATTR["User-Name"], String(username)],
    [ATTR["Event-Timestamp"], (() => {
      const b = Buffer.alloc(4);
      b.writeUInt32BE(Math.floor(Date.now() / 1000), 0);
      return b;
    })()],
    [ATTR["Message-Authenticator"], Buffer.alloc(16)],
  ];
  if (framedIp) attrs.push([ATTR["Framed-IP-Address"], ipBytes(framedIp)]);
  if (acctSessionId) attrs.push([ATTR["Acct-Session-Id"], String(acctSessionId)]);
  if (nasIp) attrs.push([ATTR["NAS-IP-Address"], ipBytes(nasIp)]);
  const packet = buildPacket({ code: 40, id: identifier, authenticator, attributes: attrs });
  return { packet: setMessageAuthenticator(packet, secret), id: identifier, authenticator };
}

// ---------------------------------------------------------------------------
// UDP transport
// ---------------------------------------------------------------------------

export function sendUdp({ host, port, packet, timeoutMs = 5000 }) {
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket("udp4");
    let settled = false;
    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      try { sock.close(); } catch { /* already closed */ }
      err ? reject(err) : resolve(value);
    };
    const timer = setTimeout(() => finish(new Error("RADIUS request timed out")), timeoutMs);
    sock.on("message", (msg, rinfo) => {
      if (msg.length < 20 || msg[1] !== packet[1]) return; // wrong/echoed identifier
      clearTimeout(timer);
      finish(null, { response: msg, rinfo });
    });
    sock.on("error", (e) => { clearTimeout(timer); finish(e); });
    sock.send(packet, port, host, (e) => { if (e) { clearTimeout(timer); finish(e); } });
  });
}

// Probe a FreeRADIUS server for real. Any valid, authenticated reply means the
// server is alive (Access-Reject is a healthy answer — it proves the tenant
// lookup + SQL layer ran); no reply means offline. No fake ONLINE, ever.
export async function probeAccess({
  host, port = 1812, secret, username, password, nasIp, nasIdentifier, timeoutMs = 5000,
}) {
  const { packet, authenticator, id } = buildAccessRequest({
    secret, username, password, nasIp, nasIdentifier,
  });
  const started = Date.now();
  try {
    const { response } = await sendUdp({ host, port, packet, timeoutMs });
    const rttMs = Date.now() - started;
    const parsed = parsePacket(response);
    const verified = verifyResponseAuthenticator(response, authenticator, secret);
    const maOk = findAttribute(response, ATTR["Message-Authenticator"])
      ? verifyMessageAuthenticator(response, secret) : null;
    const expected = response[1] === id;
    return {
      ok: verified && expected, rttMs, id, code: parsed.code, codeName: parsed.codeName,
      verified, messageAuthenticator: maOk, replyMessage: attrText(parsed, "Reply-Message"),
      detail: `probe=${parsed.codeName} rtt=${rttMs}ms verified=${verified}`,
    };
  } catch (e) {
    return {
      ok: false, rttMs: Date.now() - started, id, code: null, codeName: "NO-RESPONSE",
      verified: false, messageAuthenticator: null, replyMessage: null,
      detail: String(e?.message ?? e).slice(0, 160),
    };
  }
}

// CoA Disconnect-Request (RFC 3576) to the NAS on its CoA port (MikroTik 3799).
export async function sendDisconnect({
  host, port = 3799, secret, username, framedIp, acctSessionId, nasIp, timeoutMs = 5000,
}) {
  const { packet, authenticator, id } = buildDisconnectRequest({
    secret, username, framedIp, acctSessionId, nasIp,
  });
  const started = Date.now();
  try {
    const { response } = await sendUdp({ host, port, packet, timeoutMs });
    const parsed = parsePacket(response);
    const verified = verifyResponseAuthenticator(response, authenticator, secret);
    return {
      ok: verified && (parsed.code === 41 || parsed.code === 44),
      rttMs: Date.now() - started, id, code: parsed.code, codeName: parsed.codeName,
      verified, replyMessage: attrText(parsed, "Reply-Message"),
      detail: `coa=${parsed.codeName} rtt=${Date.now() - started}ms verified=${verified}`,
    };
  } catch (e) {
    return {
      ok: false, rttMs: Date.now() - started, id, code: null, codeName: "NO-RESPONSE",
      verified: false, replyMessage: null, detail: String(e?.message ?? e).slice(0, 160),
    };
  }
}
