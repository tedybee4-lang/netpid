// Verify that every installed package actually ships the files its own
// package.json points at (main / module / types / exports).
//
// Why: a partially written node_modules can be missing files inside a package
// (e.g. an ESM build) while `npm install` still reports "up to date" — npm
// compares versions, not file contents. The symptom is a hard failure at import
// time: "Cannot find module '.../dist/index.mjs'".
//
// Usage: node scripts/check-node-modules.mjs [path-to-node_modules]
//   node scripts/check-node-modules.mjs network-worker/node_modules
//
// Exit code 0 = every declared entry point exists, 1 = something is missing
// (repair with `npm ci` inside that workspace).
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(process.argv[2] ?? "node_modules");
if (!fs.existsSync(root)) {
  console.error(`no such directory: ${root}`);
  process.exitCode = 2;
} else {
  const missing = [];
  const seen = [];

  function targets(pkg) {
    const out = new Set();
    const add = (v) => {
      if (typeof v === "string") out.add(v);
      else if (v && typeof v === "object") for (const k of Object.keys(v)) add(v[k]);
    };
    add(pkg.main); add(pkg.module); add(pkg.types); add(pkg.exports);
    // Directory entry points ("lib", "./lib") are resolved by Node, not us.
    return [...out].filter((v) => v.startsWith("./") && !v.endsWith("/"));
  }

  function checkPackage(dir, label) {
    const manifest = path.join(dir, "package.json");
    if (!fs.existsSync(manifest)) return;
    let pkg;
    try { pkg = JSON.parse(fs.readFileSync(manifest, "utf8")); } catch { return; }
    seen.push(label);

    for (const rel of targets(pkg)) {
      if (rel.includes("*")) continue; // wildcard exports resolve at runtime
      if (!fs.existsSync(path.join(dir, rel))) missing.push(`${label} -> ${rel}`);
    }

    if (label.includes("/")) return; // already inside @scope/name
    for (const scope of fs.readdirSync(dir).filter((n) => n.startsWith("@"))) {
      const scopeDir = path.join(dir, scope);
      if (!fs.statSync(scopeDir).isDirectory()) continue;
      for (const name of fs.readdirSync(scopeDir)) {
        checkPackage(path.join(scopeDir, name), `${scope}/${name}`);
      }
    }
  }

  for (const name of fs.readdirSync(root)) {
    if (name === ".bin" || name.startsWith("@")) continue;
    const dir = path.join(root, name);
    if (!fs.statSync(dir).isDirectory()) continue;
    checkPackage(dir, name);
  }

  console.log(`scanned ${seen.length} package(s) under ${root}`);
  if (missing.length) {
    console.log(`MISSING ${missing.length} file(s):`);
    for (const m of missing) console.log(`  ${m}`);
    console.log("repair: cd into the workspace and run `npm ci`");
    process.exitCode = 1;
  } else {
    console.log("OK - every declared entry point exists");
  }
}
