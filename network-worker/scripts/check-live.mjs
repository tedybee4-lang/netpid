/**
 * Check a LIVE provisioning script fetched over HTTPS.
 *
 * This is the check that finally caught line 89. Every earlier attempt
 * asserted properties of the generator's output in memory, which only proved
 * the generator agreed with itself. Fetching the bytes the router will actually
 * download, from the deployment the router will actually call, tests the thing
 * that matters: the deployed artefact.
 *
 * Run: node scripts/check-live.mjs <host> <token> [bootstrap|configure]
 */
const host = process.argv[2];
const token = process.argv[3];
const kind = process.argv[4] ?? "bootstrap";
if (!host || !token) {
  console.error("usage: node scripts/check-live.mjs <host> <token> [bootstrap|configure]");
  process.exit(2);
}

const res = await fetch(`${host}/api/provision/mikrotik/${kind}/${token}`);
console.log(`  GET ${host}/api/provision/mikrotik/${kind}/... -> HTTP ${res.status}`);
if (!res.ok) {
  console.log(`  body: ${(await res.text()).slice(0, 200)}`);
  process.exit(1);
}

const text = await res.text();
const lines = text.split(/\r?\n/);
console.log(`  ${lines.length} lines, ${text.length} bytes`);

let problems = 0;
const fail = (msg) => { problems++; console.log(`  FAIL  ${msg}`); };
const pass = (msg) => console.log(`  PASS  ${msg}`);

// 1. Braces balance. An unbalanced brace makes RouterOS swallow the rest of the
//    file and report a syntax error on an unrelated line.
let depth = 0;
for (const raw of lines) {
  const t = raw.replace(/(^|\s)#.*$/, "");
  depth += (t.match(/\{/g) ?? []).length - (t.match(/\}/g) ?? []).length;
}
depth === 0 ? pass("braces balance") : fail(`brace depth ends at ${depth}`);

// 2. :set targets must be :local-declared, and a :foreach variable may only be
//    assigned while its loop is still open. This is the line 89 bug.
const locals = new Set();
for (const raw of lines) {
  const m = /^\s*:local\s+(\w+)/.exec(raw);
  if (m) locals.add(m[1]);
}
const loopVars = new Set();
for (const raw of lines) {
  const m = /:foreach\s+(\w+)\s+in=/.exec(raw);
  if (m) loopVars.add(m[1]);
}
console.log(`  locals: ${[...locals].join(",")}`);
console.log(`  loop vars: ${[...loopVars].join(",")}`);

let d = 0;
for (const [i, raw] of lines.entries()) {
  const t = raw.replace(/(^|\s)#.*$/, "").trim();
  const m = /^:set\s+(\w+)\s/.exec(t);
  if (!m) continue;
  const name = m[1];
  if (loopVars.has(name)) {
    if (d <= 0) fail(`line ${i + 1}: assigns to the out-of-scope loop variable ${name}`);
    continue;
  }
  if (!locals.has(name)) fail(`line ${i + 1}: sets undeclared ${name}`);
}
if (problems === 0) pass("every :set target is in scope");

// 3. No expression left open at end of line. RouterOS reports only a column
//    number for this, which is how line 60 went unnoticed.
let open = 0;
for (const [i, raw] of lines.entries()) {
  const t = raw.replace(/(^|\s)#.*$/, "").trim();
  if (!t) { open = 0; continue; }
  open += (t.match(/\(/g) ?? []).length - (t.match(/\)/g) ?? []).length;
  if (open > 0) fail(`line ${i + 1}: ${open} unclosed parenthesis(es) at end of line`);
}
pass("no expression split across lines");

// 4. The URL must carry no literal space, which /tool fetch rejects outright.
const urlLine = lines.find((l) => /^\s*:local\s+npUrl\s+"/.test(l)) ?? "";
const m = /"([^"]+)"/.exec(urlLine);
if (!m) {
  fail("no :local npUrl line found");
} else {
  const url = m[1];
  console.log(`  npUrl: ${url.slice(0, 80)}...`);
  if (url.includes(" ")) fail("npUrl contains a literal space");
  else pass("npUrl has no literal space");
  // npUrl must be the bare endpoint with NO query yet. The query is appended by
  // the `:set npUrl (... "?board=" ...)` lines that follow, so a "?" here would
  // mean the generator baked in a second one and the first field would be lost.
  // (An earlier version of this check tested the condition backwards and
  // reported a failure on a perfectly correct URL.)
  if (url.includes("?")) fail("npUrl already carries a query before the fields are appended");
  else pass("npUrl is the bare endpoint, query appended by the following lines");
  if (/projects\.vercel\.app/.test(url)) {
    fail("npUrl points at a preview host, which is deleted when the branch closes");
  } else {
    pass("npUrl is not a preview host");
  }
}

// 5. Every field must be appended with a separator, so the query string is
//    well formed. The first uses "?", the rest "&".
let first = true;
for (const [i, raw] of lines.entries()) {
  const t = raw.replace(/(^|\s)#.*$/, "").trim();
  const m = /^:set\s+npUrl\s+\(\$npUrl\s+\.\s+"([?&])/.exec(t);
  if (!m) continue;
  const want = first ? "?" : "&";
  if (m[1] !== want) {
    fail(`line ${i + 1}: appends with "${m[1]}", expected "${want}"`);
    first = false;
  } else {
    first = false;
  }
}
if (problems === 0) pass("query separators are correct");

// 6. The space-encoding loop must close before the next field starts, and must
//    not assign to the loop variable once closed. The line 89 bug, stated as a
//    standalone check so a regression names itself.
for (const [i, raw] of lines.entries()) {
  if (/^\s*:set\s+npW\s/.test(raw)) {
    fail(`line ${i + 1}: ":set npW" assigns a :foreach variable outside its loop`);
  }
}
if (problems === 0) pass("no :set npW anywhere");

console.log(problems === 0 ? "\n  ALL CHECKS PASSED" : `\n  ${problems} PROBLEM(S)`);
// Give node a tick to close its handles; exiting immediately can trip an
// assertion in libuv on Windows.
await new Promise((r) => setTimeout(r, 50));
process.exitCode = problems === 0 ? 0 : 1;

