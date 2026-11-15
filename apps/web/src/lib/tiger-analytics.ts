/**
 * Tiger Data analytics layer — the typed surface over db/migrations/tiger_0002…0005.
 *
 * Everything here reads the live Tiger service. Nothing is computed in Node
 * that Tiger can compute better: LTTB downsampling, the per-generation
 * continuous aggregate, the percentile/variance hyperfunctions and the
 * divergence detector all run inside the database, and this module only shapes
 * the rows for the wire.
 *
 * Deliberately a NEW file rather than an addition to db/tiger.ts: that module
 * is imported by the live SSE route and a mission is streaming into Tiger while
 * this is being developed.
 *
 * Capability notes, measured on the service on 2026-11-15:
 *   timescaledb 2.32.0, timescaledb_toolkit 1.26.0, PostgreSQL 18.6
 *   → lttb(), stats_agg(), percentile_agg(), hyperloglog() all available in
 *     the `public` schema (stable, not toolkit_experimental).
 */
import { db, schema } from "@/db";
import { requireTiger, tiger } from "@/db/tiger";

/** Metrics furrow_curve() will accept, per source. Mirrors the SQL whitelist. */
export const CURVE_METRICS = {
  episode: ["score", "removal", "damage", "trample", "precision", "steps"],
  metric: [
    "ep_return_mean", "entropy", "approx_kl", "policy_loss", "value_loss",
    "fps", "act_precision", "target_removal_rate", "protect_damage_rate",
    "trample_rate",
  ],
} as const;

export type CurveSource = keyof typeof CURVE_METRICS;

export type CurvePointRow = {
  run_id: string;
  ts: Date;
  value: number | null;
  global_step: string | number | null;
  samples: string | number | null;
};

export type CurveScope = {
  missionId?: string | null;
  runId?: string | null;
  generation?: number | null;
  resolution?: number;
  from?: Date | null;
  to?: Date | null;
  phase?: string | null;
};

const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));

// ---------------------------------------------------------------------------
// run_dim — the generation/variant dimension Tiger needs but does not own
// ---------------------------------------------------------------------------
// episode_stats has run_id, not generation. A continuous aggregate can only
// GROUP BY its own hypertable's columns, so generation/variant are mirrored
// into Tiger from Neon's `runs` table and joined to the aggregate's partials.
// Straight copy of real rows — a run Neon does not have does not appear here.

const lastSync = new Map<string, number>();
const SYNC_TTL_MS = 4_000;

export async function syncRunDim(missionId?: string | null): Promise<number> {
  if (!tiger) return 0;
  const key = missionId ?? "*";
  const now = Date.now();
  if ((lastSync.get(key) ?? 0) > now - SYNC_TTL_MS) return 0;
  lastSync.set(key, now);

  const rows = missionId
    ? await db.select().from(schema.runs).where(
        (await import("drizzle-orm")).eq(schema.runs.missionId, missionId))
    : await db.select().from(schema.runs);
  if (!rows.length) return 0;

  const t = requireTiger();
  const values = rows.map((r) => {
    const hp = (r.hyperparams ?? {}) as Record<string, unknown>;
    return [
      r.id, r.missionId, r.generation, r.variant, r.sandboxId ?? null,
      r.rewardSpecId ?? null, r.status ?? null,
      hp.n_envs === undefined || hp.n_envs === null ? null : Number(hp.n_envs),
      hp.total_steps === undefined || hp.total_steps === null ? null : Number(hp.total_steps),
      r.startedAt ?? null, r.endedAt ?? null,
    ];
  });

  await t`
    insert into run_dim
      (run_id, mission_id, generation, variant, sandbox_id, reward_spec_id,
       status, n_envs, total_steps, started_at, ended_at)
    values ${t(values)}
    on conflict (run_id) do update set
      mission_id     = excluded.mission_id,
      generation     = excluded.generation,
      variant        = excluded.variant,
      sandbox_id     = excluded.sandbox_id,
      reward_spec_id = excluded.reward_spec_id,
      status         = excluded.status,
      n_envs         = excluded.n_envs,
      total_steps    = excluded.total_steps,
      started_at     = excluded.started_at,
      ended_at       = excluded.ended_at,
      synced_at      = now()`;
  return values.length;
}

// ---------------------------------------------------------------------------
// 1. LTTB-downsampled curves
// ---------------------------------------------------------------------------

/** One LTTB-downsampled series per run. Downsampling happens in Tiger. */
export async function curveLttb(
  source: CurveSource, metric: string, scope: CurveScope,
): Promise<CurvePointRow[]> {
  const t = requireTiger();
  return t<CurvePointRow[]>`
    select run_id, ts, value, global_step, samples
    from furrow_curve(
      ${source}::text,
      ${metric}::text,
      ${scope.missionId ?? null}::text,
      ${scope.runId ?? null}::text,
      ${scope.generation ?? null}::int,
      ${scope.resolution ?? 200}::int,
      ${scope.from ?? null}::timestamptz,
      ${scope.to ?? null}::timestamptz,
      ${scope.phase ?? null}::text
    )`;
}

/**
 * How many raw rows the curve was built from — so the UI can honestly say
 * "4,032 points → 200 via LTTB" instead of implying it drew everything.
 * Counts duplicate-free rows for the episode source, matching furrow_curve.
 */
export async function curveRawCount(
  source: CurveSource, scope: CurveScope,
): Promise<number> {
  const t = requireTiger();
  if (source === "episode") {
    const [r] = await t<{ n: string }[]>`
      select count(*)::text n
      from episode_stats_exact e
      where (${scope.missionId ?? null}::text is null or e.mission_id = ${scope.missionId ?? null}::text)
        and (${scope.runId ?? null}::text is null or e.run_id = ${scope.runId ?? null}::text)
        and (${scope.phase ?? null}::text is null or e.phase = ${scope.phase ?? null}::text)
        and (${scope.generation ?? null}::int is null or e.run_id in (
              select run_id from run_dim where generation = ${scope.generation ?? null}::int))`;
    return Number(r?.n ?? 0);
  }
  const [r] = await t<{ n: string }[]>`
    select count(*)::text n
    from (select distinct run_id, ts, step from run_metrics) m
    where m.run_id in (
      select run_id from run_dim
       where (${scope.missionId ?? null}::text is null or mission_id = ${scope.missionId ?? null}::text)
         and (${scope.generation ?? null}::int is null or generation = ${scope.generation ?? null}::int)
         and (${scope.runId ?? null}::text is null or run_id = ${scope.runId ?? null}::text)
      union
      select distinct run_id from episode_stats
       where ${scope.generation ?? null}::int is null
         and (${scope.missionId ?? null}::text is null or mission_id = ${scope.missionId ?? null}::text)
         and (${scope.runId ?? null}::text is null or run_id = ${scope.runId ?? null}::text))`;
  return Number(r?.n ?? 0);
}

export type CurveSeries = {
  run_id: string;
  generation: number | null;
  variant: number | null;
  sandbox_id: string | null;
  points: { t: string; v: number | null; step: number | null; n: number | null }[];
};

/** Groups flat furrow_curve() rows into one series per run, with run_dim attached. */
export function groupCurve(
  rows: CurvePointRow[],
  dims: Map<string, { generation: number | null; variant: number | null; sandbox_id: string | null }>,
): CurveSeries[] {
  const byRun = new Map<string, CurveSeries>();
  for (const r of rows) {
    let s = byRun.get(r.run_id);
    if (!s) {
      const d = dims.get(r.run_id);
      s = {
        run_id: r.run_id,
        generation: d?.generation ?? null,
        variant: d?.variant ?? null,
        sandbox_id: d?.sandbox_id ?? null,
        points: [],
      };
      byRun.set(r.run_id, s);
    }
    s.points.push({
      t: new Date(r.ts).toISOString(),
      v: num(r.value),
      step: num(r.global_step),
      n: num(r.samples),
    });
  }
  return [...byRun.values()];
}

export async function runDims(missionId?: string | null) {
  const t = requireTiger();
  const rows = await t<{
    run_id: string; generation: number | null; variant: number | null; sandbox_id: string | null;
  }[]>`
    select run_id, generation, variant, sandbox_id
    from run_dim
    where (${missionId ?? null}::text is null or mission_id = ${missionId ?? null}::text)`;
  return new Map(rows.map((r) => [r.run_id, r]));
}

// ---------------------------------------------------------------------------
// 2. Per-generation continuous aggregate
// ---------------------------------------------------------------------------

export async function generationRollup(missionId: string, generation?: number | null) {
  const t = requireTiger();
  return t<Record<string, unknown>[]>`
    select * from generation_rollup
    where mission_id = ${missionId}
      and (${generation ?? null}::int is null or generation = ${generation ?? null}::int)
    order by generation, bucket`;
}

export async function genVariantRollup(missionId: string, generation?: number | null) {
  const t = requireTiger();
  return t<Record<string, unknown>[]>`
    select * from gen_variant_rollup
    where mission_id = ${missionId}
      and (${generation ?? null}::int is null or generation = ${generation ?? null}::int)
    order by generation, variant, bucket`;
}

// ---------------------------------------------------------------------------
// 3. Distributions (stats_agg / percentile_agg)
// ---------------------------------------------------------------------------

export async function runDistribution(missionId: string, phase?: string | null) {
  const t = requireTiger();
  return t<Record<string, unknown>[]>`
    select * from run_distribution
    where mission_id = ${missionId}
      and (${phase ?? null}::text is null or phase = ${phase ?? null}::text)
    order by generation nulls last, variant nulls last, run_id`;
}

export async function runEnvSpread(missionId: string, phase?: string | null) {
  const t = requireTiger();
  return t<Record<string, unknown>[]>`
    select * from run_env_spread
    where mission_id = ${missionId}
      and (${phase ?? null}::text is null or phase = ${phase ?? null}::text)
    order by generation nulls last, variant nulls last, run_id`;
}

export async function testSplitDist(missionId: string) {
  const t = requireTiger();
  return t<Record<string, unknown>[]>`
    select * from test_split_dist where mission_id = ${missionId} order by policy`;
}

// ---------------------------------------------------------------------------
// 4. Divergence / collapse detection
// ---------------------------------------------------------------------------

export type Anomaly = {
  mission_id: string;
  run_id: string;
  generation: number | null;
  variant: number | null;
  sandbox_id: string | null;
  kind: string;
  severity: "warn" | "critical";
  observed: number | null;
  threshold: number | null;
  detail: Record<string, unknown>;
  detected_at: Date;
};

export type AnomalyThresholds = {
  lookback?: string;
  collapseFrac?: number;
  entropyDrop?: number;
  klMax?: number;
  flatVar?: number;
  stallSeconds?: number;
  spreadMult?: number;
};

export async function anomalies(
  missionId?: string | null, runId?: string | null, th: AnomalyThresholds = {},
): Promise<Anomaly[]> {
  const t = requireTiger();
  return t<Anomaly[]>`
    select * from furrow_anomalies(
      ${missionId ?? null}::text,
      ${runId ?? null}::text,
      ${th.lookback ?? "6 hours"}::interval,
      ${th.collapseFrac ?? 0.10}::double precision,
      ${th.entropyDrop ?? 0.50}::double precision,
      ${th.klMax ?? 0.05}::double precision,
      ${th.flatVar ?? 1e-6}::double precision,
      ${th.stallSeconds ?? 45}::double precision,
      ${th.spreadMult ?? 3.0}::double precision
    )`;
}

export async function runHealth(missionId?: string | null) {
  const t = requireTiger();
  return t<Record<string, unknown>[]>`
    select * from run_health
    where (${missionId ?? null}::text is null or mission_id = ${missionId ?? null}::text)
    order by generation nulls last, variant nulls last, run_id`;
}

// ---------------------------------------------------------------------------
// 5. Engine introspection — what Tiger is actually doing
// ---------------------------------------------------------------------------

export async function engineStatus() {
  const t = requireTiger();
  const [extensions, hypertables, jobs, jobStats, caggs, chunks, failures] = await Promise.all([
    t<{ extname: string; extversion: string }[]>`
      select extname, extversion from pg_extension
      where extname in ('timescaledb', 'timescaledb_toolkit') order by extname`,
    t<Record<string, unknown>[]>`
      select hypertable_name, num_chunks, compression_enabled
      from timescaledb_information.hypertables order by hypertable_name`,
    t<Record<string, unknown>[]>`
      select job_id, application_name, proc_name, hypertable_name,
             schedule_interval::text, config, next_start, scheduled
      from timescaledb_information.jobs order by job_id`,
    t<Record<string, unknown>[]>`
      select job_id, last_run_started_at, last_successful_finish, last_run_status,
             job_status, total_runs, total_successes, total_failures
      from timescaledb_information.job_stats order by job_id`,
    t<Record<string, unknown>[]>`
      select view_name, materialized_only, compression_enabled,
             materialization_hypertable_name
      from timescaledb_information.continuous_aggregates order by view_name`,
    t<Record<string, unknown>[]>`
      select hypertable_name,
             count(*)::int                                as chunks,
             count(*) filter (where is_compressed)::int   as compressed_chunks
      from timescaledb_information.chunks group by 1 order by 1`,
    t<Record<string, unknown>[]>`
      select job_id, start_time, left(coalesce(err_message, ''), 300) as err
      from timescaledb_information.job_history
      where succeeded is not true
      order by start_time desc limit 10`,
  ]);

  // hypertable_compression_stats() is per-table, so one call each.
  const compression: Record<string, unknown> = {};
  for (const name of ["episode_stats", "live_frames", "run_metrics"]) {
    try {
      const [row] = await t<Record<string, unknown>[]>`
        select * from hypertable_compression_stats(${name}::regclass)`;
      if (row) {
        const before = Number(row.before_compression_total_bytes ?? 0);
        const after = Number(row.after_compression_total_bytes ?? 0);
        compression[name] = {
          ...row,
          compression_ratio: after > 0 ? Number((before / after).toFixed(2)) : null,
        };
      }
    } catch (err) {
      compression[name] = { error: (err as Error).message.slice(0, 160) };
    }
  }

  const statsById = new Map(jobStats.map((s) => [Number(s.job_id), s]));
  return {
    extensions,
    hypertables,
    continuous_aggregates: caggs,
    chunks,
    compression,
    recent_job_failures: failures,
    // a policy that exists but has never fired is reported as such, not as working
    jobs: jobs.map((j) => {
      const s = statsById.get(Number(j.job_id));
      const runs = Number(s?.total_runs ?? 0);
      return {
        ...j,
        total_runs: runs,
        total_successes: Number(s?.total_successes ?? 0),
        total_failures: Number(s?.total_failures ?? 0),
        last_run_status: s?.last_run_status ?? null,
        last_successful_finish: s?.last_successful_finish ?? null,
        job_status: s?.job_status ?? null,
        has_ever_run: runs > 0,
      };
    }),
  };
}
