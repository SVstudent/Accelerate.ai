/**
 * The Architect — Facts → EnvConfig, and the reward function itself.
 *
 * Two jobs, both of which have to be auditable after the fact:
 *
 *  1. `buildEnvConfig` turns the Scout's Facts into a validated EnvConfig.
 *     Every physical number in the config is a `Sourced`: it carries either the
 *     `fact_id` it came from, or `assumed: true`. There is no third option —
 *     the invariant is asserted before the row is written, so the UI can always
 *     say "this came from that page" or "we made this up".
 *
 *  2. `writeRewardSpec` asks the LLM for Python reward code against
 *     trainer/reward_runtime.py's contract, then proves it in a Daytona
 *     sandbox with `dryRunReward()`. LLM-written reward code is NEVER executed
 *     in this process — not with eval, not with new Function, not ever. The
 *     only thing Node does with it is store it and ship it to a sandbox.
 *
 * The reward system prompt below is not generic RL advice: it encodes what two
 * real measured runs taught us — a damage-dominated reward makes the policy
 * freeze (removal collapsed to 0.05 while damage fell to ~0), and a 0.05 miss
 * penalty makes it spray-fire (removal 0.340 -> 0.401 at identical crop damage,
 * act_precision 0.395 -> 0.265). The reward has to price BOTH failures.
 */
import { z } from "zod";
import { db, schema } from "@/db";
import { newId } from "@/lib/ids";
import {
  EnvConfig,
  type Reflection,
  type Sourced,
  type TaskSpec,
} from "@/lib/contracts";
import { dryRunReward } from "@/mastra/tools/daytona";
import type { EventSink } from "@/mastra/tools/events";
import { llmConfigured, structured } from "@/mastra/tools/llm";

export type RewardSpecRow = typeof schema.rewardSpecs.$inferSelect;

/**
 * A fact as either contracts.ts `Fact` or a raw `facts` row (camelCase keys,
 * `value` as unknown jsonb). The Architect is handed both, so it normalises
 * rather than making callers convert.
 */
export type FactLike = {
  id?: string | null;
  key?: string | null;
  value?: unknown;
  unit?: string | null;
  quote?: string | null;
  confidence?: number | null;
};

/* ── rover geometry ───────────────────────────────────────────────────────
 * Mirrors EnvConfig.rover's defaults (contracts.ts / trainer RoverSpec). The
 * numbers are needed here too: the root-zone clamp below depends on them, and
 * getting that wrong is what previously made trampling unavoidable and taught
 * policies to stand still.
 *
 * MEASURED CEILING (live run: rows=2, length_m=9, row_spacing≈1.05 m):
 *   bed area      = 9 * (2 * 1.05)                   = 18.9 m²
 *   travel budget = 400 steps * 0.1 s * 0.6 m/s      = 24 m
 *   tool swath    = 2 * 0.18 m reach                 = 0.36 m
 *   max coverable = 24 * 0.36                        = 8.64 m² = 46% of the bed
 * Measured target_removal_rate was 0.401 — about 87% of that arithmetic
 * maximum. No reward can fix that: the rover physically cannot reach the rest
 * of the weeds inside the episode, and asking it to try only makes it fire
 * more often (which is what dragged act_precision down). So the ceiling is
 * raised here, in the physics, with numbers a real inter-row weeder has:
 *   · max_speed 0.6 → 0.9 m/s   (commercial inter-row weeders run 0.5-1.5 m/s)
 *   · reach     0.18 → 0.25 m   (a multi-nozzle/multi-tine implement, not a
 *                                single point tool: 0.5 m total swath)
 *   · episode_steps 400 → 800   (dt 0.1 → an 80 s pass; 40 s was not a
 *                                realistic pass over a bed of this size)
 * body_radius_m stays 0.05: it is sized so the chassis clears a 30 cm furrow
 * next to an 8 cm root zone. Raising it reintroduces unavoidable trampling,
 * which is the known cause of the idle collapse.
 */
const ROVER = {
  max_speed_mps: 0.9,
  max_turn_rps: 1.2,
  body_radius_m: 0.05,
  reach_m: 0.25,
} as const;

const EPISODE_STEPS = 800;
const DT = 0.1;

/**
 * Theoretical coverage the bed must leave spare: coverable area / bed area.
 * A policy drives an imperfect path (overlap, turns, re-approaches), so it
 * needs roughly 2-3x the arithmetic minimum to reach 60-70% removal. 2.5x
 * keeps the task demanding — it is headroom, not a free pass.
 */
const MIN_COVERAGE_HEADROOM = 2.5;

/* ── agronomic fallbacks (ONLY ever emitted as assumed: true) ─────────── */
const FALLBACK = {
  row_spacing_m: 0.30,          // a typical narrow-bed row crop
  in_row_spacing_m: 0.12,
  crop_radius_m: 0.10,          // strawberry canopy at the weeding window
  root_zone_radius_m: 0.08,     // 0.05 body + 0.08 zone = 13 cm, clears a 15 cm furrow
  // 12/m^2 is an infested field; a managed bed at the weeding window runs
  // ~2-6/m^2, which is also what the scraped extension guidance reports.
  weed_density_per_m2: 5,
  // 4-leaf seedling rather than cotyledon: 0.02 m renders at the minimum
  // visible size, and the weeding window in the scraped guidance is the 2-4
  // leaf stage anyway. Still well under the 0.10 m crop canopy.
  weed_radius_m: 0.045,
} as const;

/** Plausible physical bounds. A bad fact must not be able to break the sim. */
const BOUNDS: Record<keyof typeof FALLBACK, [number, number]> = {
  row_spacing_m: [0.12, 1.2],
  in_row_spacing_m: [0.05, 0.6],
  crop_radius_m: [0.01, 0.3],
  root_zone_radius_m: [0.02, 0.3],
  weed_density_per_m2: [0.5, 60],
  weed_radius_m: [0.005, 0.15],
};

/* ── fact → number plumbing ──────────────────────────────────────────── */

type NumOrRange = number | [number, number];

/** Pull numbers out of a FactValue, including sloppy strings like "25–30 cm". */
function factNumber(value: unknown): NumOrRange | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) {
    const a = Number(value[0]);
    const b = Number(value[1]);
    if (Number.isFinite(a) && Number.isFinite(b)) {
      return a <= b ? [a, b] : [b, a];
    }
    return null;
  }
  if (typeof value === "string") {
    const hits = (value.match(/-?\d+(?:[.,]\d+)?/g) ?? [])
      .map((s) => Number(s.replace(",", ".")))
      .filter((n) => Number.isFinite(n));
    if (hits.length >= 2) return hits[0] <= hits[1] ? [hits[0], hits[1]] : [hits[1], hits[0]];
    if (hits.length === 1) return hits[0];
  }
  return null;
}

/**
 * Multiplier that takes a fact's value into the config's unit.
 * The FactKey names declare their own unit (`*_cm`, `*_per_m2`), so cm is the
 * default; `fact.unit` only matters when a source quoted something else.
 */
function unitScale(key: string, unit?: string | null): number {
  const u = (unit ?? "").trim().toLowerCase().replace(/[.\s]/g, "");
  if (key === "weed_density_per_m2") {
    return u.includes("ft") ? 10.7639 : 1; // per sq ft → per m²
  }
  if (["m", "meter", "metre", "meters", "metres"].includes(u)) return 1;
  if (["mm", "millimeter", "millimetre", "millimeters", "millimetres"].includes(u)) return 0.001;
  if (["in", "inch", "inches", '"'].includes(u)) return 0.0254;
  if (["ft", "foot", "feet", "'"].includes(u)) return 0.3048;
  return 0.01; // cm, the declared unit of every *_cm FactKey
}

/** Highest-confidence fact for a key (ties → the most recently supplied one). */
function pickFact(facts: FactLike[], key: string): FactLike | undefined {
  let best: FactLike | undefined;
  for (const f of facts) {
    if (f.key !== key) continue;
    const c = f.confidence ?? 0.7;
    if (!best || c >= (best.confidence ?? 0.7)) best = f;
  }
  return best;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

function clampValue(v: NumOrRange, lo: number, hi: number): NumOrRange {
  if (typeof v === "number") return clamp(v, lo, hi);
  const a = clamp(v[0], lo, hi);
  const b = clamp(v[1], lo, hi);
  return a === b ? a : [a, b];
}

/** The midpoint the geometry checks reason about (same rule as Sourced.mid()). */
function mid(s: Sourced): number {
  const v = s.value;
  return typeof v === "number" ? v : (v[0] + v[1]) / 2;
}

function assumed(value: NumOrRange, bounds: [number, number]): Sourced {
  return { value: clampValue(value, bounds[0], bounds[1]), assumed: true };
}

/**
 * One config field from a fact, or the agronomic fallback.
 * A fact with no `id` cannot be cited, so it is recorded as an assumption —
 * the invariant is "every number is attributable or explicitly made up".
 */
function sourced(
  facts: FactLike[],
  key: string,
  field: keyof typeof FALLBACK,
): Sourced {
  const bounds = BOUNDS[field];
  const f = pickFact(facts, key);
  if (!f) return assumed(FALLBACK[field], bounds);
  const raw = factNumber(f.value);
  if (raw === null) return assumed(FALLBACK[field], bounds);
  const k = unitScale(key, f.unit);
  const scaled: NumOrRange = typeof raw === "number" ? raw * k : [raw[0] * k, raw[1] * k];
  const value = clampValue(scaled, bounds[0], bounds[1]);
  return f.id ? { value, fact_id: f.id } : { value, assumed: true };
}

/** Keep provenance while tightening a value for physical coherence. */
function retighten(s: Sourced, lo: number, hi: number): Sourced {
  return { ...s, value: clampValue(s.value, lo, hi) };
}

export type BuiltEnvConfig = { id: string; config: EnvConfig };

/**
 * Facts → EnvConfig → env_configs row.
 *
 * Units are converted (every `*_cm` FactKey becomes metres), values are clamped
 * to physically plausible bounds, and the geometry is made self-consistent:
 *  · the crop root zone must leave the furrow drivable
 *    (row_spacing/2 - body_radius - 2 cm), otherwise trampling is unavoidable
 *    and the policy learns to freeze;
 *  · the canopy cannot exceed the root zone or half the in-row spacing;
 *  · `length_m` is derived so one full sweep of every row fits inside
 *    episode_steps at max speed with slack, AND so the tool's swath can cover
 *    the bed at least MIN_COVERAGE_HEADROOM times over — an episode in which
 *    60-70% removal is arithmetically impossible teaches nothing good, and
 *    measurement showed the policy pinned against exactly that ceiling.
 */
export async function buildEnvConfig(opts: {
  missionId: string;
  taskSpec: TaskSpec;
  facts: FactLike[];
  perceptionModelId?: string | null;
  onEvent?: EventSink;
}): Promise<BuiltEnvConfig> {
  const { missionId, taskSpec, facts, perceptionModelId } = opts;
  const list = facts ?? [];

  const rowSpacing = sourced(list, "row_spacing_cm", "row_spacing_m");
  const inRow = sourced(list, "in_row_spacing_cm", "in_row_spacing_m");
  let cropRadius = sourced(list, "crop_canopy_radius_cm", "crop_radius_m");
  let rootZone = sourced(list, "crop_root_zone_radius_cm", "root_zone_radius_m");
  const density = sourced(list, "weed_density_per_m2", "weed_density_per_m2");
  const weedRadius = sourced(list, "weed_radius_cm_at_stage", "weed_radius_m");

  const rsMid = mid(rowSpacing);

  // rows: from bed width when a source gave one, else the 3-row default bed.
  let rows = 3;
  const bed = pickFact(list, "bed_width_cm");
  if (bed) {
    const raw = factNumber(bed.value);
    if (raw !== null) {
      const bedM = (typeof raw === "number" ? raw : (raw[0] + raw[1]) / 2) *
        unitScale("bed_width_cm", bed.unit);
      rows = clamp(Math.round(bedM / Math.max(0.05, rsMid)), 2, 6);
    }
  }

  // The rover must be able to sit in the furrow without standing on a crown.
  const maxRoot = Math.max(0.03, rsMid / 2 - ROVER.body_radius_m - 0.02);
  rootZone = retighten(rootZone, BOUNDS.root_zone_radius_m[0], maxRoot);
  // The canopy is capped by HALF THE IN-ROW SPACING (neighbouring plants must
  // not overlap), NOT by the root zone. Tying it to the root zone was wrong in
  // both directions: a strawberry's canopy is far wider than its crown no-go
  // radius, and the 0.08 m root zone was squashing crops to 4 cm blobs that
  // rendered as almost nothing next to the weeds.
  cropRadius = retighten(
    cropRadius,
    BOUNDS.crop_radius_m[0],
    Math.max(BOUNDS.crop_radius_m[0], Math.min(0.5 * mid(inRow), BOUNDS.crop_radius_m[1])),
  );

  // Weed size must match the growth stage the farmer asked about. A scraped
  // fact like "branches can be up to 2 feet" describes a MATURE plant; when the
  // TaskSpec targets seedlings, that number models the wrong plant entirely
  // (and made weeds render larger than the crop they grow between).
  const stageHint = `${taskSpec.target.stage_hint ?? ""}`.toLowerCase();
  const matureStage = /mature|flowering|seed set|bolting|full.?grown|established/.test(stageHint);
  // Default to the EARLY stage, because that is when selective weeding happens
  // and it is what the whole task is about. Scraped radius facts routinely
  // describe mature plants ("branches up to 2 feet"), which produced 0.15 m
  // weeds towering over 0.10 m strawberries — physically wrong for the job and
  // visually wrong in the arena. Only an explicit mature hint lifts the cap.
  const weedRadiusCapped = matureStage
    ? weedRadius
    : retighten(weedRadius, BOUNDS.weed_radius_m[0], 0.06);

  // Derive bed length from the travel budget: episode_steps * dt * max_speed,
  // minus the cross-row turns, at 80% utilisation so the policy has slack.
  const travelBudget = EPISODE_STEPS * DT * ROVER.max_speed_mps;
  const turnCost = Math.max(0, rows - 1) * rsMid;
  const travelLength = (0.8 * travelBudget - turnCost) / Math.max(1, rows);

  // ...but do NOT let the field grow to re-absorb the new travel budget. The
  // point of the faster, wider rover is higher achievable coverage, so the bed
  // is also capped by the headroom rule
  //   coverable = travelBudget * (2 * reach)  >=  HEADROOM * length * rows * row_spacing
  // solved for length. Floored (not rounded) to the half metre so rounding
  // cannot push the headroom back under the bar.
  const coverableArea = travelBudget * 2 * ROVER.reach_m;
  const headroomLength = coverableArea /
    (MIN_COVERAGE_HEADROOM * Math.max(1, rows) * Math.max(0.05, rsMid));
  const lengthM = clamp(
    Math.floor(Math.min(travelLength, headroomLength) * 2) / 2,
    4,   // below 4 m a "bed" stops being an agronomically meaningful pass …
    12,  // … and above 12 m the episode is a sweep, not a weeding decision
  );
  // Reported, not assumed: a very wide multi-row bed can hit the 4 m floor
  // before the headroom rule is satisfied, and the audit trail should say so.
  const coverageHeadroom = coverableArea /
    Math.max(0.01, lengthM * Math.max(1, rows) * Math.max(0.05, rsMid));

  const config = EnvConfig.parse({
    obs_version: 1,
    field: {
      length_m: lengthM,
      rows,
      row_spacing_m: rowSpacing,
      in_row_spacing_m: inRow,
      crop_radius_m: cropRadius,
      root_zone_radius_m: rootZone,
      weed_density_per_m2: density,
      weed_radius_m: weedRadiusCapped,
    },
    rover: { ...ROVER },
    perception: perceptionModelId
      ? { mode: "pool", perception_model_id: perceptionModelId }
      : { mode: "uninformative" },
    episode_steps: EPISODE_STEPS,
    dt: DT,
    randomize: {
      // A tighter crop template deserves less jitter, or crops land on crops.
      spacing_jitter: clamp(0.15 * (mid(inRow) / FALLBACK.in_row_spacing_m), 0.05, 0.2),
      missing_crop_prob: 0.05,
    },
  });

  // The invariant, asserted rather than assumed.
  const cited: string[] = [];
  const guessed: string[] = [];
  for (const [k, v] of Object.entries(config.field)) {
    if (typeof v === "number") continue; // length_m / rows: layout, not agronomy
    const s = v as Sourced;
    if (s.fact_id) cited.push(k);
    else if (s.assumed === true) guessed.push(k);
    else throw new Error(`env_config.field.${k} carries neither fact_id nor assumed:true`);
  }

  const id = newId("env_config");
  await db.insert(schema.envConfigs).values({ id, missionId, config });
  void taskSpec; // the template only changes labels, not geometry (§2.1)

  await opts.onEvent?.({
    agent: "architect",
    kind: "decision",
    title:
      `Environment built for ${taskSpec.crop}: ${cited.length} of ${cited.length + guessed.length} ` +
      `numbers from sources, ${guessed.length} assumed — ${config.field.rows} rows x ${config.field.length_m} m, ` +
      `${coverageHeadroom.toFixed(1)}x coverage headroom`,
    payload: {
      cited,
      assumed: guessed,
      config,
      coverage: {
        travel_budget_m: Number(travelBudget.toFixed(2)),
        swath_m: Number((2 * ROVER.reach_m).toFixed(3)),
        coverable_area_m2: Number(coverableArea.toFixed(2)),
        bed_area_m2: Number((lengthM * rows * rsMid).toFixed(2)),
        headroom_x: Number(coverageHeadroom.toFixed(2)),
        headroom_target_x: MIN_COVERAGE_HEADROOM,
      },
    },
    refTable: "env_configs",
    refId: id,
  });

  return { id, config };
}

/* ────────────────────────────────────────────────────────────────────────
 * Reward writing
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * The reward contract and the hard-won design rules, verbatim in the prompt.
 * Exported so the UI and tests can show exactly what the Architect was told.
 */
export const REWARD_SYSTEM_PROMPT = `You are Furrow's Architect. You write the step reward for a PPO policy that drives a small weeding rover down crop rows in a 2.5D simulator (FieldGym).

OUTPUT CONTRACT — your code is executed as-is inside a locked-down sandbox namespace:
 * Define exactly one top-level function: \`def reward(info):\`.
 * It returns \`(float, dict)\`: the scalar step reward, and a dict of named components (name -> float) used for diagnostics. Both are required.
 * The ONLY names available are \`math\`, \`np\` (numpy) and the \`info\` argument, plus these builtins: abs min max sum len round float int bool pow range enumerate zip sorted any all.
 * NO import statements anywhere, not even inside the function. No I/O, no print, no open, no eval/exec, no getattr, no globals, no module-level state, no randomness. The word "import" anywhere in the source is an automatic rejection.
 * Pure and fast: it is called once per simulator step, millions of times. Scalar arithmetic only — do not allocate numpy arrays or loop over plants.

THE info DICT — read ONLY these keys:
 t (int step index), dt (seconds), episode_steps (int),
 rover_speed (m/s, signed), rover_turn (heading rad), dist_to_row_center (m),
 acted (bool: the tool fired this step), removed_target (0/1 weed removed),
 removed_protect (0/1 CROP removed — the severe failure),
 trampled_protect (int crops newly driven over this step),
 miss (bool: fired with nothing in reach),
 nearest_target_dist (m to the nearest live weed, 99.0 when none remain),
 nearest_protect_dist (m to the nearest live crop, 99.0 when none remain),
 targets_remaining (int), targets_total (int), protect_total (int), done (bool).
There are no other keys. Never read "episode_summary" or "components" — they do not exist yet when the reward is called. Guard the distance fields with \`if d < 50.0\` because 99.0 is the "nothing left" sentinel. Guard every division with max(1, ...).

VALIDATION — dry_run executes 1,000 random-action steps over 3 seeds and REJECTS your code if it: raises, returns NaN or inf, has |mean| > 100, has std < 1e-6 (a constant reward), or costs more than 2 ms per call. Keep event magnitudes near 1.0 and per-step shaping at or below 0.05 so the mean stays small.

REWARD DESIGN — this is measured knowledge from a real run, not theory. Follow it:
 1. AN ANTI-IDLE TERM IS MANDATORY. A reward that mostly punishes damage teaches the policy to freeze: in a real measured run target_removal_rate collapsed to 0.05 while protect_damage_rate fell toward 0 — a perfectly safe rover that does nothing. Always include a small per-step cost proportional to the work remaining, e.g. \`-c * info["targets_remaining"] / max(1, info["targets_total"])\` with c around 0.005 to 0.02. Doing nothing must be strictly worse than working.
 2. PULLING A WEED MUST OUT-EARN STANDING STILL BY A WIDE MARGIN. removed_target should pay about +1.0 while a step of idling costs about 0.01.
 3. CROP DAMAGE IS WEIGHTED 1.5x TO 2x THE WEED REWARD — NOT 10x. Over-penalising damage is exactly what caused the freeze. removed_protect is the severe case (about 1.5-2.0); trampled_protect is milder (about 0.5-0.6 of removed_protect). Note a crop that is trampled and later removed counts as ONE damaged crop in the metric, so do not stack huge penalties for the same plant.
 4. A MISS COSTS 0.1 TO 0.15 — bigger than it sounds, and this is measured, not cautious. With a 0.05 miss penalty the trained policy learned to spray-fire: it removed 18% more weeds than the baseline at identical crop damage (removal 0.340 -> 0.401, damage 0.400 -> 0.403) but fired so indiscriminately that act_precision FELL from 0.395 to 0.265, because misses dominate that metric's denominator. Firing into empty soil costs real time, water and wear, so price it at 0.1-0.15 — about a tenth of a weed. Still keep it well under the +1.0 removal payoff: a miss must be a bad trade, never a reason to stop firing. If you also use the anti-idle term from rule 1, the policy cannot answer a miss penalty by freezing — idling has to stay strictly worse than trying.
 4b. SCALE THE WEED PAYOFF BY HOW CONFIDENT THE SHOT IS. The policy's observation carries a per-plant perception probability (p_target), and a shot at a low-p_target plant is worth less: it is likelier to be a crop or empty soil. The info dict above does NOT expose that probability, and inventing a key raises KeyError inside the reward — which the simulator swallows as a zero reward and dry_run then rejects, so NEVER read a key that is not listed. Express the same idea with the evidence you do have: weight the removal payoff and any approach shaping by a bounded confidence factor built from \`info["nearest_target_dist"]\` against the rover's reach (given in the mission prompt) — full price when a weed is plainly inside reach, a fraction of it when the nearest weed is far or the 99.0 "none left" sentinel is showing. A fire with no weed within reach is not a confident shot; it is the miss in rule 4. One caveat so you do not corrupt the outcome payoff: on the step a weed dies, \`nearest_target_dist\` already measures the NEXT weed, so apply the confidence factor to the approach and firing-discipline terms rather than multiplying it straight into \`removed_target\`, whose outcome is certain.
 5. Dense shaping is allowed and helps, but keep each shaping term at or below 0.05 per step so it cannot be farmed instead of weeding. Good shaping: a bounded approach term on nearest_target_dist such as \`c * math.exp(-d / 0.5)\`, a small penalty on dist_to_row_center, a small forward-progress term on rover_speed.
 6. Do NOT reward \`acted\` on its own — firing at everything is the base policy's bad habit. Reward the OUTCOME (removed_target), not the attempt.
 7. The policy is judged by score = target_removal_rate - W * protect_damage_rate - 0.1 * (steps_used / episode_steps), with W near 2. Your reward must be a dense, shaped proxy for exactly that statistic, including its mild time cost.

PRIVILEGE — the reward runs inside the simulator, so it MAY use the privileged true-class fields (removed_target vs removed_protect, nearest_target_dist, targets_remaining). The OBSERVATION the policy sees never contains a class label: only per-plant relative geometry, radius, an in-root-zone contact flag and a perception probability. So never assume the policy already knows which plant is a weed — the reward is what teaches that boundary.

Submit exactly two fields:
 "code": the Python source, no markdown fences, no commentary outside the code.
 "rationale": at most 60 words — the terms, the weights, and why.`;

/**
 * Deliberately FLAT and constraint-free: Vultr's models fill a two-string tool
 * schema reliably, and miss anything nested or defaulted. The real contract is
 * enforced afterwards — by `staticRewardIssue` here and by `dryRunReward` in
 * the sandbox, which is the only validation that actually counts.
 */
const RewardDraft = z.object({
  code: z.string(),
  rationale: z.string(),
});

/** Variant personalities, so N variants explore instead of converging. */
const VARIANT_HINTS = [
  "Variant A — balanced: event rewards dominate, light approach shaping, modest anti-idle cost.",
  "Variant B — forager: stronger bounded approach shaping on nearest_target_dist and a row-centre term, so the rover hunts weeds instead of drifting.",
  "Variant C — surgeon: emphasise precision — a slightly larger miss penalty and a crop-proximity caution term — while keeping the anti-idle cost strictly larger than the gain from stopping.",
  "Variant D — sweeper: emphasise throughput — a larger anti-idle cost proportional to targets_remaining plus a small forward-progress term — while holding the damage weight at 1.5-2x.",
] as const;

/** Mask anything secret-shaped before a sandbox log reaches a prompt or a row. */
function redact(s: string): string {
  return s
    .replace(/postgres(?:ql)?:\/\/[^\s'"]+/gi, "postgres://***")
    .replace(/\b([A-Z_]*(?:KEY|TOKEN|SECRET|PASSWORD|URL)[A-Z_]*)\s*=\s*'[^']*'/g, "$1='***'")
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, "***");
}

/** Strip fences/prose the model may wrap the code in. Text only — never run. */
function sanitizeRewardCode(raw: string): string {
  let code = raw.trim();
  const fence = /```(?:python|py)?\s*([\s\S]*?)```/i.exec(code);
  if (fence) code = fence[1];
  code = code.replace(/^\s*```[a-z]*\s*/i, "").replace(/```\s*$/i, "").trim();
  return code + "\n";
}

/** Cheap text checks that mirror reward_runtime.build_reward's fail-fast rules. */
function staticRewardIssue(code: string): string | null {
  if (!/\bdef\s+reward\s*\(/.test(code)) return "code must define a top-level `def reward(info):`";
  if (/\bimport\b/.test(code)) return "code must not contain the word `import`";
  if (/\b(open|eval|exec|__import__|globals|locals|getattr|setattr|print)\s*\(/.test(code)) {
    return "code must not call open/eval/exec/__import__/globals/locals/getattr/setattr/print";
  }
  if (/\breturn\b/.test(code) === false) return "reward(info) must return (float, dict)";
  return null;
}

/**
 * Hand-written fallback that satisfies every rule in the system prompt.
 * Used when the LLM is unconfigured or when 4 attempts all failed validation —
 * the mission must not die because a model had a bad minute. Still dry-run.
 */
function templateRewardCode(variant: number, damageWeight: number): string {
  const v = ((variant % 4) + 4) % 4;
  const wRemove = 1.0;
  const wDamage = clamp(damageWeight, 1.5, 2.0);
  const wTrample = Math.round(wDamage * 0.55 * 100) / 100;
  // Miss penalties sit in the measured 0.10-0.15 band (system prompt rule 4):
  // at 0.05 the trained policy spray-fired — removal 0.340 -> 0.401 at the same
  // crop damage, but act_precision 0.395 -> 0.265. Still << the +1.0 removal.
  const wMiss = [0.12, 0.10, 0.15, 0.10][v];
  const wApproach = [0.02, 0.04, 0.02, 0.015][v];
  const wIdle = [0.01, 0.008, 0.008, 0.02][v];
  const wRow = [0.01, 0.02, 0.01, 0.01][v];
  const wSpeed = [0.0, 0.0, 0.0, 0.01][v];
  const wCaution = [0.0, 0.0, 0.015, 0.0][v];
  return `def reward(info):
    """Furrow template reward (variant ${v}). Dense proxy for
    score = removal - ${wDamage}*damage - 0.1*(steps/episode_steps).

    Confidence (prompt rule 4b) rides on the approach term, not on
    removed_target: by the time a weed dies, nearest_target_dist already
    measures the NEXT weed, so weighting the payoff by it would price a
    certain outcome off a stale distance."""
    total_targets = max(1, info["targets_total"])
    frac_left = info["targets_remaining"] / total_targets

    removed = ${wRemove} * info["removed_target"]
    crop_loss = -${wDamage} * info["removed_protect"] - ${wTrample} * info["trampled_protect"]
    missed = -${wMiss} if info["miss"] else 0.0

    d_target = info["nearest_target_dist"]
    approach = ${wApproach} * math.exp(-d_target / 0.5) if d_target < 50.0 else 0.0

    d_crop = info["nearest_protect_dist"]
    caution = -${wCaution} * math.exp(-d_crop / 0.1) if (d_crop < 50.0 and ${wCaution} > 0.0) else 0.0

    row = -${wRow} * min(1.0, info["dist_to_row_center"])
    progress = ${wSpeed} * max(0.0, info["rover_speed"]) / ${ROVER.max_speed_mps}
    idle = -${wIdle} * frac_left

    comps = {
        "removed_target": removed,
        "crop_loss": crop_loss,
        "miss": missed,
        "approach": approach,
        "caution": caution,
        "row_align": row,
        "progress": progress,
        "idle": idle,
    }
    return float(removed + crop_loss + missed + approach + caution + row + progress + idle), comps
`;
}

function userPrompt(opts: {
  taskSpec: TaskSpec;
  envConfig: EnvConfig;
  generation: number;
  variant: number;
  reflection?: Reflection;
  damageWeight: number;
}): string {
  const { taskSpec, envConfig, generation, variant, reflection, damageWeight } = opts;
  const f = envConfig.field;
  const geom = [
    `rows=${f.rows}`,
    `length_m=${f.length_m}`,
    `row_spacing_m=${JSON.stringify(f.row_spacing_m.value)}`,
    `in_row_spacing_m=${JSON.stringify(f.in_row_spacing_m.value)}`,
    `crop_radius_m=${JSON.stringify(f.crop_radius_m.value)}`,
    `root_zone_radius_m=${JSON.stringify(f.root_zone_radius_m.value)}`,
    `weed_density_per_m2=${JSON.stringify(f.weed_density_per_m2.value)}`,
    `weed_radius_m=${JSON.stringify(f.weed_radius_m.value)}`,
  ].join(", ");

  const lines = [
    `MISSION: ${taskSpec.template} — protect ${taskSpec.crop} (${taskSpec.protect.names.join(", ")}), remove ${taskSpec.target.names.join(", ")}.`,
    `PRIORITIES (0..1): avoid_damage=${taskSpec.priorities.avoid_damage}, coverage=${taskSpec.priorities.coverage}, speed=${taskSpec.priorities.speed}.`,
    `The ranking statistic for this mission uses damage weight W=${damageWeight.toFixed(2)}; your crop-damage weight should sit near it (1.5-2x the weed reward), never far above.`,
    `FIELD: ${geom}.`,
    `ROVER: max_speed=${envConfig.rover.max_speed_mps} m/s, reach=${envConfig.rover.reach_m} m, body_radius=${envConfig.rover.body_radius_m} m, dt=${envConfig.dt} s, episode_steps=${envConfig.episode_steps}.`,
    `Roughly ${Math.round(mid(f.weed_density_per_m2) * f.length_m * mid(f.row_spacing_m) * f.rows)} weeds per episode, and ${Math.round((f.rows * f.length_m) / Math.max(0.05, mid(f.in_row_spacing_m)))} crops to protect.`,
    `GENERATION ${generation}, VARIANT ${variant}. ${VARIANT_HINTS[((variant % 4) + 4) % 4]}`,
  ];

  if (reflection) {
    lines.push(
      "",
      `JUDGE'S REFLECTION ON GENERATION ${reflection.generation} — fix these, do not repeat them:`,
      ...reflection.observations.slice(0, 8).map((o) => `  observed: ${o}`),
      ...reflection.suggestions.slice(0, 8).map((s) => `  suggested: ${s}`),
    );
    const stats = Object.entries(reflection.component_stats ?? {}).slice(0, 12);
    if (stats.length) {
      lines.push(`  measured: ${stats.map(([k, v]) => `${k}=${Number(v).toFixed(4)}`).join(", ")}`);
    }
  }

  lines.push(
    "",
    "Write the reward now. Submit `code` (the Python source) and `rationale`.",
  );
  return lines.join("\n");
}

/** score()'s damage weight for this mission (contracts.ts `score()`, W≈2). */
export function damageWeightFor(taskSpec?: Pick<TaskSpec, "priorities">): number {
  const a = taskSpec?.priorities?.avoid_damage ?? 0.9;
  return clamp((2.0 * a) / 0.9, 1.0, 3.0);
}

const MAX_RETRIES = 3; // 1 draft + 3 retries, each fed the previous dry-run error

/**
 * Ask the LLM for reward code, prove it in a sandbox, store it.
 *
 * `dryRunReward` is the only validator: it compiles and runs the code inside
 * Daytona (1,000 random-action steps over 3 seeds) and rejects NaN/inf,
 * |mean| > 100, constant rewards and anything slower than 2 ms/call. Its error
 * string is fed back verbatim (redacted) so the model can fix its own bug.
 */
export async function writeRewardSpec(opts: {
  missionId: string;
  generation: number;
  variant: number;
  taskSpec: TaskSpec;
  envConfig: EnvConfig;
  reflection?: Reflection;
  parentId?: string;
  onEvent?: EventSink;
}): Promise<RewardSpecRow> {
  const { missionId, generation, variant, taskSpec, envConfig, reflection, parentId, onEvent } = opts;
  const damageWeight = damageWeightFor(taskSpec);
  const prompt = userPrompt({ taskSpec, envConfig, generation, variant, reflection, damageWeight });

  type Attempt = { code: string; rationale: string; dry: Record<string, unknown>; llm: boolean };
  const attempts: Attempt[] = [];
  /** Rejections so far, appended to the prompt — `structured` is single-turn. */
  let feedback = "";

  if (llmConfigured()) {
    for (let i = 0; i <= MAX_RETRIES; i++) {
      let draft: { code: string; rationale: string };
      try {
        draft = await structured({
          schema: RewardDraft,
          name: "submit_reward_spec",
          description: "Submit the Python reward function and its rationale.",
          instructions: REWARD_SYSTEM_PROMPT,
          prompt: prompt + feedback,
        });
      } catch (err) {
        console.warn("[architect] reward draft failed:", redact((err as Error).message));
        break;
      }

      const code = sanitizeRewardCode(draft.code ?? "");
      const issue = staticRewardIssue(code);
      // `dry` is the ONLY execution of this code, and it happens in Daytona.
      const dry: Record<string, unknown> = issue
        ? { ok: false, error: issue }
        : await dryRunReward({ missionId, code, envConfig });

      const rationale = (draft.rationale ?? "").trim();

      if (dry.ok === true) {
        return await storeRewardSpec({
          missionId, generation, variant, parentId, code, rationale, dry, onEvent,
        });
      }

      const error = redact(String(dry.error ?? "rejected")).slice(0, 400);
      attempts.push({ code, rationale, dry, llm: true });
      console.warn(`[architect] dry_run rejected g${generation}v${variant} attempt ${i + 1}: ${error}`);
      await onEvent?.({
        agent: "architect",
        kind: "error",
        title: `Reward g${generation}v${variant} rejected by dry_run (attempt ${i + 1}): ${error}`,
        payload: { generation, variant, attempt: i + 1, dry_run: dry },
      });
      if (i === MAX_RETRIES) break;
      feedback +=
        `\n\n--- ATTEMPT ${i + 1} WAS REJECTED ---\nYou previously submitted:\n${code}\n` +
        `dry_run REJECTED it: ${error}\n` +
        "Fix that cause and submit different code. Reminders: no `import`; return " +
        "(float, dict); guard distances with `if d < 50.0`; guard every division with " +
        "max(1, ...); keep |mean| under 100 and the reward non-constant (it must vary " +
        "step to step); keep it under 2 ms per call; keep the mandatory anti-idle term.";
    }
  }

  // Fallback: the hand-written template. Still validated in the sandbox.
  const code = templateRewardCode(variant, damageWeight);
  const dry = await dryRunReward({ missionId, code, envConfig });
  if (dry.ok === true) {
    const why = attempts.length
      ? `LLM reward failed dry_run ${attempts.length}x (last: ${redact(String(attempts[attempts.length - 1].dry.error ?? "")).slice(0, 160)}); fell back to the audited template reward.`
      : "Audited template reward: outcome-paid removal, crop damage at " +
        `${clamp(damageWeight, 1.5, 2.0).toFixed(2)}x, miss priced in the measured 0.10-0.15 band ` +
        "so firing stays disciplined, bounded approach shaping, " +
        "and a per-step anti-idle cost proportional to targets_remaining.";
    return await storeRewardSpec({
      missionId, generation, variant, parentId, code, rationale: why, dry, onEvent,
    });
  }

  // Even the template failed (sandbox trouble): keep the evidence, fail loudly.
  const last = attempts[attempts.length - 1];
  const row = await storeRewardSpec({
    missionId, generation, variant, parentId,
    code: last?.code ?? code,
    rationale: `UNVALIDATED — dry_run never passed. ${redact(String(dry.error ?? "unknown")).slice(0, 200)}`,
    dry: { ...dry, template_also_failed: true },
  });
  throw Object.assign(
    new Error(`reward dry_run never passed for g${generation}v${variant}: ${redact(String(dry.error ?? "unknown")).slice(0, 200)}`),
    { rewardSpecId: row.id },
  );
}

async function storeRewardSpec(args: {
  missionId: string;
  generation: number;
  variant: number;
  parentId?: string;
  code: string;
  rationale: string;
  dry: Record<string, unknown>;
  onEvent?: EventSink;
}): Promise<RewardSpecRow> {
  const [row] = await db.insert(schema.rewardSpecs).values({
    id: newId("reward_spec"),
    missionId: args.missionId,
    generation: args.generation,
    variant: args.variant,
    parentId: args.parentId ?? null,
    code: args.code,
    rationale: args.rationale.slice(0, 2000),
    dryRun: args.dry,
  }).returning();

  const mean = typeof args.dry.mean === "number" ? args.dry.mean : null;
  await args.onEvent?.({
    agent: "architect",
    kind: "decision",
    title:
      `Reward g${args.generation}v${args.variant} passed dry_run` +
      (mean === null ? "" : ` (mean ${mean.toFixed(3)}/step)`) +
      ` — ${args.rationale.slice(0, 160)}`,
    payload: { generation: args.generation, variant: args.variant, dry_run: args.dry },
    refTable: "reward_specs",
    refId: row.id,
  });
  return row;
}
