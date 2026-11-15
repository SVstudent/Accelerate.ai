/**
 * Live divergence / collapse detection, so the observability platform can flag
 * a bad sandbox while it is still training.
 *
 * GET /api/telemetry/anomalies?mission=msn_…[&run=run_…][&lookback=6 hours]
 *   &collapse_frac=0.10   fall off the run's own peak, as a fraction of |peak|
 *   &entropy_drop=0.50    nats of policy entropy lost, final vs first quarter
 *   &kl_max=0.05          PPO trust-region ceiling on approx_kl p90
 *   &flat_var=1e-6        score variance below which a run counts as flatlined
 *   &stall_s=45           seconds behind the liveliest sibling
 *   &spread_mult=3        across-env sd vs the mission median
 *
 * Detection runs in SQL over the hypertables (furrow_anomalies), not in Node:
 *
 *   reward_regression  final-quarter mean reward below the first quarter
 *   reward_collapse    reward fell off its own peak by more than collapse_frac
 *   entropy_collapse   policy entropy dropped sharply — it stopped exploring
 *   kl_blowup          approx_kl p90 above the trust region
 *   reward_flatline    no variance left in the recent window
 *   step_flatline      global_step has not advanced in the recent window
 *   sandbox_stalled    stopped emitting while its siblings kept going
 *   env_divergence     the 32 envs disagree far more than the mission norm
 *   variance_blowup    episode spread doubled by the end: unstable
 *
 * Every verdict carries `observed`, `threshold` and a `detail` object with the
 * supporting numbers, so a flag can be checked rather than trusted.
 */
import { NextRequest, NextResponse } from "next/server";
import { tiger } from "@/db/tiger";
import { anomalies, runHealth, syncRunDim, type AnomalyThresholds } from "@/lib/tiger-analytics";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const n = (v: string | null, d: number) => {
  if (v === null || v === "") return d;
  const x = Number(v);
  return Number.isFinite(x) ? x : d;
};

export async function GET(req: NextRequest) {
  if (!tiger) {
    return NextResponse.json({ error: "TIGER_DATABASE_URL is not set" }, { status: 503 });
  }
  const started = Date.now();
  const q = req.nextUrl.searchParams;
  const missionId = q.get("mission");
  const runId = q.get("run");

  // free-text interval, but keep it to a shape Postgres will accept
  const lookbackRaw = q.get("lookback") ?? "6 hours";
  const lookback = /^[0-9]{1,6}\s*(second|minute|hour|day)s?$/i.test(lookbackRaw.trim())
    ? lookbackRaw.trim()
    : "6 hours";

  const th: AnomalyThresholds = {
    lookback,
    collapseFrac: n(q.get("collapse_frac"), 0.10),
    entropyDrop: n(q.get("entropy_drop"), 0.50),
    klMax: n(q.get("kl_max"), 0.05),
    flatVar: n(q.get("flat_var"), 1e-6),
    stallSeconds: n(q.get("stall_s"), 45),
    spreadMult: n(q.get("spread_mult"), 3.0),
  };

  try {
    await syncRunDim(missionId).catch(() => {});
    const [found, health] = await Promise.all([
      anomalies(missionId, runId, th),
      runHealth(missionId),
    ]);

    const byRun = new Map<string, { critical: number; warn: number; kinds: string[] }>();
    for (const a of found) {
      const e = byRun.get(a.run_id) ?? { critical: 0, warn: 0, kinds: [] };
      if (a.severity === "critical") e.critical++; else e.warn++;
      if (!e.kinds.includes(a.kind)) e.kinds.push(a.kind);
      byRun.set(a.run_id, e);
    }

    return NextResponse.json({
      engine: {
        database: "tiger",
        computed_in: "database",
        function: "furrow_anomalies",
        over: ["episode_stats", "run_metrics"],
      },
      scope: { mission_id: missionId, run_id: runId },
      thresholds: th,
      counts: {
        total: found.length,
        critical: found.filter((a) => a.severity === "critical").length,
        warn: found.filter((a) => a.severity === "warn").length,
      },
      anomalies: found,
      // one entry per flagged sandbox, for colouring the farm blocks
      by_run: [...byRun.entries()].map(([run_id, v]) => ({ run_id, ...v })),
      run_health: health,
      generated_in_ms: Date.now() - started,
    });
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message.slice(0, 300) }, { status: 500 });
  }
}
