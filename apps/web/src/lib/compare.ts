/**
 * Side-by-side comparison of one mission across two Neon branches.
 *
 * Both sides are the SAME mission id read through two different branches, so
 * the comparison is "the original timeline" against "the alternate one" — not
 * two rows that happen to look similar. The reuse evidence is part of the
 * answer: identical source / fact / image counts on both sides are proof that
 * the fork re-ran the pipeline without re-scraping or re-curating anything.
 *
 * Lives in lib/ (not in the route) so the fork verification scripts exercise
 * exactly the code the API serves.
 */
import { and, desc, eq } from "drizzle-orm";
import { closeBranchDb, db, schema, withBranchDb } from "@/db";
import type { TaskSpec } from "@/lib/contracts";
import { connectionUri } from "@/lib/neon";

export type MissionSnapshot = {
  branch: string | null;
  status: string;
  priorities: TaskSpec["priorities"] | null;
  budget: TaskSpec["budget"] | null;
  counts: {
    sources: number; facts: number; images: number;
    perception_models: number; reward_specs: number; runs: number; evaluations: number;
  };
  perception: { probe_acc: number | null; zero_shot_acc: number | null } | null;
  baseline: Record<string, unknown> | null;
  best: Record<string, unknown> | null;
  best_policy_id: string | null;
  reward_rationales: { generation: number; variant: number; rationale: string }[];
  field_report: string | null;
};

export const meanOf = (m: Record<string, unknown> | null, key: string): number | null => {
  const v = (m ?? {})[key] as { mean?: number } | undefined;
  return typeof v?.mean === "number" ? v.mean : null;
};
const pct = (v: number | null) => (v === null ? null : Math.round(v * 1000) / 10);

/** Everything the comparison needs, read through whichever branch is bound. */
export async function missionSnapshot(
  missionId: string, branchLabel: string | null,
): Promise<MissionSnapshot | null> {
  const [m] = await db.select().from(schema.missions)
    .where(eq(schema.missions.id, missionId)).limit(1);
  if (!m) return null;
  const spec = (m.taskSpec ?? null) as TaskSpec | null;

  const [sources, facts, images, perception_models, reward_specs, runs, evaluations] =
    await Promise.all([
      db.$count(schema.sources, eq(schema.sources.missionId, missionId)),
      db.$count(schema.facts, eq(schema.facts.missionId, missionId)),
      db.$count(schema.datasetItems, eq(schema.datasetItems.missionId, missionId)),
      db.$count(schema.perceptionModels, eq(schema.perceptionModels.missionId, missionId)),
      db.$count(schema.rewardSpecs, eq(schema.rewardSpecs.missionId, missionId)),
      db.$count(schema.runs, eq(schema.runs.missionId, missionId)),
      db.$count(schema.evaluations, eq(schema.evaluations.missionId, missionId)),
    ]);

  const [pm] = await db.select().from(schema.perceptionModels)
    .where(eq(schema.perceptionModels.missionId, missionId))
    .orderBy(desc(schema.perceptionModels.createdAt)).limit(1);
  const pmMetrics = (pm?.metrics ?? null) as { probe_acc?: number; zero_shot_acc?: number } | null;

  const allEvals = await db.select().from(schema.evaluations)
    .where(eq(schema.evaluations.missionId, missionId));
  const baseline = allEvals.find((e) => e.isBaseline)?.metrics ?? null;
  const best = allEvals.filter((e) => !e.isBaseline).sort((a, b) =>
    ((b.metrics as { score?: { mean?: number } })?.score?.mean ?? -Infinity) -
    ((a.metrics as { score?: { mean?: number } })?.score?.mean ?? -Infinity))[0]?.metrics ?? null;

  const specs = await db.select({
    generation: schema.rewardSpecs.generation,
    variant: schema.rewardSpecs.variant,
    rationale: schema.rewardSpecs.rationale,
  }).from(schema.rewardSpecs)
    .where(eq(schema.rewardSpecs.missionId, missionId))
    .orderBy(desc(schema.rewardSpecs.createdAt)).limit(4);

  const [reportEvent] = await db.select({
    title: schema.agentEvents.title, payload: schema.agentEvents.payload,
  }).from(schema.agentEvents)
    .where(and(
      eq(schema.agentEvents.missionId, missionId),
      eq(schema.agentEvents.kind, "report"),
      eq(schema.agentEvents.agent, "judge"),
    ))
    .orderBy(desc(schema.agentEvents.ts)).limit(1);
  const payload = (reportEvent?.payload ?? {}) as { text?: string; report?: { text?: string } };

  return {
    branch: branchLabel,
    status: m.status,
    priorities: spec?.priorities ?? null,
    budget: spec?.budget ?? null,
    counts: {
      sources: Number(sources), facts: Number(facts), images: Number(images),
      perception_models: Number(perception_models), reward_specs: Number(reward_specs),
      runs: Number(runs), evaluations: Number(evaluations),
    },
    perception: pmMetrics
      ? { probe_acc: pmMetrics.probe_acc ?? null, zero_shot_acc: pmMetrics.zero_shot_acc ?? null }
      : null,
    baseline: (baseline ?? null) as Record<string, unknown> | null,
    best: (best ?? null) as Record<string, unknown> | null,
    best_policy_id: m.bestPolicyId ?? null,
    reward_rationales: specs.map((s) => ({
      generation: s.generation, variant: s.variant, rationale: (s.rationale ?? "").slice(0, 400),
    })),
    field_report: payload.text ?? payload.report?.text ?? reportEvent?.title ?? null,
  };
}

export type ForkComparison = {
  mission_id: string;
  fork: {
    id: string; from_stage: string; overrides: unknown; label: string | null;
    status: string; neon_branch_id: string; neon_branch_name: string;
  };
  original: MissionSnapshot;
  forked: MissionSnapshot | null;
  headline: Record<string, number | null> | null;
  delta: {
    target_removal_rate_pp: number | null;
    protect_damage_rate_pp: number | null;
    score: number | null;
    reused_without_rescraping: boolean;
  } | null;
};

export type ForkRow = typeof schema.missionForks.$inferSelect;

/**
 * Read the mission on this branch and on the fork's branch, and diff them.
 * `uri` lets a caller that already holds the branch connection string reuse it;
 * otherwise it is fetched from the Neon API.
 */
export async function compareWithFork(
  missionId: string, fork: ForkRow, uri?: string,
): Promise<ForkComparison | { error: string; status: number }> {
  const original = await missionSnapshot(missionId, process.env.NEON_BRANCH ?? "main");
  if (!original) return { error: "mission not found", status: 404 };

  let branchUri = uri;
  let opened = false;
  if (!branchUri) {
    try {
      branchUri = await connectionUri(fork.neonBranchId);
      opened = true;
    } catch (err) {
      return { error: `could not reach the fork branch: ${(err as Error).message}`, status: 502 };
    }
  }
  let forked: MissionSnapshot | null = null;
  try {
    forked = await withBranchDb(branchUri, () => missionSnapshot(missionId, fork.neonBranchName));
  } finally {
    if (opened) await closeBranchDb(branchUri);
  }

  const delta = forked ? {
    target_removal_rate_pp: (() => {
      const a = meanOf(original.best, "target_removal_rate");
      const b = meanOf(forked.best, "target_removal_rate");
      return a !== null && b !== null ? Math.round((b - a) * 1000) / 10 : null;
    })(),
    protect_damage_rate_pp: (() => {
      const a = meanOf(original.best, "protect_damage_rate");
      const b = meanOf(forked.best, "protect_damage_rate");
      return a !== null && b !== null ? Math.round((b - a) * 1000) / 10 : null;
    })(),
    score: (() => {
      const a = meanOf(original.best, "score");
      const b = meanOf(forked.best, "score");
      return a !== null && b !== null ? Math.round((b - a) * 1000) / 1000 : null;
    })(),
    // the whole point of branching: the fork did not pay for the web again
    reused_without_rescraping:
      forked.counts.sources === original.counts.sources &&
      forked.counts.facts === original.counts.facts &&
      forked.counts.images === original.counts.images,
  } : null;

  return {
    mission_id: missionId,
    fork: {
      id: fork.id, from_stage: fork.fromStage, overrides: fork.overrides,
      label: fork.label, status: fork.status,
      neon_branch_id: fork.neonBranchId, neon_branch_name: fork.neonBranchName,
    },
    original,
    forked,
    headline: forked ? {
      original_weeds_removed_pct: pct(meanOf(original.best, "target_removal_rate")),
      forked_weeds_removed_pct: pct(meanOf(forked.best, "target_removal_rate")),
      original_crop_damage_pct: pct(meanOf(original.best, "protect_damage_rate")),
      forked_crop_damage_pct: pct(meanOf(forked.best, "protect_damage_rate")),
    } : null,
    delta,
  };
}
