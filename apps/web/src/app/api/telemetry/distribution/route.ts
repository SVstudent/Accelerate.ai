/**
 * Distributions, not bare means.
 *
 * GET /api/telemetry/distribution?mission=msn_…[&phase=train|test][&generation=1]
 *
 * The observability platform currently shows avg(score), avg(removal),
 * avg(damage). A policy with a good mean and terrible variance is not a good
 * policy, and a mean alone cannot tell the two apart. This route returns, for
 * every sandbox:
 *
 *   episodes   — the episode-level distribution: mean, sd, variance, p10/p50/p90
 *                (timescaledb_toolkit stats_agg + percentile_agg)
 *   envs       — the distribution ACROSS the 32 parallel environments: each env
 *                is reduced to its own mean first, so env_score_sd answers
 *                "does this policy work everywhere, or only on some tiles?"
 *                plus the worst and best env ids, which is what you click on.
 *   test_split — Before | After with p10/p50/p90 and sd attached.
 *
 * All of it is computed by Tiger over the hypertable; nothing is averaged here.
 */
import { NextRequest, NextResponse } from "next/server";
import { tiger } from "@/db/tiger";
import {
  genVariantRollup, generationRollup, runDistribution, runEnvSpread,
  syncRunDim, testSplitDist,
} from "@/lib/tiger-analytics";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  if (!tiger) {
    return NextResponse.json({ error: "TIGER_DATABASE_URL is not set" }, { status: 503 });
  }
  const started = Date.now();
  const q = req.nextUrl.searchParams;
  const missionId = q.get("mission");
  if (!missionId) {
    return NextResponse.json({ error: "pass ?mission=" }, { status: 400 });
  }
  const phase = q.get("phase");
  const genRaw = q.get("generation");
  const generation = genRaw === null || genRaw === "" ? null : Number(genRaw);
  if (generation !== null && !Number.isInteger(generation)) {
    return NextResponse.json({ error: "generation must be an integer" }, { status: 400 });
  }
  const includeRollup = q.get("rollup") !== "0";

  try {
    await syncRunDim(missionId).catch(() => {});

    const [episodes, envs, split] = await Promise.all([
      runDistribution(missionId, phase),
      runEnvSpread(missionId, phase),
      testSplitDist(missionId),
    ]);

    const rollup = includeRollup
      ? await Promise.all([
          generationRollup(missionId, generation),
          genVariantRollup(missionId, generation),
        ])
      : null;

    return NextResponse.json({
      engine: {
        database: "tiger",
        hyperfunctions: ["stats_agg", "percentile_agg", "hyperloglog"],
        percentiles: "approx_percentile over uddsketch (~0.1% relative error)",
        variance: "exact (stats_agg keeps a Welford summary, not a sample)",
        source_view: "episode_stats_exact",
        note:
          "episode_stats_exact deduplicates the Neon→Tiger relay, which can " +
          "deliver the same row more than once. Nothing is deleted; the view " +
          "reads DISTINCT over the natural key.",
      },
      scope: { mission_id: missionId, phase, generation },
      episodes,
      envs,
      test_split: split,
      generation_rollup: rollup?.[0] ?? null,
      gen_variant_rollup: rollup?.[1] ?? null,
      generated_in_ms: Date.now() - started,
    });
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message.slice(0, 300) }, { status: 500 });
  }
}
