/**
 * Tiger Data (telemetry engine) — SCHEMA.md §1.1.
 * Join key to Neon is run_id / mission_id, in app code. No cross-DB FKs.
 */
import postgres from "postgres";

const url = process.env.TIGER_DATABASE_URL;

const g = globalThis as unknown as { __furrowTiger?: ReturnType<typeof postgres> };

export const tiger = (() => {
  if (!url) return null;
  if (!g.__furrowTiger) {
    g.__furrowTiger = postgres(url, {
      max: 8,
      // Tiger Cloud presents a private CA chain; `require` encrypts without
      // asserting the chain, matching libpq's sslmode=require (and the CLI).
      ssl: "require",
      prepare: false,
    });
  }
  return g.__furrowTiger;
})();

export function requireTiger() {
  if (!tiger) throw new Error("TIGER_DATABASE_URL is not set");
  return tiger;
}

export type CurvePoint = {
  bucket: Date; mission_id: string; run_id: string; phase: string; policy: string;
  score: number | null; removal: number | null; damage: number | null; episodes: number;
};

/** Learning curves. curve_5s is a real-time aggregate, so this includes the newest seconds. */
export async function curve(missionId: string, since?: Date) {
  const sql = requireTiger();
  return sql<CurvePoint[]>`
    select bucket, mission_id, run_id, phase, policy, score, removal, damage, episodes
    from curve_5s
    where mission_id = ${missionId}
      and (${since ?? null}::timestamptz is null or bucket > ${since ?? null}::timestamptz)
    order by bucket asc`;
}

/** Farm heat-map: latest score per env (one row per field tile). */
export async function farmHeat(missionId: string) {
  const sql = requireTiger();
  return sql<{ run_id: string; env: number; score: number | null }[]>`
    select h.run_id, h.env, h.score
    from farm_heat h
    join (select distinct run_id from episode_stats where mission_id = ${missionId}) r
      on r.run_id = h.run_id`;
}

/** Before | After totals during the test phase. */
export async function testSplit(missionId: string) {
  const sql = requireTiger();
  return sql<{ policy: string; episodes: number; removal: number; damage: number; score: number }[]>`
    select policy, episodes, removal, damage, score
    from test_split where mission_id = ${missionId}`;
}

/** Training Farm frame stream. */
export async function liveFrames(missionId: string, afterTs?: Date, limit = 64) {
  const sql = requireTiger();
  return sql<{ ts: Date; run_id: string; seq: number; phase: string; global_step: number; data: unknown }[]>`
    select ts, run_id, seq, phase, global_step, data
    from live_frames
    where mission_id = ${missionId}
      and (${afterTs ?? null}::timestamptz is null or ts > ${afterTs ?? null}::timestamptz)
    order by ts asc
    limit ${limit}`;
}
