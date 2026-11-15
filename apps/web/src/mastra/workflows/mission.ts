/**
 * Mission workflow (CLAUDE.md §4.1) — real Mastra steps with a suspendable
 * confirm, Postgres-backed snapshots in Neon, and the generation loop.
 *
 *   draft → confirm (suspend) → research ∥ curate → design → baseline
 *         → loop g: train → evaluate → promote → reflect → redesign
 *         → test (paired seeds, base | promoted) → report → done
 *
 * Every step here is a thin wrapper around the stage functions in stages.ts.
 * That is deliberate: this workflow object lives in the Next.js server process
 * and dies with it, while POST /api/missions/[id]/resume has to be able to
 * re-enter the pipeline at any stage from nothing but the rows in Neon. One
 * implementation of each stage, two ways to drive it.
 */
import { createStep, createWorkflow } from "@mastra/core/workflows";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import type { TaskSpec } from "@/lib/contracts";
import { eventSink, setMissionStatus } from "@/mastra/tools/events";
import {
  stageBaseline, stageCurate, stageDesign, stageDraft, stageGeneration,
  stageReport, stageResearch, stageTest, type StageCtx,
} from "./stages";

const Ctx = z.object({
  missionId: z.string(),
  goalText: z.string(),
  lang: z.string().default("en"),
});

/* ── 1. draft ─────────────────────────────────────────────────────────── */
const draft = createStep({
  id: "draft",
  description: "Foreman parses the goal into a TaskSpec",
  inputSchema: Ctx,
  outputSchema: Ctx.extend({ taskSpec: z.unknown() }),
  execute: async ({ inputData }) => {
    const spec = await stageDraft(inputData as StageCtx);
    return { ...inputData, taskSpec: spec };
  },
});

/* ── 2. confirm (suspends until the farmer presses Confirm) ───────────── */
const confirm = createStep({
  id: "confirm",
  description: "Wait for the farmer to confirm the TaskSpec (auto in demo mode)",
  inputSchema: Ctx.extend({ taskSpec: z.unknown() }),
  outputSchema: Ctx,
  resumeSchema: z.object({ confirmed: z.boolean(), taskSpec: z.unknown().optional() }),
  suspendSchema: z.object({ taskSpec: z.unknown() }),
  execute: async ({ inputData, resumeData, suspend }) => {
    const onEvent = eventSink(inputData.missionId);
    if (process.env.DEMO_MODE === "true") {
      await onEvent({ agent: "foreman", kind: "decision", title: "Demo mode: auto-confirmed" });
      return { missionId: inputData.missionId, goalText: inputData.goalText, lang: inputData.lang };
    }
    if (!resumeData?.confirmed) {
      await setMissionStatus(inputData.missionId, "awaiting_confirm", "waiting for confirmation");
      return await suspend({ taskSpec: inputData.taskSpec });
    }
    if (resumeData.taskSpec) {
      await db.update(schema.missions)
        .set({ taskSpec: resumeData.taskSpec as TaskSpec, updatedAt: new Date() })
        .where(eq(schema.missions.id, inputData.missionId));
    }
    await onEvent({ agent: "foreman", kind: "decision", title: "Task confirmed — starting research" });
    return { missionId: inputData.missionId, goalText: inputData.goalText, lang: inputData.lang };
  },
});

/* ── 3. research ∥ curate (Bright Data ingestion) ─────────────────────── */
const research = createStep({
  id: "research",
  description: "Scout: SERP + Unlocker + typed Facts with citations",
  inputSchema: Ctx,
  outputSchema: z.object({ facts: z.number() }),
  execute: async ({ inputData }) => await stageResearch(inputData as StageCtx),
});

const curate = createStep({
  id: "curate",
  description: "Curator: image SERP, Gemini label QA, CLIP probe, perception pool",
  inputSchema: Ctx,
  outputSchema: z.object({ perceptionModelId: z.string().nullable() }),
  execute: async ({ inputData }) => {
    // A fresh workflow run reuses an existing perception model too: the only
    // way to reach this step with one already stored is a re-run of a mission
    // whose curate stage finished, and re-paying for the dataset is never the
    // right answer.
    const out = await stageCurate(inputData as StageCtx, { reuse: true });
    return { perceptionModelId: out.perceptionModelId };
  },
});

/* ── 4. design: EnvConfig + reward variants, each dry-run in a sandbox ── */
const design = createStep({
  id: "design",
  description: "Architect: EnvConfig from cited facts + K reward variants",
  inputSchema: z.object({
    research: z.object({ facts: z.number() }),
    curate: z.object({ perceptionModelId: z.string().nullable() }),
  }),
  outputSchema: z.object({ envConfigId: z.string(), variants: z.number() }),
  execute: async ({ getInitData, inputData }) => {
    const init = getInitData() as StageCtx;
    return await stageDesign(init, {
      perceptionModelId: inputData.curate.perceptionModelId,
      reuse: true,
    });
  },
});

/* ── 5. baseline: the base policy on THIS mission's env ──────────────── */
const baseline = createStep({
  id: "baseline",
  description: "Judge: evaluate the base policy on the mission environment",
  inputSchema: z.object({ envConfigId: z.string(), variants: z.number() }),
  outputSchema: z.object({
    envConfigId: z.string(), variants: z.number(), baselineEvalId: z.string().nullable(),
  }),
  execute: async ({ getInitData, inputData }) => {
    const init = getInitData() as StageCtx;
    return await stageBaseline(init, { ...inputData, reuse: true });
  },
});

/* ── 6. one generation: train K variants, evaluate, promote, reflect ──── */
const generation = createStep({
  id: "generation",
  description: "Trainer fans out K sandboxes; Judge ranks and promotes; Architect revises",
  inputSchema: z.object({
    envConfigId: z.string(), variants: z.number(), baselineEvalId: z.string().nullable(),
    generation: z.number().default(0),
  }),
  outputSchema: z.object({
    envConfigId: z.string(), variants: z.number(), baselineEvalId: z.string().nullable(),
    generation: z.number(), done: z.boolean(), bestPolicyId: z.string().nullable(),
  }),
  execute: async ({ getInitData, inputData }) => {
    const init = getInitData() as StageCtx;
    return await stageGeneration(init, {
      envConfigId: inputData.envConfigId,
      variants: inputData.variants,
      baselineEvalId: inputData.baselineEvalId,
      generation: inputData.generation ?? 0,
      reuse: true,
    });
  },
});

/* ── 7. test phase: paired seeds, base | promoted, live ───────────────── */
const testPhase = createStep({
  id: "test",
  description: "Same sandboxes switch to test: half base, half promoted, paired seeds",
  inputSchema: generation.outputSchema,
  outputSchema: z.object({ bestPolicyId: z.string().nullable(), envConfigId: z.string() }),
  execute: async ({ getInitData, inputData }) => {
    const init = getInitData() as StageCtx;
    return await stageTest(init, {
      bestPolicyId: inputData.bestPolicyId, envConfigId: inputData.envConfigId,
    });
  },
});

/* ── 8. report ────────────────────────────────────────────────────────── */
const report = createStep({
  id: "report",
  description: "Judge writes the Field Report from this mission's own rows",
  inputSchema: testPhase.outputSchema,
  outputSchema: z.object({ status: z.string(), text: z.string().nullable() }),
  execute: async ({ getInitData }) => await stageReport(getInitData() as StageCtx),
});

/* ── the workflow ─────────────────────────────────────────────────────── */
export const missionWorkflow = createWorkflow({
  id: "mission",
  inputSchema: Ctx,
  outputSchema: report.outputSchema,
})
  .then(draft)
  .then(confirm)
  .parallel([research, curate])
  .then(design)
  .then(baseline)
  .dountil(generation, async ({ inputData }) => Boolean(inputData?.done))
  .then(testPhase)
  .then(report)
  .commit();
