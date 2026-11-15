"use client";
/**
 * End-of-mission Impact card (DESIGN.md §7).
 *
 * Four before → after numbers, then context lines taken ONLY from facts with
 * key='impact_stat', each printed with the domain it came from. Nothing on this
 * card is synthesised: a metric we do not have renders "—".
 *
 * Count-ups are disabled under prefers-reduced-motion.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { C } from "@/lib/colors";
import type { EvalRow } from "@/lib/store";
import type { EvalMetrics } from "@/lib/contracts";
import type { EvidenceFact, EvidencePayload } from "@/app/api/missions/[id]/evidence/route";

const EM_DASH = "—";

function reducedMotion(): boolean {
  if (typeof window === "undefined") return false;
  return !!window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
}

/**
 * Animated number, unless the viewer asked for less motion — then the real
 * value is shown immediately. A missing target stays null, so the caller can
 * print "—" rather than counting up to a number nobody measured.
 */
function useCountUp(target: number | null | undefined, ms = 700): number | null {
  const [anim, setAnim] = useState<number | null>(null);
  const fromRef = useRef<number>(0);
  useEffect(() => {
    if (target === null || target === undefined || Number.isNaN(target)) return;
    if (reducedMotion()) {
      fromRef.current = target;
      return;
    }
    const from = fromRef.current;
    const t0 = performance.now();
    let raf = 0;
    const step = (now: number) => {
      const k = Math.min(1, (now - t0) / ms);
      const eased = 1 - Math.pow(1 - k, 3);
      setAnim(from + (target - from) * eased);
      if (k < 1) raf = requestAnimationFrame(step);
      else fromRef.current = target;
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target, ms]);
  if (target === null || target === undefined || Number.isNaN(target)) return null;
  return anim ?? target;
}

function Pair({ label, before, after, lowerIsBetter = false }: {
  label: string; before?: number | null; after?: number | null; lowerIsBetter?: boolean;
}) {
  const live = useCountUp(after);
  const fmt = (x: number | null | undefined) =>
    x === null || x === undefined || Number.isNaN(x) ? EM_DASH : `${Math.round(x * 100)}%`;
  const delta = before != null && after != null ? after - before : null;
  const good = delta === null ? null : lowerIsBetter ? delta < 0 : delta > 0;
  return (
    <div className="min-w-[160px]">
      <div className="text-[11px] uppercase tracking-wider" style={{ color: C.chaff600 }}>
        {label}
      </div>
      <div className="flex items-baseline gap-2">
        <span className="num text-base" style={{ color: C.sky400, opacity: 0.7 }}>
          {fmt(before)}
        </span>
        <span style={{ color: C.chaff600 }}>→</span>
        <span className="hero-num text-[34px]" style={{ color: C.chaff200 }}>
          {fmt(live ?? after)}
        </span>
        {delta !== null && (
          <span
            className="chip num text-[11px]"
            style={{
              color: good ? C.leaf400 : C.blight500,
              borderColor: good ? `${C.leaf400}55` : `${C.blight500}55`,
            }}
          >
            {delta > 0 ? "▲" : "▼"} {Math.abs(Math.round(delta * 100))}
          </span>
        )}
      </div>
    </div>
  );
}

export function ImpactCard({
  missionId, evals, replayMode = false, reportText, facts: factsProp,
  perceptionBefore, perceptionAfter, onOpenCompare, onTryAnother, onClose,
}: {
  missionId: string;
  evals: EvalRow[];
  replayMode?: boolean;
  /** the Judge's written report on this mission, composed from its own rows */
  reportText?: string | null;
  /** pass facts in to avoid a second fetch; otherwise the card loads them */
  facts?: EvidenceFact[];
  perceptionBefore?: number | null;
  perceptionAfter?: number | null;
  onOpenCompare?: () => void;
  onTryAnother?: () => void;
  onClose?: () => void;
}) {
  const baseline = evals.find((e) => e.is_baseline)?.metrics as EvalMetrics | undefined;
  const best = useMemo(() => {
    const cands = evals.filter((e) => !e.is_baseline);
    if (!cands.length) return undefined;
    return cands.reduce((a, b) =>
      (b.metrics?.score?.mean ?? -Infinity) > (a.metrics?.score?.mean ?? -Infinity) ? b : a,
    ).metrics as EvalMetrics;
  }, [evals]);

  const [loaded, setLoaded] = useState<{
    facts: EvidenceFact[]; pb: number | null; pa: number | null;
  }>({ facts: [], pb: null, pa: null });
  const [showTranscript, setShowTranscript] = useState(false);
  const [reportNote, setReportNote] = useState<string | null>(null);

  // props win; anything not passed in comes from the evidence feed
  const facts = factsProp ?? loaded.facts;
  const pb = perceptionBefore ?? loaded.pb;
  const pa = perceptionAfter ?? loaded.pa;

  // the impact_stat context lines and the perception numbers live in the evidence feed
  useEffect(() => {
    if (factsProp && perceptionBefore != null && perceptionAfter != null) return;
    let gone = false;
    (async () => {
      try {
        const res = await fetch(
          `/api/missions/${missionId}/evidence${replayMode ? "?replay=1" : ""}`,
          { cache: "no-store" },
        );
        if (!res.ok) return;
        const body = (await res.json()) as EvidencePayload;
        if (gone) return;
        const m = body.perceptionModel?.metrics;
        setLoaded({
          facts: body.facts,
          pb: m?.zero_shot_acc ?? null,
          pa: m?.probe_acc ?? null,
        });
      } catch {
        /* the card still shows the metrics it has */
      }
    })();
    return () => { gone = true; };
  }, [missionId, replayMode, factsProp, perceptionBefore, perceptionAfter]);

  const impactStats = useMemo(
    () => facts.filter((f) => f.key === "impact_stat"),
    [facts],
  );

  const pctFmt = (x: number | null | undefined) =>
    x === null || x === undefined || Number.isNaN(x) ? EM_DASH : `${Math.round(x * 100)}%`;

  return (
    <div
      className="panel p-4 w-full max-w-[1100px] pointer-events-auto"
      style={{ background: C.soil900, boxShadow: "0 -8px 40px rgba(0,0,0,0.55)" }}
    >
      <div className="flex items-center gap-3">
        <span className="text-[11px] uppercase tracking-[0.2em]" style={{ color: C.signal400 }}>
          Mission impact
        </span>
        <span className="num text-[11px]" style={{ color: C.chaff600 }}>
          {missionId}
          {best?.n_episodes ? ` · ${best.n_episodes} eval episodes` : ""}
        </span>
        {onClose && (
          <button onClick={onClose} className="chip ml-auto hover:border-chaff-400"
            style={{ color: C.chaff400 }}>
            dismiss ✕
          </button>
        )}
      </div>

      <div className="mt-3 flex flex-wrap gap-x-8 gap-y-3">
        <Pair label="Weeds removed"
          before={baseline?.target_removal_rate?.mean} after={best?.target_removal_rate?.mean} />
        <Pair label="Crop damage" lowerIsBetter
          before={baseline?.protect_damage_rate?.mean} after={best?.protect_damage_rate?.mean} />
        <Pair label="Applications avoided"
          before={baseline?.applications_avoided_pct} after={best?.applications_avoided_pct} />
        <div className="min-w-[160px]">
          <div className="text-[11px] uppercase tracking-wider" style={{ color: C.chaff600 }}>
            Perception
          </div>
          <div className="flex items-baseline gap-2">
            <span className="num text-base" style={{ color: C.sky400, opacity: 0.7 }}>
              {pctFmt(pb)}
            </span>
            <span style={{ color: C.chaff600 }}>→</span>
            <span className="hero-num text-[34px]" style={{ color: C.leaf400 }}>
              {pctFmt(pa)}
            </span>
          </div>
          <div className="text-[10px]" style={{ color: C.chaff600 }}>
            zero-shot → web-trained
          </div>
        </div>
      </div>

      <div className="mt-3 border-t pt-3" style={{ borderColor: C.soil700 }}>
        {impactStats.length === 0 ? (
          <div className="text-[11px]" style={{ color: C.chaff600 }}>
            No impact_stat facts were gathered, so there is no context line to show.
          </div>
        ) : (
          <ul className="space-y-1">
            {impactStats.map((f) => (
              <li key={f.id} className="flex items-start gap-2 text-[12px]">
                <span style={{ color: C.signal400 }}>·</span>
                <span style={{ color: C.chaff200 }}>
                  {typeof f.value === "string" ? f.value : JSON.stringify(f.value)}
                  {f.unit ? ` ${f.unit}` : ""}
                </span>
                {f.url ? (
                  <a href={f.url} target="_blank" rel="noreferrer noopener"
                    className="num text-[11px] underline shrink-0" style={{ color: C.sky400 }}>
                    {f.domain ?? "source"}
                  </a>
                ) : (
                  <span className="num text-[11px] shrink-0" style={{ color: C.chaff600 }}>
                    {f.domain ?? EM_DASH}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      {showTranscript && reportText && (
        <div className="mt-2 panel px-3 py-2 text-[12px] leading-relaxed"
          style={{ background: C.soil950, color: C.chaff400 }}>
          {reportText}
        </div>
      )}
      {reportNote && (
        <div className="mt-2 text-[11px]" style={{ color: C.chaff600 }}>{reportNote}</div>
      )}

      <div className="mt-3 flex items-center gap-2">
        {reportText && (
          <button
            onClick={() => { setReportNote(null); setShowTranscript((s) => !s); }}
            className="chip hover:border-chaff-400 transition-colors"
            style={{ color: C.chaff400 }}
            title="the Judge's own write-up of this mission"
          >
            {showTranscript ? "hide the Judge's write-up" : "Judge's write-up"}
          </button>
        )}
        <button
          onClick={onOpenCompare}
          className="chip hover:border-chaff-400 transition-colors"
          style={{ color: C.sky400, borderColor: `${C.sky400}66` }}
        >
          Open compare
        </button>
        <button
          onClick={onTryAnother}
          className="chip hover:border-chaff-400 transition-colors"
          style={{ color: C.chaff400 }}
        >
          Try another skill
        </button>
      </div>
    </div>
  );
}
