-- Furrow · telemetry relay (measured constraint, 2026-11-14)
--
-- Daytona sandboxes can only egress on :443. Neon is reachable there via its
-- SQL-over-HTTP endpoint, but Tiger Cloud exposes only its Postgres port, which
-- the sandbox cannot open. So sandboxes append telemetry here over HTTPS and the
-- Next.js app drains it into Tiger's hypertables, which still own every
-- aggregate the UI reads (curve_5s, farm_heat, test_split).
create table if not exists telemetry_inbox (
  id         bigserial primary key,
  kind       text not null,          -- 'episode' | 'metric' | 'live_frame'
  mission_id text not null,
  run_id     text not null,
  payload    jsonb not null,
  created_at timestamptz not null default now(),
  drained_at timestamptz
);
-- the drain reads the undrained head in insert order
create index if not exists telemetry_inbox_undrained_idx
  on telemetry_inbox (id) where drained_at is null;
create index if not exists telemetry_inbox_mission_idx
  on telemetry_inbox (mission_id, id desc);
