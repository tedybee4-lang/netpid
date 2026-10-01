/**
 * Download a file with resume, because a 43 MB transfer over a flaky link gets
 * truncated and Expand-Archive then fails with a misleading "End of Central
 * Directory record could not be found" - which reads like a corrupt archive
 * rather than a short download.
 *
 * Run: node scripts/fetch.mjs <url> <dest> [expectedBytes]
 */
import { createWriteStream, existsSync, statSync, unlinkSync } from "node:fs";
import { request } from "node:https";

const [, , url, dest, expectedRaw] = process.argv;
if (!url || !dest) {
  console.error("usage: node scripts/fetch.mjs <url> <dest> [expectedBytes]");
  process.exit(2);
}
const expected = Number(expectedRaw || 0);

function head() {
  return new Promise((resolve) => {
    const r = request(url, { method: "HEAD" }, (res) => {
      res.resume();
      resolve({
        size: Number(res.headers["content-length"] || 0),
        ranges: res.headers["accept-ranges"] === "bytes",
        status: res.statusCode,
      });
    });
    r.on("error", () => resolve({ size: 0, ranges: false, status: 0 }));
    r.end();
  });
}

function get(from) {
  return new Promise((resolve, reject) => {
    const headers = from > 0 ? { Range: `bytes=${from}-` } : {};
    const r = request(url, { headers }, (res) => resolve(res));
    r.on("error", reject);
    r.end();
  });
}

for (let attempt = 1; attempt <= 8; attempt++) {
  const have = existsSync(dest) ? statSync(dest).size : 0;
  if (expected && have >= expected) {
    console.log(`  complete: ${have} bytes`);
    process.exit(0);
  }
  if (expected && have >= expected) break;

  const res = await get(have);
  if (res.statusCode !== 200 && res.statusCode !== 206) {
    console.log(`  attempt ${attempt}: HTTP ${res.statusCode}`);
    process.exit(1);
  }
  const appending = res.statusCode === 206;
  const out = createWriteStream(dest, { flags: appending ? "a" : "w" });
  res.pipe(out);
  await new Promise((resolve, reject) => {
    out.on("finish", resolve);
    out.on("error", reject);
    res.on("error", reject);
  });

  const now = statSync(dest).size;
  const pct = expected ? Math.round((now / expected) * 100) : 0;
  console.log(`  attempt ${attempt}: ${now} bytes${expected ? ` (${pct}%)` : ""}`);
  if (expected && now < expected) {
    // Short read: keep the partial file and resume from where it stopped.
    continue;
  }
  process.exit(0);
}

const finalSize = existsSync(dest) ? statSync(dest).size : 0;
console.log(`  incomplete after retries: ${finalSize} of ${expected}`);
process.exit(1);
