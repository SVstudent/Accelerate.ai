-- Furrow · Neon (agent backend) — SCHEMA.md Part 2 §1
-- Applied to the Neon project's `main` branch.

create extension if not exists vector;      -- only needed if RAG ships

-- ── Missions ──────────────────────────────────────────────────────────────
create table if not exists missions (
  id               text primary key,
  goal_text        text not null,
  goal_lang        text not null default 'en',
  task_spec        jsonb,
  status           text not null default 'draft',
  phase_detail     text,
  generation       int  not null default 0,
  base_policy_id   text,
  best_policy_id   text,
  baseline_eval_id text,
  is_demo          boolean not null default false,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

-- ── Agent trace ───────────────────────────────────────────────────────────
create table if not exists agent_events (
  id            text primary key,
  mission_id    text not null references missions(id) on delete cascade,
  agent         text not null,
  kind          text not null,
  title         text not null,
  payload       jsonb not null default '{}',
  ref_table     text,
  ref_id        text,
  voice_clip_id text,
  ts            timestamptz not null default now()
);
create index if not exists agent_events_mission_ts_idx on agent_events (mission_id, ts);

-- ── Bright Data provenance ────────────────────────────────────────────────
create table if not exists sources (
  id           text primary key,
  mission_id   text references missions(id) on delete cascade,
  url          text not null,
  url_hash     text not null,
  title        text,
  domain       text,
  via          text not null,
  query        text,
  content_md   text,
  http_status  int,
  fetched_at   timestamptz not null default now()
);
create unique index if not exists sources_urlhash_mission_idx on sources (url_hash, mission_id);

create table if not exists facts (
  id           text primary key,
  mission_id   text not null references missions(id) on delete cascade,
  source_id    text not null references sources(id),
  key          text not null,
  value        jsonb not null,
  unit         text,
  quote        text,
  confidence   real not null default 0.7,
  created_at   timestamptz not null default now()
);
create index if not exists facts_mission_key_idx on facts (mission_id, key);

-- ── Perception dataset ────────────────────────────────────────────────────
create table if not exists dataset_items (
  id            text primary key,
  mission_id    text not null references missions(id) on delete cascade,
  source_id     text references sources(id),
  image_url     text not null,
  img_hash      text not null,
  thumb         bytea,
  class_key     text not null,
  class_label   text not null,
  label_source  text not null,
  verified      boolean,
  verifier_note text,
  split         text,
  created_at    timestamptz not null default now()
);
create unique index if not exists dataset_items_mission_hash_idx on dataset_items (mission_id, img_hash);

create table if not exists perception_models (
  id                text primary key,
  mission_id        text not null references missions(id) on delete cascade,
  arch              text not null,
  classes           jsonb not null,
  metrics           jsonb not null,
  pool_artifact_id  text,
  model_artifact_id text,
  created_at        timestamptz not null default now()
);

-- ── Env + reward ──────────────────────────────────────────────────────────
create table if not exists env_configs (
  id          text primary key,
  mission_id  text references missions(id) on delete cascade,
  config      jsonb not null,
  created_at  timestamptz not null default now()
);

create table if not exists reward_specs (
  id          text primary key,
  mission_id  text not null references missions(id) on delete cascade,
  generation  int  not null,
  variant     int  not null default 0,
  parent_id   text references reward_specs(id),
  code        text not null,
  rationale   text not null,
  dry_run     jsonb,
  created_at  timestamptz not null default now()
);

-- ── Policies + runs ───────────────────────────────────────────────────────
create table if not exists policies (
  id           text primary key,
  name         text not null,
  kind         text not null,
  mission_id   text references missions(id),
  parent_id    text references policies(id),
  obs_version  int  not null default 1,
  artifact_id  text not null,
  created_at   timestamptz not null default now()
);

create table if not exists runs (
  id               text primary key,
  mission_id       text not null references missions(id) on delete cascade,
  generation       int  not null,
  variant          int  not null,
  reward_spec_id   text not null references reward_specs(id),
  env_config_id    text not null references env_configs(id),
  init_policy_id   text not null references policies(id),
  result_policy_id text references policies(id),
  hyperparams      jsonb not null,
  sandbox_id       text,
  status           text not null default 'queued',
  progress         real not null default 0,
  error            text,
  started_at       timestamptz,
  ended_at         timestamptz
);
create index if not exists runs_mission_gen_idx on runs (mission_id, generation);

-- run_metrics, episode_stats, live_frames → Tiger Data (§1.1).

create table if not exists replays (
  id          text primary key,
  run_id      text references runs(id) on delete cascade,
  policy_id   text references policies(id),
  mission_id  text not null references missions(id) on delete cascade,
  step        int,
  seed        int not null,
  kind        text not null,
  data        jsonb not null,
  summary     jsonb not null,
  created_at  timestamptz not null default now()
);
create index if not exists replays_run_step_idx on replays (run_id, step desc);

create table if not exists evaluations (
  id                  text primary key,
  mission_id          text not null references missions(id) on delete cascade,
  policy_id           text not null references policies(id),
  env_config_id       text not null references env_configs(id),
  perception_model_id text references perception_models(id),
  seeds               int[] not null,
  metrics             jsonb not null,
  is_baseline         boolean not null default false,
  created_at          timestamptz not null default now()
);

-- ── Binary artifacts ──────────────────────────────────────────────────────
create table if not exists artifacts (
  id          text primary key,
  kind        text not null,
  mime        text not null,
  bytes       bytea not null,
  sha256      text not null,
  size        int  not null,
  created_at  timestamptz not null default now()
);

-- ── ElevenLabs voice (§5) ─────────────────────────────────────────────────
create table if not exists voice_clips (
  id           text primary key,
  mission_id   text references missions(id) on delete cascade,
  direction    text not null,
  purpose      text not null,
  lang         text not null default 'en',
  transcript   text not null,
  voice_id     text,
  model_id     text,
  artifact_id  text references artifacts(id),
  duration_ms  int,
  created_at   timestamptz not null default now()
);

-- ── Optional: RAG over scraped corpus ─────────────────────────────────────
create table if not exists source_chunks (
  id         text primary key,
  source_id  text not null references sources(id) on delete cascade,
  idx        int  not null,
  text       text not null,
  embedding  vector(768)
);
