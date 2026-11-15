/**
 * Telemetry relay drain: Neon `telemetry_inbox` → Tiger hypertables.
 *
 * Why this exists: Daytona sandboxes can only egress on :443. Neon is reachable
 * there over SQL-over-HTTP, Tiger's Postgres port is not (measured 2026-11-14,
 * see db/migrations/0002). Sandboxes therefore append telemetry to Neon and this
 * drain moves it into Tiger, which still owns every aggregate the UI reads.
 */
import { db } from "@/db";
import { sql } from "drizzle-orm";
import { tiger } from "@/db/tiger";

const BATCH = 500;

type InboxRow = {
  id: string;
  kind: "episode" | "metric" | "live_frame";
  mission_id: string;
  run_id: string;
  payload: Record<string, unknown>;
  created_at: string | Date;
};

let running = false;
let timer: ReturnType<typeof setInterval> | null = null;
export const drainStats = { drained: 0, failed: 0, lastError: "" as string };

export async function drainOnce(limit = BATCH): Promise<number> {
  if (!tiger) return 0;
  const t = tiger;   // narrow once; the closures below lose the guard otherwise
  // Claim the batch ATOMICALLY. The previous shape was select-then-update, so
  // two concurrent drain loops both read the same undrained rows and both
  // inserted them into Tiger — measured at ~2.85x duplication, which inflated
  // episode counts and biased mean score. FOR UPDATE SKIP LOCKED makes a row
  // belong to exactly one drain.
  const res = await db.execute(sql`
    update telemetry_inbox set drained_at = now()
    where id in (
      select id from telemetry_inbox
      where drained_at is null
      order by id
      limit ${limit}
      for update skip locked
    )
    returning id::text, kind, mission_id, run_id, payload, created_at`);
  const rows = (res.rows ?? res) as unknown as InboxRow[];
  if (!rows.length) return 0;

  const episodes: InboxRow[] = [];
  const metrics: InboxRow[] = [];
  const frames: InboxRow[] = [];
  for (const r of rows) {
    if (r.kind === "episode") episodes.push(r);
    else if (r.kind === "metric") metrics.push(r);
    else if (r.kind === "live_frame") frames.push(r);
  }

  const n = (v: unknown) => (v === null || v === undefined || v === "" ? null : Number(v));
  // the sandbox wrote this row at created_at; using Date.now() here would
  // squash a backfill into one instant and break every time-range query
  const ts = (r: InboxRow) => new Date(r.created_at);

  try {
    if (episodes.length) {
      await t`
        insert into episode_stats
          (ts, mission_id, run_id, env, phase, policy, seed, global_step,
           score, removal, damage, trample, "precision", steps)
        values ${tiger(episodes.map((r) => {
          const p = r.payload as Record<string, unknown>;
          return [
            ts(r), r.mission_id, r.run_id, Number(p.env ?? 0),
            String(p.phase ?? "train"), String(p.policy ?? "cand"),
            Number(p.seed ?? 0), Number(p.global_step ?? 0),
            n(p.score), n(p.removal), n(p.damage), n(p.trample),
            n(p.precision), n(p.steps),
          ];
        }))}`;
    }
    if (metrics.length) {
      await t`
        insert into run_metrics
          (ts, run_id, step, ep_return_mean, target_removal_rate, protect_damage_rate,
           trample_rate, act_precision, fps, policy_loss, value_loss, entropy,
           approx_kl, components)
        values ${tiger(metrics.map((r) => {
          const p = r.payload as Record<string, unknown>;
          return [
            ts(r), r.run_id, Number(p.step ?? 0),
            n(p.ep_return_mean), n(p.target_removal_rate), n(p.protect_damage_rate),
            n(p.trample_rate), n(p.act_precision), n(p.fps),
            n(p.policy_loss), n(p.value_loss), n(p.entropy), n(p.approx_kl),
            t.json((p.components ?? {}) as object),
          ];
        }))}`;
    }
    if (frames.length) {
      await t`
        insert into live_frames (ts, mission_id, run_id, seq, phase, global_step, data)
        values ${tiger(frames.map((r) => {
          const p = r.payload as Record<string, unknown>;
          return [
            ts(r), r.mission_id, r.run_id, Number(p.seq ?? 0),
            String(p.phase ?? "train"), Number(p.global_step ?? 0),
            t.json((p.data ?? {}) as object),
          ];
        }))}`;
    }

    // rows were already marked drained by the atomic claim above
    drainStats.drained += rows.length;
    return rows.length;
  } catch (err) {
    // The claim already marked these drained. Since the Tiger write failed,
    // release them so the next pass retries instead of silently losing them.
    try {
      const ids = rows.map((r) => r.id);
      await db.execute(sql`
        update telemetry_inbox set drained_at = null
        where id = any(${sql.raw(`array[${ids.join(",")}]::bigint[]`)})`);
    } catch { /* if the release fails the rows stay claimed; counted below */ }
    drainStats.failed += rows.length;
    drainStats.lastError = (err as Error).message;
    console.warn("[drain] failed:", drainStats.lastError);
    return 0;
  }
}

/** Idempotent: the first SSE connection starts it, later ones reuse it. */
export function startDrain(intervalMs = 700) {
  if (running || !tiger) return;
  running = true;
  timer = setInterval(() => {
    drainOnce().catch(() => {});
  }, intervalMs);
}

export function stopDrain() {
  if (timer) clearInterval(timer);
  timer = null;
  running = false;
}
