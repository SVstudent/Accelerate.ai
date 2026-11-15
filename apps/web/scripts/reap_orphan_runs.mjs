/**
 * Orphaned run reaper.
 *
 * A run row sits in `booting`/`queued` while its sandbox starts. If the server
 * dies in that window the row stays that way forever, and two things break:
 *   1. the sandbox pool counts it against the ceiling, so later generations
 *      fail with "sandbox ceiling reached" even on an empty account;
 *   2. the arena renders "Sandboxes booting" instead of replaying the mission.
 *
 * A run is an orphan when its mission has not produced a heartbeat or an agent
 * event for STALE_MIN minutes. Runs belonging to a LIVE mission are never
 * touched, so this is safe to run while a mission trains.
 *
 * Dry run by default; pass --apply to write.
 */
import { config } from "dotenv";
import postgres from "postgres";

config({ path: new URL("../../../.env.local", import.meta.url).pathname, quiet: true });

const STALE_MIN = Number(process.env.REAP_STALE_MIN ?? 10);
const apply = process.argv.includes("--apply");
const sql = postgres(process.env.DATABASE_URL, { ssl: "require", max: 2 });

const stuck = await sql`
  select r.id, r.mission_id, r.generation, r.variant, r.status,
         greatest(
           coalesce(extract(epoch from (now() - m.heartbeat_at)) / 60, 1e9),
           coalesce((select extract(epoch from (now() - max(e.ts))) / 60
                     from agent_events e where e.mission_id = m.id), 1e9)
         ) as quiet_min,
         least(
           coalesce(extract(epoch from (now() - m.heartbeat_at)) / 60, 1e9),
           coalesce((select extract(epoch from (now() - max(e.ts))) / 60
                     from agent_events e where e.mission_id = m.id), 1e9)
         ) as freshest_min
  from runs r
  join missions m on m.id = r.mission_id
  where r.status in ('booting', 'queued')
  order by r.mission_id, r.generation, r.variant`;

const orphans = stuck.filter((r) => Number(r.freshest_min) > STALE_MIN);
const live = stuck.filter((r) => Number(r.freshest_min) <= STALE_MIN);

console.log(`runs in booting/queued: ${stuck.length}`);
console.log(`  belonging to LIVE missions (never touched): ${live.length}`);
console.log(`  orphaned (quiet > ${STALE_MIN}m): ${orphans.length}`);

const byMission = new Map();
for (const r of orphans) {
  byMission.set(r.mission_id, (byMission.get(r.mission_id) ?? 0) + 1);
}
for (const [mid, n] of byMission) console.log(`    ${mid}  ${n} run(s)`);

if (!orphans.length) {
  console.log("nothing to reap");
} else if (!apply) {
  console.log("\n(dry run — pass --apply to mark these failed)");
} else {
  const ids = orphans.map((r) => r.id);
  const done = await sql`
    update runs set status = 'failed'
    where id = any(${ids}) and status in ('booting','queued')
    returning id`;
  console.log(`\nreaped ${done.length} orphaned run(s)`);
  console.log("their telemetry, policies and evaluations are untouched —");
  console.log("a run that never trained produced none of those.");
}

await sql.end();
