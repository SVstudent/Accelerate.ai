"use client";
/**
 * Baseline vs promoted, same seed, same clock (DESIGN.md §4.2).
 *
 * Both fields are FieldScene instances driven by one playhead, so the two
 * rovers move through identical plant layouts frame for frame. Damage counters
 * above each field count the events that have fired up to the playhead; the
 * episode totals come from the replay's stored summary.
 *
 * Replay ids come from the mission stream's `replay` events, or from
 * ?base=rpl_…&cand=rpl_… when a particular pair should be shown.
 */
import { Suspense, use, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { FieldScene } from "@/components/arena/FieldScene";
import { useMission } from "@/lib/store";
import { useMissionStream } from "@/lib/useMissionStream";
import { C } from "@/lib/colors";
import { decodeReplay, type DecodedReplay } from "@/lib/replay-decode";
import type { ReplayResponse } from "@/app/api/replays/[id]/route";

const EM_DASH = "—";
const SPEEDS = [1, 2, 4] as const;

function reducedMotion(): boolean {
  if (typeof window === "undefined") return false;
  return !!window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
}

type Loaded = { res: ReplayResponse; dec: DecodedReplay };

/** Fetch + decode one replay. `loading` is derived from which id was answered. */
function useReplay(rid: string | null, replayMode: boolean) {
  const [answered, setAnswered] = useState<{
    rid: string | null; data: Loaded | null; error: string | null;
  }>({ rid: null, data: null, error: null });

  useEffect(() => {
    if (!rid) return;
    let gone = false;
    (async () => {
      try {
        const r = await fetch(`/api/replays/${rid}${replayMode ? "?replay=1" : ""}`,
          { cache: "no-store" });
        if (!r.ok) {
          const body = (await r.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error ?? `HTTP ${r.status}`);
        }
        const res = (await r.json()) as ReplayResponse;
        const dec = decodeReplay(res.data);
        if (!gone) setAnswered({ rid, data: { res, dec }, error: null });
      } catch (err) {
        if (!gone) setAnswered({ rid, data: null, error: (err as Error).message });
      }
    })();
    return () => { gone = true; };
  }, [rid, replayMode]);

  const fresh = answered.rid === rid;
  return {
    data: fresh ? answered.data : null,
    error: fresh ? answered.error : null,
    loading: !!rid && !fresh,
  };
}

function liveCounts(dec: DecodedReplay | undefined, t: number) {
  if (!dec) return { removed: 0, damaged: 0, misses: 0 };
  let removed = 0, misses = 0;
  const damaged = new Set<number>();
  for (const [et, pid, kind] of dec.events) {
    if (et > t) continue;
    if (kind === "removed_target") removed++;
    else if (kind === "removed_protect" || kind === "trampled_protect") damaged.add(pid);
    else if (kind === "miss") misses++;
  }
  return { removed, damaged: damaged.size, misses };
}

function Counters({ title, accent, loaded, t }: {
  title: string; accent: string; loaded: Loaded | null; t: number;
}) {
  const counts = liveCounts(loaded?.dec, t);
  const s = loaded?.res.summary ?? {};
  const totTargets = s.targets_total ?? null;
  const totProtect = s.protect_total ?? null;
  const fmtPct = (v: number | undefined) =>
    v === undefined || Number.isNaN(v) ? EM_DASH : `${Math.round(v * 100)}%`;

  return (
    <div className="flex items-end gap-6 px-4 py-2">
      <div>
        <div className="text-[11px] uppercase tracking-[0.18em]" style={{ color: accent }}>
          {title}
        </div>
        <div className="num text-[11px]" style={{ color: C.chaff600 }}>
          {loaded ? `${loaded.res.kind} · ${loaded.res.id}` : "no replay"}
        </div>
      </div>
      <div>
        <div className="text-[10px] uppercase tracking-wider" style={{ color: C.chaff600 }}>
          Crop damage
        </div>
        <div className="hero-num text-[30px]" style={{ color: counts.damaged ? C.blight500 : C.chaff200 }}>
          {loaded ? counts.damaged : EM_DASH}
          <span className="num text-[13px]" style={{ color: C.chaff600 }}>
            {totProtect !== null ? ` / ${totProtect}` : ""}
          </span>
        </div>
      </div>
      <div>
        <div className="text-[10px] uppercase tracking-wider" style={{ color: C.chaff600 }}>
          Weeds removed
        </div>
        <div className="hero-num text-[30px]" style={{ color: C.leaf400 }}>
          {loaded ? counts.removed : EM_DASH}
          <span className="num text-[13px]" style={{ color: C.chaff600 }}>
            {totTargets !== null ? ` / ${totTargets}` : ""}
          </span>
        </div>
      </div>
      <div className="num text-[11px] leading-snug" style={{ color: C.chaff400 }}>
        <div>episode removal {fmtPct(s.target_removal_rate)}</div>
        <div>episode damage {fmtPct(s.protect_damage_rate)}</div>
        <div>score {s.score === undefined ? EM_DASH : s.score.toFixed(3)}</div>
      </div>
    </div>
  );
}

function Panel({ title, accent, state, kind, t }: {
  title: string; accent: string;
  state: { data: Loaded | null; error: string | null; loading: boolean };
  kind: "baseline" | "promoted"; t: number;
}) {
  return (
    <section className="flex-1 min-w-0 flex flex-col border-r last:border-r-0"
      style={{ borderColor: C.soil700 }}>
      <Counters title={title} accent={accent} loaded={state.data} t={t} />
      <div className="flex-1 min-h-0 border-t" style={{ borderColor: C.soil800 }}>
        {state.data ? (
          <FieldScene
            replay={state.data.res.data}
            policyKind={kind}
            playing={false}
            t={t}
            showScrub={false}
            label={`${state.data.res.summary.steps_used ?? EM_DASH} steps`}
            className="h-full"
          />
        ) : (
          <div className="h-full grid place-items-center p-6 text-center">
            <div className="panel px-4 py-3 max-w-[340px] text-xs" style={{ color: C.chaff400 }}>
              {state.loading ? "loading replay…"
                : state.error ? <span style={{ color: C.blight500 }}>replay unavailable · {state.error}</span>
                : "No replay for this side yet. It appears once the evaluation writes one."}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

function Compare({ id }: { id: string }) {
  const search = useSearchParams();
  const router = useRouter();
  const replayMode = search.get("replay") === "1";

  useMissionStream(id, replayMode);
  const replays = useMission((s) => s.replays);
  const status = useMission((s) => s.status);

  // pick the pair: explicit ids win, else baseline + the newest evaluated policy
  const picked = useMemo(() => {
    const qBase = search.get("base");
    const qCand = search.get("cand");
    if (qBase || qCand) return { base: qBase, cand: qCand };

    const seedOf = (r: typeof replays[number]) =>
      (r.summary as { seed?: number } | null)?.seed ?? null;
    const base = replays.find((r) => r.kind === "baseline") ?? null;
    const evals = replays.filter((r) => r.kind === "eval");
    const checkpoints = replays
      .filter((r) => r.kind === "checkpoint")
      .sort((a, b) => (b.step ?? 0) - (a.step ?? 0));
    const sameSeed = base
      ? evals.find((r) => seedOf(r) !== null && seedOf(r) === seedOf(base))
      : undefined;
    const cand = sameSeed ?? evals.at(-1) ?? checkpoints[0] ?? null;
    return { base: base?.id ?? null, cand: cand?.id ?? null };
  }, [replays, search]);

  const baseState = useReplay(picked.base, replayMode);
  const candState = useReplay(picked.cand, replayMode);

  const frames = Math.min(
    baseState.data?.dec.frames ?? Number.POSITIVE_INFINITY,
    candState.data?.dec.frames ?? Number.POSITIVE_INFINITY,
  );
  const maxFrame = Number.isFinite(frames) ? Math.max(1, frames - 1) : 1;
  const dt = baseState.data?.dec.dt ?? candState.data?.dec.dt ?? 0.1;

  const [t, setT] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [speed, setSpeed] = useState<(typeof SPEEDS)[number]>(2);
  const tRef = useRef(0);
  useEffect(() => { tRef.current = t; }, [t]);

  // one clock for both fields
  useEffect(() => {
    if (!playing || !Number.isFinite(frames)) return;
    let raf = 0;
    let last = performance.now();
    const step = (now: number) => {
      const dtS = Math.min(0.2, (now - last) / 1000);
      last = now;
      const next = Math.min(maxFrame, tRef.current + (dtS / Math.max(0.001, dt)) * speed);
      tRef.current = next;
      setT(next);
      if (next < maxFrame) raf = requestAnimationFrame(step);
      else setPlaying(false);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [playing, speed, dt, maxFrame, frames]);

  // reduced motion: do not auto-run the comparison (the scrub bar still works)
  useEffect(() => {
    if (!reducedMotion()) return;
    const raf = requestAnimationFrame(() => setPlaying(false));
    return () => cancelAnimationFrame(raf);
  }, []);

  const restart = useCallback(() => {
    tRef.current = 0;
    setT(0);
    setPlaying(true);
  }, []);

  const seedBase = baseState.data?.dec.seed ?? null;
  const seedCand = candState.data?.dec.seed ?? null;
  const seedsMatch = seedBase !== null && seedCand !== null && seedBase === seedCand;

  return (
    <main className="h-screen w-screen flex flex-col overflow-hidden"
      style={{ background: C.soil950, color: C.chaff200 }}>
      <header className="h-12 shrink-0 flex items-center gap-3 px-4 border-b"
        style={{ borderColor: C.soil700 }}>
        <button onClick={() => router.push(`/m/${id}${replayMode ? "?replay=1" : ""}`)}
          className="chip hover:border-chaff-400" style={{ color: C.chaff400 }}>
          ← Console
        </button>
        <span className="font-medium tracking-wide">Before / after</span>
        <span className="num text-[11px]" style={{ color: C.chaff600 }}>
          {id} · {status}
        </span>
        {seedBase !== null && (
          <span className="chip num text-[11px]"
            style={{
              color: seedsMatch ? C.leaf400 : C.signal400,
              borderColor: seedsMatch ? `${C.leaf400}55` : `${C.signal400}55`,
            }}
            title={seedsMatch ? "identical field layout on both sides" : "the two replays used different seeds"}>
            {seedsMatch ? `same seed ${seedBase}` : `seeds ${seedBase} / ${seedCand ?? EM_DASH}`}
          </span>
        )}

        <div className="ml-auto flex items-center gap-2">
          <button onClick={() => setPlaying((p) => !p)} className="chip hover:border-chaff-400"
            style={{ color: C.signal400, borderColor: `${C.signal400}66` }}>
            {playing ? "❚❚ Pause" : "▶ Play"}
          </button>
          <button onClick={restart} className="chip hover:border-chaff-400"
            style={{ color: C.chaff400 }}>
            ↺ Restart
          </button>
          {SPEEDS.map((s) => (
            <button key={s} onClick={() => setSpeed(s)} className="chip num"
              style={{
                color: speed === s ? C.chaff200 : C.chaff600,
                borderColor: speed === s ? C.chaff400 : C.soil700,
              }}>
              {s}×
            </button>
          ))}
        </div>
      </header>

      <div className="flex-1 min-h-0 flex">
        <Panel title="Before · baseline policy" accent={C.sky400} state={baseState}
          kind="baseline" t={t} />
        <Panel title="After · promoted policy" accent={C.signal400} state={candState}
          kind="promoted" t={t} />
      </div>

      <footer className="shrink-0 border-t px-4 py-3 flex items-center gap-4"
        style={{ borderColor: C.soil700 }}>
        <input
          type="range"
          min={0}
          max={maxFrame}
          step={1}
          value={Math.round(t)}
          aria-label="scrub both fields"
          onChange={(e) => {
            const next = Number(e.target.value);
            tRef.current = next;
            setT(next);
            setPlaying(false);
          }}
          className="flex-1 h-1 appearance-none rounded-full"
          style={{
            background: `linear-gradient(to right, ${C.chaff400} ${(t / maxFrame) * 100}%, ${C.soil700} ${(t / maxFrame) * 100}%)`,
            accentColor: C.chaff200,
          }}
        />
        <span className="num text-[12px] shrink-0" style={{ color: C.chaff400 }}>
          {(t * dt).toFixed(1)}s / {(maxFrame * dt).toFixed(1)}s
        </span>
        {!picked.base && !picked.cand && (
          <span className="num text-[11px]" style={{ color: C.chaff600 }}>
            waiting for replays on the mission stream…
          </span>
        )}
      </footer>
    </main>
  );
}

export default function ComparePage(props: { params: Promise<{ id: string }> }) {
  const { id } = use(props.params);
  return (
    <Suspense
      fallback={
        <main className="h-screen grid place-items-center" style={{ background: C.soil950 }}>
          <span className="num text-xs" style={{ color: C.chaff600 }}>loading compare…</span>
        </main>
      }
    >
      <Compare id={id} />
    </Suspense>
  );
}
