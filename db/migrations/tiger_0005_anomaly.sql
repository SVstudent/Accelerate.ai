-- Furrow · Tiger Data / TimescaleDB — divergence / collapse detection in SQL.
--
-- Additive only. Apply with:
--   psql "$TIGER_DATABASE_URL" -f db/migrations/tiger_0005_anomaly.sql
--
-- Eight sandboxes train in parallel and one of them will sometimes go bad:
-- reward walks backwards, the policy's entropy collapses and it stops
-- exploring, a PPO update blows the trust region, the sandbox dies and the
-- block on the farm just stops moving. All of that is detectable from the
-- telemetry itself, so it is detected here — in the hypertable, over the live
-- stream — rather than eyeballed off a chart.
--
-- Uses only what this service has: window functions, time_bucket, and
-- timescaledb_toolkit 1.26.0 stats_agg / percentile_agg.

-- ---------------------------------------------------------------------------
-- 1. run_health — the live snapshot, one row per run
-- ---------------------------------------------------------------------------
-- Cheap enough to poll: it is the "is this sandbox alive and moving?" view.
create or replace view run_health as
select
  s.mission_id,
  s.run_id,
  d.generation,
  d.variant,
  d.sandbox_id,
  d.status                                              as run_status,
  s.episodes,
  s.envs,
  s.global_step,
  s.first_seen,
  s.last_seen,
  extract(epoch from (now() - s.last_seen))             as seconds_since_episode,
  -- episodes per second over the run's whole life; the farm preset does ~26/s
  case when s.last_seen > s.first_seen
       then s.episodes / extract(epoch from (s.last_seen - s.first_seen)) end as episodes_per_s,
  case when s.last_seen > s.first_seen
       then s.global_step / extract(epoch from (s.last_seen - s.first_seen)) end as steps_per_s,
  m.last_metric_ts,
  m.entropy_last,
  m.approx_kl_last,
  m.fps_last,
  -- how far behind the liveliest sibling in the same mission this run is
  extract(epoch from (max(s.last_seen) over (partition by s.mission_id) - s.last_seen))
                                                        as seconds_behind_siblings
from (
  select mission_id, run_id,
         count(*) as episodes, count(distinct env) as envs,
         max(global_step) as global_step,
         min(ts) as first_seen, max(ts) as last_seen
  from episode_stats_exact
  group by 1, 2
) s
left join run_dim d on d.run_id = s.run_id
left join (
  select distinct on (run_id)
         run_id, ts as last_metric_ts, entropy as entropy_last,
         approx_kl as approx_kl_last, fps as fps_last
  from run_metrics
  order by run_id, ts desc
) m on m.run_id = s.run_id;

-- ---------------------------------------------------------------------------
-- 2. furrow_anomalies — the detector
-- ---------------------------------------------------------------------------
-- Every check is a CTE over the hypertable, unioned into one verdict table.
-- Thresholds are parameters, not magic numbers buried in the body, so the UI
-- can tighten them for a demo without a migration.
--
-- Returned columns:
--   kind           which failure mode fired
--   severity       'warn' | 'critical'
--   observed       the number that fired it
--   threshold      what it was compared against
--   detail         the supporting numbers, so a judge can check the call
create or replace function furrow_anomalies(
  p_mission_id    text        default null,
  p_run_id        text        default null,
  p_lookback      interval    default interval '6 hours',
  p_collapse_frac double precision default 0.10,   -- fall off own peak, fraction of |peak|
  p_entropy_drop  double precision default 0.50,   -- nats of entropy lost end-vs-start
  p_kl_max        double precision default 0.05,   -- PPO trust-region ceiling
  p_flat_var      double precision default 1.0e-6, -- score variance ~ 0 = flatlined
  p_stall_s       double precision default 45.0,   -- seconds behind the liveliest sibling
  p_spread_mult   double precision default 3.0     -- across-env sd vs mission median
) returns table (
  mission_id  text,
  run_id      text,
  generation  smallint,
  variant     smallint,
  sandbox_id  text,
  kind        text,
  severity    text,
  observed    double precision,
  threshold   double precision,
  detail      jsonb,
  detected_at timestamptz
)
language sql
stable
as $fn$
with scoped as (
  select e.*
  from episode_stats_exact e
  where e.ts > now() - p_lookback
    and (p_mission_id is null or e.mission_id = p_mission_id)
    and (p_run_id     is null or e.run_id     = p_run_id)
),
dim as (
  select distinct s.mission_id, s.run_id, d.generation, d.variant, d.sandbox_id
  from scoped s left join run_dim d on d.run_id = s.run_id
),

-- ---- reward trajectory, in quarters of the run's own step range ----------
quartered as (
  select run_id, mission_id, score,
         ntile(4) over (partition by run_id order by global_step, ts) as qtr
  from scoped
  where score is not null
),
qtr_stats as (
  select run_id, mission_id, qtr,
         avg(score)   as m,
         stddev_samp(score) as sd,
         count(*)     as n
  from quartered
  group by 1, 2, 3
),
traj as (
  select run_id, mission_id,
         max(m)  filter (where qtr = 1) as q1,
         max(m)  filter (where qtr = 2) as q2,
         max(m)  filter (where qtr = 3) as q3,
         max(m)  filter (where qtr = 4) as q4,
         max(sd) filter (where qtr = 1) as sd1,
         max(sd) filter (where qtr = 4) as sd4,
         sum(n)                         as n
  from qtr_stats
  group by 1, 2
),

-- ---- PPO internals per run ----------------------------------------------
metric_q as (
  select m.run_id, m.entropy, m.approx_kl,
         ntile(4) over (partition by m.run_id order by m.step, m.ts) as qtr
  from (select distinct run_id, ts, step, entropy, approx_kl from run_metrics) m
  join (select distinct run_id from scoped) s on s.run_id = m.run_id
  where m.ts > now() - p_lookback
),
metric_traj as (
  select run_id,
         avg(entropy) filter (where qtr = 1) as ent_first,
         avg(entropy) filter (where qtr = 4) as ent_last,
         max(approx_kl)                      as kl_max,
         approx_percentile(0.90, percentile_agg(approx_kl::double precision)) as kl_p90,
         count(*)                            as n
  from metric_q
  group by 1
),

-- ---- recent window: flatline and across-env spread ----------------------
recent as (
  select run_id, mission_id,
         stats_agg(score::double precision)  as score_s,
         count(*)                            as n,
         max(global_step)                    as step_max,
         min(global_step)                    as step_min
  from scoped
  where ts > now() - greatest(interval '20 seconds', p_lookback / 20)
  group by 1, 2
),
env_spread as (
  select mission_id, run_id, stddev_samp(m) as env_sd, count(*) as envs
  from (select mission_id, run_id, env, avg(score::double precision) m
        from scoped group by 1, 2, 3) pe
  group by 1, 2
),
env_spread_ref as (
  select mission_id, percentile_cont(0.5) within group (order by env_sd) as med_sd
  from env_spread group by 1
),

-- ---- liveness ------------------------------------------------------------
live as (
  select mission_id, run_id, max(ts) as last_seen, count(*) as n
  from scoped group by 1, 2
),
live_ref as (
  select mission_id, max(last_seen) as mission_last_seen from live group by 1
),

-- =========================== the checks ==================================
a_regress as (
  select t.run_id, t.mission_id, 'reward_regression' as kind,
         case when t.q4 < t.q1 - 0.05 * abs(nullif(t.q1, 0)) then 'critical' else 'warn' end as severity,
         t.q4 as observed, t.q1 as threshold,
         jsonb_build_object('q1', t.q1, 'q2', t.q2, 'q3', t.q3, 'q4', t.q4,
                            'episodes', t.n,
                            'why', 'mean reward in the final quarter of the run is below the first quarter') as detail
  from traj t
  where t.q1 is not null and t.q4 is not null and t.q4 < t.q1
),
a_collapse as (
  select t.run_id, t.mission_id, 'reward_collapse' as kind, 'critical' as severity,
         t.q4 as observed,
         greatest(t.q1, t.q2, t.q3) - p_collapse_frac * abs(greatest(t.q1, t.q2, t.q3)) as threshold,
         jsonb_build_object('peak_quarter_mean', greatest(t.q1, t.q2, t.q3),
                            'final_quarter_mean', t.q4,
                            'drop_frac', (greatest(t.q1, t.q2, t.q3) - t.q4)
                                         / nullif(abs(greatest(t.q1, t.q2, t.q3)), 0),
                            'episodes', t.n,
                            'why', 'reward fell off its own peak by more than the allowed fraction') as detail
  from traj t
  where t.q1 is not null and t.q4 is not null
    and t.q4 < greatest(t.q1, t.q2, t.q3) - p_collapse_frac * abs(greatest(t.q1, t.q2, t.q3))
),
a_entropy as (
  select m.run_id, s.mission_id, 'entropy_collapse' as kind, 'critical' as severity,
         (m.ent_last - m.ent_first) as observed, -p_entropy_drop as threshold,
         jsonb_build_object('entropy_first_quarter', m.ent_first,
                            'entropy_final_quarter', m.ent_last,
                            'delta', m.ent_last - m.ent_first,
                            'samples', m.n,
                            'why', 'policy entropy fell sharply: it has stopped exploring') as detail
  from metric_traj m
  join (select distinct run_id, mission_id from scoped) s on s.run_id = m.run_id
  where m.ent_first is not null and m.ent_last is not null
    and (m.ent_last - m.ent_first) < -p_entropy_drop
),
a_kl as (
  select m.run_id, s.mission_id, 'kl_blowup' as kind,
         case when m.kl_max > 4 * p_kl_max then 'critical' else 'warn' end as severity,
         m.kl_p90 as observed, p_kl_max as threshold,
         jsonb_build_object('approx_kl_p90', m.kl_p90, 'approx_kl_max', m.kl_max,
                            'samples', m.n,
                            'why', 'PPO updates are leaving the trust region; the policy can diverge') as detail
  from metric_traj m
  join (select distinct run_id, mission_id from scoped) s on s.run_id = m.run_id
  where m.kl_p90 > p_kl_max
),
a_flat as (
  select r.run_id, r.mission_id, 'reward_flatline' as kind, 'warn' as severity,
         variance(r.score_s) as observed, p_flat_var as threshold,
         jsonb_build_object('recent_episodes', r.n,
                            'recent_score_variance', variance(r.score_s),
                            'recent_score_mean', average(r.score_s),
                            'why', 'reward has no variance left in the recent window') as detail
  from recent r
  where r.n >= 32 and variance(r.score_s) < p_flat_var
),
a_step_stall as (
  select r.run_id, r.mission_id, 'step_flatline' as kind, 'critical' as severity,
         (r.step_max - r.step_min)::double precision as observed, 0::double precision as threshold,
         jsonb_build_object('recent_episodes', r.n,
                            'global_step', r.step_max,
                            'why', 'global_step has not advanced in the recent window') as detail
  from recent r
  where r.n >= 32 and r.step_max = r.step_min
),
a_stalled as (
  -- Only meaningful while the mission is still streaming. A mission that
  -- finished ten minutes ago has every run "behind" its last row, and calling
  -- those stalled would be a false positive on every completed generation —
  -- so the mission itself has to be live before any of its runs can be late.
  select l.run_id, l.mission_id, 'sandbox_stalled' as kind, 'critical' as severity,
         extract(epoch from (lr.mission_last_seen - l.last_seen))::double precision as observed,
         p_stall_s as threshold,
         jsonb_build_object('last_seen', l.last_seen,
                            'mission_last_seen', lr.mission_last_seen,
                            'seconds_behind', extract(epoch from (lr.mission_last_seen - l.last_seen)),
                            'episodes', l.n,
                            'why', 'this sandbox stopped emitting episodes while its siblings kept going') as detail
  from live l
  join live_ref lr on lr.mission_id = l.mission_id
  where lr.mission_last_seen > now() - make_interval(secs => p_stall_s * 2)
    and extract(epoch from (lr.mission_last_seen - l.last_seen)) > p_stall_s
),
a_spread as (
  select es.run_id, es.mission_id, 'env_divergence' as kind, 'warn' as severity,
         es.env_sd as observed, p_spread_mult * r.med_sd as threshold,
         jsonb_build_object('across_env_sd', es.env_sd,
                            'mission_median_across_env_sd', r.med_sd,
                            'envs', es.envs,
                            'why', 'the 32 parallel environments disagree far more than the mission norm') as detail
  from env_spread es
  join env_spread_ref r on r.mission_id = es.mission_id
  where r.med_sd > 0 and es.env_sd > p_spread_mult * r.med_sd
),
a_var_blowup as (
  select t.run_id, t.mission_id, 'variance_blowup' as kind, 'warn' as severity,
         t.sd4 as observed, 2.0 * t.sd1 as threshold,
         jsonb_build_object('sd_first_quarter', t.sd1, 'sd_final_quarter', t.sd4,
                            'ratio', t.sd4 / nullif(t.sd1, 0),
                            'why', 'episode-to-episode spread doubled by the end: unstable, not converging') as detail
  from traj t
  where t.sd1 is not null and t.sd4 is not null and t.sd1 > 0 and t.sd4 > 2.0 * t.sd1
),
all_checks as (
  select * from a_regress     union all
  select * from a_collapse    union all
  select * from a_entropy     union all
  select * from a_kl          union all
  select * from a_flat        union all
  select * from a_step_stall  union all
  select * from a_stalled     union all
  select * from a_spread      union all
  select * from a_var_blowup
)
select c.mission_id, c.run_id, d.generation, d.variant, d.sandbox_id,
       c.kind, c.severity, c.observed, c.threshold, c.detail, now()
from all_checks c
left join dim d on d.run_id = c.run_id and d.mission_id = c.mission_id
order by (c.severity = 'critical') desc, c.kind, c.run_id;
$fn$;

comment on function furrow_anomalies(text, text, interval, double precision, double precision,
                                     double precision, double precision, double precision,
                                     double precision) is
  'Divergence / collapse detection over episode_stats and run_metrics: reward '
  'regression and collapse, entropy collapse, PPO KL blowup, reward and step '
  'flatline, stalled sandbox, across-environment divergence, variance blowup.';
