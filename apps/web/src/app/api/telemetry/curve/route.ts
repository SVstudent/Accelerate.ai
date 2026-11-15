/**
 * Tiger-powered training curves, downsampled with LTTB inside the database.
 *
 * GET /api/telemetry/curve
 *   ?mission=msn_…            one of mission or run is required
 *   &run=run_…                a single sandbox
 *   &generation=1             all variants of one generation (needs run_dim)
 *   &source=episode|metric    episode_stats (default) or run_metrics
 *   &metrics=score,removal    comma separated, whitelisted in SQL
 *   &resolution=200           points per run, 3…5000
 *   &phase=train|test         episode source only
 *   &from=…&to=…              ISO timestamps
 *
 * A run emits thousands of episodes; the browser needs ~200 points. This route
 * does NOT fetch the rows and thin them in Node — it calls furrow_curve(),
 * which pre-buckets the hypertable and then applies timescaledb_toolkit's
 * lttb() (Largest-Triangle-Three-Buckets). LTTB keeps the points that carry
 * the curve's shape, so the spike where a reward term first fires and the step
 * where a run collapses survive the downsample. Bucketed averaging erases both.
 *
 * `raw_points` and `returned_points` are both reported so the UI can state the
 * compression honestly rather than implying it drew every episode.
 */
import { NextRequest, NextResponse } from "next/server";
import { tiger } from "@/db/tiger";
import {
  CURVE_METRICS, curveLttb, curveRawCount, groupCurve, runDims, syncRunDim,
  type CurveSource,
} from "@/lib/tiger-analytics";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const parseDate = (v: string | null) => {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};

export async function GET(req: NextRequest) {
  if (!tiger) {
    return NextResponse.json({ error: "TIGER_DATABASE_URL is not set" }, { status: 503 });
  }
  const started = Date.now();
  const q = req.nextUrl.searchParams;

  const missionId = q.get("mission");
  const runId = q.get("run");
  if (!missionId && !runId) {
    return NextResponse.json({ error: "pass ?mission= or ?run=" }, { status: 400 });
  }

  const source = (q.get("source") ?? "episode") as CurveSource;
  if (!(source in CURVE_METRICS)) {
    return NextResponse.json(
      { error: `source must be one of ${Object.keys(CURVE_METRICS).join(", ")}` },
      { status: 400 });
  }

  const allowed = CURVE_METRICS[source] as readonly string[];
  const metrics = (q.get("metrics") ?? q.get("metric") ?? (source === "episode" ? "score" : "entropy"))
    .split(",").map((m) => m.trim()).filter(Boolean);
  const bad = metrics.filter((m) => !allowed.includes(m));
  if (!metrics.length || bad.length) {
    return NextResponse.json(
      { error: `unknown metric(s) ${bad.join(", ")} for source ${source}`, allowed },
      { status: 400 });
  }

  const genRaw = q.get("generation");
  const generation = genRaw === null || genRaw === "" ? null : Number(genRaw);
  if (generation !== null && !Number.isInteger(generation)) {
    return NextResponse.json({ error: "generation must be an integer" }, { status: 400 });
  }

  const resRaw = Number(q.get("resolution") ?? 200);
  const resolution = Number.isFinite(resRaw) ? Math.max(3, Math.min(5000, Math.trunc(resRaw))) : 200;

  const scope = {
    missionId,
    runId,
    generation,
    resolution,
    phase: source === "episode" ? q.get("phase") : null,
    from: parseDate(q.get("from")),
    to: parseDate(q.get("to")),
  };

  try {
    // generation/variant live in Neon; mirror them so a ?generation= filter and
    // the series labels work. Throttled to once every few seconds.
    await syncRunDim(missionId).catch(() => {});
    const dims = await runDims(missionId);

    const series: Record<string, unknown> = {};
    let returned = 0;
    for (const metric of metrics) {
      const rows = await curveLttb(source, metric, scope);
      const grouped = groupCurve(rows, dims);
      returned += rows.length;
      series[metric] = grouped;
    }
    const raw = await curveRawCount(source, scope);

    return NextResponse.json({
      engine: {
        database: "tiger",
        downsample: "lttb",
        implementation: "timescaledb_toolkit.lttb (Largest-Triangle-Three-Buckets)",
        computed_in: "database",
        function: "furrow_curve",
      },
      scope: {
        mission_id: missionId, run_id: runId, generation,
        source, metrics, resolution, phase: scope.phase,
        from: scope.from?.toISOString() ?? null,
        to: scope.to?.toISOString() ?? null,
      },
      raw_points: raw,
      returned_points: returned,
      // how much the browser was spared, over all requested metrics
      reduction: raw > 0 ? Number((raw * metrics.length / Math.max(returned, 1)).toFixed(1)) : null,
      series,
      generated_in_ms: Date.now() - started,
    });
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message.slice(0, 300) }, { status: 500 });
  }
}
