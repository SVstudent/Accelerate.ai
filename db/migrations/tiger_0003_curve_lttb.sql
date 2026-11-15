-- Furrow · Tiger Data / TimescaleDB — curve downsampling with LTTB.
--
-- Additive only. Apply with:
--   psql "$TIGER_DATABASE_URL" -f db/migrations/tiger_0003_curve_lttb.sql
--
-- Why LTTB and not avg(): a PPO learning curve is thousands of points per run
-- and the browser needs ~200. Bucketed averaging flattens exactly the features
-- a judge is looking at — the spike where a reward term fires for the first
-- time, the step where a run collapses. Largest-Triangle-Three-Buckets keeps
-- the point in each bucket that contributes most to the visual shape, so the
-- 200-point curve looks like the 4,000-point curve.
--
-- Verified present on this service: timescaledb_toolkit 1.26.0 provides
-- public.lttb(timestamptz, double precision, integer) -> timevector_tstz_f64.

-- ---------------------------------------------------------------------------
-- furrow_curve — one downsampled series per run
-- ---------------------------------------------------------------------------
-- Two stages, both of which matter:
--
--   1. Pre-bucket. 32 environments finish episodes concurrently, so the raw
--      stream has ~26 rows per second sharing a timestamp. Feeding that
--      straight to lttb() gives a sawtooth of per-episode noise, not a
--      learning curve. So the rows are first collapsed to one mean per narrow
--      time bucket (span / 4·resolution, floor 50 ms) — fine enough that LTTB
--      still has 4x more candidate points than it will keep.
--
--   2. LTTB to exactly the requested resolution, per run.
--
-- The selected points are then joined back to the bucketed stage to recover
-- global_step and the sample count behind each point, so the UI can label the
-- x-axis in PPO steps and show how many episodes a point stands for.
--
-- `select distinct` in the source stage is not cosmetic: the Neon→Tiger relay
-- can deliver the same inbox row more than once (measured 2026-11-15: 38,826
-- episode_stats rows over 13,640 distinct (ts, run_id, env, global_step) keys,
-- multiplicity 1–7, exact full-row duplicates). Averaging the raw rows weights
-- an episode by how many times it happened to be relayed; deduplicating on the
-- natural key first removes that bias.
create or replace function furrow_curve(
  p_source     text,                     -- 'episode' (episode_stats) | 'metric' (run_metrics)
  p_metric     text,                     -- whitelisted column name
  p_mission_id text        default null,
  p_run_id     text        default null,
  p_generation int         default null, -- needs run_dim to be synced
  p_resolution int         default 200,
  p_from       timestamptz default null,
  p_to         timestamptz default null,
  p_phase      text        default null  -- 'train' | 'test', episode source only
) returns table (
  run_id      text,
  ts          timestamptz,
  value       double precision,
  global_step bigint,
  samples     bigint
)
language plpgsql
stable
as $fn$
declare
  v_tbl    text;
  v_col    text;
  v_key    text;
  v_step   text;
  v_extra  text := 'true';
  v_res    int := greatest(3, least(coalesce(p_resolution, 200), 5000));
  v_from   timestamptz;
  v_to     timestamptz;
  v_bucket interval;
  v_runs   text;
begin
  if p_mission_id is null and p_run_id is null then
    raise exception 'furrow_curve: pass p_mission_id or p_run_id';
  end if;

  -- Column whitelist. p_metric never reaches the query text except through
  -- these literals, so there is no injection surface in the format() below.
  if p_source = 'episode' then
    v_tbl  := 'episode_stats';
    v_key  := 'e.env, e.global_step';
    v_step := 'global_step';
    v_extra := '($8::text is null or e.phase = $8::text)';
    v_col  := case p_metric
                when 'score'     then 'score'
                when 'removal'   then 'removal'
                when 'damage'    then 'damage'
                when 'trample'   then 'trample'
                when 'precision' then '"precision"'
                when 'steps'     then 'steps'
              end;
  elsif p_source = 'metric' then
    v_tbl  := 'run_metrics';
    v_key  := 'e.step';
    v_step := 'step';
    v_col  := case p_metric
                when 'ep_return_mean'      then 'ep_return_mean'
                when 'entropy'             then 'entropy'
                when 'approx_kl'           then 'approx_kl'
                when 'policy_loss'         then 'policy_loss'
                when 'value_loss'          then 'value_loss'
                when 'fps'                 then 'fps'
                when 'act_precision'       then 'act_precision'
                when 'target_removal_rate' then 'target_removal_rate'
                when 'protect_damage_rate' then 'protect_damage_rate'
                when 'trample_rate'        then 'trample_rate'
              end;
  else
    raise exception 'furrow_curve: p_source must be episode or metric (got %)', p_source;
  end if;

  if v_col is null then
    raise exception 'furrow_curve: metric % is not available on source %', p_metric, p_source;
  end if;

  -- Runs in scope. run_metrics carries no mission_id, so the mapping comes from
  -- run_dim; with no generation filter we also accept run ids episode_stats has
  -- seen itself, so curves work even before run_dim has been synced.
  v_runs := $f$
    select run_id from run_dim
     where ($1::text is null or mission_id = $1::text)
       and ($2::int  is null or generation = $2::int)
       and ($3::text is null or run_id = $3::text)
    union
    select distinct run_id from episode_stats
     where $2::int is null
       and ($1::text is null or mission_id = $1::text)
       and ($3::text is null or run_id = $3::text)
  $f$;

  -- Resolve the real time bounds of the series before choosing a bucket width.
  execute format($f$
    select min(ts), max(ts) from %I e
     where ($4::timestamptz is null or e.ts >= $4::timestamptz)
       and ($5::timestamptz is null or e.ts <= $5::timestamptz)
       and e.run_id in (%s)
  $f$, v_tbl, v_runs)
  into v_from, v_to
  using p_mission_id, p_generation, p_run_id, p_from, p_to;

  if v_from is null then
    return;                                     -- no telemetry for that scope
  end if;

  v_bucket := greatest(
    interval '50 milliseconds',
    make_interval(secs => extract(epoch from (v_to - v_from))::double precision
                          / (v_res * 4)::double precision));

  return query execute format($f$
    with src as (
      select distinct e.run_id, e.ts, %s, (%s)::double precision as v
      from %I e
      where e.ts >= $4::timestamptz and e.ts <= $5::timestamptz
        and (%s) is not null
        and %s
        and e.run_id in (%s)
    ),
    b as (
      select src.run_id,
             time_bucket($6::interval, src.ts) as bucket,
             avg(src.v)                        as v,
             max(src.%s)::bigint               as st,
             count(*)                          as n
      from src
      group by 1, 2
    ),
    d as (
      select b.run_id, lttb(b.bucket, b.v, $7::int) as tv
      from b
      group by b.run_id
    ),
    picked as (
      select d.run_id, u.time, u.value
      from d, lateral unnest(d.tv) u
    )
    select p.run_id, p.time, p.value, b.st, b.n
    from picked p
    join b on b.run_id = p.run_id and b.bucket = p.time
    order by 1, 2
  $f$, v_key, v_col, v_tbl, v_col, v_extra, v_runs, v_step)
  using p_mission_id, p_generation, p_run_id, v_from, v_to, v_bucket, v_res, p_phase;
end;
$fn$;

comment on function furrow_curve(text, text, text, text, int, int, timestamptz, timestamptz, text) is
  'LTTB-downsampled telemetry curve (timescaledb_toolkit). Pre-buckets the raw '
  'hypertable to 4x the requested resolution, deduplicates relay repeats, then '
  'applies Largest-Triangle-Three-Buckets per run. Returns global_step and the '
  'sample count behind every retained point.';
