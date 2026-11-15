/**
 * Standalone drain: Neon telemetry_inbox -> Tiger hypertables.
 * Used to backfill rows that queued while Tiger auth was broken, without
 * restarting the app server (which would kill a running mission).
 * Preserves each row's original created_at so the timeline stays real.
 */
import { config } from "dotenv";
import pg from "pg";
import postgres from "postgres";

config({ path: new URL("../../../.env.local", import.meta.url).pathname, quiet: true });
const clean = (v) => (v || "").trim().replace(/^["']|["']$/g, "");

const neon = new pg.Client({ connectionString: clean(process.env.DATABASE_URL) });
const tiger = postgres(clean(process.env.TIGER_DATABASE_URL), { ssl: "require", max: 4, prepare: false });

const n = (v) => (v === null || v === undefined || v === "" ? null : Number(v));
let drained = 0, failed = 0;

await neon.connect();
try {
  for (;;) {
    const { rows } = await neon.query(
      `select id::text, kind, mission_id, run_id, payload, created_at
       from telemetry_inbox where drained_at is null order by id limit 500`);
    if (!rows.length) break;

    const ep = rows.filter((r) => r.kind === "episode");
    const me = rows.filter((r) => r.kind === "metric");
    const lf = rows.filter((r) => r.kind === "live_frame");

    try {
      if (ep.length) {
        await tiger`insert into episode_stats
          (ts, mission_id, run_id, env, phase, policy, seed, global_step,
           score, removal, damage, trample, "precision", steps)
          values ${tiger(ep.map((r) => {
            const p = r.payload;
            return [new Date(r.created_at), r.mission_id, r.run_id, Number(p.env ?? 0),
              String(p.phase ?? "train"), String(p.policy ?? "cand"),
              Number(p.seed ?? 0), Number(p.global_step ?? 0),
              n(p.score), n(p.removal), n(p.damage), n(p.trample), n(p.precision), n(p.steps)];
          }))}`;
      }
      if (me.length) {
        await tiger`insert into run_metrics
          (ts, run_id, step, ep_return_mean, target_removal_rate, protect_damage_rate,
           trample_rate, act_precision, fps, policy_loss, value_loss, entropy, approx_kl, components)
          values ${tiger(me.map((r) => {
            const p = r.payload;
            return [new Date(r.created_at), r.run_id, Number(p.step ?? 0),
              n(p.ep_return_mean), n(p.target_removal_rate), n(p.protect_damage_rate),
              n(p.trample_rate), n(p.act_precision), n(p.fps),
              n(p.policy_loss), n(p.value_loss), n(p.entropy), n(p.approx_kl),
              tiger.json(p.components ?? {})];
          }))}`;
      }
      if (lf.length) {
        await tiger`insert into live_frames (ts, mission_id, run_id, seq, phase, global_step, data)
          values ${tiger(lf.map((r) => {
            const p = r.payload;
            return [new Date(r.created_at), r.mission_id, r.run_id, Number(p.seq ?? 0),
              String(p.phase ?? "train"), Number(p.global_step ?? 0), tiger.json(p.data ?? {})];
          }))}`;
      }
      const ids = rows.map((r) => r.id).join(",");
      await neon.query(`update telemetry_inbox set drained_at = now() where id = any(array[${ids}]::bigint[])`);
      drained += rows.length;
      process.stdout.write(`\rdrained ${drained}…`);
    } catch (e) {
      failed += rows.length;
      console.error("\nbatch failed:", e.message.slice(0, 200));
      break;
    }
  }
} finally {
  console.log(`\ndrained=${drained} failed=${failed}`);
  const [a] = await tiger`select count(*) n from episode_stats`;
  const [b] = await tiger`select count(*) n from live_frames`;
  const [c] = await tiger`select count(*) n from run_metrics`;
  console.log(`tiger now: episode_stats=${a.n} live_frames=${b.n} run_metrics=${c.n}`);
  await neon.end(); await tiger.end();
}
