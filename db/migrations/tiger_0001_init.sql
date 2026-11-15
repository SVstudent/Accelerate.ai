-- Furrow · Tiger Data / TimescaleDB (telemetry) — SCHEMA.md Part 2 §1.1
-- NOT applied yet: needs TIGER_DATABASE_URL (create a Tiger Cloud service first).
-- Apply with: psql "$TIGER_DATABASE_URL" -f db/migrations/tiger_0001_init.sql

create extension if not exists timescaledb;

-- Every finished episode from every env (~256 envs at the `demo` preset)
create table if not exists episode_stats (
  ts            timestamptz not null,
  mission_id    text not null,
  run_id        text not null,
  env           smallint not null,
  phase         text not null,         -- 'train' | 'test'
  policy        text not null,         -- 'cand' | 'base'
  seed          int  not null,
  global_step   int  not null,
  score         real,
  removal       real,
  damage        real,
  trample       real,
  "precision"   real,                  -- quoted: PRECISION is a Postgres keyword
  steps         smallint
);
select create_hypertable('episode_stats', by_range('ts', interval '1 hour'), if_not_exists => true);
create index if not exists episode_stats_run_ts_idx on episode_stats (run_id, ts desc);

-- PPO internals every ~5k steps
create table if not exists run_metrics (
  ts timestamptz not null, run_id text not null, step int not null,
  ep_return_mean real, target_removal_rate real, protect_damage_rate real,
  trample_rate real, act_precision real, fps real,
  policy_loss real, value_loss real, entropy real, approx_kl real,
  components jsonb
);
select create_hypertable('run_metrics', by_range('ts', interval '1 hour'), if_not_exists => true);

-- Training Farm frame stream (LiveFrame, §3.1)
create table if not exists live_frames (
  ts timestamptz not null, mission_id text not null, run_id text not null,
  seq int not null, phase text not null, global_step int not null, data jsonb not null
);
select create_hypertable('live_frames', by_range('ts', interval '15 minutes'), if_not_exists => true);
create index if not exists live_frames_mission_ts_idx on live_frames (mission_id, ts desc);

-- Learning curves: 5-second buckets per run
create materialized view if not exists curve_5s with (timescaledb.continuous) as
select time_bucket('5 seconds', ts) as bucket, mission_id, run_id, phase, policy,
       avg(score) as score, avg(removal) as removal, avg(damage) as damage, count(*) as episodes
from episode_stats group by 1,2,3,4,5;
-- real-time aggregate: include the newest, not-yet-materialized rows in curve_5s
-- (modern TimescaleDB defaults materialized_only = true, which would hide the last ~5 s)
alter materialized view curve_5s set (timescaledb.materialized_only = false);

select add_continuous_aggregate_policy('curve_5s',
  start_offset => interval '10 minutes', end_offset => interval '0 seconds',
  schedule_interval => interval '5 seconds', if_not_exists => true);

-- Farm heat-map: latest score per env (one row per field tile)
create or replace view farm_heat as
select distinct on (run_id, env) run_id, env, phase, policy, score, ts
from episode_stats order by run_id, env, ts desc;

-- Before | After live totals during the test phase
create or replace view test_split as
select mission_id, policy, count(*) episodes, avg(removal) removal, avg(damage) damage, avg(score) score
from episode_stats where phase = 'test' group by 1,2;

-- Keep storage tiny on the free tier
alter table live_frames set (timescaledb.compress, timescaledb.compress_segmentby = 'run_id');
select add_compression_policy('live_frames', interval '30 minutes', if_not_exists => true);
alter table episode_stats set (timescaledb.compress, timescaledb.compress_segmentby = 'run_id');
select add_compression_policy('episode_stats', interval '1 hour', if_not_exists => true);
