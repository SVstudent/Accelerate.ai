/**
 * The mission pipeline as PLAIN, RESUMABLE STAGE FUNCTIONS.
 *
 * mission.ts (the Mastra workflow) and the resume/fork routes both run these —
 * there is exactly one implementation of each stage. The workflow keeps its
 * suspendable confirm and its snapshots; this module is what makes a run
 * survivable, because every stage:
 *
 *   · reads everything it needs from Postgres (nothing is carried in RAM
 *     between stages — a resume can start at any stage and still have the
 *     EnvConfig, the perception model, the baseline eval, the best policy);
 *   · reuses what has already been paid for (scraped sources and facts,
 *     curated images, the fitted perception model, written reward specs,
 *     completed training runs, recorded evaluations) instead of redoing it;
 *   · writes a heartbeat while it is alive, so "alive but quiet" (a 2-minute
 *     PPO run writes no events) is distinguishable from "the process died".
 *
 * See lib/resume.ts for how progress is reconstructed, and the comment at the
 * top of db/migrations/0004_resume_and_forks.sql for why.
 */
import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { db, schema, activeDbTag, onBranch } from "@/db";
import {
  EVAL_SEEDS, EvalMetrics, TaskSpec,
  type EnvConfig, type Fact,
} from "@/lib/contracts";
import { eventSink, setMissionStatus } from "@/mastra/tools/events";
import { parseGoal } from "./foreman";
import { runScout } from "@/mastra/agents/scout";
import { runCurator, refitPerceptionFromStored } from "@/mastra/agents/curator";
import { buildEnvConfig, writeRewardSpec } from "@/mastra/agents/architect";
import { evaluatePolicy, rankAndPromote, writeReflection, writeFieldReport } from "@/mastra/agents/judge";
import { launchRun, runEval, warmFarm, teardownFarm, preset, releaseFarm } from "@/mastra/tools/daytona";
import { newId } from "@/lib/ids";
import {
  MIN_REFIT_IMAGES, STAGES, missionProgress,
  type MissionProgress, type Stage,
} from "@/lib/resume";

export { STAGES };
export type { Stage };

export type StageCtx = { missionId: string; goalText: string; lang: string };

/* ── shared loaders: every stage's inputs come from Postgres ───────────── */

export async function basePolicy() {
  const [p] = await db.select().from(schema.policies)
    .where(eq(schema.policies.kind, "base"))
    .orderBy(desc(schema.policies.createdAt)).limit(1);
  return p ?? null;
}

/** Drizzle rows → the zod `Fact` shape the Architect and Judge expect. */
export async function factsFor(missionId: string): Promise<Fact[]> {
  const rows = await db.select().from(schema.facts)
    .where(eq(schema.facts.missionId, missionId));
  return rows.map((r) => ({
    id: r.id,
    source_id: r.sourceId,
    key: r.key as Fact["key"],
    value: r.value as Fact["value"],
    ...(r.unit ? { unit: r.unit } : {}),
    ...(r.quote ? { quote: r.quote } : {}),
    confidence: r.confidence ?? 0.7,
  }));
}

export async function taskSpecOf(missionId: string): Promise<TaskSpec> {
  const [m] = await db.select().from(schema.missions)
    .where(eq(schema.missions.id, missionId)).limit(1);
  if (!m?.taskSpec) throw new Error("mission has no confirmed TaskSpec");
  return m.taskSpec as TaskSpec;
}

/** Latest EnvConfig for the mission — the design stage's durable product. */
export async function latestEnvConfig(missionId: string) {
  const [row] = await db.select().from(schema.envConfigs)
    .where(eq(schema.envConfigs.missionId, missionId))
    .orderBy(desc(schema.envConfigs.createdAt)).limit(1);
  return row ?? null;
}

export async function latestPerceptionModel(missionId: string) {
  const [row] = await db.select().from(schema.perceptionModels)
    .where(eq(schema.perceptionModels.missionId, missionId))
    .orderBy(desc(schema.perceptionModels.createdAt)).limit(1);
  return row ?? null;
}

export async function latestBaselineEvalId(missionId: string): Promise<string | null> {
  const [row] = await db.select({ id: schema.evaluations.id }).from(schema.evaluations)
    .where(and(eq(schema.evaluations.missionId, missionId), eq(schema.evaluations.isBaseline, true)))
    .orderBy(desc(schema.evaluations.createdAt)).limit(1);
  return row?.id ?? null;
}

export async function latestPromotedPolicyId(missionId: string): Promise<string | null> {
  const [row] = await db.select({ id: schema.policies.id }).from(schema.policies)
    .where(and(eq(schema.policies.missionId, missionId), eq(schema.policies.kind, "promoted")))
    .orderBy(desc(schema.policies.createdAt)).limit(1);
  return row?.id ?? null;
}

/* ── 1. draft ─────────────────────────────────────────────────────────── */
export async function stageDraft(ctx: StageCtx): Promise<TaskSpec> {
  const onEvent = eventSink(ctx.missionId);
  return await parseGoal({ ...ctx, onEvent });
}

/* ── 2. research (Scout · Bright Data SERP + Unlocker) ────────────────── */
export async function stageResearch(ctx: StageCtx): Promise<{ facts: number }> {
  const onEvent = eventSink(ctx.missionId);
  await setMissionStatus(ctx.missionId, "researching", "searching the open web");
  const spec = await taskSpecOf(ctx.missionId);
  const out = await runScout({ missionId: ctx.missionId, taskSpec: spec });
  await onEvent({
    agent: "scout", kind: "result",
    title: `Scout finished: ${out.facts.length} cited facts from ${out.sources.length} sources`,
  });
  return { facts: out.facts.length };
}

/* ── 3. curate (Curator · image SERP → CLIP + probe) ─────────────────── */
/**
 * `reuse` is what makes an interrupted curate cheap: if the mission already
 * has a fitted perception model we skip the stage outright, and if it has
 * stored images but no model we re-fit the probe from those images instead of
 * re-paying for every image-SERP hit and Unlocker download.
 */
export async function stageCurate(
  ctx: StageCtx,
  opts: { reuse?: boolean } = {},
): Promise<{ perceptionModelId: string | null; reused: "model" | "images" | null }> {
  const onEvent = eventSink(ctx.missionId);
  const spec = await taskSpecOf(ctx.missionId);

  if (opts.reuse) {
    const existing = await latestPerceptionModel(ctx.missionId);
    if (existing) {
      await onEvent({
        agent: "curator", kind: "decision",
        title: "Reusing the perception model already trained for this mission",
        payload: { perception_model_id: existing.id, brightdata_requests: 0, reused: true },
        refTable: "perception_models", refId: existing.id,
      });
      return { perceptionModelId: existing.id, reused: "model" };
    }
    const [{ c }] = await db.select({
      c: sql<number>`count(*)::int`,
    }).from(schema.datasetItems).where(and(
      eq(schema.datasetItems.missionId, ctx.missionId),
      inArray(schema.datasetItems.split, ["train", "val", "pool"]),
    ));
    if (Number(c) >= MIN_REFIT_IMAGES) {
      await setMissionStatus(ctx.missionId, "curating", "re-fitting perception from stored images");
      const model = await refitPerceptionFromStored({ missionId: ctx.missionId, taskSpec: spec });
      if (model) return { perceptionModelId: model.id, reused: "images" };
      await onEvent({
        agent: "curator", kind: "decision",
        title: "Re-fit from stored images failed — falling back to a full curate",
      });
    }
  }

  await setMissionStatus(ctx.missionId, "curating", "building the perception dataset");
  const out = await runCurator({ missionId: ctx.missionId, taskSpec: spec });
  const m = out.perceptionModel;
  await onEvent({
    agent: "curator", kind: "result",
    title: m
      ? `Perception trained: zero-shot ${Math.round((m.metrics?.zero_shot_acc ?? 0) * 100)}% → probe ${Math.round((m.metrics?.probe_acc ?? 0) * 100)}%`
      : `Curated ${out.items.length} images (no perception model)`,
  });
  return { perceptionModelId: m?.id ?? null, reused: null };
}

/* ── 4. design (Architect · EnvConfig + K reward variants) ────────────── */
export async function stageDesign(
  ctx: StageCtx,
  opts: { perceptionModelId?: string | null; reuse?: boolean } = {},
): Promise<{ envConfigId: string; variants: number }> {
  const onEvent = eventSink(ctx.missionId);
  await setMissionStatus(ctx.missionId, "designing", "writing the environment and reward");
  const spec = await taskSpecOf(ctx.missionId);
  const variants = Math.min(spec.budget.variants, preset().sandboxes);

  const perceptionModelId =
    opts.perceptionModelId ?? (await latestPerceptionModel(ctx.missionId))?.id ?? undefined;

  // Reuse the EnvConfig: it is derived from the cited facts, so rebuilding it
  // would produce the same thing at the cost of another LLM pass.
  let envConfigId: string;
  const existingEnv = opts.reuse ? await latestEnvConfig(ctx.missionId) : null;
  if (existingEnv) {
    envConfigId = existingEnv.id;
    await onEvent({
      agent: "architect", kind: "decision",
      title: "Reusing the EnvConfig already derived from this mission's cited facts",
      payload: { env_config_id: envConfigId, reused: true },
      refTable: "env_configs", refId: envConfigId,
    });
  } else {
    const facts = await factsFor(ctx.missionId);
    const env = await buildEnvConfig({
      missionId: ctx.missionId, taskSpec: spec, facts,
      ...(perceptionModelId ? { perceptionModelId } : {}),
    });
    envConfigId = env.id;
  }

  const [cfgRow] = await db.select().from(schema.envConfigs)
    .where(eq(schema.envConfigs.id, envConfigId)).limit(1);

  // Only write the reward variants that are missing: an interrupted design
  // stage can leave 2 of 4 written, and each one is an LLM call plus a sandbox
  // dry-run.
  const have = opts.reuse
    ? await db.select({ variant: schema.rewardSpecs.variant }).from(schema.rewardSpecs)
      .where(and(eq(schema.rewardSpecs.missionId, ctx.missionId), eq(schema.rewardSpecs.generation, 0)))
    : [];
  const haveVariants = new Set(have.map((h) => h.variant));
  if (haveVariants.size) {
    await onEvent({
      agent: "architect", kind: "decision",
      title: `Reusing ${haveVariants.size} reward spec(s) already written for generation 0`,
      payload: { variants: [...haveVariants], reused: true },
    });
  }
  for (let v = 0; v < variants; v++) {
    if (haveVariants.has(v)) continue;
    await writeRewardSpec({
      missionId: ctx.missionId, generation: 0, variant: v,
      taskSpec: spec, envConfig: cfgRow.config as EnvConfig,
    });
  }
  return { envConfigId, variants };
}

/* ── 5. baseline (Judge · the untrained policy on THIS env) ───────────── */
export async function stageBaseline(
  ctx: StageCtx,
  opts: { envConfigId: string; variants: number; reuse?: boolean },
): Promise<{ envConfigId: string; variants: number; baselineEvalId: string | null }> {
  const onEvent = eventSink(ctx.missionId);
  if (opts.reuse) {
    const existing = await latestBaselineEvalId(ctx.missionId);
    if (existing) {
      await onEvent({
        agent: "judge", kind: "decision",
        title: "Reusing the baseline measurement already recorded for this environment",
        payload: { evaluation_id: existing, reused: true },
        refTable: "evaluations", refId: existing,
      });
      await setMissionStatus(ctx.missionId, "baseline", null, { baselineEvalId: existing });
      return { envConfigId: opts.envConfigId, variants: opts.variants, baselineEvalId: existing };
    }
  }

  await setMissionStatus(ctx.missionId, "baseline", "measuring the untrained robot");
  const spec = await taskSpecOf(ctx.missionId);
  const base = await basePolicy();
  if (!base) {
    await onEvent({
      agent: "judge", kind: "error",
      title: "No base policy registered — run scripts/pretrain_base.py first",
    });
    return { envConfigId: opts.envConfigId, variants: opts.variants, baselineEvalId: null };
  }
  const [cfgRow] = await db.select().from(schema.envConfigs)
    .where(eq(schema.envConfigs.id, opts.envConfigId)).limit(1);

  // FAIRNESS: the baseline must be evaluated in exactly the world the
  // candidates are evaluated in, including the SAME perception pool.
  const pm = await latestPerceptionModel(ctx.missionId);
  const metrics = await evaluatePolicy({
    missionId: ctx.missionId, policyId: base.id, envConfigId: opts.envConfigId,
    envConfig: cfgRow.config as EnvConfig, policyArtifactId: base.artifactId,
    poolArtifactId: pm?.poolArtifactId ?? undefined,
    perceptionModelId: pm?.id,
    kind: "baseline", taskSpec: spec,
  });
  if (metrics.evaluation_id) {
    await setMissionStatus(ctx.missionId, "baseline", null, { baselineEvalId: metrics.evaluation_id });
  }
  await onEvent({
    agent: "judge", kind: "result",
    title: `Baseline: ${Math.round((metrics?.target_removal_rate?.mean ?? 0) * 100)}% weeds removed, ` +
           `${Math.round((metrics?.protect_damage_rate?.mean ?? 0) * 100)}% crop damage`,
    payload: { metrics },
  });
  return {
    envConfigId: opts.envConfigId, variants: opts.variants,
    baselineEvalId: metrics.evaluation_id ?? null,
  };
}

/* ── 6. one generation (Trainer fan-out → Judge ranks → Architect revises) ── */
export async function stageGeneration(
  ctx: StageCtx,
  opts: {
    envConfigId: string; variants: number; baselineEvalId: string | null;
    generation: number; reuse?: boolean;
  },
): Promise<{
  envConfigId: string; variants: number; baselineEvalId: string | null;
  generation: number; done: boolean; bestPolicyId: string | null;
}> {
  const onEvent = eventSink(ctx.missionId);
  const g = opts.generation ?? 0;
  const spec = await taskSpecOf(ctx.missionId);
  const [cfgRow] = await db.select().from(schema.envConfigs)
    .where(eq(schema.envConfigs.id, opts.envConfigId)).limit(1);
  const envConfig = cfgRow.config as EnvConfig;

  await setMissionStatus(ctx.missionId, "training", `generation ${g}`, { generation: g });

  const specs = await db.select().from(schema.rewardSpecs)
    .where(and(eq(schema.rewardSpecs.missionId, ctx.missionId),
               eq(schema.rewardSpecs.generation, g)));
  const usable = specs.filter((s) => (s.dryRun as { ok?: boolean })?.ok !== false);

  // A completed run is minutes of sandbox time that was already paid for:
  // never retrain a variant whose checkpoint is already in Postgres.
  const priorRuns = await db.select().from(schema.runs)
    .where(and(eq(schema.runs.missionId, ctx.missionId), eq(schema.runs.generation, g)));
  const trained = opts.reuse ? priorRuns.filter((r) => r.resultPolicyId) : [];
  const trainedVariants = new Set(trained.map((r) => r.variant));
  const todo = usable.filter((s) => !trainedVariants.has(s.variant));

  if (trained.length) {
    await onEvent({
      agent: "trainer", kind: "decision",
      title: `Generation ${g}: reusing ${trained.length} completed run(s), training ${todo.length} remaining variant(s)`,
      payload: {
        reused_runs: trained.map((r) => ({ run_id: r.id, variant: r.variant })),
        retraining_variants: todo.map((s) => s.variant), reused: true,
      },
    });
  }

  const handles: { runId: string; variant: number; promise: Promise<string> }[] = [];
  if (todo.length) {
    // Warm only what is still to be trained. On a resume that reuses three of
    // four completed runs, warming the full preset would boot (and bill) seven
    // sandboxes to run one variant.
    await warmFarm(ctx.missionId, Math.min(todo.length, preset().sandboxes));
    const base = await basePolicy();
    const promotedId = await latestPromotedPolicyId(ctx.missionId);
    const [promoted] = promotedId
      ? await db.select().from(schema.policies).where(eq(schema.policies.id, promotedId)).limit(1)
      : [];
    const initPolicy = promoted ?? base;
    const pm = await latestPerceptionModel(ctx.missionId);
    const poolArtifact = pm?.poolArtifactId ?? undefined;

    for (const rs of todo) {
      const runId = newId("run");
      const hyperparams = {
        algo: "PPO" as const, total_steps: spec.budget.steps_per_run, n_envs: preset().envs,
        lr: 3e-4, n_steps: 1024, batch_size: 2048, gamma: 0.99, ent_coef: 0.005,
        clip_range: 0.2, seed: 7 + rs.variant, metrics_every: 5000,
        replay_every: 25000, replay_seed: 1000,
      };
      await db.insert(schema.runs).values({
        id: runId, missionId: ctx.missionId, generation: g, variant: rs.variant,
        rewardSpecId: rs.id, envConfigId: opts.envConfigId,
        initPolicyId: initPolicy?.id ?? "pol_missing",
        hyperparams, status: "queued",
      });
      const h = await launchRun({
        missionId: ctx.missionId,
        job: {
          job: "train", mission_id: ctx.missionId, run_id: runId,
          init_policy_artifact_id: initPolicy?.artifactId,
          env_config: envConfig, reward_code: rs.code,
          perception_pool_artifact_id: poolArtifact,
          hyperparams,
        },
      });
      await db.update(schema.runs).set({ sandboxId: h.sandboxId }).where(eq(schema.runs.id, runId));
      handles.push({ runId, variant: rs.variant, promise: h.promise });
    }
    await onEvent({
      agent: "trainer", kind: "result",
      title: `Generation ${g}: ${handles.length} sandboxes x ${preset().envs} envs = ${handles.length * preset().envs} live fields`,
    });
    await Promise.allSettled(handles.map((h) => h.promise));
  }

  // ── evaluate every finished run, reusing evaluations already recorded ──
  await setMissionStatus(ctx.missionId, "evaluating", `generation ${g}`);
  const finished = await db.select().from(schema.runs)
    .where(and(eq(schema.runs.missionId, ctx.missionId), eq(schema.runs.generation, g)));
  const pm = await latestPerceptionModel(ctx.missionId);
  const poolArtifact = pm?.poolArtifactId ?? undefined;
  const evaluated = new Set(
    (await db.select({ policyId: schema.evaluations.policyId }).from(schema.evaluations)
      .where(and(eq(schema.evaluations.missionId, ctx.missionId), eq(schema.evaluations.isBaseline, false))))
      .map((e) => e.policyId),
  );

  const evals: { runId: string; policyId: string; metrics: EvalMetrics }[] = [];
  let reusedEvals = 0;
  for (const r of finished) {
    if (!r.resultPolicyId) continue;
    const [pol] = await db.select().from(schema.policies)
      .where(eq(schema.policies.id, r.resultPolicyId)).limit(1);
    if (!pol) continue;
    if (opts.reuse && evaluated.has(pol.id)) {
      // the measurement is already in Postgres: hand the Judge the stored
      // metrics instead of paying for another sandbox evaluation
      const [prior] = await db.select({ metrics: schema.evaluations.metrics })
        .from(schema.evaluations)
        .where(and(eq(schema.evaluations.missionId, ctx.missionId),
                   eq(schema.evaluations.policyId, pol.id)))
        .orderBy(desc(schema.evaluations.createdAt)).limit(1);
      const parsed = EvalMetrics.safeParse(prior?.metrics);
      if (parsed.success) {
        evals.push({ runId: r.id, policyId: pol.id, metrics: parsed.data });
        reusedEvals++;
        continue;
      }
      // a stored row that no longer parses is not evidence — re-measure it
    }
    const m = await evaluatePolicy({
      missionId: ctx.missionId, policyId: pol.id, envConfigId: opts.envConfigId,
      envConfig, policyArtifactId: pol.artifactId, poolArtifactId: poolArtifact,
      perceptionModelId: pm?.id, kind: "candidate", runId: r.id,
    });
    evals.push({ runId: r.id, policyId: pol.id, metrics: m });
  }
  if (reusedEvals) {
    await onEvent({
      agent: "judge", kind: "decision",
      title: `Reusing ${reusedEvals} evaluation(s) already measured for generation ${g}`,
      payload: { reused_evaluations: reusedEvals, reused: true },
    });
  }
  if (!evals.length) {
    throw new Error(`generation ${g} produced no trained policy to evaluate`);
  }

  const { ranking } = await rankAndPromote({ missionId: ctx.missionId, generation: g, runs: evals });
  const reflection = await writeReflection({
    missionId: ctx.missionId, generation: g, ranking, evals,
  });

  const last = g + 1 >= spec.budget.generations;
  if (!last) {
    await setMissionStatus(ctx.missionId, "redesigning", `revising reward after gen ${g}`);
    const nextHave = new Set(
      (await db.select({ variant: schema.rewardSpecs.variant }).from(schema.rewardSpecs)
        .where(and(eq(schema.rewardSpecs.missionId, ctx.missionId),
                   eq(schema.rewardSpecs.generation, g + 1))))
        .map((r) => r.variant),
    );
    for (let v = 0; v < opts.variants; v++) {
      if (opts.reuse && nextHave.has(v)) continue;
      await writeRewardSpec({
        missionId: ctx.missionId, generation: g + 1, variant: v,
        taskSpec: spec, envConfig, reflection,
      });
    }
  }

  return {
    envConfigId: opts.envConfigId, variants: opts.variants,
    baselineEvalId: opts.baselineEvalId,
    generation: g + 1, done: last,
    bestPolicyId: await latestPromotedPolicyId(ctx.missionId),
  };
}

/* ── 7. test phase (paired seeds, base | promoted) ─────────────────────── */
export async function stageTest(
  ctx: StageCtx,
  opts: { bestPolicyId: string | null; envConfigId: string },
): Promise<{ bestPolicyId: string | null; envConfigId: string }> {
  const onEvent = eventSink(ctx.missionId);
  const [cfgRow] = await db.select().from(schema.envConfigs)
    .where(eq(schema.envConfigs.id, opts.envConfigId)).limit(1);
  const envConfig = cfgRow.config as EnvConfig;
  const base = await basePolicy();
  const pm = await latestPerceptionModel(ctx.missionId);
  const bestId = opts.bestPolicyId ?? (await latestPromotedPolicyId(ctx.missionId));
  const [best] = bestId
    ? await db.select().from(schema.policies).where(eq(schema.policies.id, bestId)).limit(1)
    : [];

  await onEvent({ agent: "judge", kind: "decision", title: "Test phase: Before | After on identical seeds" });

  for (const [kind, pol] of [["baseline", base], ["candidate", best]] as const) {
    if (!pol) continue;
    await runEval({
      missionId: ctx.missionId,
      job: {
        job: "eval", mission_id: ctx.missionId,
        init_policy_artifact_id: pol.artifactId, env_config: envConfig,
        perception_pool_artifact_id: pm?.poolArtifactId ?? undefined,
        eval_seeds: EVAL_SEEDS,
      },
      kind, policyId: pol.id, envConfigId: opts.envConfigId,
      perceptionModelId: pm?.id, phase: "test",
    });
  }
  return { bestPolicyId: bestId ?? null, envConfigId: opts.envConfigId };
}

/* ── 8. report (the Judge writes it from this mission's own rows) ────── */
export async function stageReport(ctx: StageCtx): Promise<{ status: string; text: string | null }> {
  const onEvent = eventSink(ctx.missionId);
  await setMissionStatus(ctx.missionId, "reporting", "writing the field report");
  const spec = await taskSpecOf(ctx.missionId);
  const evals = await db.select().from(schema.evaluations)
    .where(eq(schema.evaluations.missionId, ctx.missionId));
  const baselineEval = evals.find((e) => e.isBaseline);
  const bestEval = evals.filter((e) => !e.isBaseline).sort((a, b) =>
    ((b.metrics as { score?: { mean?: number } })?.score?.mean ?? -Infinity) -
    ((a.metrics as { score?: { mean?: number } })?.score?.mean ?? -Infinity))[0];

  const impact = (await factsFor(ctx.missionId)).filter((f) => f.key === "impact_stat");
  if (!baselineEval?.metrics || !bestEval?.metrics) {
    await onEvent({
      agent: "judge", kind: "error",
      title: "No baseline or candidate evaluation — cannot write an honest report",
    });
    await setMissionStatus(ctx.missionId, "failed", "missing evaluations");
    await teardownFarm(ctx.missionId).catch(() => {});
    return { status: "failed", text: null };
  }
  const out = await writeFieldReport({
    missionId: ctx.missionId, taskSpec: spec,
    baseline: baselineEval.metrics as EvalMetrics,
    best: bestEval.metrics as EvalMetrics,
    impactFacts: impact,
  });

  // The Judge's write-up is stored as text so the console can show it. It is
  // composed from this mission's own evaluation rows by writeFieldReport().
  if (out?.text) {
    await db.insert(schema.voiceClips).values({
      id: newId("voice_clip"), missionId: ctx.missionId, direction: "out",
      purpose: "field_report", lang: spec.lang, transcript: out.text,
    });
    await onEvent({ agent: "judge", kind: "report", title: "Field Report written" });
  }

  await setMissionStatus(ctx.missionId, "done", "mission complete");
  await teardownFarm(ctx.missionId).catch(() => {});
  return { status: "done", text: out?.text ?? null };
}

/* ══ the resumable runner ══════════════════════════════════════════════ */

const HEARTBEAT_MS = 20_000;

export type ActiveRun = { stage: Stage; startedAt: number; resumedFrom: Stage };
const g = globalThis as unknown as { __furrowActiveStages?: Map<string, ActiveRun> };
/** Survives HMR so a reload cannot start a second runner for one mission. */
const active = g.__furrowActiveStages ?? (g.__furrowActiveStages = new Map());

/**
 * Runs are keyed by mission AND branch: the same mission id exists on `main`
 * and inside every fork branch, and a fork re-run must not be mistaken for a
 * second runner of the original.
 */
function runKey(missionId: string): string {
  const tag = activeDbTag();
  return tag === "main" ? missionId : `${missionId}@${tag}`;
}

export function activeStageRun(missionId: string): ActiveRun | null {
  return active.get(runKey(missionId)) ?? null;
}
export function activeStageRuns(): { mission_id: string; stage: Stage; elapsed_s: number }[] {
  return [...active.entries()].map(([mission_id, r]) => ({
    mission_id, stage: r.stage, elapsed_s: Math.round((Date.now() - r.startedAt) / 1000),
  }));
}

/**
 * Keep a non-resumed run (the Mastra workflow started by POST /run) visible to
 * the same liveness machinery: it registers in the active map so a resume
 * cannot double-run it, and writes heartbeat_at so a long, quiet PPO run is
 * not mistaken for a dead one. Returns the stop function.
 */
export function startHeartbeat(missionId: string, stage: Stage = "draft"): () => void {
  active.set(runKey(missionId), { stage, startedAt: Date.now(), resumedFrom: stage });
  const beat = setInterval(() => {
    db.update(schema.missions)
      .set({ heartbeatAt: new Date() })
      .where(eq(schema.missions.id, missionId))
      .catch(() => {});
  }, HEARTBEAT_MS);
  (beat as unknown as { unref?: () => void }).unref?.();
  void db.update(schema.missions).set({ heartbeatAt: new Date() })
    .where(eq(schema.missions.id, missionId)).catch(() => {});
  return () => {
    clearInterval(beat);
    active.delete(runKey(missionId));
    void db.update(schema.missions).set({ heartbeatAt: null })
      .where(eq(schema.missions.id, missionId)).catch(() => {});
  };
}

export type SpecOverrides = {
  priorities?: { avoid_damage?: number; coverage?: number; speed?: number };
  budget?: { generations?: number; variants?: number; steps_per_run?: number };
};

/**
 * Merge overrides into the mission's TaskSpec and persist them. The whole
 * pipeline reads the spec from the row, so this is all a "re-run with different
 * parameters" needs — no parameter has to be threaded through the stages.
 */
export async function applyOverrides(
  missionId: string, overrides: SpecOverrides,
): Promise<TaskSpec | null> {
  if (!overrides || (!overrides.priorities && !overrides.budget)) return null;
  const spec = await taskSpecOf(missionId);
  const merged = TaskSpec.parse({
    ...spec,
    priorities: { ...spec.priorities, ...(overrides.priorities ?? {}) },
    budget: { ...spec.budget, ...(overrides.budget ?? {}) },
  });
  await db.update(schema.missions)
    .set({ taskSpec: merged, forkOverrides: overrides, updatedAt: new Date() })
    .where(eq(schema.missions.id, missionId));
  return merged;
}

/**
 * Delete the downstream products of `stage` and after, so a fork can re-run
 * them cleanly. ONLY runs inside a fork branch — on `main` this would destroy
 * a real mission's history, so it refuses.
 */
export async function resetFromStage(missionId: string, stage: Stage): Promise<Record<string, number>> {
  if (!onBranch()) {
    throw new Error("resetFromStage refuses to run outside a fork branch");
  }
  const idx = STAGES.indexOf(stage);
  const deleted: Record<string, number> = {};
  const del = async (name: string, run: () => Promise<{ rowCount?: number | null }>) => {
    const r = await run();
    deleted[name] = r.rowCount ?? 0;
  };

  if (idx <= STAGES.indexOf("generation")) {
    await del("replays", () => db.delete(schema.replays)
      .where(eq(schema.replays.missionId, missionId)) as unknown as Promise<{ rowCount?: number | null }>);
    await del("evaluations", () => db.delete(schema.evaluations)
      .where(and(eq(schema.evaluations.missionId, missionId),
                 idx <= STAGES.indexOf("baseline")
                   ? sql`true`
                   : eq(schema.evaluations.isBaseline, false))) as unknown as Promise<{ rowCount?: number | null }>);
    await del("runs", () => db.delete(schema.runs)
      .where(and(eq(schema.runs.missionId, missionId), gte(schema.runs.generation, 0))) as unknown as Promise<{ rowCount?: number | null }>);
    await del("promoted_policies", () => db.delete(schema.policies)
      .where(and(eq(schema.policies.missionId, missionId),
                 eq(schema.policies.kind, "promoted"))) as unknown as Promise<{ rowCount?: number | null }>);
    await db.update(schema.missions)
      .set({ bestPolicyId: null, generation: 0, updatedAt: new Date() })
      .where(eq(schema.missions.id, missionId));
  }
  if (idx <= STAGES.indexOf("design")) {
    await del("reward_specs", () => db.delete(schema.rewardSpecs)
      .where(eq(schema.rewardSpecs.missionId, missionId)) as unknown as Promise<{ rowCount?: number | null }>);
  }
  if (idx <= STAGES.indexOf("baseline")) {
    await db.update(schema.missions)
      .set({ baselineEvalId: null, updatedAt: new Date() })
      .where(eq(schema.missions.id, missionId));
  }
  return deleted;
}

export type StageRunResult = {
  mission_id: string;
  resumed_from: Stage;
  skipped: Stage[];
  ran: Stage[];
  reused: string[];
  status: string;
  text?: string | null;
  error?: string;
};

/**
 * Run the pipeline from `from` (default: the first stage whose product is
 * missing) to the end, reusing everything already in Postgres.
 *
 * This is what POST /api/missions/[id]/resume and the fork re-run both call.
 * It is deliberately a plain async function: the durable state is the mission's
 * tables, so there is no in-memory workflow to keep alive.
 */
export async function runMissionStages(
  missionId: string,
  opts: {
    from?: Stage;
    overrides?: SpecOverrides;
    /** false → redo stages instead of reusing their outputs (forks). */
    reuse?: boolean;
    /** Ignore a live heartbeat from another runner. */
    force?: boolean;
    /** Free text that goes in the resume event. */
    reason?: string;
    /** Wording only: a fork's re-run is not a recovery. */
    kind?: "resume" | "fork";
  } = {},
): Promise<StageRunResult> {
  // A resumed mission may inherit a sandbox pool from the attempt that died:
  // entries still flagged busy whose sandboxes are long gone. Forget it, so
  // allocation starts from what the provider actually has.
  releaseFarm(missionId);

  const reuse = opts.reuse !== false;
  const [mission] = await db.select().from(schema.missions)
    .where(eq(schema.missions.id, missionId)).limit(1);
  if (!mission) throw new Error(`mission ${missionId} not found`);

  if (active.has(runKey(missionId))) {
    throw new Error(
      `mission ${missionId} is already running in this process (${activeDbTag()})`,
    );
  }
  if (opts.overrides) await applyOverrides(missionId, opts.overrides);

  let progress = await missionProgress(missionId);
  if (!progress) throw new Error(`mission ${missionId} not found`);
  if (progress.live && !opts.force) {
    throw new Error(
      `mission ${missionId} has a live heartbeat (${progress.quiet_minutes}m ago) — ` +
      `another process is running it; pass force to override`,
    );
  }

  const from: Stage | null = opts.from ?? progress.resume_from;
  if (!from) {
    return {
      mission_id: missionId, resumed_from: "report", skipped: [...STAGES], ran: [],
      reused: progress.reuse, status: progress.status,
    };
  }
  const startIdx = STAGES.indexOf(from);
  const skipped = STAGES.slice(0, startIdx);
  const onEvent = eventSink(missionId);

  active.set(runKey(missionId), { stage: from, startedAt: Date.now(), resumedFrom: from });
  const beat = setInterval(() => {
    db.update(schema.missions)
      .set({ heartbeatAt: new Date() })
      .where(eq(schema.missions.id, missionId))
      .catch(() => {});
  }, HEARTBEAT_MS);
  (beat as unknown as { unref?: () => void }).unref?.();

  const ran: Stage[] = [];
  try {
    await db.update(schema.missions).set({
      heartbeatAt: new Date(),
      resumedFrom: from,
      resumedCount: (mission.resumedCount ?? 0) + 1,
      updatedAt: new Date(),
    }).where(eq(schema.missions.id, missionId));

    await onEvent({
      agent: "system", kind: "decision",
      title:
        `${opts.kind === "fork" ? "Fork re-run" : "Resuming"} from ${from}` +
        `${opts.reason ? ` (${opts.reason})` : ""} — ` +
        `reusing ${progress.reuse.length ? progress.reuse.join(", ") : "nothing"}`,
      payload: {
        kind: opts.kind ?? "resume",
        resumed_from: from, skipped_stages: skipped, reuse: progress.reuse,
        counts: progress.counts, was_status: progress.status,
        quiet_minutes: progress.quiet_minutes, stalled: progress.stalled,
        resumed_count: (mission.resumedCount ?? 0) + 1,
        brightdata_requests_saved: reuse && progress.counts.sources > 0 ? progress.counts.sources : 0,
      },
    });

    const ctx: StageCtx = {
      missionId, goalText: mission.goalText, lang: mission.goalLang ?? "en",
    };
    const at = (s: Stage) => STAGES.indexOf(s) >= startIdx;
    const mark = (s: Stage) => {
      ran.push(s);
      active.set(runKey(missionId), { stage: s, startedAt: Date.now(), resumedFrom: from });
    };

    if (at("draft")) { mark("draft"); await stageDraft(ctx); }
    if (at("research")) { mark("research"); await stageResearch(ctx); }

    let perceptionModelId: string | null =
      (await latestPerceptionModel(missionId))?.id ?? null;
    if (at("curate")) {
      mark("curate");
      perceptionModelId = (await stageCurate(ctx, { reuse })).perceptionModelId;
    }

    let envConfigId: string | null = (await latestEnvConfig(missionId))?.id ?? null;
    let variants = (await taskSpecOf(missionId)).budget.variants;
    if (at("design")) {
      mark("design");
      const d = await stageDesign(ctx, { perceptionModelId, reuse });
      envConfigId = d.envConfigId;
      variants = d.variants;
    }
    if (!envConfigId) throw new Error("no EnvConfig for this mission — cannot train");

    let baselineEvalId = await latestBaselineEvalId(missionId);
    if (at("baseline")) {
      mark("baseline");
      baselineEvalId = (await stageBaseline(ctx, { envConfigId, variants, reuse })).baselineEvalId;
    }

    let bestPolicyId = await latestPromotedPolicyId(missionId);
    if (at("generation")) {
      const spec = await taskSpecOf(missionId);
      const startGen = reuse ? Math.min(progress.counts.generations_done, spec.budget.generations - 1) : 0;
      let gen = startGen;
      // dountil, but driven by the durable generation counter
      for (;;) {
        mark("generation");
        const out = await stageGeneration(ctx, {
          envConfigId, variants, baselineEvalId, generation: gen, reuse,
        });
        bestPolicyId = out.bestPolicyId;
        if (out.done) break;
        gen = out.generation;
      }
    }

    if (at("test")) { mark("test"); await stageTest(ctx, { bestPolicyId, envConfigId }); }

    let text: string | null = null;
    let status = "done";
    if (at("report")) {
      mark("report");
      const r = await stageReport(ctx);
      status = r.status;
      text = r.text;
    }

    progress = (await missionProgress(missionId)) ?? progress;
    return {
      mission_id: missionId, resumed_from: from, skipped, ran,
      reused: progress.reuse, status, text,
    };
  } catch (err) {
    const message = (err as Error).message ?? String(err);
    await onEvent({
      agent: "system", kind: "error",
      title: `Resume failed in ${active.get(runKey(missionId))?.stage ?? from}: ${message}`.slice(0, 280),
    });
    await db.update(schema.missions)
      .set({ status: "failed", phaseDetail: message.slice(0, 200), updatedAt: new Date() })
      .where(eq(schema.missions.id, missionId));
    return {
      mission_id: missionId, resumed_from: from, skipped, ran,
      reused: progress.reuse, status: "failed", error: message,
    };
  } finally {
    clearInterval(beat);
    active.delete(runKey(missionId));
    await db.update(schema.missions)
      .set({ heartbeatAt: null, updatedAt: new Date() })
      .where(eq(schema.missions.id, missionId))
      .catch(() => {});
    await teardownFarm(missionId).catch(() => {});
  }
}

export type { MissionProgress };
