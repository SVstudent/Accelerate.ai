/**
 * Mission resumability — what survived, and where to pick up.
 *
 * THE PROBLEM. The Mastra workflow runs inside the Next.js server process.
 * Every rebuild, crash or deploy kills every in-flight mission; the row keeps
 * saying `training` and the UI advertises a run that does not exist. We found
 * fourteen of them, one 38 minutes into real work: Bright Data requests already
 * paid for, sandbox minutes already burned, a trained perception model already
 * fitted — all of it still sitting in Postgres, and all of it thrown away
 * because the only record of "how far did it get" was in RAM.
 *
 * THE APPROACH. Nothing here tries to keep the in-memory workflow alive.
 * Progress is RECONSTRUCTED from what is durable in Neon: the mission row, the
 * agent_events trace, and the per-stage output tables. Each stage declares what
 * its finished product looks like in Postgres; the first stage whose product is
 * missing is where a resume starts. Everything before it is reused as-is.
 *
 * Liveness is a separate question from progress. GET /api/missions already
 * reports a working-state mission with no agent_event for >10 minutes as
 * `stalled`; this module uses the same signal (and `missions.heartbeat_at`,
 * which the live stage runner writes while a long PPO run is quiet) rather than
 * inventing a second definition of dead.
 */
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { TaskSpec } from "@/lib/contracts";

/** Durable pipeline stages, in order. */
export const STAGES = [
  "draft", "research", "curate", "design", "baseline", "generation", "test", "report",
] as const;
export type Stage = (typeof STAGES)[number];

/** Statuses that claim work is happening right now. */
export const WORKING_STATUSES = new Set([
  "researching", "curating", "perceiving", "designing", "baseline",
  "training", "evaluating", "redesigning", "testing", "reporting",
]);

/** Same threshold as GET /api/missions (do not drift). */
export const STALE_MIN = 10;

/** curate.py aborts below 20 images; the same floor gates a thumbnail re-fit. */
export const MIN_REFIT_IMAGES = 20;

export type StageReport = {
  stage: Stage;
  complete: boolean;
  /** What is already in Postgres for this stage, in plain numbers. */
  have: Record<string, number | string | null>;
  /** Why it counts as complete, or what is missing. */
  detail: string;
};

export type MissionProgress = {
  mission_id: string;
  status: string;
  generation: number;
  /** Minutes since the last agent_event (or heartbeat), null if neither. */
  quiet_minutes: number | null;
  /** The mission claims to be working but nothing has reported in STALE_MIN. */
  stalled: boolean;
  /** A stage runner has written a heartbeat within the last minute. */
  live: boolean;
  budget: { generations: number; variants: number; steps_per_run: number } | null;
  counts: {
    sources: number; facts: number; images: number; usable_images: number;
    thumbs: number; perception_models: number; env_configs: number;
    reward_specs: number; runs: number; trained_runs: number;
    evaluations: number; baseline_evals: number; generations_done: number;
    field_reports: number;
  };
  stages: StageReport[];
  /** Stage a resume would start from; null when there is nothing left to do. */
  resume_from: Stage | null;
  /** For resume_from === "generation": which generation index to start at. */
  resume_generation: number;
  /** One line per already-paid-for artifact a resume will reuse. */
  reuse: string[];
};

type Row = Record<string, unknown>;
const n = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));

/**
 * One round trip, because this is also what the resume route calls before it
 * decides anything. Every count is the durable product of a stage.
 */
export async function missionProgress(missionId: string): Promise<MissionProgress | null> {
  const res = await db.execute(sql`
    select
      m.id, m.status, m.generation, m.task_spec, m.heartbeat_at,
      (select max(ts) from agent_events ae where ae.mission_id = m.id)            as last_event,
      (select count(*) from sources s where s.mission_id = m.id)                  as sources,
      (select count(*) from facts f where f.mission_id = m.id)                    as facts,
      (select count(*) from dataset_items d where d.mission_id = m.id)            as images,
      (select count(*) from dataset_items d where d.mission_id = m.id
         and d.class_key <> 'background' and d.split in ('train','val','pool'))   as usable_images,
      (select count(*) from dataset_items d where d.mission_id = m.id
         and d.class_key <> 'background' and d.split in ('train','val','pool')
         and d.thumb is not null and length(d.thumb) > 0)                         as thumbs,
      (select count(*) from perception_models p where p.mission_id = m.id)        as perception_models,
      (select count(*) from env_configs e where e.mission_id = m.id)              as env_configs,
      (select count(*) from reward_specs r where r.mission_id = m.id)             as reward_specs,
      (select count(*) from runs r where r.mission_id = m.id)                     as runs,
      (select count(*) from runs r where r.mission_id = m.id
         and r.result_policy_id is not null)                                      as trained_runs,
      (select count(distinct r.generation) from runs r where r.mission_id = m.id
         and r.result_policy_id is not null)                                      as generations_done,
      (select count(*) from evaluations ev where ev.mission_id = m.id)            as evaluations,
      (select count(*) from evaluations ev where ev.mission_id = m.id
         and ev.is_baseline)                                                      as baseline_evals,
      -- the Judge's field report only: the Curator also writes kind='report'
      (select count(*) from agent_events ae where ae.mission_id = m.id
         and ae.kind = 'report' and ae.agent = 'judge')                           as field_reports,
      (select max(e.id) from env_configs e where e.mission_id = m.id)             as env_config_id
    from missions m where m.id = ${missionId}`);
  const rows = ((res as unknown as { rows?: Row[] }).rows ?? (res as unknown as Row[]));
  const r = rows[0];
  if (!r) return null;

  const spec = TaskSpec.safeParse(r.task_spec);
  const budget = spec.success ? spec.data.budget : null;
  const wantGenerations = budget?.generations ?? 1;

  const lastEvent = r.last_event ? new Date(String(r.last_event)).getTime() : null;
  const heartbeat = r.heartbeat_at ? new Date(String(r.heartbeat_at)).getTime() : null;
  const newest = Math.max(lastEvent ?? 0, heartbeat ?? 0) || null;
  const quietMinutes = newest === null ? null : (Date.now() - newest) / 60_000;
  const status = String(r.status);
  const counts = {
    sources: n(r.sources), facts: n(r.facts), images: n(r.images),
    usable_images: n(r.usable_images), thumbs: n(r.thumbs),
    perception_models: n(r.perception_models), env_configs: n(r.env_configs),
    reward_specs: n(r.reward_specs), runs: n(r.runs), trained_runs: n(r.trained_runs),
    evaluations: n(r.evaluations), baseline_evals: n(r.baseline_evals),
    generations_done: n(r.generations_done), field_reports: n(r.field_reports),
  };

  const stages: StageReport[] = [
    {
      stage: "draft",
      complete: Boolean(r.task_spec),
      have: { task_spec: r.task_spec ? "stored" : null },
      detail: r.task_spec ? "TaskSpec is on the mission row" : "no TaskSpec — the Foreman must parse the goal",
    },
    {
      stage: "research",
      complete: counts.facts > 0,
      have: { sources: counts.sources, facts: counts.facts },
      detail: counts.facts > 0
        ? `${counts.facts} cited facts from ${counts.sources} scraped sources — no re-scrape`
        : "no facts yet",
    },
    {
      stage: "curate",
      complete: counts.perception_models > 0,
      have: {
        images: counts.images, usable_images: counts.usable_images,
        thumbs: counts.thumbs, perception_models: counts.perception_models,
      },
      detail: counts.perception_models > 0
        ? `perception model already fitted on ${counts.usable_images} images`
        : counts.thumbs >= MIN_REFIT_IMAGES
          ? `${counts.thumbs} curated images are stored — the probe can be re-fitted from them without re-downloading`
          : "no usable curated images",
    },
    {
      stage: "design",
      complete: counts.env_configs > 0 && counts.reward_specs > 0,
      have: { env_configs: counts.env_configs, reward_specs: counts.reward_specs },
      detail: counts.env_configs > 0 && counts.reward_specs > 0
        ? `EnvConfig and ${counts.reward_specs} reward spec(s) already written`
        : counts.env_configs > 0
          ? "EnvConfig exists but no reward spec was written"
          : "no EnvConfig",
    },
    {
      stage: "baseline",
      complete: counts.baseline_evals > 0,
      have: { baseline_evals: counts.baseline_evals },
      detail: counts.baseline_evals > 0
        ? "the untrained policy was already measured on this environment"
        : "no baseline evaluation",
    },
    {
      stage: "generation",
      complete: counts.generations_done >= wantGenerations,
      have: {
        generations_done: counts.generations_done, of: wantGenerations,
        trained_runs: counts.trained_runs, evaluations: counts.evaluations,
      },
      detail: `${counts.generations_done}/${wantGenerations} generations have at least one trained policy` +
        (counts.trained_runs ? ` (${counts.trained_runs} completed runs are reused, not retrained)` : ""),
    },
    {
      // No column distinguishes a test-phase evaluation from a candidate one,
      // so this is deliberately conservative: the test phase is two evals and
      // no training, and re-running it costs far less than claiming it
      // happened when it did not.
      stage: "test",
      complete: status === "reporting" || status === "done",
      have: { status },
      detail: status === "reporting" || status === "done"
        ? "the mission already reached the reporting stage"
        : "paired-seed Before | After test not confirmed — it will be re-run (2 evals, no training)",
    },
    {
      stage: "report",
      complete: status === "done" && counts.field_reports > 0,
      have: { field_reports: counts.field_reports, status },
      detail: status === "done" && counts.field_reports > 0
        ? "field report written"
        : "no field report",
    },
  ];

  const firstIncomplete = stages.find((s) => !s.complete) ?? null;
  const reuse: string[] = [];
  if (counts.sources || counts.facts) {
    reuse.push(`${counts.sources} Bright Data sources + ${counts.facts} cited facts`);
  }
  if (counts.images) reuse.push(`${counts.images} curated images`);
  if (counts.perception_models) reuse.push(`${counts.perception_models} trained perception model(s)`);
  if (counts.env_configs) reuse.push(`${counts.env_configs} EnvConfig(s)`);
  if (counts.reward_specs) reuse.push(`${counts.reward_specs} reward spec(s)`);
  if (counts.trained_runs) reuse.push(`${counts.trained_runs} completed training run(s)`);
  if (counts.evaluations) reuse.push(`${counts.evaluations} evaluation(s)`);

  return {
    mission_id: String(r.id),
    status,
    generation: n(r.generation),
    quiet_minutes: quietMinutes === null ? null : Math.round(quietMinutes * 10) / 10,
    stalled: WORKING_STATUSES.has(status) && (quietMinutes === null || quietMinutes > STALE_MIN),
    live: heartbeat !== null && Date.now() - heartbeat < 60_000,
    budget,
    counts,
    stages,
    resume_from: firstIncomplete?.stage ?? null,
    resume_generation: Math.min(counts.generations_done, Math.max(0, wantGenerations - 1)),
    reuse,
  };
}
