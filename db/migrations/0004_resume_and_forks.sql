-- Furrow · 0004 — survivable mission runs + Neon fork lineage
--
-- Two problems, one migration. Everything here is additive (every column is
-- nullable or defaulted), so a mission that is mid-flight against the old
-- schema keeps working.
--
-- 1. RESUMABILITY. The Mastra workflow runs inside the Next.js server process.
--    A rebuild, a crash or a deploy kills every in-flight mission silently and
--    its row keeps claiming `training` forever. Nothing in the old schema can
--    tell "alive but quiet" (a 20-minute PPO run writes no events while it
--    trains) from "dead". `heartbeat_at` is written by the live stage runner
--    every HEARTBEAT_MS, so a missing heartbeat is proof of death, not a guess
--    from event silence. `resumed_from` / `resumed_count` record that a mission
--    was picked back up and from which stage, so the trace does not pretend the
--    run was continuous.
--
-- 2. FORKS. "What if I told it to be more cautious?" is answered by branching
--    Neon at a finished mission's state and re-running one stage of the
--    pipeline with different parameters against that branch. The scraped
--    sources, facts, curated images, perception model and binary artifacts come
--    along copy-on-write — nothing is re-scraped and nothing is copied. Each
--    fork is one row here plus one real Neon branch, and deleting the row's
--    branch is the whole cleanup.

-- ── 1. resumability ───────────────────────────────────────────────────────
-- last time a live stage runner said "this mission is still mine"
alter table missions add column if not exists heartbeat_at timestamptz;
-- which stage the most recent resume restarted at ('curate', 'generation', …)
alter table missions add column if not exists resumed_from text;
alter table missions add column if not exists resumed_count int not null default 0;

create index if not exists missions_status_heartbeat_idx on missions (status, heartbeat_at);

-- ── 2. fork lineage ───────────────────────────────────────────────────────
-- Set on the mission row AS IT EXISTS INSIDE A FORK BRANCH: the row knows which
-- Neon branch it lives on, so a connection to any branch can answer "am I the
-- original or an alternate timeline?" without a cross-branch query. On `main`
-- these stay null for ordinary missions.
alter table missions add column if not exists neon_branch_id text;
alter table missions add column if not exists neon_branch_name text;
-- the TaskSpec deltas this timeline was re-run with (reward emphasis, budget)
alter table missions add column if not exists fork_overrides jsonb;
-- mission_forks.id of the fork this row belongs to
alter table missions add column if not exists fork_id text;

-- The index of forks, kept on the PARENT's branch (normally `main`).
create table if not exists mission_forks (
  id                text primary key,
  mission_id        text not null references missions(id) on delete cascade,
  -- the real Neon branch created through the Neon API
  neon_branch_id    text not null,
  neon_branch_name  text not null,
  parent_branch_id  text,
  -- stage the fork re-ran from: research|curate|design|baseline|generation|test|report
  from_stage        text not null,
  overrides         jsonb not null default '{}',
  label             text,
  -- creating | running | done | failed | deleted
  status            text not null default 'creating',
  detail            text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  deleted_at        timestamptz
);
create index if not exists mission_forks_mission_idx on mission_forks (mission_id, created_at desc);
create unique index if not exists mission_forks_branch_idx on mission_forks (neon_branch_id);
