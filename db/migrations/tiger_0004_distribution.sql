-- Furrow · Tiger Data / TimescaleDB — distributions instead of bare means.
--
-- Additive only. Apply with:
--   psql "$TIGER_DATABASE_URL" -f db/migrations/tiger_0004_distribution.sql
--
-- A policy with score_mean = -0.75 and a p10 of -1.9 is not the same policy as
-- one with score_mean = -0.75 and a p10 of -0.9, and only the second is worth
-- shipping to a field robot. tiger_0001's test_split and the observability
-- route both report avg() alone; these views expose the whole distribution
-- using timescaledb_toolkit's stats_agg (exact mean/variance/stddev) and
-- percentile_agg (uddsketch, ~0.1% relative error on quantiles).
--
-- Verified present: timescaledb_toolkit 1.26.0 — public.stats_agg,
-- public.percentile_agg, public.approx_percentile, public.average,
-- public.stddev, public.variance, public.num_vals.

-- ---------------------------------------------------------------------------
-- 1. The duplicate-free episode stream
-- ---------------------------------------------------------------------------
-- The Neon→Tiger relay can deliver the same inbox row more than once: measured
-- on 2026-11-15 the hypertable held 38,826 rows for 13,640 distinct
-- (ts, run_id, env, global_step) keys — exact full-row duplicates, multiplicity
-- 1 to 7, NOT uniform. Non-uniform duplication biases every mean: raw
-- avg(score) was -0.72809 against a duplicate-free -0.72397 over the same
-- episodes, and count(*) overstates episodes by ~2.8x.
--
-- This view is how the statistics layer reads the hypertable. It deletes
-- nothing — the raw rows stay exactly as written.
create or replace view episode_stats_exact as
select distinct
  ts, mission_id, run_id, env, phase, policy, seed, global_step,
  score, removal, damage, trample, "precision", steps
from episode_stats;

-- ---------------------------------------------------------------------------
-- 2. Per-run episode distribution
-- ---------------------------------------------------------------------------
-- Partials are computed once in the inner query and opened up by the accessor
-- functions in the outer one, so each metric is scanned a single time.
create or replace view run_distribution as
select
  a.mission_id,
  a.run_id,
  a.phase,
  a.policy,
  d.generation,
  d.variant,
  d.sandbox_id,
  d.status,
  a.episodes,
  a.envs,
  a.global_step,
  a.first_seen,
  a.last_seen,

  num_vals(a.score_s)                       as score_n,
  average(a.score_s)                        as score_mean,
  stddev(a.score_s)                         as score_sd,
  variance(a.score_s)                       as score_var,
  approx_percentile(0.10, a.score_p)        as score_p10,
  approx_percentile(0.50, a.score_p)        as score_p50,
  approx_percentile(0.90, a.score_p)        as score_p90,
  -- coefficient of variation: spread relative to the level, so runs with very
  -- different reward scales stay comparable. null when the mean is ~0.
  case when abs(average(a.score_s)) > 1e-9
       then stddev(a.score_s) / abs(average(a.score_s)) end as score_cv,

  average(a.removal_s)                      as removal_mean,
  stddev(a.removal_s)                       as removal_sd,
  approx_percentile(0.10, a.removal_p)      as removal_p10,
  approx_percentile(0.50, a.removal_p)      as removal_p50,
  approx_percentile(0.90, a.removal_p)      as removal_p90,

  average(a.damage_s)                       as damage_mean,
  stddev(a.damage_s)                        as damage_sd,
  approx_percentile(0.50, a.damage_p)       as damage_p50,
  -- the tail that matters for crop damage is the bad one
  approx_percentile(0.90, a.damage_p)       as damage_p90,
  approx_percentile(0.99, a.damage_p)       as damage_p99,

  average(a.precision_s)                    as precision_mean,
  stddev(a.precision_s)                     as precision_sd,
  approx_percentile(0.10, a.precision_p)    as precision_p10,
  approx_percentile(0.50, a.precision_p)    as precision_p50,
  approx_percentile(0.90, a.precision_p)    as precision_p90,

  average(a.trample_s)                      as trample_mean,
  stddev(a.trample_s)                       as trample_sd
from (
  select
    mission_id, run_id, phase, policy,
    count(*)                                as episodes,
    count(distinct env)                     as envs,
    max(global_step)                        as global_step,
    min(ts)                                 as first_seen,
    max(ts)                                 as last_seen,
    stats_agg(score::double precision)              as score_s,
    percentile_agg(score::double precision)         as score_p,
    stats_agg(removal::double precision)            as removal_s,
    percentile_agg(removal::double precision)       as removal_p,
    stats_agg(damage::double precision)             as damage_s,
    percentile_agg(damage::double precision)        as damage_p,
    stats_agg("precision"::double precision)        as precision_s,
    percentile_agg("precision"::double precision)   as precision_p,
    stats_agg(trample::double precision)            as trample_s
  from episode_stats_exact
  group by 1, 2, 3, 4
) a
left join run_dim d on d.run_id = a.run_id;

-- ---------------------------------------------------------------------------
-- 3. Spread ACROSS the 32 parallel environments
-- ---------------------------------------------------------------------------
-- run_distribution spreads over episodes. This spreads over environments: each
-- of the 32 envs is reduced to its own mean first, and the statistics are taken
-- over those 32 numbers. That is the number that answers "does this policy work
-- everywhere, or only on some of the field?" — episode-level variance mixes it
-- up with ordinary episode-to-episode noise.
create or replace view run_env_spread as
select
  a.mission_id,
  a.run_id,
  a.phase,
  a.policy,
  d.generation,
  d.variant,
  d.sandbox_id,
  a.envs,
  a.episodes,

  average(a.env_score_s)                      as env_score_mean,
  stddev(a.env_score_s)                       as env_score_sd,
  variance(a.env_score_s)                     as env_score_var,
  approx_percentile(0.10, a.env_score_p)      as env_score_p10,
  approx_percentile(0.50, a.env_score_p)      as env_score_p50,
  approx_percentile(0.90, a.env_score_p)      as env_score_p90,
  a.worst_env,
  a.worst_env_score,
  a.best_env,
  a.best_env_score,
  a.best_env_score - a.worst_env_score        as env_score_range,

  average(a.env_removal_s)                    as env_removal_mean,
  stddev(a.env_removal_s)                     as env_removal_sd,
  average(a.env_damage_s)                     as env_damage_mean,
  stddev(a.env_damage_s)                      as env_damage_sd,
  a.worst_damage_env,
  a.worst_damage_env_rate
from (
  select
    mission_id, run_id, phase, policy,
    count(*)                                              as envs,
    sum(n)                                                as episodes,
    stats_agg(m_score)                                    as env_score_s,
    percentile_agg(m_score)                               as env_score_p,
    stats_agg(m_removal)                                  as env_removal_s,
    stats_agg(m_damage)                                   as env_damage_s,
    (array_agg(env     order by m_score  asc nulls last))[1] as worst_env,
    (array_agg(m_score order by m_score  asc nulls last))[1] as worst_env_score,
    (array_agg(env     order by m_score  desc nulls last))[1] as best_env,
    (array_agg(m_score order by m_score  desc nulls last))[1] as best_env_score,
    (array_agg(env      order by m_damage desc nulls last))[1] as worst_damage_env,
    (array_agg(m_damage order by m_damage desc nulls last))[1] as worst_damage_env_rate
  from (
    select mission_id, run_id, phase, policy, env,
           count(*)                                 as n,
           avg(score::double precision)             as m_score,
           avg(removal::double precision)           as m_removal,
           avg(damage::double precision)            as m_damage,
           avg("precision"::double precision)       as m_precision
    from episode_stats_exact
    group by 1, 2, 3, 4, 5
  ) per_env
  group by 1, 2, 3, 4
) a
left join run_dim d on d.run_id = a.run_id;

-- ---------------------------------------------------------------------------
-- 4. Before | After with the distribution attached
-- ---------------------------------------------------------------------------
-- The distribution-aware replacement for tiger_0001's test_split, which reports
-- avg() only. Same shape plus median / p10 / p90 / sd, so the Before→After
-- panel can say how reliable the improvement is, not just that there is one.
create or replace view test_split_dist as
select
  a.mission_id,
  a.policy,
  a.episodes,
  a.envs,

  average(a.score_s)                      as score_mean,
  stddev(a.score_s)                       as score_sd,
  approx_percentile(0.10, a.score_p)      as score_p10,
  approx_percentile(0.50, a.score_p)      as score_p50,
  approx_percentile(0.90, a.score_p)      as score_p90,

  average(a.removal_s)                    as removal_mean,
  stddev(a.removal_s)                     as removal_sd,
  approx_percentile(0.10, a.removal_p)    as removal_p10,
  approx_percentile(0.50, a.removal_p)    as removal_p50,
  approx_percentile(0.90, a.removal_p)    as removal_p90,

  average(a.damage_s)                     as damage_mean,
  stddev(a.damage_s)                      as damage_sd,
  approx_percentile(0.50, a.damage_p)     as damage_p50,
  approx_percentile(0.90, a.damage_p)     as damage_p90,

  average(a.precision_s)                  as precision_mean,
  stddev(a.precision_s)                   as precision_sd,
  approx_percentile(0.50, a.precision_p)  as precision_p50
from (
  select
    mission_id, policy,
    count(*)                                        as episodes,
    count(distinct env)                             as envs,
    stats_agg(score::double precision)              as score_s,
    percentile_agg(score::double precision)         as score_p,
    stats_agg(removal::double precision)            as removal_s,
    percentile_agg(removal::double precision)       as removal_p,
    stats_agg(damage::double precision)             as damage_s,
    percentile_agg(damage::double precision)        as damage_p,
    stats_agg("precision"::double precision)        as precision_s,
    percentile_agg("precision"::double precision)   as precision_p
  from episode_stats_exact
  where phase = 'test'
  group by 1, 2
) a;
