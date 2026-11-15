/**
 * Integration test: real PPO inside a Daytona sandbox.
 * Proves, end to end: torch installs in the sandbox · FieldGym trains ·
 * Neon writes land over SQL-over-HTTPS · telemetry relays into telemetry_inbox.
 */
import { config } from "dotenv";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { Daytona } from "@daytonaio/sdk";
import pg from "pg";

config({ path: new URL("../../../.env.local", import.meta.url).pathname, quiet: true });
const clean = (v) => (v || "").trim().replace(/^["']|["']$/g, "");
const DB = clean(process.env.DATABASE_URL);
const ROOT = new URL("../../../", import.meta.url).pathname;
const TRAINER = join(ROOT, "trainer");

const MISSION = "msn_itest";
const RUN = "run_itest";
const STEPS = Number(process.env.ITEST_STEPS || 12000);
const N_ENVS = Number(process.env.ITEST_ENVS || 8);

const REWARD = `
def reward(info):
    c = {}
    c["pull_weed"] = 3.0 * info["removed_target"]
    c["crop_hit"] = -5.0 * info["removed_protect"]
    c["trample"] = -1.5 * info["trampled_protect"]
    c["miss"] = -0.08 if info["miss"] else 0.0
    c["approach"] = 0.02 / (1.0 + info["nearest_target_dist"])
    c["row"] = -0.03 * info["dist_to_row_center"]
    c["step"] = -0.002
    return sum(c.values()), c
`;

function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    if (e === "__pycache__" || e.endsWith(".pyc")) continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const sqlClient = new pg.Client({ connectionString: DB });

async function seedMission() {
  await sqlClient.connect();
  const envCfg = JSON.parse(readFileSync(join(ROOT, "scripts/itest_env_config.json"), "utf8"));
  // full FK chain, exactly as the Trainer agent creates it before launching a sandbox
  await sqlClient.query(
    `insert into missions (id, goal_text, status) values ($1,$2,'training')
     on conflict (id) do update set status = 'training'`,
    [MISSION, "integration test: pull pigweed from strawberry beds"],
  );
  await sqlClient.query(
    `insert into env_configs (id, mission_id, config) values ('env_itest',$1,$2)
     on conflict (id) do update set config = $2`, [MISSION, JSON.stringify(envCfg)]);
  await sqlClient.query(
    `insert into reward_specs (id, mission_id, generation, variant, code, rationale)
     values ('rwd_itest',$1,0,0,$2,'integration test reward')
     on conflict (id) do update set code = $2`, [MISSION, REWARD]);
  await sqlClient.query(
    `insert into policies (id, name, kind, mission_id, artifact_id)
     values ('pol_itest_base','rover-base-itest','base',$1,'art_seed')
     on conflict (id) do nothing`, [MISSION]);
  await sqlClient.query(
    `insert into runs (id, mission_id, generation, variant, reward_spec_id, env_config_id,
                       init_policy_id, hyperparams, status)
     values ($1,$2,0,0,'rwd_itest','env_itest','pol_itest_base',$3,'queued')
     on conflict (id) do update set status='queued', progress=0, error=null`,
    [RUN, MISSION, JSON.stringify({ algo: "PPO", total_steps: STEPS, n_envs: N_ENVS })]);
  await sqlClient.query(`delete from telemetry_inbox where mission_id = $1`, [MISSION]);
  await sqlClient.query(`delete from replays where mission_id = $1`, [MISSION]);
  console.log("seeded mission + env_config + reward_spec + base policy + run row");
}

const d = new Daytona({ apiKey: process.env.DAYTONA_API_KEY, apiUrl: process.env.DAYTONA_API_URL });
let sb;
try {
  await seedMission();
  console.log("creating sandbox…");
  sb = await d.create({ language: "python", autoStopInterval: 20 });
  console.log("sandbox", sb.id);

  // upload the trainer package
  const files = walk(TRAINER).map((p) => ({
    source: readFileSync(p),
    destination: join("/home/daytona/trainer", relative(TRAINER, p)),
  }));
  await sb.fs.uploadFiles(files);
  console.log(`uploaded ${files.length} trainer files`);

  const job = {
    job: "train",
    mission_id: MISSION,
    run_id: RUN,
    env_config: JSON.parse(readFileSync(join(ROOT, "scripts/itest_env_config.json"), "utf8")),
    reward_code: REWARD,
    hyperparams: {
      algo: "PPO", total_steps: STEPS, n_envs: N_ENVS, lr: 3e-4, n_steps: 1024,
      batch_size: 512, gamma: 0.99, ent_coef: 0.005, clip_range: 0.2, seed: 7,
      metrics_every: 2000, replay_every: 25000, replay_seed: 1000,
    },
  };
  await sb.fs.uploadFile(Buffer.from(JSON.stringify(job, null, 2)), "/home/daytona/job.json");

  console.log("installing torch + sb3 (this is the slow part)…");
  const t0 = Date.now();
  const inst = await sb.process.executeCommand(
    "pip install --quiet numpy gymnasium 'stable-baselines3>=2.3' torch pydantic 'psycopg[binary]' 2>&1 | tail -4; " +
    "python3 -c \"import torch, stable_baselines3, gymnasium; print('torch', torch.__version__, '| sb3', stable_baselines3.__version__)\"",
    undefined, undefined, 900,
  );
  console.log(inst.result?.trim());
  console.log(`install took ${((Date.now() - t0) / 1000).toFixed(0)}s`);

  console.log(`training ${STEPS} steps on ${N_ENVS} envs…`);
  const t1 = Date.now();
  const run = await sb.process.executeCommand(
    "cd /home/daytona && " +
    `DATABASE_URL='${DB}' FURROW_DB_TRANSPORT=http ` +
    "python3 trainer/train.py --job job.json 2>&1 | tail -25",
    undefined, undefined, 1800,
  );
  console.log(run.result);
  console.log(`training wall clock ${((Date.now() - t1) / 1000).toFixed(0)}s`);

  // ── verify from the laptop side ──
  const inbox = await sqlClient.query(
    `select kind, count(*) n from telemetry_inbox where mission_id = $1 group by kind order by kind`,
    [MISSION],
  );
  console.log("telemetry_inbox:", inbox.rows.map((r) => `${r.kind}=${r.n}`).join(" ") || "(empty)");

  const learn = await sqlClient.query(
    `select (payload->>'global_step')::int as step, avg((payload->>'score')::float) as score,
            avg((payload->>'removal')::float) as removal, count(*) n
     from telemetry_inbox
     where mission_id = $1 and kind = 'episode'
     group by 1 order by 1`,
    [MISSION],
  );
  if (learn.rows.length) {
    const first = learn.rows.slice(0, Math.ceil(learn.rows.length / 3));
    const last = learn.rows.slice(-Math.ceil(learn.rows.length / 3));
    const avg = (rs, k) => rs.reduce((a, r) => a + Number(r[k]), 0) / rs.length;
    console.log(`episodes: ${learn.rows.reduce((a, r) => a + Number(r.n), 0)} across ${learn.rows.length} step buckets`);
    console.log(`score    first third ${avg(first, "score").toFixed(3)} -> last third ${avg(last, "score").toFixed(3)}`);
    console.log(`removal  first third ${avg(first, "removal").toFixed(3)} -> last third ${avg(last, "removal").toFixed(3)}`);
  }
  const arts = await sqlClient.query(`select kind, size from artifacts order by created_at desc limit 3`);
  console.log("artifacts:", arts.rows.map((r) => `${r.kind}:${r.size}B`).join(", ") || "(none)");
  const pol = await sqlClient.query(`select count(*) n from policies where mission_id = $1`, [MISSION]);
  const rep = await sqlClient.query(`select count(*) n, max(jsonb_array_length(data->'plants')) plants,
      max((summary->>'score')::float) score from replays where mission_id = $1`, [MISSION]);
  console.log(`policies=${pol.rows[0].n} replays=${rep.rows[0].n} replay_plants=${rep.rows[0].plants} replay_score=${rep.rows[0].score}`);
  const rr = await sqlClient.query(`select status, progress, result_policy_id, error from runs where id = $1`, [RUN]);
  console.log("run row:", rr.rows[0]);
} catch (e) {
  console.error("FAILED:", e?.message || e);
  process.exitCode = 1;
} finally {
  try { await sqlClient.end(); } catch {}
  if (sb) { try { await sb.delete(); console.log("sandbox deleted"); } catch {} }
}
