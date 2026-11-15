/**
 * Furrow · Neon (agent backend) — Drizzle schema.
 * Mirrors SCHEMA.md Part 2 §1 and db/migrations/0001_init.sql exactly.
 * High-frequency telemetry lives in Tiger Data (§1.1), never here.
 */
import {
  pgTable, text, jsonb, integer, real, boolean, timestamp, customType, index, uniqueIndex,
} from "drizzle-orm/pg-core";

const bytea = customType<{ data: Buffer; notNull: false; default: false }>({
  dataType: () => "bytea",
});
const vector768 = customType<{ data: number[]; notNull: false; default: false }>({
  dataType: () => "vector(768)",
});

export const missions = pgTable("missions", {
  id: text("id").primaryKey(),
  goalText: text("goal_text").notNull(),
  goalLang: text("goal_lang").notNull().default("en"),
  taskSpec: jsonb("task_spec"),
  status: text("status").notNull().default("draft"),
  phaseDetail: text("phase_detail"),
  generation: integer("generation").notNull().default(0),
  basePolicyId: text("base_policy_id"),
  bestPolicyId: text("best_policy_id"),
  baselineEvalId: text("baseline_eval_id"),
  isDemo: boolean("is_demo").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  /* ── migration 0004: survivable runs ── */
  /** Written every few seconds by the live stage runner; proof the run exists. */
  heartbeatAt: timestamp("heartbeat_at", { withTimezone: true }),
  /** Stage the latest resume restarted at ('curate', 'generation', …). */
  resumedFrom: text("resumed_from"),
  resumedCount: integer("resumed_count").notNull().default(0),
  /* ── migration 0004: fork lineage (set on the row INSIDE a fork branch) ── */
  neonBranchId: text("neon_branch_id"),
  neonBranchName: text("neon_branch_name"),
  /** TaskSpec deltas this timeline was re-run with. */
  forkOverrides: jsonb("fork_overrides"),
  forkId: text("fork_id"),
});

/** One row per Neon branch Furrow created to re-run a mission differently. */
export const missionForks = pgTable("mission_forks", {
  id: text("id").primaryKey(),
  missionId: text("mission_id").notNull().references(() => missions.id, { onDelete: "cascade" }),
  neonBranchId: text("neon_branch_id").notNull(),
  neonBranchName: text("neon_branch_name").notNull(),
  parentBranchId: text("parent_branch_id"),
  fromStage: text("from_stage").notNull(),
  overrides: jsonb("overrides").notNull().default({}),
  label: text("label"),
  /** creating | running | done | failed | deleted */
  status: text("status").notNull().default("creating"),
  detail: text("detail"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
}, (t) => [index("mission_forks_mission_idx").on(t.missionId, t.createdAt)]);

export const agentEvents = pgTable("agent_events", {
  id: text("id").primaryKey(),
  missionId: text("mission_id").notNull().references(() => missions.id, { onDelete: "cascade" }),
  agent: text("agent").notNull(),
  kind: text("kind").notNull(),
  title: text("title").notNull(),
  payload: jsonb("payload").notNull().default({}),
  refTable: text("ref_table"),
  refId: text("ref_id"),
  voiceClipId: text("voice_clip_id"),
  ts: timestamp("ts", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("agent_events_mission_ts_idx").on(t.missionId, t.ts)]);

export const sources = pgTable("sources", {
  id: text("id").primaryKey(),
  missionId: text("mission_id").references(() => missions.id, { onDelete: "cascade" }),
  url: text("url").notNull(),
  urlHash: text("url_hash").notNull(),
  title: text("title"),
  domain: text("domain"),
  via: text("via").notNull(),
  query: text("query"),
  contentMd: text("content_md"),
  httpStatus: integer("http_status"),
  fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
  /* ── migration 0003: region targeting + provenance chain ── */
  /** Google `gl` the SERP was issued with ('us', 'gb', …), null if untargeted. */
  region: text("region"),
  /** Google `hl` (UI language) for the same request. */
  regionLang: text("region_lang"),
  /** The Bright Data zone that served it (zone name, never a credential). */
  zone: text("zone"),
  /** sha256 of the bytes Bright Data returned, before compaction/truncation. */
  contentSha256: text("content_sha256"),
  contentBytes: integer("content_bytes"),
  /** The page's own published/modified date, when it states one. */
  pagePublishedAt: timestamp("page_published_at", { withTimezone: true }),
  pagePublishedRaw: text("page_published_raw"),
}, (t) => [
  uniqueIndex("sources_urlhash_mission_idx").on(t.urlHash, t.missionId),
  index("sources_mission_region_idx").on(t.missionId, t.region),
]);

export const facts = pgTable("facts", {
  id: text("id").primaryKey(),
  missionId: text("mission_id").notNull().references(() => missions.id, { onDelete: "cascade" }),
  sourceId: text("source_id").notNull().references(() => sources.id),
  key: text("key").notNull(),
  value: jsonb("value").notNull(),
  unit: text("unit"),
  quote: text("quote"),
  confidence: real("confidence").notNull().default(0.7),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  /** migration 0003: the SERP region the citing source was retrieved from. */
  region: text("region"),
}, (t) => [
  index("facts_mission_key_idx").on(t.missionId, t.key),
  index("facts_mission_key_region_idx").on(t.missionId, t.key, t.region),
]);

export const datasetItems = pgTable("dataset_items", {
  id: text("id").primaryKey(),
  missionId: text("mission_id").notNull().references(() => missions.id, { onDelete: "cascade" }),
  sourceId: text("source_id").references(() => sources.id),
  imageUrl: text("image_url").notNull(),
  imgHash: text("img_hash").notNull(),
  thumb: bytea("thumb"),
  classKey: text("class_key").notNull(),
  classLabel: text("class_label").notNull(),
  labelSource: text("label_source").notNull(),
  verified: boolean("verified"),
  verifierNote: text("verifier_note"),
  split: text("split"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  /* ── migration 0003: provenance of the bytes + hard-negative mining ── */
  /** The image-SERP query that surfaced this image. */
  query: text("query"),
  /** The page the image was found on (Google Images `source`). */
  pageUrl: text("page_url"),
  /** Bright Data Unlocker zone that downloaded the bytes. */
  zone: text("zone"),
  /** sha256 of the ORIGINAL downloaded bytes (not the thumbnail). */
  bytesSha256: text("bytes_sha256"),
  bytesLen: integer("bytes_len"),
  contentType: text("content_type"),
  fetchedAt: timestamp("fetched_at", { withTimezone: true }),
  /** Mined deliberately as a look-alike of the other class. */
  hardNegative: boolean("hard_negative").notNull().default(false),
  /** Which class it is visually confusable WITH ('target' | 'protect'). */
  lookalikeOf: text("lookalike_of"),
  /** The look-alike entity the planner named, in its own words. */
  lookalikeName: text("lookalike_name"),
}, (t) => [
  uniqueIndex("dataset_items_mission_hash_idx").on(t.missionId, t.imgHash),
  index("dataset_items_mission_hardneg_idx").on(t.missionId, t.hardNegative),
]);

export const perceptionModels = pgTable("perception_models", {
  id: text("id").primaryKey(),
  missionId: text("mission_id").notNull().references(() => missions.id, { onDelete: "cascade" }),
  arch: text("arch").notNull(),
  classes: jsonb("classes").notNull(),
  metrics: jsonb("metrics").notNull(),
  poolArtifactId: text("pool_artifact_id"),
  modelArtifactId: text("model_artifact_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const envConfigs = pgTable("env_configs", {
  id: text("id").primaryKey(),
  missionId: text("mission_id").references(() => missions.id, { onDelete: "cascade" }),
  config: jsonb("config").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const rewardSpecs = pgTable("reward_specs", {
  id: text("id").primaryKey(),
  missionId: text("mission_id").notNull().references(() => missions.id, { onDelete: "cascade" }),
  generation: integer("generation").notNull(),
  variant: integer("variant").notNull().default(0),
  parentId: text("parent_id"),
  code: text("code").notNull(),
  rationale: text("rationale").notNull(),
  dryRun: jsonb("dry_run"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const policies = pgTable("policies", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  kind: text("kind").notNull(),
  missionId: text("mission_id").references(() => missions.id),
  parentId: text("parent_id"),
  obsVersion: integer("obs_version").notNull().default(1),
  artifactId: text("artifact_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const runs = pgTable("runs", {
  id: text("id").primaryKey(),
  missionId: text("mission_id").notNull().references(() => missions.id, { onDelete: "cascade" }),
  generation: integer("generation").notNull(),
  variant: integer("variant").notNull(),
  rewardSpecId: text("reward_spec_id").notNull().references(() => rewardSpecs.id),
  envConfigId: text("env_config_id").notNull().references(() => envConfigs.id),
  initPolicyId: text("init_policy_id").notNull().references(() => policies.id),
  resultPolicyId: text("result_policy_id"),
  hyperparams: jsonb("hyperparams").notNull(),
  sandboxId: text("sandbox_id"),
  status: text("status").notNull().default("queued"),
  progress: real("progress").notNull().default(0),
  error: text("error"),
  startedAt: timestamp("started_at", { withTimezone: true }),
  endedAt: timestamp("ended_at", { withTimezone: true }),
}, (t) => [index("runs_mission_gen_idx").on(t.missionId, t.generation)]);

export const replays = pgTable("replays", {
  id: text("id").primaryKey(),
  runId: text("run_id").references(() => runs.id, { onDelete: "cascade" }),
  policyId: text("policy_id").references(() => policies.id),
  missionId: text("mission_id").notNull().references(() => missions.id, { onDelete: "cascade" }),
  step: integer("step"),
  seed: integer("seed").notNull(),
  kind: text("kind").notNull(),
  data: jsonb("data").notNull(),
  summary: jsonb("summary").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("replays_run_step_idx").on(t.runId, t.step)]);

export const evaluations = pgTable("evaluations", {
  id: text("id").primaryKey(),
  missionId: text("mission_id").notNull().references(() => missions.id, { onDelete: "cascade" }),
  policyId: text("policy_id").notNull().references(() => policies.id),
  envConfigId: text("env_config_id").notNull().references(() => envConfigs.id),
  perceptionModelId: text("perception_model_id").references(() => perceptionModels.id),
  seeds: integer("seeds").array().notNull(),
  metrics: jsonb("metrics").notNull(),
  isBaseline: boolean("is_baseline").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const artifacts = pgTable("artifacts", {
  id: text("id").primaryKey(),
  kind: text("kind").notNull(),
  mime: text("mime").notNull(),
  bytes: bytea("bytes").notNull(),
  sha256: text("sha256").notNull(),
  size: integer("size").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const voiceClips = pgTable("voice_clips", {
  id: text("id").primaryKey(),
  missionId: text("mission_id").references(() => missions.id, { onDelete: "cascade" }),
  direction: text("direction").notNull(),
  purpose: text("purpose").notNull(),
  lang: text("lang").notNull().default("en"),
  transcript: text("transcript").notNull(),
  voiceId: text("voice_id"),
  modelId: text("model_id"),
  artifactId: text("artifact_id").references(() => artifacts.id),
  durationMs: integer("duration_ms"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const sourceChunks = pgTable("source_chunks", {
  id: text("id").primaryKey(),
  sourceId: text("source_id").notNull().references(() => sources.id, { onDelete: "cascade" }),
  idx: integer("idx").notNull(),
  text: text("text").notNull(),
  embedding: vector768("embedding"),
});
