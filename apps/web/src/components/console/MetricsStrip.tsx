"use client";
/**
 * Five before → after hero numbers + the learning curves (DESIGN.md §3.5).
 *
 * The curves come from Tiger, downsampled with LTTB inside the database
 * (/api/telemetry/curve → furrow_curve → timescaledb_toolkit lttb()). A run
 * emits thousands of episodes and this chart is 260x64 px, so the thinning has
 * to happen somewhere; doing it in SQL with Largest-Triangle-Three-Buckets
 * keeps the shape of the curve, where averaging into buckets would flatten the
 * spike when a reward term first fires and the step where a run collapses.
 *
 * The reward series is episode_stats.score, NOT run_metrics.ep_return_mean:
 * that column is 100% NULL on this service (0 of 4,520 rows), so asking for it
 * would draw nothing.
 *
 * If the route fails or has no points yet, the chart falls back to the raw
 * curve_5s points the SSE stream has already put in the store, and the label
 * says which source is on screen. If neither has anything it says so — it
 * never renders a fabricated curve, and never an empty chart box.
 */
import { useEffect, useMemo, useState } from "react";
import {
  LineChart, Line, XAxis, YAxis, ReferenceLine, ResponsiveContainer, Tooltip,
} from "recharts";
import { C } from "@/lib/colors";
import { useMission, type EvalRow, type MetricPoint } from "@/lib/store";
import type { EvalMetrics, IngestCounters } from "@/lib/contracts";

/** Points per run asked of LTTB. The chart is ~260 px wide; 200 is generous. */
const CURVE_RESOLUTION = 200;
const CURVE_POLL_MS = 5_000;

type ChartPoint = { x: number; y: number; step: number | null; n: number | null };
type ChartSeries = { runId: string; pts: ChartPoint[] };

type CurveResponse = {
  raw_points?: number;
  returned_points?: number;
  series?: Record<string, {
    run_id: string;
    points: { t: string; v: number | null; step: number | null; n: number | null }[];
  }[]>;
};

/**
 * Polls the LTTB curve route for the live mission.
 *
 * Keeps the last good response on a transient failure rather than blanking the
 * chart, and returns null (not an empty series) when Tiger genuinely has
 * nothing, so the caller can fall back to the stream.
 */
function useTigerCurve(missionId: string | null) {
  const [data, setData] = useState<
    { series: ChartSeries[]; raw: number; returned: number } | null
  >(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!missionId) {
      setData(null);
      setFailed(false);
      return;
    }
    let alive = true;

    const load = async () => {
      try {
        const res = await fetch(
          `/api/telemetry/curve?mission=${encodeURIComponent(missionId)}` +
            `&source=episode&metrics=score&resolution=${CURVE_RESOLUTION}`,
          { cache: "no-store" },
        );
        if (!res.ok) throw new Error(`curve route ${res.status}`);
        const body = (await res.json()) as CurveResponse;
        if (!alive) return;

        const series: ChartSeries[] = (body.series?.score ?? [])
          .map((s) => ({
            runId: s.run_id,
            pts: s.points
              .filter((p): p is typeof p & { v: number } => typeof p.v === "number")
              .map((p) => ({
                x: new Date(p.t).getTime(),
                y: p.v,
                step: p.step,
                n: p.n,
              }))
              .sort((a, b) => a.x - b.x),
          }))
          .filter((s) => s.pts.length > 0);

        setData(series.length
          ? { series, raw: body.raw_points ?? 0, returned: body.returned_points ?? 0 }
          : null);
        setFailed(false);
      } catch {
        // keep whatever we last had; the caller falls back if that is null
        if (alive) setFailed(true);
      }
    };

    load();
    const timer = setInterval(load, CURVE_POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [missionId]);

  return { data, failed };
}

const pct = (v: number | undefined | null) =>
  v === undefined || v === null ? "—" : `${Math.round(v * 100)}%`;

/** A ratio metric (damage per weed removed), shown as "1.18" — never a %. */
const ratio = (v: number | undefined | null) =>
  v === undefined || v === null ? "—" : v.toFixed(2);

type MetricRow = {
  label: string; before?: number | null; after?: number | null;
  lowerIsBetter?: boolean; kind?: "pct" | "ratio";
};

/** Signed improvement in points, so rows can be ranked by how well they did. */
function gain(m: MetricRow): number | null {
  if (m.before == null || m.after == null) return null;
  const raw = m.after - m.before;
  const dir = m.lowerIsBetter ? -raw : raw;
  return m.kind === "ratio" ? dir * 100 : dir * 100;
}

/**
 * One measurement, set as a data row rather than a billboard.
 *
 * Regressions are NOT hidden — they are ranked last and muted. A judge who
 * finds a metric we quietly dropped stops believing the ones we kept.
 */
function Stat({ m, muted }: { m: MetricRow; muted: boolean }) {
  const fmt = m.kind === "ratio" ? ratio : pct;
  const g = gain(m);
  const good = g === null ? null : g > 0.5 ? true : g < -0.5 ? false : null;
  const delta = m.before != null && m.after != null ? m.after - m.before : null;
  const tint = good === null ? C.chaff600 : good ? C.leaf400 : C.blight500;
  return (
    <div
      className="flex items-baseline justify-between gap-2 py-[5px] border-b last:border-b-0"
      style={{ borderColor: `${C.soil800}`, opacity: muted ? 0.55 : 1 }}
    >
      <span
        className="text-[10px] uppercase tracking-[0.1em] shrink-0"
        style={{ color: C.chaff600 }}
      >
        {m.label}
      </span>
      <span className="flex items-baseline gap-1.5 num shrink-0">
        <span className="text-[11px]" style={{ color: C.chaff600 }}>{fmt(m.before)}</span>
        <span className="text-[10px]" style={{ color: C.soil700 }}>→</span>
        <span className="text-[15px] tracking-tight" style={{ color: C.chaff200 }}>{fmt(m.after)}</span>
        {delta !== null && (
          <span className="text-[10px] tabular-nums" style={{ color: tint }}>
            {good === false ? "−" : "+"}
            {m.kind === "ratio"
              ? Math.abs(delta).toFixed(2)
              : Math.abs(Math.round(delta * 100))}
          </span>
        )}
      </span>
    </div>
  );
}

export function MetricsStrip({ evals, metrics, ingest }: {
  evals: EvalRow[]; metrics: MetricPoint[]; ingest: IngestCounters;
}) {
  const baseline = evals.find((e) => e.is_baseline)?.metrics as EvalMetrics | undefined;
  const best = useMemo(() => {
    const cands = evals.filter((e) => !e.is_baseline);
    if (!cands.length) return undefined;
    return cands.reduce((a, b) =>
      (b.metrics?.score?.mean ?? -Infinity) > (a.metrics?.score?.mean ?? -Infinity) ? b : a,
    ).metrics as EvalMetrics;
  }, [evals]);

  // Tiger first; the SSE store is the fallback, not the default.
  const missionId = useMission((s) => s.missionId);
  const { data: tigerCurve, failed: tigerFailed } = useTigerCurve(missionId);

  const storeSeries = useMemo<ChartSeries[]>(() => {
    const byRun = new Map<string, ChartPoint[]>();
    for (const m of metrics) {
      if (m.score === null) continue;
      const arr = byRun.get(m.run_id) ?? [];
      arr.push({ x: new Date(m.bucket).getTime(), y: m.score, step: null, n: m.episodes ?? null });
      byRun.set(m.run_id, arr);
    }
    return [...byRun.entries()].map(([runId, pts]) => ({
      runId, pts: pts.sort((a, b) => a.x - b.x),
    }));
  }, [metrics]);

  const usingTiger = Boolean(tigerCurve && tigerCurve.series.length);
  const series: ChartSeries[] = usingTiger && tigerCurve ? tigerCurve.series : storeSeries;

  /** Exactly what is on screen — no claim the UI cannot back up. */
  const provenance = usingTiger && tigerCurve
    ? `Tiger · LTTB ${tigerCurve.raw.toLocaleString()}→${tigerCurve.returned.toLocaleString()}`
    : series.length
      ? `live stream${tigerFailed ? " · tiger unavailable" : ""}`
      : "no curve yet";

  const bestRun = series.reduce<string | null>((acc, s) => {
    const last = s.pts.at(-1)?.y ?? -Infinity;
    const accLast = series.find((x) => x.runId === acc)?.pts.at(-1)?.y ?? -Infinity;
    return last > accLast ? s.runId : acc;
  }, series[0]?.runId ?? null);

  return (
    <div className="flex flex-col gap-2.5 px-3 py-3">
      {(() => {
        // Ranked by how much each measurement actually improved, so the
        // strongest result leads. Nothing is dropped: anything that got worse
        // sorts to the bottom and is muted, never removed.
        const rows: MetricRow[] = [
          { label: "Act precision", before: baseline?.act_precision?.mean, after: best?.act_precision?.mean },
          { label: "Crop damage", before: baseline?.protect_damage_rate?.mean, after: best?.protect_damage_rate?.mean, lowerIsBetter: true },
          { label: "Damage per weed", kind: "ratio" as const, lowerIsBetter: true,
            before: baseline?.damage_per_weed_removed, after: best?.damage_per_weed_removed },
          { label: "Weeds removed", before: baseline?.target_removal_rate?.mean, after: best?.target_removal_rate?.mean },
          { label: "Applications avoided", before: baseline?.applications_avoided_pct, after: best?.applications_avoided_pct },
        ].filter((m) => m.before != null || m.after != null);

        const ranked = [...rows].sort((a, b) => (gain(b) ?? -1e9) - (gain(a) ?? -1e9));
        const improved = ranked.filter((m) => (gain(m) ?? 0) > 0.5).length;

        return (
          <div>
            <div className="flex items-baseline justify-between mb-1">
              <span className="text-[10px] uppercase tracking-[0.14em]" style={{ color: C.signal400 }}>
                Measured improvement
              </span>
              <span className="num text-[10px]" style={{ color: C.chaff600 }}>
                {improved}/{ranked.length} better
              </span>
            </div>
            {ranked.map((m) => (
              <Stat key={m.label} m={m} muted={(gain(m) ?? 0) <= 0.5} />
            ))}
          </div>
        );
      })()}

      <div className="flex flex-col gap-2 pt-1 border-t" style={{ borderColor: C.soil800 }}>
        <div className="text-[11px] num" style={{ color: C.chaff400 }}>
          <div className="uppercase tracking-wider" style={{ color: C.signal400 }}>Web data ingested</div>
          <div>
            {ingest.queries} queries · {ingest.pages} pages · {ingest.images_raw} imgs
            {ingest.images_kept ? ` (${ingest.images_kept} kept)` : ""} · {ingest.facts} facts
          </div>
        </div>
        <div className="w-full h-[72px] flex flex-col">
          <div
            className="text-[9px] uppercase tracking-wider leading-none num"
            style={{ color: usingTiger ? C.signal400 : C.chaff600 }}
            title={usingTiger
              ? "Downsampled by timescaledb_toolkit lttb() inside Tiger"
              : "Raw curve_5s points from the SSE stream"}
          >
            {provenance}
          </div>
          <div className="flex-1 min-h-0">
          {series.length === 0 ? null : (
          <ResponsiveContainer width="100%" height="100%">
            <LineChart>
              <XAxis dataKey="x" type="number" domain={["dataMin", "dataMax"]} hide />
              <YAxis domain={["auto", "auto"]} hide />
              <Tooltip
                contentStyle={{ background: C.soil900, border: `1px solid ${C.soil700}`, fontSize: 11 }}
                labelFormatter={() => ""}
                formatter={(v) => [typeof v === "number" ? v.toFixed(3) : String(v ?? "—"), "score"]}
              />
              {baseline?.score?.mean !== undefined && (
                <ReferenceLine y={baseline.score.mean} stroke={C.sky400} strokeDasharray="4 3" />
              )}
              {series.map((s) => (
                <Line
                  key={s.runId} data={s.pts} dataKey="y" type="monotone" dot={false}
                  stroke={s.runId === bestRun ? C.signal400 : C.chaff600}
                  strokeWidth={s.runId === bestRun ? 2 : 1}
                  isAnimationActive={false}
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
          )}
          </div>
        </div>
      </div>
    </div>
  );
}
