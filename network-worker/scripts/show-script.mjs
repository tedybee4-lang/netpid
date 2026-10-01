/**
 * Diagnostic: dump a generated script with line numbers and column rulers.
 * Run: node scripts/show-script.mjs [bootstrap|configure]
 */
import { buildBootstrapScript } from "../../apps/web/lib/mikrotik-provision-script.ts";
import { writeFileSync } from "node:fs";

const which = process.argv[2] ?? "bootstrap";

const s = which === "bootstrap"
  ? buildBootstrapScript({
    baseUrl: "https://netpid-2b9dmps30-malariachrome-7756s-projects.vercel.app",
    token: "xxcQt2adX1j_xDOS3aHIdPWBuCRLZ7pjJoAkZ8ve_IA",
    sessionId: "0b0e0000-0000-0000-0000-000000000000",
  })
  : "";

const out = s.split("\n").map((l, i) => `${String(i + 1).padStart(4)}| ${l}`).join("\n");
const path = `scripts/.out-${which}.rsc`;
writeFileSync(path, s);
console.log(out);
console.log(`\n--- written to ${path} (${s.split("\n").length} lines) ---`);

// Point at any line the router rejected.
const line = Number(process.argv[3] ?? 0);
if (line > 0) {
  const text = s.split("\n")[line - 1] ?? "";
  console.log(`\nline ${line} length ${text.length}`);
  console.log(text);
  const col = Number(process.argv[4] ?? 0);
  if (col > 0) {
    console.log(`\ncaret at column ${col}:`);
    console.log(" ".repeat(Math.max(0, col - 1)) + "^");
    console.log("context: ..." + text.slice(Math.max(0, col - 40), col + 40) + "...");
  }
}
