-- Furrow · Tiger Data / TimescaleDB — generation rollups, compression, retention.
--
-- Additive only: creates new objects beside tiger_0001_init.sql, never alters or
-- drops anything it created. Apply with:
--   psql "$TIGER_DATABASE_URL" -f db/migrations/tiger_0002_rollups.sql
--
-- Verified against the live service on 2026-11-15:
--   timescaledb 2.32.0, timescaledb_toolkit 1.26.0, PostgreSQL 18.6.
-- Everything below uses only functions present on that instance.

-- ---------------------------------------------------------------------------
-- 1. run_dim — the generation/variant dimension
-- ---------------------------------------------------------------------------
-- episode_stats carries run_id but not generation/variant: those live in Neon's
-- `runs` table, and there are no cross-database joins. A continuous aggregate
-- can only GROUP BY columns of its own hypertable, so the per-generation rollup
-- is built as (bucket, run_id) partials in the aggregate and folded up to
-- (generation, variant) through this dimension table — which is exactly what
-- toolkit's rollup() of a partial aggregate is for.
--
-- Populated by apps/web/src/lib/tiger-analytics.ts (syncRunDim) straight out of
-- Neon. Nothing here is invented: a run absent from Neon is absent here.
create table if not exists run_dim (
  run_id         text primary key,
  mission_id     text        not null,
  generation     smallint    not null default 0,
  variant        smallint    not null default 0,
  sandbox_id     text,
  reward_spec_id text,
  status         text,
  n_envs         smallint,
  total_steps    integer,
  started_at     timestamptz,
  ended_at       timestamptz,
  synced_at      timestamptz not null default now()
);
create index if not exists run_dim_mission_gen_idx on run_dim (mission_id, generation, variant);

-- ---------------------------------------------------------------------------
-- 2. gen_rollup_10s — the real per-generation continuous aggregate
-- ---------------------------------------------------------------------------
-- 10 s buckets: a training run on the demo preset lasts ~60 s and emits ~26
-- episodes/s across 32 envs, so 10 s is the finest bucket that still holds a
-- statistically meaningful sample (≈260 episodes) per point.
--
-- It stores PARTIAL aggregates (statssummary1d / uddsketch / hyperloglog), not
-- finished numbers. That is the whole point: partials can be rolled up across
-- buckets, across variants and across a whole generation without ever touching
-- the raw hypertable again, and the result is identical to aggregating the raw
-- rows — unlike avg-of-avg, which is not.
--
-- episode_hll: the Neon→Tiger relay can deliver the same inbox row more than
-- once (measured 2026-11-15: 38,826 episode_stats rows for 13,640 distinct
-- (ts, run_id, env, global_step) keys, multiplicity 1–7). count(*) therefore
-- overstates episodes. hyperloglog over the natural key gives a rollup-able
-- approximate distinct count, so the duplication is visible rather than hidden.
create materialized view if not exists gen_rollup_10s
with (timescaledb.continuous) as
select
  time_bucket('10 seconds', ts)                               as bucket,
  mission_id,
  run_id,
  phase,
  policy,
  count(*)                                                    as rows_raw,
  hyperloglog(256, env::text || ':' || global_step::text)      as episode_hll,
  max(global_step)                                            as global_step,
  stats_agg(score::double precision)                          as score_stats,
  stats_agg(removal::double precision)                        as removal_stats,
  stats_agg(damage::double precision)                         as damage_stats,
  stats_agg("precision"::double precision)                    as precision_stats,
  stats_agg(trample::double precision)                        as trample_stats,
  percentile_agg(score::double precision)                     as score_pct,
  percentile_agg(removal::double precision)                   as removal_pct,
  percentile_agg(damage::double precision)                    as damage_pct,
  percentile_agg("precision"::double precision)               as precision_pct
from episode_stats
group by 1, 2, 3, 4, 5;

-- real-time aggregate: the newest, not-yet-materialised 10 s is included, so a
-- live sandbox shows up immediately instead of up to 10 s late.
alter materialized view gen_rollup_10s set (timescaledb.materialized_only = false);

select add_continuous_aggregate_policy('gen_rollup_10s',
  start_offset      => interval '6 hours',
  end_offset        => interval '0 seconds',
  schedule_interval => interval '30 seconds',
  if_not_exists     => true);

-- ---------------------------------------------------------------------------
-- 3. Generation / variant views over the aggregate
-- ---------------------------------------------------------------------------
-- One row per 10 s per sandbox, with generation + variant resolved and the
-- partials opened up into mean / sd / variance / p10 / p50 / p90.
create or replace view gen_variant_rollup as
select
  r.bucket,
  r.mission_id,
  d.generation,
  d.variant,
  r.run_id,
  d.sandbox_id,
  r.phase,
  r.policy,
  r.rows_raw,
  distinct_count(r.episode_hll)                   as episodes,
  r.global_step,
  average(r.score_stats)                          as score_mean,
  stddev(r.score_stats)                           as score_sd,
  variance(r.score_stats)                         as score_var,
  approx_percentile(0.10, r.score_pct)            as score_p10,
  approx_percentile(0.50, r.score_pct)            as score_p50,
  approx_percentile(0.90, r.score_pct)            as score_p90,
  average(r.removal_stats)                        as removal_mean,
  stddev(r.removal_stats)                         as removal_sd,
  approx_percentile(0.50, r.removal_pct)          as removal_p50,
  average(r.damage_stats)                         as damage_mean,
  stddev(r.damage_stats)                          as damage_sd,
  approx_percentile(0.90, r.damage_pct)           as damage_p90,
  average(r.precision_stats)                      as precision_mean,
  approx_percentile(0.50, r.precision_pct)        as precision_p50,
  average(r.trample_stats)                        as trample_mean
from gen_rollup_10s r
join run_dim d on d.run_id = r.run_id;

-- One row per 10 s per GENERATION: the partials from every variant in the
-- generation are rolled up, which is an exact pooled statistic, not an average
-- of averages.
create or replace view generation_rollup as
select
  r.bucket,
  r.mission_id,
  d.generation,
  r.phase,
  r.policy,
  count(distinct r.run_id)                                as variants,
  sum(r.rows_raw)                                         as rows_raw,
  -- Sum the per-row distinct counts rather than rollup()-ing the sketches.
  -- The hyperloglog key is (env, global_step), which is unique inside one
  -- (bucket, run_id) row but COLLIDES between runs: two sandboxes both finish
  -- env 7 at step 25600, and merging their sketches would count that once.
  -- Episodes from different runs are different episodes, so the per-run counts
  -- add. (Approximate: 256 registers, ~6.5% standard error.)
  sum(distinct_count(r.episode_hll))::bigint              as episodes,
  max(r.global_step)                                      as global_step,
  average(rollup(r.score_stats))                          as score_mean,
  stddev(rollup(r.score_stats))                           as score_sd,
  variance(rollup(r.score_stats))                         as score_var,
  num_vals(rollup(r.score_stats))                         as score_n,
  approx_percentile(0.10, rollup(r.score_pct))            as score_p10,
  approx_percentile(0.50, rollup(r.score_pct))            as score_p50,
  approx_percentile(0.90, rollup(r.score_pct))            as score_p90,
  average(rollup(r.removal_stats))                        as removal_mean,
  stddev(rollup(r.removal_stats))                         as removal_sd,
  approx_percentile(0.10, rollup(r.removal_pct))          as removal_p10,
  approx_percentile(0.50, rollup(r.removal_pct))          as removal_p50,
  approx_percentile(0.90, rollup(r.removal_pct))          as removal_p90,
  average(rollup(r.damage_stats))                         as damage_mean,
  stddev(rollup(r.damage_stats))                          as damage_sd,
  approx_percentile(0.50, rollup(r.damage_pct))            as damage_p50,
  approx_percentile(0.90, rollup(r.damage_pct))            as damage_p90,
  average(rollup(r.precision_stats))                      as precision_mean,
  approx_percentile(0.50, rollup(r.precision_pct))        as precision_p50,
  average(rollup(r.trample_stats))                        as trample_mean
from gen_rollup_10s r
join run_dim d on d.run_id = r.run_id
group by 1, 2, 3, 4, 5;

-- ---------------------------------------------------------------------------
-- 4. Compression (columnstore) and retention policies
-- ---------------------------------------------------------------------------
-- run_metrics was the one hypertable with no compression at all. PPO internals
-- are highly repetitive per run, so segmenting by run_id compresses well.
alter table run_metrics set (
  timescaledb.compress,
  timescaledb.compress_segmentby = 'run_id',
  timescaledb.compress_orderby   = 'ts desc'
);
select add_compression_policy('run_metrics', interval '1 hour', if_not_exists => true);

-- Retention. Deliberately generous: the whole demo dataset is hours old, so
-- these policies will not drop a single existing chunk — they exist so the
-- service does not grow without bound after the demo. live_frames is the
-- jsonb-heavy stream and gets the shortest window.
select add_retention_policy('live_frames',   interval '7 days',  if_not_exists => true);
select add_retention_policy('episode_stats', interval '90 days', if_not_exists => true);
select add_retention_policy('run_metrics',   interval '90 days', if_not_exists => true);
