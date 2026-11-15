/**
 * Cost guardrail: list every branch in the Neon project and delete the ones
 * Furrow created. A branch costs storage (and compute the moment something
 * connects to it), so a fork that is never cleaned up bills forever.
 *
 *   node scripts/neon_branches.mjs            # list only (always safe)
 *   node scripts/neon_branches.mjs --delete   # delete Furrow's fork branches
 *   node scripts/neon_branches.mjs --delete --branch br-xxx   # just that one
 *
 * Mirrors scripts/daytona_cleanup.mjs: nothing is destroyed without --delete.
 *
 * TWO BRANCHES CAN NEVER BE DELETED BY THIS SCRIPT, whatever flags are passed:
 *   · main            — the project's default branch, the live agent backend
 *   · demo-golden     — br-plain-dawn-bbo54zme, the pinned demo replay
 * They are filtered out by name AND by id, before the delete loop, and any
 * branch Neon reports as default or protected is filtered out too.
 */
import { config } from "dotenv";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";
import pg from "pg";

const exec = promisify(execFile);

config({ path: new URL("../../../.env.local", import.meta.url).pathname, quiet: true });

const API = process.env.NEON_API_BASE ?? "https://console.neon.tech/api/v2";
const KEY = process.env.NEON_API_KEY;

/** Belt and braces: by name, and by id, and by Neon's own flags. */
const PROTECTED_NAMES = new Set(["main", "demo-golden"]);
const PROTECTED_IDS = new Set(["br-plain-dawn-bbo54zme"]);
const FORK_PREFIX = "furrow-fork-";

const DO_DELETE = process.argv.includes("--delete");
const ONLY = (() => {
  const i = process.argv.indexOf("--branch");
  return i > -1 ? process.argv[i + 1] : null;
})();

function projectId() {
  if (process.env.NEON_PROJECT_ID) return process.env.NEON_PROJECT_ID;
  for (const p of ["../../../.neon", "../.neon"]) {
    try {
      const j = JSON.parse(readFileSync(new URL(p, import.meta.url).pathname, "utf8"));
      if (j.projectId) return j.projectId;
    } catch { /* next */ }
  }
  throw new Error("NEON_PROJECT_ID is not set and no .neon file was found");
}

/** Without NEON_API_KEY, fall back to the logged-in `neon` CLI passthrough. */
async function cliApi(path, init = {}) {
  const args = ["api", path, "-X", String(init.method ?? "GET"),
    ...(init.body ? ["-d", String(init.body)] : [])];
  const { stdout } = await exec("neon", args, { timeout: 60_000, maxBuffer: 8 * 1024 * 1024 });
  const text = stdout.trim();
  return text ? JSON.parse(text) : {};
}

async function api(path, init = {}) {
  if (!KEY) {
    if (process.env.NEON_CLI_FALLBACK === "false") {
      throw new Error("NEON_API_KEY is not set (see .env.local)");
    }
    return await cliApi(path, init);
  }
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${KEY}`,
      "content-type": "application/json",
      accept: "application/json",
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`neon api ${init.method ?? "GET"} ${path} → ${res.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : {};
}

/** The forks our app recorded, so a branch is flagged as ours even if renamed. */
async function knownForks() {
  if (!process.env.DATABASE_URL) return new Map();
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
  try {
    await c.connect();
    const r = await c.query(
      `select id, mission_id, neon_branch_id, from_stage, status, deleted_at
         from mission_forks`,
    );
    return new Map(r.rows.map((row) => [row.neon_branch_id, row]));
  } catch (err) {
    console.warn(`(could not read mission_forks: ${err.message})`);
    return new Map();
  } finally {
    await c.end().catch(() => {});
  }
}

const mb = (bytes) => (bytes ? `${(bytes / 1024 / 1024).toFixed(1)}MB` : "?");
const ageOf = (iso) => {
  if (!iso) return "?";
  const m = (Date.now() - new Date(iso).getTime()) / 60000;
  return m < 60 ? `${m.toFixed(0)}m` : m < 1440 ? `${(m / 60).toFixed(1)}h` : `${(m / 1440).toFixed(1)}d`;
};

const project = projectId();
console.log(KEY ? "(transport: NEON_API_KEY)" : "(transport: neon CLI passthrough — set NEON_API_KEY for the HTTP API)");
const forks = await knownForks();
const { branches } = await api(`/projects/${project}/branches`);

if (!branches?.length) {
  console.log("no branches in the project — nothing allocated");
  process.exit(0);
}

const classify = (b) => {
  const locked = Boolean(b.default) || Boolean(b.protected) ||
    PROTECTED_NAMES.has(b.name) || PROTECTED_IDS.has(b.id);
  const ours = !locked && (b.name.startsWith(FORK_PREFIX) || forks.has(b.id));
  return { locked, ours };
};

let total = 0;
console.log(`project ${project} — ${branches.length} branch(es):`);
for (const b of branches) {
  const { locked, ours } = classify(b);
  total += Number(b.logical_size ?? 0);
  const fork = forks.get(b.id);
  console.log(
    `  ${b.id}  ${b.name}` +
    `  size=${mb(b.logical_size)}  age=${ageOf(b.created_at)}  state=${b.current_state ?? "?"}` +
    `  ${locked ? "PROTECTED" : ours ? "furrow-fork" : "other"}` +
    (fork ? `  mission=${fork.mission_id} from=${fork.from_stage} status=${fork.status}` : ""),
  );
}
console.log(`total logical size: ${mb(total)}`);

const deletable = branches
  .filter((b) => classify(b).ours)
  .filter((b) => !ONLY || b.id === ONLY);

if (!deletable.length) {
  console.log(ONLY
    ? `\nnothing deletable matching ${ONLY} (it is protected, or not a Furrow fork)`
    : "\nno Furrow fork branches to clean up");
  process.exit(0);
}

if (!DO_DELETE) {
  console.log(`\n${deletable.length} Furrow fork branch(es) would be deleted:`);
  for (const b of deletable) console.log(`  ${b.id}  ${b.name}`);
  console.log("(dry run — pass --delete to remove them)");
  process.exit(0);
}

for (const b of deletable) {
  // re-assert the guard immediately before the destructive call
  const { locked } = classify(b);
  if (locked) { console.log("refusing to delete protected branch", b.name); continue; }
  try {
    await api(`/projects/${project}/branches/${b.id}`, { method: "DELETE" });
    console.log("deleted", b.id, b.name);
    if (forks.has(b.id) && process.env.DATABASE_URL) {
      const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
      try {
        await c.connect();
        await c.query(
          `update mission_forks set status='deleted', deleted_at=now(), updated_at=now()
             where neon_branch_id=$1`, [b.id]);
      } finally { await c.end().catch(() => {}); }
    }
  } catch (err) {
    console.warn("could not delete", b.id, err.message);
  }
}
console.log("done — storage released");
