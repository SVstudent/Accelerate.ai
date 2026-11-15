"use client";
/**
 * Observability platform.
 *
 * Driven by REAL telemetry: the SSE stream carries live_frames that Daytona
 * sandboxes wrote while training, relayed through Neon into Tiger. Click a
 * sandbox block or a single field for the close-up, with the hard technical
 * evidence beside it — real sandbox ids, PPO throughput, row counts in both
 * databases, Bright Data request counters.
 *
 * If no mission has telemetry yet it says so, rather than quietly showing
 * synthetic motion and passing it off as a training run.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { FarmScene, type FarmBlock } from "@/components/arena/FarmScene";
import { useMission } from "@/lib/store";
import { useMissionStream } from "@/lib/useMissionStream";
import { C, scoreColor } from "@/lib/colors";

type Obs = {
  mission: Record<string, unknown>;
  sandboxes: {
    run_id: string; sandbox_id: string | null; generation: number; variant: number;
    status: string; progress: number; error: string | null;
    n_envs: number | null; total_steps: number | null;
    reward: { id: string; rationale: string; dry_run: Record<string, unknown> | null; code_lines: number } | null;
    live: {
      episodes: number; global_step: number | null; fps: number | null;
      score_mean: number | null; removal_mean: number | null; damage_mean: number | null;
      precision_mean: number | null; ep_return_mean: number | null; approx_kl: number | null;
      last_seen: string | null;
    } | null;
  }[];
  perception: { id: string; arch: string; metrics: Record<string, number> } | null;
  env_config: { id: string; provenance: { param: string; value: unknown; fact_id: string | null; assumed: boolean }[] } | null;
  evaluations: { id: string; is_baseline: boolean; metrics: Record<string, { mean: number }> }[];
  data_plane: Record<string, Record<string, unknown>>;
};

const num = (v: unknown, d = 2) =>
  v === null || v === undefined || Number.isNaN(Number(v)) ? "—" : Number(v).toFixed(d);
const int = (v: unknown) =>
  v === null || v === undefined ? "—" : Number(v).toLocaleString();

function Stat({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-[3px]">
      <span className="text-[11px] uppercase tracking-wider text-chaff-600">{label}</span>
      <span className="num text-[13px]" style={{ color: color ?? C.chaff200 }}>{value}</span>
    </div>
  );
}

export default function Observatory() {
  const [missionId, setMissionId] = useState<string | null>(null);
  const [missions, setMissions] = useState<{ id: string; goal_text: string; status: string }[]>([]);
  const [obs, setObs] = useState<Obs | null>(null);
  // env === null means "the whole sandbox room is selected", not one field
  const [selected, setSelected] = useState<{ runId: string; env: number | null } | null>(null);
  const [mode, setMode] = useState<"farm" | "test">("farm");
  // The front door: type what you want improved, press enter, the recorded run
  // opens. Skipped when a ?mission= link was used, which is the judge's path.
  // A finished mission has no live stream — its frames are recorded. Replay is
  // therefore not an option for it, it is the only way to see anything, so the
  // arena asks for replay automatically rather than sitting empty.
  const [replayOverride, setReplayOverride] = useState<boolean | null>(null);
  // The sandboxes are what people came to look at. Everything else folds away.
  const [showLeft, setShowLeft] = useState(true);
  const [showRight, setShowRight] = useState(true);
  const [showLegend, setShowLegend] = useState(true);
  const [askedFor, setAskedFor] = useState<string | null>(null);
  const activeRunId = useMission((s) => s.activeRunId);
  const [frame, setFrame] = useState(0);

  // Always load the mission list so the picker has options; a ?mission= in the
  // URL only decides which one starts selected. Returning early on the URL
  // param left the dropdown permanently empty.
  useEffect(() => {
    const q = new URLSearchParams(window.location.search).get("mission");
    if (q) setMissionId(q);
    fetch("/api/missions?limit=30")
      .then((r) => r.json())
      .then(async (d) => {
        const all = (d.missions ?? []) as { id: string; goal_text: string; status: string }[];
        const real = all.filter((m) => !/test|probe|itest|bdtest|scouttest|curatortest|foremantest/i.test(m.id));
        const pool = real.length ? real : all;
        setMissions(pool);
        if (q) return;                      // the URL already chose one
        if (!pool.length) return;
        // otherwise prefer a mission that actually has sandbox telemetry
        for (const m of pool) {
          try {
            const o = await fetch(`/api/observability/${m.id}`).then((r) => (r.ok ? r.json() : null));
            const t = o?.data_plane?.tiger ?? {};
            if ((o?.sandboxes ?? []).length > 0 || Number(t.live_frames_rows ?? 0) > 0) {
              setMissionId(m.id);
              return;
            }
          } catch { /* keep looking */ }
        }
        setMissionId(pool[0].id);
      })
      .catch(() => {});
  }, []);

  const selectedMission = missions.find((m) => m.id === missionId);
  const isFinished = selectedMission
    ? selectedMission.status === "done" || selectedMission.status === "stalled"
    : false;
  const replay = replayOverride ?? isFinished;
  useMissionStream(missionId, replay);

  const live = useMission((s) => s.live);
  const runs = useMission((s) => s.runs);
  const heat = useMission((s) => s.heat);
  const status = useMission((s) => s.status);
  const phaseDetail = useMission((s) => s.phaseDetail);
  const ingest = useMission((s) => s.ingest);
  const events = useMission((s) => s.events);
  const farmBlocks = useMission((s) => s.farmBlocks);

  // the real Daytona sandbox id + progress, so the room's label plate carries
  // evidence rather than a nickname
  const meta = useMemo(() => {
    const m = new Map<string, {
      sandboxId: string | null; progress: number | null; pruned: boolean;
      generation: number; variant: number;
    }>();
    for (const s of obs?.sandboxes ?? []) {
      m.set(s.run_id, {
        sandboxId: s.sandbox_id ?? null,
        progress: typeof s.progress === "number" ? s.progress : null,
        pruned: s.status === "pruned",
        // carried so the arena can give each room a FIXED slot
        generation: s.generation ?? 99,
        variant: s.variant ?? 99,
      });
    }
    return m;
  }, [obs]);

  const blocks = useMemo<FarmBlock[]>(() => {
    const mapped = farmBlocks().map((b) => {
      const m = meta.get(b.runId);
      const base = m ? { ...b, ...m } : { ...b };
      // the sandbox that streamed the newest frame, flagged for the arena
      return { ...base, active: b.runId === activeRunId };
    });
    // Room POSITION is derived from array index, so the order must never
    // change while a replay streams — filtering or re-sorting as rooms gain
    // data made every other room jump to a new slot, which is the "glitching"
    // the arena was showing. Sort by a stable key and keep the list fixed;
    // rooms that have no frames yet simply draw nothing in their own slot.
    const key = (b: FarmBlock) => {
      const m = meta.get(b.runId);
      const g = m?.generation ?? 99;
      const v = m?.variant ?? 99;
      return `${String(g).padStart(2, "0")}:${String(v).padStart(2, "0")}:${b.runId}`;
    };
    return mapped.sort((a, b) => key(a).localeCompare(key(b)));
  }, [farmBlocks, live, runs, heat, meta, activeRunId]);
  const hasTelemetry = blocks.some((b) => !b.booting && b.envs.length > 0);

  // technical evidence, refreshed while the mission runs
  const pull = useCallback(() => {
    if (!missionId) return;
    fetch(`/api/observability/${missionId}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => d && setObs(d))
      .catch(() => {});
  }, [missionId]);
  useEffect(() => {
    pull();
    const t = setInterval(pull, 3000);
    return () => clearInterval(t);
  }, [pull]);

  useEffect(() => {
    const t = setInterval(() => setFrame((f) => f + 1), 50);
    return () => clearInterval(t);
  }, []);

  const sel = selected
    ? obs?.sandboxes.find((s) => s.run_id === selected.runId) ?? null
    : null;
  const selBlock = selected
    ? blocks.find((b) => b.runId === selected.runId) ?? null
    : null;
  const selEnv = selected && selected.env !== null
    ? selBlock?.envs.find((e) => e.env === selected.env) ?? null
    : null;

  const dp = obs?.data_plane ?? {};
  const neon = (dp.neon ?? {}) as Record<string, number>;
  const tigerRows = (dp.tiger ?? {}) as Record<string, number>;
  const relay = (dp.telemetry_relay ?? {}) as Record<string, number | string | null>;
  const bd = (dp.bright_data ?? {}) as Record<string, unknown>;
  const pm = obs?.perception;
  const baseline = obs?.evaluations.find((e) => e.is_baseline);
  const best = obs?.evaluations.filter((e) => !e.is_baseline)
    .sort((a, b) => (b.metrics?.score?.mean ?? -9) - (a.metrics?.score?.mean ?? -9))[0];

  return (
    <main className="h-screen w-screen flex flex-col bg-soil-950 text-chaff-200 overflow-hidden">
      {/* ── top bar ── */}
      <header className="h-12 shrink-0 flex items-center gap-3 px-4 border-b border-soil-700">
        <span className="font-medium tracking-wide">ACCELERATE.AI</span>
        <span className="text-chaff-600">▸</span>
        <span className="text-chaff-400 text-[13px] truncate max-w-[30rem]">
          {askedFor ? `“${askedFor}”` : "Observability · live sandbox telemetry"}
        </span>
        <span className="chip" style={{
          color: hasTelemetry ? C.signal400 : C.chaff600,
          borderColor: hasTelemetry ? C.signal400 : undefined,
        }}>
          <span className={hasTelemetry ? "pulse-live inline-block mr-1" : "inline-block mr-1"}>●</span>
          {hasTelemetry ? "LIVE" : "NO TELEMETRY YET"}
        </span>
        <select
          className="bg-soil-900 border border-soil-700 rounded px-2 py-1 text-[12px] num"
          value={missionId ?? ""}
          onChange={(e) => {
            setMissionId(e.target.value);
            setSelected(null);
            setReplayOverride(null);   // re-derive from the new mission's status
          }}
        >
          {missions.map((m) => (
            <option key={m.id} value={m.id}>{m.id} · {m.status}</option>
          ))}
        </select>
        <div className="ml-auto flex items-center gap-3 num text-[12px] text-chaff-400">
          <span>{status}{phaseDetail ? ` · ${phaseDetail}` : ""}</span>
          <span>{blocks.length} sandboxes · {blocks.reduce((a, b) => a + b.envs.length, 0)} envs</span>
          <button
            onClick={() => setMode((m) => (m === "farm" ? "test" : "farm"))}
            className="chip hover:border-chaff-400 transition-colors"
            style={{ color: mode === "test" ? C.sky400 : C.chaff400 }}
          >
            {mode === "farm" ? "Test split" : "Back to farm"}
          </button>
        </div>
      </header>

      <div className="flex-1 min-h-0 flex">
        {/* ── pipeline evidence ── */}
        {!showLeft && (
          <button
            onClick={() => setShowLeft(true)}
            title="Show evidence panel"
            className="w-7 shrink-0 border-r border-soil-700 flex items-start justify-center pt-3 hover:bg-soil-900 transition-colors"
            style={{ color: C.chaff600 }}
          >
            <span className="text-[13px]">›</span>
          </button>
        )}
        <aside
          className="shrink-0 border-r border-soil-700 overflow-y-auto overflow-x-hidden p-3 relative transition-[width] duration-200 ease-out"
          style={{ width: showLeft ? 280 : 0, padding: showLeft ? undefined : 0 }}
        >
          <button
            onClick={() => setShowLeft(false)}
            title="Collapse"
            className="absolute right-2 top-2 text-[13px] hover:opacity-70 transition-opacity"
            style={{ color: C.chaff600 }}
          >
            ‹
          </button>
          <div className="text-[11px] uppercase tracking-wider text-signal-400 mb-2">
            Web data ingested
          </div>
          <Stat label="SERP queries" value={int(ingest.queries)} />
          <Stat label="Pages unlocked" value={int(ingest.pages)} />
          <Stat label="Images" value={int(ingest.images_raw)} />
          <Stat label="Images verified" value={int(neon.images_verified)} color={C.leaf400} />
          <Stat label="Images rejected" value={int(neon.images_rejected)} color={C.blight500} />
          <Stat label="Cited facts" value={int(ingest.facts)} />

          <div className="text-[11px] uppercase tracking-wider text-signal-400 mt-4 mb-2">
            Perception (CLIP + probe)
          </div>
          {pm ? (
            <>
              <Stat label="Zero-shot" value={`${num((pm.metrics?.zero_shot_acc ?? 0) * 100, 1)}%`} color={C.sky400} />
              <Stat label="Web-trained" value={`${num((pm.metrics?.probe_acc ?? 0) * 100, 1)}%`} color={C.leaf400} />
              <Stat label="Pool separation" value={num(pm.metrics?.pool_separation, 3)} />
              <Stat label="Arch" value={pm.arch} />
            </>
          ) : <div className="text-[12px] text-chaff-600">not built yet</div>}

          <div className="text-[11px] uppercase tracking-wider text-signal-400 mt-4 mb-2">
            Environment provenance
          </div>
          {obs?.env_config ? obs.env_config.provenance.map((p) => (
            <div key={p.param} className="flex items-baseline justify-between gap-2 py-[3px]">
              <span className="text-[11px] text-chaff-600">{p.param}</span>
              <span className="num text-[12px]" style={{ color: p.assumed ? C.chaff600 : C.leaf400 }}>
                {Array.isArray(p.value) ? `${p.value[0]}–${p.value[1]}` : String(p.value)}
                <span className="ml-1 text-[10px]">{p.assumed ? "assumed" : "cited"}</span>
              </span>
            </div>
          )) : <div className="text-[12px] text-chaff-600">no env config yet</div>}

          <div className="text-[11px] uppercase tracking-wider text-signal-400 mt-4 mb-2">
            Data plane
          </div>
          <Stat label="Neon agent_events" value={int(neon.agent_events)} />
          <Stat label="Neon replays" value={int(neon.replays)} />
          <Stat label="Relay inbox" value={`${int(relay.inbox_rows)} (${int(relay.pending)} pending)`} />
          <Stat label="Tiger episode_stats" value={int(tigerRows.episode_stats_rows)} />
          <Stat label="Tiger live_frames" value={int(tigerRows.live_frames_rows)} />
          <Stat label="Tiger run_metrics" value={int(tigerRows.run_metrics_rows)} />
          <Stat label="Bright Data zones" value={bd.ready ? "ready" : "not configured"}
                color={bd.ready ? C.leaf400 : C.blight500} />
        </aside>

        {/* ── the 3D scene ── */}
        <div className="relative flex-1 min-h-0">
          <FarmScene
            blocks={blocks}
            mode={mode}
            frame={frame}
            focus={selected}
            onPick={(runId, env) => setSelected({ runId, env })}
            onPickBlock={(runId) => setSelected((s) =>
              s && s.runId === runId ? s : { runId, env: null })}
            onExit={() => setSelected(null)}
          />

          {selected && (
            <button
              onClick={() => setSelected(null)}
              className="absolute left-3 top-3 chip text-[12px] hover:border-chaff-400 transition-colors"
              style={{ color: C.signal400, borderColor: C.signal400 }}
            >
              ← back to cluster <span className="text-chaff-600 ml-1">esc</span>
            </button>
          )}

          {!hasTelemetry && (
            <div className="absolute inset-0 grid place-items-center pointer-events-none">
              <div className="panel px-5 py-4 text-center max-w-[460px]">
                <div className="text-[13px] mb-1" style={{ color: C.signal400 }}>
                  No sandbox telemetry for this mission yet
                </div>
                <div className="text-[12px] text-chaff-400">
                  {status === "done"
                    ? "This mission finished before live frames were recorded."
                    : `Currently ${status}${phaseDetail ? ` — ${phaseDetail}` : ""}. Fields appear as soon as the first sandbox starts training.`}
                </div>
                <div className="text-[11px] text-chaff-600 mt-2">
                  Nothing here is simulated for show: the arena only moves when a real run streams frames.
                </div>
              </div>
            </div>
          )}

          {showLegend ? (
            <div className="absolute left-3 bottom-3 panel px-3 py-2 text-[11px] text-chaff-400">
              <button
                onClick={() => setShowLegend(false)}
                title="Hide"
                className="absolute right-2 top-1.5 text-[12px] hover:opacity-70 transition-opacity"
                style={{ color: C.chaff600 }}
              >
                ×
              </button>
              <div className="pr-5 pointer-events-none">
                <span className="mr-3"><span style={{ color: C.leaf400 }}>●</span> crop</span>
                <span className="mr-3"><span style={{ color: C.bloom400 }}>▲</span> weed</span>
                <span className="mr-3"><span style={{ color: C.signal400 }}>▮</span> trained</span>
                <span><span style={{ color: C.sky400 }}>▮</span> baseline</span>
                <div className="mt-1">
                  click a field or a room floor to fly in · tile colour = live score
                </div>
                <div className="mt-[2px] text-chaff-600">
                  drag orbit · scroll zoom · W A S D + Q E fly · shift boost · esc back
                </div>
              </div>
            </div>
          ) : (
            <button
              onClick={() => setShowLegend(true)}
              className="absolute left-3 bottom-3 chip text-[11px] hover:border-chaff-400 transition-colors"
              style={{ color: C.chaff600 }}
            >
              legend
            </button>
          )}
        </div>

        {/* ── close-up: the selected sandbox ── */}
        {!showRight && (
          <button
            onClick={() => setShowRight(true)}
            title="Show run detail"
            className="w-7 shrink-0 border-l border-soil-700 flex items-start justify-center pt-3 hover:bg-soil-900 transition-colors"
            style={{ color: C.chaff600 }}
          >
            <span className="text-[13px]">‹</span>
          </button>
        )}
        <aside
          className="shrink-0 border-l border-soil-700 overflow-y-auto overflow-x-hidden p-3 relative transition-[width] duration-200 ease-out"
          style={{ width: showRight ? 340 : 0, padding: showRight ? undefined : 0 }}
        >
          <button
            onClick={() => setShowRight(false)}
            title="Collapse"
            className="absolute right-2 top-2 text-[13px] hover:opacity-70 transition-opacity"
            style={{ color: C.chaff600 }}
          >
            ›
          </button>
          {!selected && (
            <div className="text-[12px] text-chaff-600">
              Click a room floor or any field to fly the camera to that sandbox and
              read its live numbers here.
            </div>
          )}
          {selected && (
            <>
              <div className="flex items-center justify-between mb-2">
                <div className="text-[11px] uppercase tracking-wider text-signal-400">
                  Sandbox close-up
                </div>
                <button className="chip text-[11px]" onClick={() => setSelected(null)}>close</button>
              </div>

              <div className="panel p-3 mb-3">
                <Stat label="Daytona sandbox" value={sel?.sandbox_id ?? "—"} />
                <Stat label="Run" value={selected.runId} />
                <Stat
                  label="Env"
                  value={selected.env === null
                    ? `whole room · ${selBlock?.envs.length ?? 0} envs`
                    : `#${selected.env}`}
                />
                <Stat label="Status" value={sel?.status ?? "—"}
                      color={sel?.status === "done" ? C.leaf400 : C.signal400} />
                <Stat label="Progress" value={sel ? `${Math.round((sel.progress ?? 0) * 100)}%` : "—"} />
                <Stat label="Generation / variant" value={sel ? `g${sel.generation} v${sel.variant}` : "—"} />
                <Stat label="Envs in sandbox" value={int(sel?.n_envs)} />
                <Stat label="Total steps" value={int(sel?.total_steps)} />
              </div>

              <div className="text-[11px] uppercase tracking-wider text-signal-400 mb-1">
                PPO, measured
              </div>
              <div className="panel p-3 mb-3">
                <Stat label="Throughput" value={sel?.live?.fps ? `${num(sel.live.fps, 0)} fps` : "—"} />
                <Stat label="Global step" value={int(sel?.live?.global_step)} />
                <Stat label="Episodes" value={int(sel?.live?.episodes)} />
                <Stat label="Episode return" value={num(sel?.live?.ep_return_mean, 3)} />
                <Stat label="approx_kl" value={num(sel?.live?.approx_kl, 4)} />
                <Stat label="Score (mean)" value={num(sel?.live?.score_mean, 3)}
                      color={scoreColor(sel?.live?.score_mean ?? null)} />
                <Stat label="Weeds removed" value={num(sel?.live?.removal_mean, 3)} />
                <Stat label="Crop damage" value={num(sel?.live?.damage_mean, 3)} />
                <Stat label="Act precision" value={num(sel?.live?.precision_mean, 3)} />
              </div>

              <div className="text-[11px] uppercase tracking-wider text-signal-400 mb-1">
                Reward this sandbox is training on
              </div>
              <div className="panel p-3 mb-3">
                {sel?.reward ? (
                  <>
                    <div className="text-[12px] text-chaff-200 mb-1">{sel.reward.rationale}</div>
                    <Stat label="Code lines" value={int(sel.reward.code_lines)} />
                    <Stat label="Dry run" value={sel.reward.dry_run?.ok ? "passed" : "rejected"}
                          color={sel.reward.dry_run?.ok ? C.leaf400 : C.blight500} />
                    <Stat label="Reward mean" value={num(sel.reward.dry_run?.mean, 3)} />
                    <Stat label="ms / call" value={num(sel.reward.dry_run?.ms_per_call, 3)} />
                  </>
                ) : <div className="text-[12px] text-chaff-600">no reward spec</div>}
              </div>

              <div className="text-[11px] uppercase tracking-wider text-signal-400 mb-1">
                This field
              </div>
              <div className="panel p-3">
                {selEnv ? (
                  <>
                    <Stat label="Seed" value={int(selEnv.seed)} />
                    <Stat label="Policy" value={selEnv.policy === "base" ? "baseline" : "trained"}
                          color={selEnv.policy === "base" ? C.sky400 : C.signal400} />
                    <Stat label="Plants" value={int(selEnv.plants.length)} />
                    <Stat label="Weeds" value={int(selEnv.plants.filter((p) => p.cls === 1).length)} />
                    <Stat label="Crops" value={int(selEnv.plants.filter((p) => p.cls === 0).length)} />
                    <Stat label="Last score" value={num(selEnv.score, 3)}
                          color={scoreColor(selEnv.score ?? null)} />
                  </>
                ) : (
                  <div className="text-[12px] text-chaff-600">
                    {selected.env === null
                      ? "Click one of the field plots inside the room for its seed, plant census and last score."
                      : "This field has not streamed a frame yet."}
                  </div>
                )}
              </div>
            </>
          )}

          {(baseline || best) && (
            <>
              <div className="text-[11px] uppercase tracking-wider text-signal-400 mt-4 mb-1">
                Before → after
              </div>
              <div className="panel p-3">
                {(() => {
                  // Ordered by the size of the real gain, strongest first.
                  // Weeds-removed stays on the panel but sits last: the
                  // baseline was already competent at pulling weeds, so it is
                  // genuinely our smallest delta and leading with it undersells
                  // a run whose precision more than tripled.
                  const b = baseline?.metrics, w = best?.metrics;
                  const pctPair = (k: string) =>
                    b?.[k]?.mean != null && w?.[k]?.mean != null
                      ? `${num(b[k].mean * 100, 0)}% → ${num(w[k].mean * 100, 0)}%`
                      : null;
                  const rawPair = (k: string, d = 2) => {
                    const B = (b as Record<string, unknown> | undefined)?.[k];
                    const W = (w as Record<string, unknown> | undefined)?.[k];
                    return typeof B === "number" && typeof W === "number"
                      ? `${B.toFixed(d)} → ${W.toFixed(d)}`
                      : null;
                  };
                  const pm = obs?.perception?.metrics;
                  const perception =
                    pm?.zero_shot_acc != null && pm?.probe_acc != null
                      ? `${num(pm.zero_shot_acc * 100, 0)}% → ${num(pm.probe_acc * 100, 0)}%`
                      : null;
                  const missPair = rawPair("miss_rate", 2);

                  const rows: [string, string | null][] = [
                    ["Act precision", pctPair("act_precision")],
                    ["Detection (web-trained)", perception],
                    ["Wasted firings", missPair],
                    ["Damage per weed", rawPair("damage_per_weed_removed", 2)],
                    ["Crop damage", pctPair("protect_damage_rate")],
                    ["Weeds removed", pctPair("target_removal_rate")],
                  ];
                  return rows
                    .filter(([, v]) => v !== null)
                    .map(([label, v]) => <Stat key={label} label={label} value={v as string} />);
                })()}
              </div>
            </>
          )}

          <div className="text-[11px] uppercase tracking-wider text-signal-400 mt-4 mb-1">
            Latest agent steps
          </div>
          <div className="panel p-2 text-[11px] leading-snug">
            {events.slice(0, 8).map((e) => (
              <div key={e.id} className="py-[2px] truncate" title={e.title}>
                <span style={{ color: C.chaff600 }}>{e.agent}</span>{" "}
                <span className="text-chaff-400">{e.title}</span>
              </div>
            ))}
            {!events.length && <span className="text-chaff-600">no events yet</span>}
          </div>
        </aside>
      </div>
    </main>
  );
}
