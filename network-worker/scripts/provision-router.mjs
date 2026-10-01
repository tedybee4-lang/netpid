#!/usr/bin/env node
// NETPID — script-only router provisioning.
//
// Registers MikroTik routers with NETPID without opening the dashboard: the
// dashboard path (apps/web/app/dashboard/network/routers/new) and this script
// write the same rows and emit the same RouterOS script, because both call
// buildRouterosSetup() from ../src/routeros.mjs.
//
//   # one router
//   node scripts/provision-router.mjs --isp lipanet --name "Nairobi Core 1" \
//     --host 196.201.214.10 --user netpid --pass 's3cret' --out ./out
//
//   # many routers, no prompts
//   node scripts/provision-router.mjs --isp lipanet --file routers.json --out ./out
//
//   # see exactly what would happen, touch nothing
//   node scripts/provision-router.mjs --isp lipanet --file routers.json --dry-run
//
// Credentials come from --env (default apps/web/.env.local) or the process
// environment. The RADIUS secret is printed ONCE and never stored in clear.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

import { encryptSecret, randomSecret } from "../src/secrets.js";
import { buildRouterosSetup, rosName } from "../src/routeros.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");

const USAGE = `
NETPID router provisioning (script only)

Required:
  --isp <slug|uuid>        ISP to attach the router to
  --name <name>            Router name shown in the dashboard
  --host <ip>              Management IP
  --pass <password>        RouterOS API password (stored AES-256-GCM encrypted)

  (or --file <routers.json> to provision a batch)

Options:
  --user <name>            API username           (default: netpid)
  --ssl / --no-ssl         Use API-SSL :8729      (default: --ssl)
  --port <n>               API port               (default: 8728)
  --ssl-port <n>           API-SSL port           (default: 8729)
  --site <text>            Site / town label
  --notes <text>           Free-text note
  --nas-shortname <name>   RADIUS NAS shortname   (default: slugified --name)
  --no-nas                 Register the router WITHOUT a RADIUS NAS
  --radius-server <host>   FreeRADIUS IP, for the generated .rsc
  --file <path>            Batch JSON (array of the fields above)
  --out <dir>              Write <shortname>.rsc per router
  --env <path>             env file               (default: apps/web/.env.local)
  --dry-run                Print the plan, write nothing
  --json                   Machine-readable result on stdout
  -h, --help               This message
`.trim();

function parseArgs(argv) {
  const out = { ssl: true, api_port: 8728, api_ssl_port: 8729, api_username: "netpid" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    switch (a) {
      case "-h": case "--help": out.help = true; break;
      case "--isp": out.isp = next(); break;
      case "--name": out.name = next(); break;
      case "--host": out.host = next(); break;
      case "--pass": out.api_password = next(); break;
      case "--user": out.api_username = next(); break;
      case "--port": out.api_port = Number(next()); break;
      case "--ssl-port": out.api_ssl_port = Number(next()); break;
      case "--site": out.site = next(); break;
      case "--notes": out.notes = next(); break;
      case "--nas-shortname": out.nas_shortname = next(); break;
      case "--radius-server": out.radius_server = next(); break;
      case "--file": out.file = next(); break;
      case "--out": out.out = next(); break;
      case "--env": out.env = next(); break;
      case "--dry-run": out.dryRun = true; break;
      case "--json": out.json = true; break;
      case "--ssl": out.ssl = true; break;
      case "--no-ssl": out.ssl = false; break;
      case "--no-nas": out.nas = false; break;
      default: throw new Error(`unknown option: ${a}`);
    }
  }
  return out;
}

// Minimal .env reader — the CLI must not need dotenv as a dependency.
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

const IPV4 = /^(\d{1,3}\.){3}\d{1,3}$/;

function validate(spec) {
  const errors = [];
  if (!spec.name || String(spec.name).trim().length < 2) errors.push("--name is required");
  if (!IPV4.test(String(spec.host ?? ""))) errors.push(`--host must be an IPv4 address (got "${spec.host}")`);
  if (!spec.api_password) errors.push("--pass is required");
  return errors;
}

async function resolveIsp(sb, ref) {
  const { data: byUuid } = await sb.from("isps").select("id, slug, name").eq("id", ref).maybeSingle();
  if (byUuid) return byUuid;
  const { data: bySlug } = await sb.from("isps").select("id, slug, name").eq("slug", ref).maybeSingle();
  if (bySlug) return bySlug;
  const { data: all } = await sb.from("isps").select("id, slug, name").order("created_at").limit(20);
  throw new Error(
    `no ISP matches "${ref}". Known ISPs: ` +
    (all ?? []).map((i) => `${i.slug} (${i.id})`).join(", ") || "none",
  );
}

// Idempotent on (isp_id, host): re-running updates the existing router and
// issues a FRESH NAS secret, so a leaked secret can be rotated by re-running.
async function provisionRouter(sb, ispId, spec, opts) {
  const shortname = rosName(
    spec.nas_shortname ?? String(spec.name).toLowerCase().replace(/[^a-z0-9]+/g, "-"),
    "netpid-nas",
  );
  const existing = await sb.from("routers").select("id, name")
    .eq("isp_id", ispId).eq("host", spec.host).maybeSingle();
  const row = {
    isp_id: ispId,
    name: spec.name,
    host: spec.host,
    api_port: spec.api_port ?? 8728,
    api_ssl_port: spec.api_ssl_port ?? 8729,
    api_username: spec.api_username ?? "netpid",
    use_ssl: spec.ssl !== false,
    site: spec.site ?? null,
    notes: spec.notes ?? null,
    radius_server_host: spec.radius_server ?? null,
    provisioned_via: "script",
    status: "unknown",
  };

  const { data: router, error } = existing.data
    ? await sb.from("routers").update(row).eq("id", existing.data.id).select("id,name,host").single()
    : await sb.from("routers").insert(row).select("id,name,host").single();
  if (error) throw new Error(`routers: ${error.message}`);

  await sb.from("router_credentials")
    .upsert({ router_id: router.id, encrypted_password: encryptSecret(String(spec.api_password)) },
      { onConflict: "router_id" });

  let nas = null;
  let secretOnce = null;
  if (spec.nas !== false) {
    const existingNas = await sb.from("radius_nas").select("id")
      .eq("isp_id", ispId).eq("nasname", spec.host).maybeSingle();
    const nasRow = {
      isp_id: ispId, router_uuid: router.id, shortname, nasname: spec.host, sync_status: "pending",
    };
    const r = existingNas.data
      ? await sb.from("radius_nas").update(nasRow).eq("id", existingNas.data.id)
          .select("id,shortname").single()
      : await sb.from("radius_nas").insert(nasRow).select("id,shortname").single();
    if (r.error) throw new Error(`radius_nas: ${r.error.message}`);
    nas = r.data;
    secretOnce = randomSecret();
    await sb.from("radius_nas_secrets")
      .upsert({ nas_id: nas.id, encrypted_secret: encryptSecret(secretOnce) },
        { onConflict: "nas_id" });
    await sb.rpc("enqueue_job", { p_kind: "radius-nas-sync", p_isp_id: ispId,
      p_payload: { nas_id: nas.id } });
  }
  await sb.rpc("enqueue_job", { p_kind: "router-health", p_isp_id: ispId,
    p_payload: { router_id: router.id } });

  await sb.from("router_provision_log").insert({
    isp_id: ispId, router_id: router.id,
    action: existing.data ? "updated" : "created",
    source: "script",
    detail: { shortname, nas_created: Boolean(nas), dry_run: Boolean(opts.dryRun) },
  });

  return { router, nas, shortname, secretOnce };
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`error: ${e.message}\n\n${USAGE}`);
    process.exit(2);
  }
  if (opts.help) { console.log(USAGE); return; }

  const envPath = path.resolve(
    REPO, opts.env ?? path.join("apps", "web", ".env.local"),
  );
  const fileEnv = loadEnv(envPath);
  const env = { ...fileEnv, ...process.env };
  const url = env.NEXT_PUBLIC_SUPABASE_URL ?? env.SUPABASE_URL;
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error(
      `error: SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY not found.\n` +
      `       Looked in the environment and in ${envPath}.`,
    );
    process.exit(2);
  }
  // secrets.js reads APP_ENCRYPTION_KEY at import time, so it must be set first.
  if (!process.env.APP_ENCRYPTION_KEY && env.APP_ENCRYPTION_KEY) {
    process.env.APP_ENCRYPTION_KEY = env.APP_ENCRYPTION_KEY;
  }

  let specs;
  if (opts.file) {
    const raw = JSON.parse(fs.readFileSync(path.resolve(opts.file), "utf8"));
    specs = Array.isArray(raw) ? raw : [raw];
  } else {
    specs = [opts];
  }
  if (!specs.length) { console.error("error: nothing to provision"); process.exit(2); }

  const bad = specs.flatMap((s, i) => validate(s).map((m) => `router[${i}]: ${m}`));
  if (bad.length) { console.error(`error:\n  ${bad.join("\n  ")}`); process.exit(2); }

  const sb = createClient(url, key, { auth: { persistSession: false } });
  const isp = await resolveIsp(sb, opts.isp ?? env.NETPID_ISP);
  console.error(`ISP: ${isp.name} (${isp.slug})`);
  if (opts.dryRun) console.error("DRY RUN — nothing will be written\n");

  const results = [];
  for (const spec of specs) {
    if (opts.dryRun) {
      const shortname = rosName(
        spec.nas_shortname ?? String(spec.name).toLowerCase().replace(/[^a-z0-9]+/g, "-"),
        "netpid-nas",
      );
      console.error(`  would provision "${spec.name}" @ ${spec.host} (NAS ${shortname})`);
      results.push({ name: spec.name, host: spec.host, shortname, dry_run: true });
      continue;
    }
    const r = await provisionRouter(sb, isp.id, spec, opts);
    const script = buildRouterosSetup({
    // The only sanctioned non-repair caller. This CLI writes a .rsc for an
    // operator to inspect, and the RADIUS/PPP-only generator is what it has
    // always used here. Router provisioning goes through
    // buildRouterosInstaller() in src/installer.mjs.
    radiusOnly: true,
      shortname: r.shortname,
      radiusServer: spec.radius_server ?? r.router.radius_server_host ?? "<RADIUS_SERVER_IP>",
      secret: r.secretOnce ?? "<no NAS — set with --no-nas off>",
      routerIp: spec.host,
      identity: spec.name,
      profiles: Array.isArray(spec.profiles) ? spec.profiles : [],
    });

    if (opts.out) {
      const dir = path.resolve(opts.out);
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `${r.shortname}.rsc`);
      fs.writeFileSync(file, `${script}\n`, "utf8");
      console.error(`  wrote ${file}`);
    }
    results.push({
      name: r.router.name, host: String(r.router.host), id: r.router.id,
      shortname: r.shortname, secret_once: r.secretOnce, routeros_script: script,
    });
  }

  if (opts.json) {
    console.log(JSON.stringify({ isp: isp.slug, results }, null, 2));
    return;
  }
  for (const r of results) {
    console.log(`\n=== ${r.name} (${r.host}) ===`);
    if (r.dry_run) continue;
    if (r.secret_once) {
      console.log(`RADIUS secret — shown ONCE, copy it now:\n  ${r.secret_once}\n`);
    }
    console.log("Paste on the router:\n");
    console.log(r.routeros_script);
  }
}

main().catch((e) => {
  console.error(`error: ${e.message}`);
  process.exit(1);
});
