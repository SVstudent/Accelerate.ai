/**
 * The Judge — fixed-seed evaluation, ranking, promotion, reflection, report.
 *
 * Everything the Judge says has to be defensible:
 *  · every policy is evaluated on the SAME EVAL_SEEDS (1000..1031), so the
 *    compare view shows the same fields for baseline and candidate;
 *  · ranking uses exactly one statistic, contracts.ts `score()`, with the
 *    damage weight scaled by taskSpec.priorities.avoid_damage;
 *  · the reflection is grounded in measured numbers, which are computed here
 *    and handed to the LLM — the model names causes, it does not invent data;
 *  · the field report may cite ONLY numbers taken from the evaluations and
 *    impact context from facts whose key is `impact_stat`. An invented impact
 *    number is a correctness bug, so generated text is screened for numeric
 *    tokens that are not on the allow-list, and the deterministic script is
 *    used if the model will not comply.
 */
import { z } from "zod";
import { and, desc, eq, inArray } from "drizzle-orm";
import { db, schema } from "@/db";
import { newId } from "@/lib/ids";
import {
  EvalMetrics,
  EVAL_SEEDS,
  Reflection,
  SandboxJob,
  score,
  type EnvConfig,
  type TaskSpec,
} from "@/lib/contracts";
import { runEval } from "@/mastra/tools/daytona";
import { llmConfigured, structured } from "@/mastra/tools/llm";

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * An impact fact as contracts.ts `Fact`, a raw `facts` row, or a row from
 * `impactFacts()` (which has already filtered key='impact_stat' in SQL and so
 * carries no `key` column).
 */
export type ImpactFactLike = {
  id?: string | null;
  key?: string | null;
  value?: unknown;
  unit?: string | null;
  quote?: string | null;
  domain?: string | null;
  url?: string | null;
};

/** score()'s damage weight for this mission. avoid_damage 0.9 → W = 2.0. */
export function damageWeightFor(taskSpec?: Pick<TaskSpec, "priorities">): number {
  const a = taskSpec?.priorities?.avoid_damage ?? 0.9;
  return clamp((2.0 * a) / 0.9, 1.0, 3.0);
}

/** Mask anything secret-shaped before a sandbox log lands in an error or a row. */
function redact(s: string): string {
  return s
    .replace(/postgres(?:ql)?:\/\/[^\s'"]+/gi, "postgres://***")
    .replace(/\b([A-Z_]*(?:KEY|TOKEN|SECRET|PASSWORD|URL)[A-Z_]*)\s*=\s*'[^']*'/g, "$1='***'")
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, "***");
}

/**
 * The episode length the scores were produced at, read from the env_config the
 * runs actually used (falling back to the newest one for the mission, then to
 * EnvConfig's default). It only matters for the time term of `score()`.
 */
async function episodeStepsFor(missionId: string, envConfigId?: string | null): Promise<number> {
  const rows = envConfigId
    ? await db.select().from(schema.envConfigs).where(eq(schema.envConfigs.id, envConfigId)).limit(1)
    : await db.select().from(schema.envConfigs)
      .where(eq(schema.envConfigs.missionId, missionId))
      .orderBy(desc(schema.envConfigs.createdAt)).limit(1);
  const cfg = rows[0]?.config as { episode_steps?: unknown } | undefined;
  const n = Number(cfg?.episode_steps);
  return Number.isFinite(n) && n > 0 ? n : 400;
}

/**
 * `score()` is linear in its three inputs, so the mean of per-episode scores
 * equals the score of the means — re-weighting the aggregate is exact.
 * (ci95 is left as measured; it was computed at the trainer's W = 2.)
 */
function rescore(m: EvalMetrics, episodeSteps: number, damageWeight: number): EvalMetrics {
  if (Math.abs(damageWeight - 2.0) < 1e-9) return m;
  const mean = score(
    {
      target_removal_rate: m.target_removal_rate.mean,
      protect_damage_rate: m.protect_damage_rate.mean,
      steps_used: m.steps_used.mean,
    },
    episodeSteps,
    damageWeight,
  );
  return { ...m, score: { mean: Number(mean.toFixed(5)), ci95: m.score.ci95 } };
}

export type PolicyEvaluation = EvalMetrics & { evaluation_id: string };

/**
 * Run one policy over EVAL_SEEDS in a sandbox and record the evaluations row.
 *
 * trainer/evaluate.py already inserts the row when it is given FURROW_POLICY_ID
 * and FURROW_ENV_CONFIG_ID (it prints `[eval] evaluation evl_…`). We reuse that
 * id when it appears in the log rather than writing a duplicate; otherwise we
 * insert the row here.
 */
export async function evaluatePolicy(opts: {
  missionId: string;
  policyId: string;
  envConfigId: string;
  envConfig: EnvConfig;
  perceptionModelId?: string | null;
  poolArtifactId?: string | null;
  policyArtifactId?: string | null;
  kind: "baseline" | "candidate";
  runId?: string;
  phase?: "train" | "test";
  taskSpec?: TaskSpec;
}): Promise<PolicyEvaluation> {
  const {
    missionId, policyId, envConfigId, envConfig, perceptionModelId,
    poolArtifactId, policyArtifactId, kind, runId, phase, taskSpec,
  } = opts;

  const job = SandboxJob.parse({
    job: "eval",
    mission_id: missionId,
    run_id: runId,
    init_policy_artifact_id: policyArtifactId ?? undefined,
    env_config: envConfig,
    perception_pool_artifact_id: poolArtifactId ?? undefined,
    eval_seeds: EVAL_SEEDS,
  });

  const { log, metrics } = await runEval({
    missionId,
    job,
    kind,
    policyId,
    envConfigId,
    perceptionModelId: perceptionModelId ?? undefined,
    phase,
  });

  if (!metrics) {
    throw new Error(
      `eval produced no metrics for ${policyId}: ${redact(log).slice(-400)}`,
    );
  }

  const parsed = rescore(
    EvalMetrics.parse(metrics),
    envConfig.episode_steps,
    damageWeightFor(taskSpec),
  );

  const fromSandbox = /evaluation\s+(evl_[A-Za-z0-9_-]+)/.exec(log)?.[1];
  let evaluationId = fromSandbox ?? "";
  if (evaluationId) {
    // The sandbox already wrote the row, at the trainer's default damage
    // weight. If this mission ranks at a different W, store the mission's
    // numbers so the row and the ranking never disagree.
    if (parsed.score.mean !== EvalMetrics.parse(metrics).score.mean) {
      await db.update(schema.evaluations)
        .set({ metrics: parsed })
        .where(eq(schema.evaluations.id, evaluationId));
    }
  } else {
    evaluationId = newId("evaluation");
    await db.insert(schema.evaluations).values({
      id: evaluationId,
      missionId,
      policyId,
      envConfigId,
      perceptionModelId: perceptionModelId ?? null,
      seeds: EVAL_SEEDS,
      metrics: parsed,
      isBaseline: kind === "baseline",
    });
  }

  if (kind === "baseline") {
    await db.update(schema.missions)
      .set({ baselineEvalId: evaluationId, updatedAt: new Date() })
      .where(eq(schema.missions.id, missionId));
  }

  return { ...parsed, evaluation_id: evaluationId };
}

/* ────────────────────────────────────────────────────────────────────────
 * Ranking and promotion
 * ──────────────────────────────────────────────────────────────────────── */

export type RunCandidate = {
  runId: string;
  variant?: number;
  /** Leave out and the Judge reads the latest candidate evaluation instead. */
  metrics?: EvalMetrics | null;
  resultPolicyId?: string | null;
  /** Alias accepted for callers that already know the evaluated policy. */
  policyId?: string | null;
  policyArtifactId?: string | null;
  status?: string | null;
};

export type Ranked = { run_id: string; score: number };

const UNFINISHED = new Set(["queued", "running", "failed", "cancelled", "killed"]);

/**
 * Rank the generation's finished runs by EvalMetrics.score.mean and promote
 * the winner: a `policies` row with kind 'promoted' pointing at the winning
 * checkpoint, and missions.best_policy_id updated to it.
 *
 * `runs` may be bare run ids — anything missing (status, result policy,
 * artifact, metrics) is read from the database.
 */
export async function rankAndPromote(opts: {
  missionId: string;
  generation: number;
  runs: (RunCandidate | string)[];
  taskSpec?: TaskSpec;
}): Promise<{ bestRunId: string; ranking: Ranked[]; promotedPolicyId: string | null }> {
  const { missionId, generation, taskSpec } = opts;
  const cands: RunCandidate[] = (opts.runs ?? []).map((r) =>
    typeof r === "string" ? { runId: r } : r);
  if (!cands.length) throw new Error(`rankAndPromote: no runs for generation ${generation}`);

  const runRows = await db.select().from(schema.runs)
    .where(and(eq(schema.runs.missionId, missionId), eq(schema.runs.generation, generation)));
  const byId = new Map(runRows.map((r) => [r.id, r]));

  // Fill in the result policy / status we were not handed.
  const resolved = cands.map((c) => {
    const row = byId.get(c.runId);
    return {
      ...c,
      variant: c.variant ?? row?.variant,
      status: c.status ?? row?.status ?? null,
      resultPolicyId: c.resultPolicyId ?? c.policyId ?? row?.resultPolicyId ?? null,
    };
  });

  // Policies → artifacts, and the latest candidate evaluation per policy.
  const policyIds = resolved.map((r) => r.resultPolicyId).filter((v): v is string => !!v);
  const policyRows = policyIds.length
    ? await db.select().from(schema.policies).where(inArray(schema.policies.id, policyIds))
    : [];
  const artifactOf = new Map(policyRows.map((p) => [p.id, p.artifactId]));

  const evalRows = policyIds.length
    ? await db.select().from(schema.evaluations)
      .where(and(
        eq(schema.evaluations.missionId, missionId),
        inArray(schema.evaluations.policyId, policyIds),
      ))
    : [];
  const metricsOf = new Map<string, EvalMetrics>();
  for (const e of evalRows) {
    if (e.isBaseline) continue;
    const parsed = EvalMetrics.safeParse(e.metrics);
    if (parsed.success) metricsOf.set(e.policyId, parsed.data); // later rows win
  }

  const episodeSteps = await episodeStepsFor(missionId, runRows[0]?.envConfigId);
  const w = damageWeightFor(taskSpec);

  const scored: { runId: string; score: number; metrics: EvalMetrics; artifactId?: string;
    policyId?: string | null; variant?: number }[] = [];
  for (const r of resolved) {
    const metrics = r.metrics
      ?? (r.resultPolicyId ? metricsOf.get(r.resultPolicyId) : undefined);
    if (!metrics) continue;                                   // never evaluated
    if (r.status && UNFINISHED.has(r.status)) continue;        // not a finished run
    const m = rescore(metrics, episodeSteps, w);
    scored.push({
      runId: r.runId,
      score: m.score.mean,
      metrics: m,
      artifactId: r.policyArtifactId
        ?? (r.resultPolicyId ? artifactOf.get(r.resultPolicyId) : undefined)
        ?? undefined,
      policyId: r.resultPolicyId,
      variant: r.variant,
    });
  }

  if (!scored.length) {
    throw new Error(`rankAndPromote: no finished, evaluated runs in generation ${generation}`);
  }

  scored.sort((a, b) => b.score - a.score);
  const ranking: Ranked[] = scored.map((s) => ({ run_id: s.runId, score: s.score }));
  const winner = scored[0];

  let promotedPolicyId: string | null = null;
  if (winner.artifactId) {
    promotedPolicyId = newId("policy");
    await db.insert(schema.policies).values({
      id: promotedPolicyId,
      name: `gen${generation} winner (${winner.runId})`,
      kind: "promoted",
      missionId,
      parentId: winner.policyId ?? null,
      obsVersion: 1,
      artifactId: winner.artifactId,
    });
  } else {
    // No artifact to re-point at: promote the run's own result policy.
    promotedPolicyId = winner.policyId ?? null;
  }

  if (promotedPolicyId) {
    await db.update(schema.missions)
      .set({ bestPolicyId: promotedPolicyId, updatedAt: new Date() })
      .where(eq(schema.missions.id, missionId));
  }

  return { bestRunId: winner.runId, ranking, promotedPolicyId };
}

/* ────────────────────────────────────────────────────────────────────────
 * Reflection
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * FLAT on purpose — two plain strings, one item per line. Vultr's models fill
 * this reliably where arrays-of-constrained-strings made them miss the schema.
 * The strict Reflection contract is assembled from it in code below.
 */
const ReflectionDraft = z.object({
  observations: z.string(),
  suggestions: z.string(),
});

/** "one per line" → a capped, trimmed list. Tolerates bullets and numbering. */
function toLines(raw: string | undefined, max: number): string[] {
  return (raw ?? "")
    .split(/\r?\n+/)
    .map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").trim())
    .filter((l) => l.length >= 4)
    .slice(0, max)
    .map((l) => l.slice(0, 240));
}

const REFLECTION_SYSTEM = `You are Accelerate.ai's Judge. You have just ranked one generation of reward-function variants for a weeding-rover policy, and the Architect will read your notes to write the next generation's rewards.

You are given measured numbers only. Say WHY each variant did what it did, in terms of the reward that produced it. Be concrete and short.

What the numbers mean:
 target_removal_rate — fraction of weeds removed (higher is better).
 protect_damage_rate — fraction of crops removed or trampled (lower is better).
 act_precision — of all tool firings, the fraction that hit a weed.
 steps_frac — episode length used; 1.0 means it never finished the bed.
 score = removal - W*damage - 0.1*steps_frac, the single ranking statistic.

The failure mode to name explicitly when you see it: a variant with
removal near 0 and damage near 0 did not get "safe" — it STOPPED ACTING. That is
the idle collapse, caused by punishing damage far harder than the reward for
pulling a weed, or by too weak a per-step cost on the work remaining. Name the
variant: for example "variant 2 stopped acting entirely (removal 0.04, 3 firings)".
Other patterns worth naming: high removal with high damage (the reward paid for
acting, not for the outcome); low act_precision (firing at crops or at nothing);
steps_frac 1.0 with low removal (wandering rather than working).

Suggestions must be concrete reward edits the Architect can apply: which term,
which direction, roughly what magnitude. Never suggest raising the crop-damage
weight above about 2x the weed reward — that is what causes the idle collapse.

Submit two fields, each a plain string holding ONE ITEM PER LINE, at most six
lines each: "observations" and "suggestions". No bullets, no numbering, no
markdown, no preamble.`;

type EvalInput = Record<string, EvalMetrics> | { runId: string; metrics: EvalMetrics }[];

function normalizeEvals(evals: EvalInput): Map<string, EvalMetrics> {
  const out = new Map<string, EvalMetrics>();
  if (Array.isArray(evals)) {
    for (const e of evals) if (e?.runId && e.metrics) out.set(e.runId, e.metrics);
  } else {
    for (const [k, v] of Object.entries(evals ?? {})) if (v) out.set(k, v);
  }
  return out;
}

/**
 * The Reflection object (contracts.ts §2.7), stored as an agent_events row of
 * kind 'decision'. The numbers in `component_stats` are computed here; the LLM
 * only supplies the prose, and gets the deterministic fallback if unavailable.
 */
export async function writeReflection(opts: {
  missionId: string;
  generation: number;
  ranking: { run_id?: string; runId?: string; score: number }[];
  evals: EvalInput;
}): Promise<Reflection> {
  const { missionId, generation } = opts;
  const ranking: Ranked[] = (opts.ranking ?? [])
    .map((r) => ({ run_id: r.run_id ?? r.runId ?? "", score: Number(r.score) }))
    .filter((r) => r.run_id);
  if (!ranking.length) throw new Error(`writeReflection: empty ranking for generation ${generation}`);

  const evals = normalizeEvals(opts.evals);
  const bestRunId = ranking[0].run_id;

  // variant numbers make the prose readable ("variant 2 stopped acting")
  const runRows = ranking.length
    ? await db.select().from(schema.runs).where(inArray(schema.runs.id, ranking.map((r) => r.run_id)))
    : [];
  const variantOf = new Map(runRows.map((r) => [r.id, r.variant]));
  const episodeSteps = await episodeStepsFor(missionId, runRows[0]?.envConfigId);

  const rows = ranking.map((r) => {
    const m = evals.get(r.run_id);
    const stepsFrac = m ? m.steps_used.mean / episodeSteps : null;
    const idle = !!m && m.target_removal_rate.mean < 0.1 && (m.policy_acts ?? 0) < 20;
    return {
      run_id: r.run_id,
      variant: variantOf.get(r.run_id) ?? null,
      score: Number(r.score.toFixed(4)),
      removal: m ? Number(m.target_removal_rate.mean.toFixed(4)) : null,
      damage: m ? Number(m.protect_damage_rate.mean.toFixed(4)) : null,
      trample: m ? Number(m.trample_rate.mean.toFixed(4)) : null,
      act_precision: m ? Number(m.act_precision.mean.toFixed(4)) : null,
      steps_frac: stepsFrac === null ? null : Number(Math.min(1, stepsFrac).toFixed(3)),
      policy_acts: m?.policy_acts ?? null,
      idle_collapse: idle,
    };
  });

  const withM = rows.filter((r) => r.removal !== null);
  const avg = (pick: (r: typeof rows[number]) => number | null) => {
    const vals = withM.map(pick).filter((v): v is number => v !== null);
    return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
  };
  const component_stats: Record<string, number> = {
    variants_evaluated: withM.length,
    removal_mean: Number(avg((r) => r.removal).toFixed(4)),
    damage_mean: Number(avg((r) => r.damage).toFixed(4)),
    act_precision_mean: Number(avg((r) => r.act_precision).toFixed(4)),
    steps_frac_mean: Number(avg((r) => r.steps_frac).toFixed(4)),
    best_score: Number(ranking[0].score.toFixed(4)),
    worst_score: Number(ranking[ranking.length - 1].score.toFixed(4)),
    score_spread: Number((ranking[0].score - ranking[ranking.length - 1].score).toFixed(4)),
    idle_collapsed_variants: rows.filter((r) => r.idle_collapse).length,
  };

  // Reward components measured in this generation's dry runs, when present.
  const specs = await db.select().from(schema.rewardSpecs).where(and(
    eq(schema.rewardSpecs.missionId, missionId),
    eq(schema.rewardSpecs.generation, generation),
  ));
  const compSums = new Map<string, { sum: number; n: number }>();
  for (const s of specs) {
    const dry = s.dryRun as { components?: Record<string, unknown> } | null;
    for (const [k, v] of Object.entries(dry?.components ?? {})) {
      if (typeof v !== "number" || !Number.isFinite(v)) continue;
      const cur = compSums.get(k) ?? { sum: 0, n: 0 };
      compSums.set(k, { sum: cur.sum + v, n: cur.n + 1 });
    }
  }
  for (const [k, { sum, n }] of compSums) {
    component_stats[`dry_${k}`] = Number((sum / Math.max(1, n)).toFixed(6));
  }

  let observations: string[] = [];
  let suggestions: string[] = [];

  if (llmConfigured()) {
    try {
      const draft = await structured({
        schema: ReflectionDraft,
        name: "submit_reflection",
        description: "Submit the generation's observations and suggestions.",
        instructions: REFLECTION_SYSTEM,
        prompt:
          `GENERATION ${generation}, ranked best first:\n` +
          JSON.stringify(rows, null, 1) +
          `\n\nAggregates: ${JSON.stringify(component_stats)}\n\n` +
          "Write the observations and suggestions, one per line in each field.",
      });
      observations = toLines(draft.observations, 6);
      suggestions = toLines(draft.suggestions, 6);
      if (!observations.length || !suggestions.length) {
        observations = [];
        suggestions = [];
        console.warn("[judge] reflection draft was empty; using the measured fallback");
      }
    } catch (err) {
      console.warn("[judge] reflection LLM failed:", redact((err as Error).message));
    }
  }

  if (!observations.length) {
    // Deterministic fallback — the same facts, stated plainly.
    for (const r of rows) {
      const label = `variant ${r.variant ?? "?"} (${r.run_id})`;
      if (r.removal === null) { observations.push(`${label} produced no evaluation.`); continue; }
      if (r.idle_collapse) {
        observations.push(
          `${label} stopped acting entirely — removal ${r.removal}, only ${r.policy_acts ?? 0} tool firings: the idle collapse.`,
        );
      } else if ((r.damage ?? 0) > 0.15) {
        observations.push(
          `${label} removed ${r.removal} of weeds but damaged ${r.damage} of crops — the reward paid for acting, not for the outcome.`,
        );
      } else if ((r.act_precision ?? 1) < 0.5) {
        observations.push(
          `${label} fired imprecisely (act_precision ${r.act_precision}) at removal ${r.removal}.`,
        );
      } else {
        observations.push(
          `${label} scored ${r.score} (removal ${r.removal}, damage ${r.damage}, steps_frac ${r.steps_frac}).`,
        );
      }
    }
    suggestions = [
      component_stats.idle_collapsed_variants > 0
        ? "Raise the per-step anti-idle cost (targets_remaining/targets_total) toward 0.02 and cut the crop-damage weight back to 1.5-1.8x the weed reward."
        : "Keep the crop-damage weight at 1.5-2x the weed reward; it is holding.",
      component_stats.removal_mean < 0.4
        ? "Strengthen the bounded approach term on nearest_target_dist (toward 0.04/step) so the rover finds weeds instead of drifting."
        : "Trim the approach shaping slightly; removal is adequate and the shaping can be farmed.",
      component_stats.act_precision_mean < 0.6
        ? "Nudge the miss penalty up to ~0.08 but no further, so firing stays worthwhile."
        : "Hold the miss penalty at ~0.05.",
    ];
  }

  const reflection = Reflection.parse({
    generation,
    ranking,
    best_run_id: bestRunId,
    observations,
    suggestions,
    component_stats,
  });

  await db.insert(schema.agentEvents).values({
    id: newId("event"),
    missionId,
    agent: "judge",
    kind: "decision",
    title: `Generation ${generation} ranked — ${bestRunId} wins at score ${ranking[0].score.toFixed(3)}`
      .slice(0, 300),
    payload: reflection,
    refTable: "runs",
    refId: bestRunId,
  });

  return reflection;
}

/* ────────────────────────────────────────────────────────────────────────
 * Field report
 * ──────────────────────────────────────────────────────────────────────── */

/** One flat string: the length and number rules are checked here, not by zod. */
const ReportDraft = z.object({ text: z.string() });

const REPORT_SYSTEM = `You are Accelerate.ai's Judge, writing a short field report for the grower who asked for this mission. It is shown to someone with no machine-learning background, so write plain prose: no markdown, no bullet points, no headings, no stage directions, no emoji, no numerals spelled as symbols.

Length: 55 to 100 words — 20 to 40 seconds of speech. Three or four sentences.

Shape: what was trained, what the trained rover now does versus the policy it started from, and the single clearest consequence for the grower.

THE RULES ABOUT NUMBERS ARE ABSOLUTE:
 * You may use ONLY the numbers in the MEASURED NUMBERS list, and only with the meaning given there.
 * You may use impact context ONLY from the IMPACT CONTEXT list, which comes from cited sources. Quote its numbers exactly as written.
 * If the IMPACT CONTEXT list is empty, say nothing at all about broader impact — no hectares, no litres, no costs, no percentages of anything.
 * Any key ending in _pct is a percentage. The crop_damage_per_weed_removed keys are a RATIO, not a percentage — crop damage divided by weeds removed, where lower is better. Say it as a ratio or leave it out; never call it a percentage, and never turn it into one.
 * NEVER estimate, extrapolate, round differently, convert units, or invent a number. No number may appear in your text that is not on one of the two lists (plain small counts of things, like "two policies", are fine).
 * Do not claim field deployment, regulatory approval, or savings that were not measured. This was measured in simulation; you may say so.

Write in the requested language. Submit a single field "text" holding the whole spoken script.`;

function fmtPct(x: number): string {
  return `${Math.round(x * 100)}`;
}

/** Every numeric token the report is allowed to contain. */
function allowedTokens(values: (number | string)[]): Set<string> {
  const out = new Set<string>();
  for (const v of values) {
    if (typeof v === "string") {
      for (const t of v.match(/\d+(?:[.,]\d+)?/g) ?? []) out.add(t.replace(",", "."));
      continue;
    }
    if (!Number.isFinite(v)) continue;
    out.add(String(v));
    out.add(v.toFixed(0));
    out.add(v.toFixed(1));
    out.add(v.toFixed(2));
    out.add(String(Math.round(v)));
  }
  return out;
}

function unknownNumbers(text: string, allowed: Set<string>): string[] {
  const toks = (text.match(/\d+(?:[.,]\d+)?/g) ?? []).map((t) => t.replace(",", "."));
  return toks.filter((t) => {
    if (allowed.has(t)) return false;
    const n = Number(t);
    // small plain counts ("two", "three policies", "32 seeds" is on the list)
    return !(Number.isInteger(n) && n >= 0 && n <= 12);
  });
}

/**
 * A 20-40 second spoken script in taskSpec.lang, citing only measured numbers
 * and only `impact_stat` facts for context. Stored as agent_events kind 'report'.
 */
export async function writeFieldReport(opts: {
  missionId: string;
  taskSpec: TaskSpec;
  /** EvalMetrics, or the raw `evaluations.metrics` jsonb for the base policy. */
  baseline?: unknown;
  /** EvalMetrics, or the raw `evaluations.metrics` jsonb for the winner. */
  best?: unknown;
  impactFacts?: ImpactFactLike[];
}): Promise<{ text: string }> {
  const { missionId, taskSpec } = opts;

  const bestParsed = EvalMetrics.safeParse(opts.best);
  if (!bestParsed.success) {
    throw new Error("writeFieldReport: no usable evaluation for the trained policy");
  }
  const best = bestParsed.data;
  // A missing baseline is survivable: report the trained policy on its own
  // rather than inventing a comparison.
  const baseParsed = EvalMetrics.safeParse(opts.baseline);
  const baseline = baseParsed.success ? baseParsed.data : null;
  if (!baseline) console.warn("[judge] field report has no baseline evaluation to compare against");

  // Only impact_stat facts may supply context. Rows that carry no `key` came
  // from the impactFacts() query, which already filtered on key='impact_stat';
  // anything else with a different key is dropped here, before the model sees it.
  const impact = (opts.impactFacts ?? [])
    .filter((f) => f.key === undefined || f.key === null || f.key === "impact_stat")
    .slice(0, 4)
    .map((f) => ({
      fact_id: f.id ?? null,
      statement: typeof f.value === "string" ? f.value : JSON.stringify(f.value ?? null),
      unit: f.unit ?? null,
      quote: f.quote ?? null,
      source: f.domain ?? f.url ?? null,
    }));

  const n = baseline ? Math.min(baseline.n_episodes, best.n_episodes) : best.n_episodes;
  const measured: Record<string, string | number | null> = {
    crop: taskSpec.crop,
    target: taskSpec.target.names[0] ?? "weeds",
    episodes_per_policy: n,
    trained_weeds_removed_pct: fmtPct(best.target_removal_rate.mean),
    trained_crops_damaged_pct: fmtPct(best.protect_damage_rate.mean),
    trained_act_precision_pct: fmtPct(best.act_precision.mean),
    trained_score: best.score.mean.toFixed(2),
    applications_avoided_pct: best.applications_avoided_pct === undefined
      ? null
      : fmtPct(best.applications_avoided_pct),
  };
  if (baseline) {
    measured.baseline_weeds_removed_pct = fmtPct(baseline.target_removal_rate.mean);
    measured.baseline_crops_damaged_pct = fmtPct(baseline.protect_damage_rate.mean);
    measured.baseline_score = baseline.score.mean.toFixed(2);
  }

  /**
   * Crop damage per weed removed (contracts.ts §6), lower is better. Only
   * reported when BOTH evaluations carry it, because the whole point of the
   * number is the before/after comparison — a one-sided ratio would be a
   * figure the grower cannot interpret. Evaluations written before the field
   * existed simply do not get this sentence; nothing is estimated to fill it.
   */
  const dpwr = baseline?.damage_per_weed_removed !== undefined &&
      best.damage_per_weed_removed !== undefined
    ? { base: baseline.damage_per_weed_removed, best: best.damage_per_weed_removed }
    : null;
  if (dpwr) {
    measured.baseline_crop_damage_per_weed_removed = dpwr.base.toFixed(2);
    measured.trained_crop_damage_per_weed_removed = dpwr.best.toFixed(2);
  }

  const allowed = allowedTokens([
    n,
    best.target_removal_rate.mean * 100, best.protect_damage_rate.mean * 100,
    best.act_precision.mean * 100, best.score.mean,
    ...(baseline ? [
      baseline.target_removal_rate.mean * 100, baseline.protect_damage_rate.mean * 100,
      baseline.act_precision.mean * 100, baseline.score.mean,
    ] : []),
    ...(best.applications_avoided_pct === undefined ? [] : [best.applications_avoided_pct * 100]),
    // the two ratios, so the guard accepts "1.18" / "1.00" when they are measured
    ...(dpwr ? [dpwr.base, dpwr.best] : []),
    ...impact.map((i) => `${i.statement} ${i.quote ?? ""}`),
  ]);

  const fallback = (() => {
    const parts = [
      `Field report. We trained a weeding rover in simulation for ${taskSpec.crop}, targeting ${measured.target}.`,
    ];
    if (baseline) {
      parts.push(
        `Across ${n} fixed evaluation seeds, the trained policy removed ${measured.trained_weeds_removed_pct} percent of weeds, against ${measured.baseline_weeds_removed_pct} percent for the policy it started from,`,
        `while crop damage went from ${measured.baseline_crops_damaged_pct} percent to ${measured.trained_crops_damaged_pct} percent.`,
        `Its mission score rose from ${measured.baseline_score} to ${measured.trained_score}.`,
      );
      if (dpwr) {
        parts.push(
          `Per weed removed, crop damage fell from ${measured.baseline_crop_damage_per_weed_removed} to ${measured.trained_crop_damage_per_weed_removed}.`,
        );
      }
    } else {
      parts.push(
        `Across ${n} fixed evaluation seeds, the trained policy removed ${measured.trained_weeds_removed_pct} percent of weeds while damaging ${measured.trained_crops_damaged_pct} percent of the crop,`,
        `for a mission score of ${measured.trained_score}.`,
      );
    }
    if (impact.length) {
      const q = impact[0].quote ?? impact[0].statement;
      parts.push(`For context, from a cited source: ${q}.`);
    }
    return parts.join(" ");
  })();

  let text = "";
  if (llmConfigured()) {
    const base = [
      `LANGUAGE: ${taskSpec.lang} (write the whole script in this language).`,
      `MISSION: ${taskSpec.template} — protect ${taskSpec.crop}, remove ${taskSpec.target.names.join(", ")}.`,
      "",
      "MEASURED NUMBERS (all from fixed-seed evaluations of two policies on the same fields):",
      JSON.stringify(measured, null, 1),
      "",
      `IMPACT CONTEXT (${impact.length} cited fact${impact.length === 1 ? "" : "s"}${impact.length ? "" : " — say nothing about broader impact"}):`,
      JSON.stringify(impact, null, 1),
      "",
      "Write the spoken script now.",
    ].join("\n");

    for (let attempt = 0; attempt < 2 && !text; attempt++) {
      try {
        const draft = await structured({
          schema: ReportDraft,
          name: "submit_field_report",
          description: "Submit the spoken field-report script.",
          instructions: REPORT_SYSTEM,
          prompt: attempt === 0
            ? base
            : base + "\n\nYour previous attempt used a number that is not on either list. " +
              "Rewrite it using ONLY the listed numbers, and drop any impact claim you cannot cite.",
        });
        const candidate = (draft.text ?? "").replace(/\s+/g, " ").trim();
        if (candidate.split(/\s+/).filter(Boolean).length < 25) {
          console.warn("[judge] report draft too short; retrying");
          continue;
        }
        const bad = unknownNumbers(candidate, allowed);
        if (bad.length) {
          console.warn("[judge] report cited unlisted numbers:", bad.join(", "));
          continue;
        }
        text = candidate;
      } catch (err) {
        console.warn("[judge] report LLM failed:", redact((err as Error).message));
        break;
      }
    }
  }

  const usedFallback = !text;
  if (usedFallback) text = fallback;

  const words = text.split(/\s+/).filter(Boolean).length;
  await db.insert(schema.agentEvents).values({
    id: newId("event"),
    missionId,
    agent: "judge",
    kind: "report",
    title: "Field report".slice(0, 300),
    payload: {
      text,
      lang: taskSpec.lang,
      words,
      est_seconds: Number((words / 2.6).toFixed(1)),
      measured,
      impact_fact_ids: impact.map((i) => i.fact_id).filter((v): v is string => !!v),
      source: usedFallback ? "deterministic" : "llm",
    },
  });

  return { text };
}
