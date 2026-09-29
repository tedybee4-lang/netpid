#!/usr/bin/env node
// NETPID — apply SQL migrations to a hosted Supabase project.
//
// The repo's normal path is the Supabase CLI (`supabase db push`, see README).
// That path needs Docker, because the CLI starts a local Postgres to diff
// against. On a machine with no Docker (and no local database) it cannot run,
// so this script talks to the Supabase Management API instead:
//
//   POST https://api.supabase.com/v1/projects/{ref}/database/migrations
//   body: { "query": "<sql>", "name": "<migration name>" }
//
// The endpoint runs the SQL in one transaction and records it in
// supabase_migrations.schema_migrations (the API assigns a timestamp version,
// so it will not look like "0034" in `supabase migration list` — the NAME is
// what matches this repo's file names).
//
//   # apply every migration that is not on the project yet
//   SUPABASE_ACCESS_TOKEN=sbp_... node supabase/scripts/apply-migration.mjs
//
//   # one file, and show what it would do first
//   node supabase/scripts/apply-migration.mjs --file supabase/migrations/0034_speed_caps_router_ops.sql --dry-run
//
// The token is a personal access token (https://supabase.com/dashboard/account/tokens)
// with database_migrations_write. It is read from --token, SUPABASE_ACCESS_TOKEN,
// or the env file given by --env (default apps/web/.env.local). It is NEVER
// printed. The project ref comes from --ref, SUPABASE_PROJECT_REF, or the ref the
// CLI already stored in supabase/.temp/project-ref.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
const MIGRATIONS_DIR = path.join(REPO, "supabase", "migrations");
const API = "https://api.supabase.com/v1";

const USAGE = `
NETPID migration runner (Management API — no Docker required)

Options:
  --file <path>     Apply one .sql file        (default: every pending migration)
  --all             Apply every pending file in supabase/migrations
  --force           Re-apply even if the migration is already recorded
  --ref <ref>       Supabase project ref       (default: SUPABASE_PROJECT_REF or supabase/.temp/project-ref)
  --token <token>   Personal access token      (default: SUPABASE_ACCESS_TOKEN)
  --env <path>      env file to read the token from (default: apps/web/.env.local)
  --dry-run         List what would be applied, run nothing
  --json            Machine-readable result on stdout
  -h, --help        This message

Exit codes: 0 ok · 1 a migration failed · 2 bad usage/no token
`.trim();

function parseArgs(argv) {
  const out = { all: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    switch (a) {
      case "-h": case "--help": out.help = true; break;
      case "--file": out.file = next(); break;
      case "--all": out.all = true; break;
      case "--force": out.force = true; break;
      case "--ref": out.ref = next(); break;
      case "--token": out.token = next(); break;
      case "--env": out.env = next(); break;
      case "--dry-run": out.dryRun = true; break;
      case "--json": out.json = true; break;
      default: throw new Error(`unknown option: ${a}`);
    }
  }
  return out;
}

// Minimal .env reader — this script must not need dotenv as a dependency.
function loadEnv(file) {
  if (!fs.existsSync(file)) return {};
  const env = {};
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m || m[1].startsWith("#")) continue;
    env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return env;
}

function resolveToken(opts) {
  if (opts.token) return opts.token;
  if (process.env.SUPABASE_ACCESS_TOKEN) return process.env.SUPABASE_ACCESS_TOKEN;
  const env = loadEnv(path.resolve(REPO, opts.env ?? "apps/web/.env.local"));
  return env.SUPABASE_ACCESS_TOKEN ?? "";
}

function resolveRef(opts) {
  if (opts.ref) return opts.ref;
  if (process.env.SUPABASE_PROJECT_REF) return process.env.SUPABASE_PROJECT_REF;
  const linked = path.join(REPO, "supabase", ".temp", "project-ref");
  if (fs.existsSync(linked)) return fs.readFileSync(linked, "utf8").trim();
  return "";
}


// "0034_speed_caps_router_ops.sql" -> { version: "0034", name: "speed_caps_router_ops" }
function describe(file) {
  const base = path.basename(file, ".sql");
  const m = base.match(/^(\d+)[_-](.+)$/);
  return m ? { version: m[1], name: m[2], file } : { version: null, name: base, file };
}

async function api(kind, { token, ref, body }) {
  const res = await fetch(`${API}/projects/${ref}/database/${kind}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { ok: res.ok, status: res.status, data: parsed };
}

async function history(ctx) {
  const r = await api("query", { ...ctx, body: { query: "select version, name from supabase_migrations.schema_migrations" } });
  if (!r.ok) throw new Error(`could not read migration history (HTTP ${r.status}): ${JSON.stringify(r.data)}`);
  return Array.isArray(r.data) ? r.data : [];
}

function isApplied(migration, rows) {
  return rows.some((h) => {
    const version = String(h.version ?? "");
    const name = String(h.name ?? "");
    return name === migration.name || version === migration.version
      || (migration.version && name.startsWith(`${migration.version}_`));
  });
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { console.log(USAGE); return 0; }

  const token = resolveToken(opts);
  const ref = resolveRef(opts);
  if (!token) { console.error(`${USAGE}\n\nNo token: pass --token, set SUPABASE_ACCESS_TOKEN, or add it to the env file.`); return 2; }
  if (!ref) { console.error(`${USAGE}\n\nNo project ref: pass --ref, set SUPABASE_PROJECT_REF, or run \`supabase link\`.`); return 2; }

  const files = opts.file
    ? [path.resolve(opts.file)]
    : fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort()
        .map((f) => path.join(MIGRATIONS_DIR, f));

  const ctx = { token, ref };
  const rows = await history(ctx);
  const described = files.map(describe);
  const pending = opts.force ? described : described.filter((m) => !isApplied(m, rows));

  console.log(`project ${ref} — ${files.length} file(s), ${described.length - pending.length} already recorded, ${pending.length} to apply`);
  if (!pending.length) { console.log("nothing to do"); return 0; }

  if (opts.dryRun) {
    for (const m of pending) console.log(`  would apply ${path.relative(REPO, m.file)} (name: ${m.name})`);
    console.log("dry run — no SQL was executed");
    return 0;
  }

  const results = [];
  for (const m of pending) {
    const sql = fs.readFileSync(m.file, "utf8");
    process.stdout.write(`applying ${path.relative(REPO, m.file)} (${sql.length} chars) ... `);
    const r = await api("migrations", { ...ctx, body: { query: sql, name: m.name } });
    console.log(r.ok ? `ok (HTTP ${r.status})` : `FAILED (HTTP ${r.status})`);
    if (!r.ok) console.error(`  ${JSON.stringify(r.data).slice(0, 800)}`);
    results.push({ name: m.name, version: m.version, file: path.relative(REPO, m.file), ok: r.ok, status: r.status, error: r.ok ? null : r.data });
  }

  const failed = results.filter((r) => !r.ok);
  if (opts.json) {
    console.log(JSON.stringify({ ref, applied: results.length - failed.length, failed: failed.length, results }, null, 2));
  }
  return failed.length ? 1 : 0;
}

main()
  .then((code) => { process.exitCode = code; })
  .catch((err) => { console.error(err?.message ?? err); process.exitCode = 1; });

