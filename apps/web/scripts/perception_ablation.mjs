/**
 * The ablation that isolates the web data's contribution.
 *
 * Takes ONE policy and evaluates it twice on the SAME fixed seeds:
 *   A) with the perception pool built from Bright Data images
 *   B) with uninformative perception (p_target ~ N(0.5, 0.08))
 * Everything else — policy weights, field, seeds, dynamics — is identical, so
 * the difference is attributable to the scraped images and nothing else.
 *
 *   node scripts/perception_ablation.mjs <missionId> [policyId]
 */
import { config } from "dotenv";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { Daytona } from "@daytonaio/sdk";
import pg from "pg";

config({ path: new URL("../../../.env.local", import.meta.url).pathname, quiet: true });
const clean = (v) => (v || "").trim().replace(/^["']|["']$/g, "");
const ROOT = new URL("../../../", import.meta.url).pathname;
const missionId = process.argv[2];
if (!missionId) { console.error("usage: node scripts/perception_ablation.mjs <missionId> [policyId]"); process.exit(1); }

function walk(d, o = []) {
  for (const e of readdirSync(d)) {
    if (e === "__pycache__" || e.endsWith(".pyc")) continue;
    const p = join(d, e);
    statSync(p).isDirectory() ? walk(p, o) : o.push(p);
  }
  return o;
}

const db = new pg.Client({ connectionString: clean(process.env.DATABASE_URL) });
await db.connect();

const { rows: envRows } = await db.query(
  `select config from env_configs where mission_id = $1 order by created_at desc limit 1`, [missionId]);
if (!envRows.length) throw new Error("no env_config for " + missionId);
const envConfig = envRows[0].config;

const { rows: pmRows } = await db.query(
  `select id, pool_artifact_id, metrics from perception_models where mission_id = $1
   order by created_at desc limit 1`, [missionId]);
const poolArtifact = pmRows[0]?.pool_artifact_id;
if (!poolArtifact) throw new Error("no perception pool for " + missionId);

const policyId = process.argv[3];
const { rows: polRows } = policyId
  ? await db.query(`select id, name, kind, artifact_id from policies where id = $1`, [policyId])
  : await db.query(
      `select id, name, kind, artifact_id from policies
       where mission_id = $1 and kind = 'promoted' order by created_at desc limit 1`, [missionId]);
if (!polRows.length) throw new Error("no promoted policy for " + missionId);
const policy = polRows[0];
console.log(`policy under test: ${policy.id} (${policy.kind}) ${policy.name}`);
console.log(`perception pool  : ${poolArtifact}  separation=${pmRows[0].metrics?.pool_separation}`);

const d = new Daytona({ apiKey: process.env.DAYTONA_API_KEY, apiUrl: process.env.DAYTONA_API_URL });
let sb;
try {
  sb = await d.create({ language: "python", autoStopInterval: 15, labels: { furrow_role: "ablation" } });
  console.log("sandbox", sb.id);
  const trainer = join(ROOT, "trainer");
  await sb.fs.uploadFiles(walk(trainer).map((p) => ({
    source: readFileSync(p), destination: join("/home/daytona/trainer", relative(trainer, p)),
  })));
  await sb.process.executeCommand(
    "pip install -q numpy gymnasium pydantic torch 'stable-baselines3>=2.3' 'psycopg[binary]' 2>&1 | tail -1",
    undefined, undefined, 1200);

  // with the web-built pool
  const withPool = {
    job: "eval", mission_id: missionId,
    init_policy_artifact_id: policy.artifact_id,
    env_config: envConfig,
    perception_pool_artifact_id: poolArtifact,
  };
  // identical, except perception falls back to uninformative
  const withoutPool = {
    ...withPool,
    env_config: { ...envConfig, perception: { mode: "uninformative" } },
    perception_pool_artifact_id: undefined,
  };

  const runOne = async (job, label) => {
    await sb.fs.uploadFile(Buffer.from(JSON.stringify(job, null, 2)), "/home/daytona/ab.json");
    const r = await sb.process.executeCommand(
      `cd /home/daytona && DATABASE_URL='${clean(process.env.DATABASE_URL)}' FURROW_DB_TRANSPORT=http ` +
      `python3 trainer/evaluate.py --job ab.json 2>&1 | tail -4`, undefined, undefined, 1800);
    const m = /EVAL_METRICS_JSON=(\{.*\})/.exec(r.result ?? "");
    if (!m) { console.log(label, "-> no metrics\n", (r.result ?? "").slice(-400)); return null; }
    const j = JSON.parse(m[1]);
    const g = (k) => j[k]?.mean;
    console.log(`${label.padEnd(34)} removed=${g("target_removal_rate").toFixed(3)} ` +
      `damage=${g("protect_damage_rate").toFixed(3)} precision=${g("act_precision").toFixed(3)} ` +
      `score=${g("score").toFixed(3)}`);
    return j;
  };

  console.log("\nSAME policy, SAME seeds, SAME field — only the perception differs:\n");
  const a = await runOne(withPool, "WITH Bright Data perception");
  const b = await runOne(withoutPool, "WITHOUT (uninformative)");
  if (a && b) {
    const dr = a.target_removal_rate.mean - b.target_removal_rate.mean;
    const dd = a.protect_damage_rate.mean - b.protect_damage_rate.mean;
    const dp = a.act_precision.mean - b.act_precision.mean;
    console.log(`\nATTRIBUTABLE TO THE WEB DATA:`);
    console.log(`  weeds removed  ${dr >= 0 ? "+" : ""}${(dr * 100).toFixed(1)} points`);
    console.log(`  crop damage    ${dd >= 0 ? "+" : ""}${(dd * 100).toFixed(1)} points (negative is better)`);
    console.log(`  act precision  ${dp >= 0 ? "+" : ""}${(dp * 100).toFixed(1)} points`);
  }
} catch (e) { console.error("ERR", e?.message); process.exitCode = 1; }
finally {
  await db.end().catch(() => {});
  if (sb) { await sb.delete().catch(() => {}); console.log("sandbox deleted"); }
}
