/**
 * A fresh CHR has no IP address, so the API on 8728 is unreachable. That is the
 * chicken-and-egg every CHR guide solves with the serial console.
 *
 * A TCP connect is NOT a liveness check here. The VirtualBox NAT proxy accepts
 * the instant a forward rule exists, so it reports "connected" while the guest
 * is still at the BIOS screen. Waiting on a bare TCP accept made this harness
 * declare success against a router that had not booted at all, so the wait now
 * requires real API bytes to come back.
 */
export function apiAlive(hostPort = 8722, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const s = net.connect({ host: "127.0.0.1", port: hostPort });
    const done = (v) => { clearTimeout(timer); s.destroy(); resolve(v); };
    const timer = setTimeout(() => done(false), timeoutMs);
    s.on("data", (c) => done(c.length > 0));
    s.on("error", () => done(false));
    s.setTimeout(timeoutMs);
  });
}


/**
 * Speak the RouterOS API to the CHR.
 *
 * The RouterOS API is not HTTP. It is length-prefixed ASCII sentences over a raw
 * TCP socket: a 4-byte little-endian length, then that many bytes of
 * space-separated words, terminated by an empty word. A reply is one or more
 * such sentences; `!trap` means the command failed and `!done` ends the reply.
 *
 * This client exists so the generated script is executed by RouterOS itself,
 * rather than by a JavaScript re-implementation of RouterOS syntax. Asserting
 * the dialect in JS only proves my model of RouterOS is self-consistent, which
 * is exactly the assumption that produced three field failures in a row.
 *
 * A fresh CHR has the API service enabled on 8728 and an admin user with no
 * password, so the default credentials are correct for a lab VM.
 */
import net from "node:net";

/** Words are sent as =word=value, or bare for the command path. */
function encodeSentence(words) {
  const payload = words.map((w) => w + " ").join("") + "\0";
  const buf = Buffer.from(payload, "utf8");
  const head = Buffer.alloc(4);
  head.writeUInt32LE(buf.length, 0);
  return Buffer.concat([head, buf]);
}

/**
 * Pull complete sentences out of a buffer.
 * Returns the sentences and the leftover bytes, so a reply split across two TCP
 * segments is not truncated - easy to do accidentally, and it produces replies
 * that look exactly like RouterOS errors.
 */
function drain(buffer) {
  const out = [];
  let offset = 0;
  while (offset + 4 <= buffer.length) {
    const len = buffer.readUInt32LE(offset);
    if (offset + 4 + len > buffer.length) break;      // wait for the rest
    const body = buffer.subarray(offset + 4, offset + 4 + len).toString("utf8");
    offset += 4 + len;
    const words = body.split(" ").filter((w) => w.length > 0);
    if (words.length) out.push(words);
  }
  return { sentences: out, rest: buffer.subarray(offset) };
}

export async function connect(hostPort = 8722) {
  const sock = net.connect({ host: "127.0.0.1", port: hostPort });
  await new Promise((resolve, reject) => {
    sock.once("connect", resolve);
    sock.once("error", reject);
  });

  let buffer = Buffer.alloc(0);
  const waiters = [];
  sock.on("data", (chunk) => {
    const d = drain(Buffer.concat([buffer, chunk]));
    buffer = d.rest;
    for (const s of d.sentences) {
      const w = waiters.shift();
      if (w) w(s);
    }
  });

  const send = (words) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("RouterOS API timeout")), 60_000);
    waiters.push((s) => { clearTimeout(timer); resolve(s); });
    sock.write(encodeSentence(words));
  });

  const login = await send(["/login", "=name=admin", "=password="]);
  if (login.some((w) => w.startsWith("!trap") || w.startsWith("!fatal"))) {
    throw new Error(`login rejected: ${login.join(" ")}`);
  }
  // RouterOS 6.43+ answers the login with !done, and the session id arrives as a
  // bare hex word in the same sentence. It has to ride on every later command or
  // the router silently drops them, which shows up as a timeout rather than an
  // error, so this is worth being loud about.
  const done = login.find((w) => w.startsWith("!done"));
  const cookie = done && done.length > 1 ? done[1] : "";
  if (!cookie) {
    throw new Error(
      `no session id in the login reply: ${JSON.stringify(login)}. `
      + "RouterOS 7 sends it as a bare word after !done.",
    );
  }

  const run = async (words) => send(cookie ? [...words, `=${cookie}`] : words);
  return { sock, run, cookie };
}

/** Human-readable one-liners from a reply. */
function render(reply) {
  const lines = [];
  for (const s of reply) {
    if (s[0] === "!trap" || s[0] === "!fatal") lines.push(`ERROR: ${s.slice(1).join(" ")}`);
    else if (s[0] === "!done") continue;
    else lines.push(s.join(" "));
  }
  return lines;
}

/** Run commands, print the output, and report any trap. */
export async function runOnChr(words, hostPort = 8722) {
  const { sock, run } = await connect(hostPort);
  try {
    const out = [];
    for (const line of words.split("\n").filter((l) => l.trim())) {
      // Trailing `.rsc` paths are terminal syntax, not API syntax. The API takes
      // menu paths: /system/resource/print. Translate so a command can be copied
      // from either form.
      const api = line.trim().replace(/\.rsc$/, "").replace(/\//g, "/").split(/\s+/);
      out.push(...render(await run(api)));
    }
    return out.join("\n");
  } finally {
    sock.destroy();
  }
}

/**
 * Upload a script and /import it, which is exactly what the operator does in the
 * terminal. The file name is the one the bootstrap command uses, so a RouterOS
 * error names something familiar.
 */
export async function importScript(script, hostPort = 8722, fileName = "netpid_init.rsc") {
  const { sock, run } = await connect(hostPort);
  try {
    // RouterOS caps a single API write, so send in chunks.
    const CHUNK = 60_000;
    for (let i = 0; i < script.length; i += CHUNK) {
      const part = script.slice(i, i + CHUNK);
      const reply = await run(["/file", "=name=" + fileName, "=contents=" + part]);
      const bad = reply.find((s) => s[0] === "!trap" || s[0] === "!fatal");
      if (bad) return `ERROR uploading: ${bad.slice(1).join(" ")}`;
    }
    const out = render(await run(["/import", `=file-name=${fileName}`]));
    return out.length ? out.join("\n") : "IMPORT OK (no output, no error)";
  } finally {
    sock.destroy();
  }
}
