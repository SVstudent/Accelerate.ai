/**
 * Furrow · JSON contracts — SOURCE OF TRUTH (CLAUDE.md §12).
 * Mirrors SCHEMA.md Part 2. Python mirror: trainer/contracts.py.
 * If you change one, change all three in the same commit.
 */
import { z } from "zod";

/* ── §2.0 MissionStatus ──────────────────────────────────────────────── */
export const MissionStatus = z.enum([
  "draft", "awaiting_confirm", "researching", "curating", "perceiving",
  "designing", "baseline", "training", "evaluating", "redesigning",
  "reporting", "done", "failed",
]);
export type MissionStatus = z.infer<typeof MissionStatus>;

/** The 8 PhaseRail steps (DESIGN.md §3.2) each status maps onto. */
export const PHASES = [
  "ask", "research", "curate", "perceive", "design", "train_g0", "train_g1", "report",
] as const;
export type Phase = (typeof PHASES)[number];

export function phaseOf(status: MissionStatus, generation = 0): Phase {
  switch (status) {
    case "draft": case "awaiting_confirm": return "ask";
    case "researching": return "research";
    case "curating": return "curate";
    case "perceiving": return "perceive";
    case "designing": case "baseline": return "design";
    case "training": case "evaluating": case "redesigning":
      return generation <= 0 ? "train_g0" : "train_g1";
    case "reporting": case "done": case "failed": return "report";
  }
}

/* ── §2.1 TaskSpec ───────────────────────────────────────────────────── */
export const TaskTemplate = z.enum(["selective_removal", "selective_harvest"]);
export type TaskTemplate = z.infer<typeof TaskTemplate>;

export const ClassSpec = z.object({
  key: z.enum(["target", "protect"]),
  names: z.array(z.string()).min(1),
  scientific: z.array(z.string()).default([]),
  stage_hint: z.string().optional(),
});
export type ClassSpec = z.infer<typeof ClassSpec>;

export const TaskSpec = z.object({
  template: TaskTemplate,
  crop: z.string(),
  target: ClassSpec,
  protect: ClassSpec,
  priorities: z.object({
    avoid_damage: z.number().min(0).max(1).default(0.9),
    coverage: z.number().min(0).max(1).default(0.7),
    speed: z.number().min(0).max(1).default(0.3),
  }),
  region_hint: z.string().optional(),
  lang: z.string().default("en"),
  budget: z.object({
    // 3 generations: the Judge's reflection measurably improves the reward each
    // round (gen 1 cut crop damage 73% -> 72% and lifted precision 69% -> 67%
    // on a harder reward), and the loop is the project's whole thesis.
    generations: z.number().int().min(1).max(5).default(3),
    variants: z.number().int().min(1).max(12).default(4),
    // 400k, not 200k: episodes are now 800 steps (the coverage fix), so 200k
    // gave the policy only half as many episodes of experience as before.
    // At the measured ~6,000 fps a sandbox still finishes this in ~70 s.
    // 800k: at the measured ~7,000 fps a sandbox finishes this in ~2 minutes,
    // and 400k was stopping before the trample-avoidance behaviour converged.
    steps_per_run: z.number().int().min(10_000).max(2_000_000).default(800_000),
  }),
});
export type TaskSpec = z.infer<typeof TaskSpec>;

/* ── §2.2 FactKey (closed set) ───────────────────────────────────────── */
export const FactKey = z.enum([
  "row_spacing_cm", "in_row_spacing_cm", "bed_width_cm", "crop_canopy_radius_cm",
  "crop_root_zone_radius_cm", "weed_density_per_m2", "weed_radius_cm_at_stage",
  "removal_window_days", "critical_weed_free_period_days", "herbicide_note", "impact_stat",
]);
export type FactKey = z.infer<typeof FactKey>;

export const FactValue = z.union([
  z.number(),
  z.tuple([z.number(), z.number()]),
  z.string(),
]);

export const Fact = z.object({
  id: z.string().optional(),
  source_id: z.string(),
  key: FactKey,
  value: FactValue,
  unit: z.string().optional(),
  /** ≤ 25 words, the supporting snippet. */
  quote: z.string().optional(),
  confidence: z.number().min(0).max(1).default(0.7),
});
export type Fact = z.infer<typeof Fact>;

/* ── §2.3 PerceptionMetrics ──────────────────────────────────────────── */
export const PerceptionMetrics = z.object({
  n_train: z.number().int(), n_val: z.number().int(),
  n_pool: z.number().int(), n_rejected: z.number().int(),
  zero_shot_acc: z.number(),   // the BEFORE
  probe_acc: z.number(),       // the AFTER
  probe_auc: z.number().optional(),
  confusion: z.array(z.array(z.number())).optional(),
  per_source_acc: z.record(z.string(), z.number()).optional(),
});
export type PerceptionMetrics = z.infer<typeof PerceptionMetrics>;

/* ── §2.4 EnvConfig ──────────────────────────────────────────────────── */
/** A number sourced from a Fact, or explicitly marked as an assumption. */
export const Sourced = z.object({
  value: z.union([z.number(), z.tuple([z.number(), z.number()])]),
  fact_id: z.string().optional(),
  assumed: z.boolean().optional(),
});
export type Sourced = z.infer<typeof Sourced>;

export const EnvConfig = z.object({
  obs_version: z.literal(1),
  field: z.object({
    length_m: z.number().default(12),
    rows: z.number().int().default(3),
    row_spacing_m: Sourced,
    in_row_spacing_m: Sourced,
    crop_radius_m: Sourced,
    root_zone_radius_m: Sourced,
    weed_density_per_m2: Sourced,
    weed_radius_m: Sourced,
  }),
  /**
   * Rover defaults. Mirror of trainer/contracts.py RoverSpec — see the docstring
   * there for why these numbers are what they are. In short: 0.9 m/s and a
   * 0.25 m reach (0.5 m swath) are what a real inter-row weeder has, and what
   * makes 60-70% removal arithmetically reachable inside an episode;
   * body_radius 0.05 is fixed by furrow clearance and must not be raised.
   */
  rover: z.object({
    max_speed_mps: z.number().default(0.9),
    max_turn_rps: z.number().default(1.2),
    body_radius_m: z.number().default(0.05),
    reach_m: z.number().default(0.25),
  }),
  perception: z.union([
    z.object({ mode: z.literal("pool"), perception_model_id: z.string() }),
    z.object({ mode: z.literal("uninformative") }),
  ]),
  /** 800 * dt 0.1 = an 80 s pass. 400 (40 s) capped removal at ~46% of the bed. */
  episode_steps: z.number().int().default(800),
  dt: z.number().default(0.1),
  randomize: z.object({
    spacing_jitter: z.number().default(0.15),
    missing_crop_prob: z.number().default(0.05),
  }),
});
export type EnvConfig = z.infer<typeof EnvConfig>;

/* ── §2.5 RunHyperparams ─────────────────────────────────────────────── */
export const RunHyperparams = z.object({
  algo: z.literal("PPO").default("PPO"),
  total_steps: z.number().int().default(200_000),
  n_envs: z.number().int().default(32),
  lr: z.number().default(3e-4),
  n_steps: z.number().int().default(1024),
  batch_size: z.number().int().default(2048),
  gamma: z.number().default(0.99),
  ent_coef: z.number().default(0.005),
  clip_range: z.number().default(0.2),
  seed: z.number().int().default(7),
  metrics_every: z.number().int().default(5000),
  replay_every: z.number().int().default(25_000),
  replay_seed: z.number().int().default(1000),
});
export type RunHyperparams = z.infer<typeof RunHyperparams>;

/* ── §2.6 SandboxJob ─────────────────────────────────────────────────── */
export const SandboxJob = z.object({
  job: z.enum(["train", "curate", "eval", "dry_run_reward"]),
  mission_id: z.string(),
  run_id: z.string().optional(),
  init_policy_artifact_id: z.string().optional(),
  env_config: EnvConfig.optional(),
  reward_code: z.string().optional(),
  perception_pool_artifact_id: z.string().optional(),
  hyperparams: RunHyperparams.optional(),
  eval_seeds: z.array(z.number().int()).optional(),
  /** curate only */
  dataset: z.array(z.object({
    id: z.string(), image_url: z.string(), class_key: z.enum(["target", "protect"]),
    split: z.enum(["train", "val", "pool"]),
    /**
     * Mined deliberately as a look-alike of the other class (migration 0003).
     * curate.py fits the probe with and without these and reports both on the
     * same held-out split, so the effect is measured, not assumed.
     */
    hard_negative: z.boolean().optional(),
    lookalike_of: z.enum(["target", "protect"]).nullable().optional(),
  })).optional(),
  classes: z.record(z.string(), z.string()).optional(),
});
export type SandboxJob = z.infer<typeof SandboxJob>;

/* ── §2.7 Reflection ─────────────────────────────────────────────────── */
export const Reflection = z.object({
  generation: z.number().int(),
  ranking: z.array(z.object({ run_id: z.string(), score: z.number() })),
  best_run_id: z.string(),
  observations: z.array(z.string()),
  suggestions: z.array(z.string()),
  component_stats: z.record(z.string(), z.number()).default({}),
});
export type Reflection = z.infer<typeof Reflection>;

/* ── §3 Replay ───────────────────────────────────────────────────────── */
export const PLANT_PROTECT = 0;
export const PLANT_TARGET = 1;

export const EventType = z.enum([
  "removed_target", "removed_protect", "trampled_protect", "miss",
]);
export type EventType = z.infer<typeof EventType>;

export const Replay = z.object({
  v: z.literal(1),
  seed: z.number().int(),
  dt: z.number(),
  field: z.object({
    length_m: z.number(), width_m: z.number(), rows_y: z.array(z.number()),
  }),
  /** [x, y, cls(0=protect,1=target), radius, p_target, image_id|null] */
  plants: z.array(z.tuple([
    z.number(), z.number(), z.number(), z.number(), z.number(),
    z.string().nullable(),
  ])),
  /** base64 Float32Array of [x,y,theta,act] * T */
  rover: z.string(),
  /** [t, plant_id, type] */
  events: z.array(z.tuple([z.number(), z.number(), EventType])),
  /** base64 Float32Array of per-step reward * T */
  reward: z.string().optional(),
});
export type Replay = z.infer<typeof Replay>;

/* ── §3.1 LiveFrame ──────────────────────────────────────────────────── */
export const LiveFrame = z.object({
  v: z.literal(1),
  n_envs: z.number().int(),
  stride: z.number().int(),
  frames: z.number().int(),
  env_policy: z.array(z.enum(["cand", "base"])),
  /** base64 Uint16 [env][frame][x_cm, y_cm] */
  pose: z.string(),
  /** base64 Uint8 [env][frame][theta_q, act] */
  theta_act: z.string(),
  resets: z.array(z.object({
    env: z.number().int(),
    frame: z.number().int(),
    seed: z.number().int(),
    /** base64 Uint16 [n][x_cm, y_cm, cls<<15 | r_mm, p_target*65535] */
    plants: z.string(),
    resync: z.boolean().optional(),
  })).default([]),
  /** [env, frame, plant_id, type] */
  events: z.array(z.tuple([z.number(), z.number(), z.number(), EventType])).default([]),
  /** [env, score] for episodes that finished in this window → tile border colour */
  ep_scores: z.array(z.tuple([z.number(), z.number()])).default([]),
  agg: z.object({
    episodes: z.number(), score_mean: z.number(),
    removal: z.number(), damage: z.number(),
  }),
});
export type LiveFrame = z.infer<typeof LiveFrame>;

/* ── §6 Metrics ──────────────────────────────────────────────────────── */
export const EpisodeSummary = z.object({
  target_removal_rate: z.number(),
  protect_damage_rate: z.number(),
  trample_rate: z.number(),
  act_precision: z.number(),
  steps_used: z.number().int(),
  score: z.number(),
  /**
   * Crop damage paid per weed removed — LOWER IS BETTER. Optional because the
   * simulator's own summary() predates it; trainer/evaluate.py fills it in.
   * Measured example: baseline 0.400/0.340 = 1.18, trained 0.403/0.401 = 1.00.
   * The trained policy was strictly cheaper per weed, which neither
   * `act_precision` nor `score` makes visible on its own.
   */
  damage_per_weed_removed: z.number().optional(),
  /**
   * Fraction of tool firings that hit nothing — LOWER IS BETTER. Separated from
   * crop damage on purpose: misses dominate `act_precision`'s denominator, so a
   * policy that fires more, removes more and harms no extra crops still looks
   * "imprecise". This field is the trigger-discipline half of that story.
   */
  miss_rate: z.number().optional(),
});
export type EpisodeSummary = z.infer<typeof EpisodeSummary>;

export const MeanCI = z.object({ mean: z.number(), ci95: z.number() });

export const EvalMetrics = z.object({
  n_episodes: z.number().int(),
  target_removal_rate: MeanCI,
  protect_damage_rate: MeanCI,
  trample_rate: MeanCI,
  act_precision: MeanCI,
  steps_used: MeanCI,
  score: MeanCI,
  /** Impact card (§6) */
  applications_avoided_pct: z.number().optional(),
  policy_acts: z.number().optional(),
  plants_total: z.number().optional(),
  /**
   * §6 honest headline — protect_damage_rate / max(RATE_EPSILON,
   * target_removal_rate), computed as a RATIO OF THE MEAN RATES over the eval's
   * episodes (not the mean of per-episode ratios, which a zero-removal episode
   * would blow up). Lower is better. Optional: evaluations written before this
   * field existed simply do not have it, and the UI renders "—".
   */
  damage_per_weed_removed: z.number().optional(),
  /** misses / max(1, acts) across the whole eval. Lower is better. */
  miss_rate: z.number().optional(),
});
export type EvalMetrics = z.infer<typeof EvalMetrics>;

/** Divide-by-zero guard for the ratio metrics (mirror: RATE_EPSILON). */
export const RATE_EPSILON = 1e-6;

/**
 * §6 — crop damage paid per weed removed. LOWER IS BETTER.
 * Keep identical to trainer/contracts.py `damage_per_weed_removed`.
 *
 * `act_precision` cannot be the honest headline, because
 * act_precision = removed_target / (removed_target + removed_protect + misses)
 * and MISSES dominate that denominator: a policy that rarely fires rarely
 * misses and scores high, while a policy that fires often, removes far more
 * weeds and harms no extra crops is punished for trigger discipline alone.
 * Measured: baseline 0.400/0.340 = 1.18, trained 0.403/0.401 = 1.00 — the
 * trained policy buys each weed at 15% less crop damage.
 *
 * Reporting only. `score()` below is untouched: policies are ranked by it.
 */
export function damagePerWeedRemoved(
  protectDamageRate: number,
  targetRemovalRate: number,
): number {
  return protectDamageRate / Math.max(RATE_EPSILON, targetRemovalRate);
}

/**
 * §6 — fraction of tool firings that hit nothing. LOWER IS BETTER.
 * Reported separately from crop damage so "fires too eagerly" and "hurts the
 * crop" can never again be read off one number.
 */
export function missRate(misses: number, acts: number): number {
  return misses / Math.max(1, acts);
}

/** §6 — the single ranking statistic. Keep identical to trainer/contracts.py. */
export function score(
  s: Pick<EpisodeSummary, "target_removal_rate" | "protect_damage_rate" | "steps_used">,
  episodeSteps: number,
  damageWeight = 2.0,
): number {
  return s.target_removal_rate
    - damageWeight * s.protect_damage_rate
    - 0.1 * (s.steps_used / episodeSteps);
}

/** EVAL_SEEDS = [1000..1031] everywhere (§12). */
export const EVAL_SEEDS: number[] = Array.from({ length: 32 }, (_, i) => 1000 + i);

/* ── §7 SSE events ───────────────────────────────────────────────────── */
export const SSE_EVENTS = [
  "mission", "agent_event", "run", "metric", "heat", "split",
  "replay", "eval", "voice", "live", "ingest",
] as const;
export type SseEventName = (typeof SSE_EVENTS)[number];

export const IngestCounters = z.object({
  queries: z.number().int().default(0),
  pages: z.number().int().default(0),
  images_raw: z.number().int().default(0),
  images_kept: z.number().int().default(0),
  facts: z.number().int().default(0),
  /** distinct Bright Data SERP regions (gl) this mission asked from (0003) */
  regions: z.number().int().default(0),
  /** images mined on purpose as look-alikes of the other class (0003) */
  hard_negatives: z.number().int().default(0),
});
export type IngestCounters = z.infer<typeof IngestCounters>;

/* ── ID prefixes (§ preamble) ────────────────────────────────────────── */
export const ID_PREFIX = {
  mission: "msn", event: "evt", source: "src", fact: "fct", dataset_item: "img",
  perception_model: "pm", env_config: "env", reward_spec: "rwd", policy: "pol",
  run: "run", replay: "rpl", evaluation: "evl", artifact: "art", voice_clip: "vc",
  /** migration 0004: one row per Neon branch created to re-run a mission. */
  mission_fork: "fork",
} as const;
