/**
 * Pin a finished mission as the golden demo and freeze a copy of it.
 *
 *   node scripts/seed_demo.mjs <missionId>
 *
 * 1. marks the mission is_demo = true
 * 2. creates the Neon branch `demo-golden` from main (a copy-on-write clone of
 *    the data as it stands right now) and prints its pooled connection string
 * 3. tells you the two env vars replay mode needs
 *
 * Replay mode then reads state from demo-golden and telemetry for
 * DEMO_MISSION_ID out of Tiger by time range, so a dead network during judging
 * costs nothing (CLAUDE.md §4, DESIGN.md §9).
 */
import { config } from "dotenv";
import { execFileSync } from "node:child_process";
import pg from "pg";

config({ path: new URL("../../../.env.local", import.meta.url).pathname, quiet: true });
const clean = (v) => (v || "").trim().replace(/^["']|["']$/g, "");

const missionId = process.argv[2];
if (!missionId) {
  console.error("usage: node scripts/seed_demo.mjs <missionId>");
  process.exit(1);
}

const c = new pg.Client({ connectionString: clean(process.env.DATABASE_URL) });
await c.connect();
try {
  const m = await c.query(
    `select id, goal_text, status, generation, best_policy_id, baseline_eval_id
     from missions where id = $1`, [missionId]);
  if (!m.rowCount) throw new Error(`mission ${missionId} not found`);
  const row = m.rows[0];
  console.log("mission:", row.id, "|", row.status, "| gen", row.generation);
  if (row.status !== "done") {
    console.warn(`WARNING: status is '${row.status}', not 'done' — pinning it anyway`);
  }

  // what the replay actually has to show
  const counts = await c.query(`
    select
      (select count(*) from agent_events where mission_id = $1) events,
      (select count(*) from sources where mission_id = $1) sources,
      (select count(*) from facts where mission_id = $1) facts,
      (select count(*) from dataset_items where mission_id = $1) images,
      (select count(*) from replays where mission_id = $1) replays,
      (select count(*) from evaluations where mission_id = $1) evals,
      (select count(*) from voice_clips where mission_id = $1) clips`, [missionId]);
  console.log("contents:", counts.rows[0]);
  const { replays, evals } = counts.rows[0];
  if (Number(replays) === 0 || Number(evals) === 0) {
    console.warn("WARNING: no replays or no evaluations — the compare view will be empty");
  }

  await c.query(`update missions set is_demo = false where is_demo = true and id <> $1`, [missionId]);
  await c.query(`update missions set is_demo = true where id = $1`, [missionId]);
  console.log("pinned is_demo = true");
} finally {
  await c.end();
}

// Neon branch: a frozen copy-on-write clone for replay mode
console.log("\ncreating the Neon branch `demo-golden` …");
try {
  const out = execFileSync("neon", [
    "branches", "create", "--name", "demo-golden", "-o", "json",
  ], { encoding: "utf8", cwd: new URL("../../../", import.meta.url).pathname });
  const j = JSON.parse(out);
  const uri = j?.connection_uris?.[0]?.connection_uri;
  console.log("branch created:", j?.branch?.id ?? "(id unknown)");
  if (uri) {
    console.log("\nAdd these to .env.local:");
    console.log(`DATABASE_URL_DEMO=${uri}`);
    console.log(`DEMO_MISSION_ID=${missionId}`);
  } else {
    console.log("branch made, but no connection uri in the response — run:");
    console.log("  neon connection-string demo-golden");
  }
} catch (err) {
  const msg = String(err.stdout || err.stderr || err.message);
  if (/already exists/i.test(msg)) {
    console.log("`demo-golden` already exists. To refresh it from current main:");
    console.log("  neon branches delete demo-golden && node scripts/seed_demo.mjs " + missionId);
  } else {
    console.error("branch creation failed:", msg.slice(0, 300));
    console.error("(the pin still worked; create the branch by hand if you want replay isolation)");
  }
}
console.log("\nReminder: exclude the golden mission from any Tiger retention job (SCHEMA.md §1).");
