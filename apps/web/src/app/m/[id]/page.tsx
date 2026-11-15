"use client";
/**
 * Mission console (DESIGN.md §3) — the page a judge spends the demo looking at.
 *
 *   48px top bar  · mission, LIVE/REPLAY pulse, generation, Evidence, Compare
 *   PhaseRail     · the eight steps
 *   3-column body · 320px Foreman chat | flex Training Farm | 360px AgentTrace
 *   MetricsStrip  · before → after, with the Impact card over it when done
 *
 * Everything on screen comes from the SSE stream via useMission(); numbers that
 * have not arrived render "—", never a placeholder.
 */
import {
  Suspense, use, useCallback, useEffect, useMemo, useState,
} from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { SendHorizontal } from "lucide-react";
import { FarmScene, type FarmBlock, type FarmMode } from "@/components/arena/FarmScene";
import { PhaseRail } from "@/components/console/PhaseRail";
import { AgentTrace } from "@/components/console/AgentTrace";
import { MetricsStrip } from "@/components/console/MetricsStrip";
import { EvidenceDrawer, type EvidenceTab } from "@/components/console/EvidenceDrawer";
import { ImpactCard } from "@/components/console/ImpactCard";
import { useMission } from "@/lib/store";
import { useMissionStream } from "@/lib/useMissionStream";
import { C, scoreColor } from "@/lib/colors";
import type { TaskSpec } from "@/lib/contracts";

const EM_DASH = "—";

/* ── centre pane: its own 20fps clock so the rest of the console stays calm ── */

function FarmPane({ blocks, mode, onPick }: {
  blocks: FarmBlock[]; mode: FarmMode; onPick: (runId: string, env: number) => void;
}) {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setFrame((f) => (f + 1) % 20), 50);   // 20fps
    return () => clearInterval(id);
  }, []);
  return <FarmScene blocks={blocks} mode={mode} frame={frame} onPick={onPick} />;
}

/* ── §4.3 booting state: never an empty black box ── */

function BootingOverlay({ blocks, phaseDetail, connected, status }: {
  blocks: FarmBlock[]; phaseDetail: string | null; connected: boolean; status: string;
}) {
  return (
    <div className="absolute inset-0 grid place-items-center pointer-events-none">
      <div className="panel px-5 py-4 max-w-[460px] pointer-events-auto">
        <div className="flex items-center gap-2">
          <span className="pulse-live" style={{ color: C.signal400 }}>●</span>
          <span className="tracking-wide" style={{ color: C.chaff200 }}>
            {blocks.length ? "Sandboxes booting" : "Waiting for the first field"}
          </span>
        </div>
        <div className="mt-2 text-xs leading-relaxed" style={{ color: C.chaff400 }}>
          {connected
            ? "The farm fills in as each sandbox streams its first frame window. Plant layouts arrive on episode reset, so a tile stays dark until its env resets."
            : "Connecting to the mission stream…"}
        </div>
        {phaseDetail && (
          <div className="mt-2 num text-[11px]" style={{ color: C.signal400 }}>{phaseDetail}</div>
        )}
        <div className="mt-3 space-y-1">
          {blocks.length === 0 && (
            <div className="num text-[11px]" style={{ color: C.chaff600 }}>
              status {status} · no runs yet
            </div>
          )}
          {blocks.map((b) => (
            <div key={b.runId} className="flex items-center gap-2 num text-[11px]">
              <span style={{ color: b.booting ? C.chaff600 : C.leaf400 }}>
                {b.booting ? "○" : "●"}
              </span>
              <span className="truncate" style={{ color: C.chaff400 }}>{b.label}</span>
              <span className="ml-auto" style={{ color: C.chaff600 }}>
                {b.envs.length ? `${b.envs.length} envs` : "booting"}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ── left column: the Foreman ── */

function PriorityRow({ label, value }: { label: string; value: number | undefined }) {
  const v = typeof value === "number" ? value : null;
  return (
    <div className="flex items-center gap-2">
      <span className="text-[11px] w-[88px]" style={{ color: C.chaff400 }}>{label}</span>
      <div className="flex-1 h-1 rounded-full" style={{ background: C.soil800 }}>
        <div
          className="h-1 rounded-full"
          style={{ width: `${(v ?? 0) * 100}%`, background: C.signal400 }}
        />
      </div>
      <span className="num text-[11px] w-[34px] text-right" style={{ color: C.chaff200 }}>
        {v === null ? EM_DASH : v.toFixed(2)}
      </span>
    </div>
  );
}

function ClassRows({ title, spec, color }: {
  title: string; spec: TaskSpec["target"] | undefined; color: string;
}) {
  return (
    <div className="mt-2">
      <div className="text-[11px] uppercase tracking-wider" style={{ color }}>{title}</div>
      <div className="text-[12px]" style={{ color: C.chaff200 }}>
        {spec?.names?.length ? spec.names.join(", ") : EM_DASH}
      </div>
      {spec?.scientific?.length ? (
        <div className="text-[11px] italic" style={{ color: C.chaff600 }}>
          {spec.scientific.join(", ")}
        </div>
      ) : null}
      {spec?.stage_hint ? (
        <div className="text-[11px]" style={{ color: C.chaff400 }}>stage · {spec.stage_hint}</div>
      ) : null}
    </div>
  );
}

function ForemanColumn({ missionId, goalText, taskSpec }: {
  missionId: string; goalText: string; taskSpec: TaskSpec | null;
}) {
  const voice = useMission((s) => s.voice);
  const [draft, setDraft] = useState("");
  const [sent, setSent] = useState<{ text: string; state: "sending" | "sent" | "failed" }[]>([]);
  const [note, setNote] = useState<string | null>(null);

  const submit = useCallback(async (text: string) => {
    const body = text.trim();
    if (!body) return;
    setDraft("");
    setSent((s) => [...s, { text: body, state: "sending" }]);
    const mark = (state: "sent" | "failed") =>
      setSent((s) => s.map((m) => (m.text === body && m.state === "sending" ? { ...m, state } : m)));
    try {
      const res = await fetch("/api/missions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ goal_text: body, mission_id: missionId }),
      });
      if (res.status === 404) {
        mark("failed");
        setNote("/api/missions is not available — the message was not recorded");
        return;
      }
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        mark("failed");
        setNote(`could not send · ${err.error ?? `HTTP ${res.status}`}`);
        return;
      }
      mark("sent");
      setNote(null);
    } catch (err) {
      mark("failed");
      setNote(`could not send · ${(err as Error).message}`);
    }
  }, [missionId]);

  const lang = taskSpec?.lang ?? "en";

  return (
    <aside
      className="w-[320px] shrink-0 border-r flex flex-col min-h-0"
      style={{ borderColor: C.soil700 }}
    >
      <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-3">
        <section>
          <div className="text-[11px] uppercase tracking-wider" style={{ color: C.chaff600 }}>
            Operator goal
          </div>
          <p className="mt-1 text-[14px] leading-snug" style={{ color: C.chaff200 }}>
            {goalText || EM_DASH}
          </p>
        </section>

        <section className="panel p-3">
          <div className="flex items-baseline justify-between">
            <span className="text-[11px] uppercase tracking-wider" style={{ color: C.chaff600 }}>
              TaskSpec
            </span>
            <span className="num text-[11px]" style={{ color: C.chaff400 }}>
              {taskSpec?.template ?? EM_DASH}
            </span>
          </div>
          {!taskSpec ? (
            <div className="mt-2 text-[12px]" style={{ color: C.chaff600 }}>
              The Foreman has not read the task back yet.
            </div>
          ) : (
            <>
              <div className="mt-1 text-[13px]" style={{ color: C.chaff200 }}>
                crop · <span className="num">{taskSpec.crop || EM_DASH}</span>
              </div>
              <ClassRows title="Target (remove)" spec={taskSpec.target} color={C.bloom400} />
              <ClassRows title="Protect (keep)" spec={taskSpec.protect} color={C.leaf400} />
              <div className="mt-3 space-y-1.5">
                <div className="text-[11px] uppercase tracking-wider" style={{ color: C.chaff600 }}>
                  Priorities
                </div>
                <PriorityRow label="avoid damage" value={taskSpec.priorities?.avoid_damage} />
                <PriorityRow label="coverage" value={taskSpec.priorities?.coverage} />
                <PriorityRow label="speed" value={taskSpec.priorities?.speed} />
              </div>
              <div className="mt-3 num text-[11px]" style={{ color: C.chaff600 }}>
                {taskSpec.region_hint ? `${taskSpec.region_hint} · ` : ""}lang {taskSpec.lang}
                {taskSpec.budget
                  ? ` · ${taskSpec.budget.generations} gens × ${taskSpec.budget.variants} variants · ${taskSpec.budget.steps_per_run.toLocaleString()} steps`
                  : ""}
              </div>
            </>
          )}
        </section>

        {voice.length > 0 && (
          <section className="space-y-2">
            <div className="text-[11px] uppercase tracking-wider" style={{ color: C.chaff600 }}>
              Voice
            </div>
            {voice.map((v) => (
              <div key={v.clip_id} className="panel px-2.5 py-2">
                <div className="num text-[10px]" style={{ color: C.signal400 }}>
                  {v.purpose}{v.lang ? ` · ${v.lang}` : ""}
                </div>
                <div className="text-[12px] leading-snug" style={{ color: C.chaff400 }}>
                  {v.transcript}
                </div>
              </div>
            ))}
          </section>
        )}

        {sent.length > 0 && (
          <section className="space-y-2">
            <div className="text-[11px] uppercase tracking-wider" style={{ color: C.chaff600 }}>
              You
            </div>
            {sent.map((m, i) => (
              <div key={`${i}-${m.text.slice(0, 12)}`} className="panel px-2.5 py-2">
                <div className="text-[12px]" style={{ color: C.chaff200 }}>{m.text}</div>
                <div className="num text-[10px] mt-1" style={{
                  color: m.state === "failed" ? C.blight500
                    : m.state === "sent" ? C.leaf400 : C.chaff600,
                }}>
                  {m.state}
                </div>
              </div>
            ))}
          </section>
        )}
      </div>

      <div className="shrink-0 border-t p-2" style={{ borderColor: C.soil700 }}>
        {note && (
          <div className="mb-2 text-[11px] leading-snug" style={{ color: C.blight500 }}>{note}</div>
        )}
        <div className="flex items-end gap-2">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void submit(draft); }
            }}
            rows={2}
            placeholder="Correct the Foreman, or add a constraint…"
            className="flex-1 resize-none rounded px-2 py-1.5 text-[13px] outline-none"
            style={{
              background: C.soil950, color: C.chaff200,
              border: `1px solid ${C.soil700}`,
            }}
          />
          <button
            onClick={() => void submit(draft)}
            disabled={!draft.trim()}
            aria-label="send to the Foreman"
            className="shrink-0 grid place-items-center rounded-full disabled:opacity-40"
            style={{
              width: 36, height: 36, border: `1px solid ${C.soil700}`, color: C.signal400,
            }}
          >
            <SendHorizontal size={16} />
          </button>
        </div>
      </div>
    </aside>
  );
}

/* ── the console ── */

function Console({ id }: { id: string }) {
  const search = useSearchParams();
  const router = useRouter();
  const replayMode = search.get("replay") === "1";

  useMissionStream(id, replayMode);

  const connected = useMission((s) => s.connected);
  const goalText = useMission((s) => s.goalText);
  const taskSpec = useMission((s) => s.taskSpec);
  const status = useMission((s) => s.status);
  const phase = useMission((s) => s.phase);
  const phaseDetail = useMission((s) => s.phaseDetail);
  const generation = useMission((s) => s.generation);
  const events = useMission((s) => s.events);
  const metrics = useMission((s) => s.metrics);
  const evals = useMission((s) => s.evals);
  const ingest = useMission((s) => s.ingest);
  const voice = useMission((s) => s.voice);
  const live = useMission((s) => s.live);
  const runs = useMission((s) => s.runs);
  const heat = useMission((s) => s.heat);
  const farmBlocks = useMission((s) => s.farmBlocks);

  // farmBlocks() allocates, so derive it once per store update rather than per
  // render — live/runs/heat are exactly the slices it reads.
  const blocks = useMemo(() => {
    void live; void runs; void heat;
    return farmBlocks();
  }, [farmBlocks, live, runs, heat]);

  const [mode, setMode] = useState<FarmMode>("farm");
  // The simulation is the subject. Both columns slide away; nothing else may
  // compete with it for attention.
  const [leftOpen, setLeftOpen] = useState(true);
  const [rightOpen, setRightOpen] = useState(true);
  const [drawer, setDrawer] = useState<EvidenceTab | null>(null);
  const [picked, setPicked] = useState<{ runId: string; env: number } | null>(null);
  const [impactOpen, setImpactOpen] = useState(true);

  const booting = blocks.length === 0 || blocks.every((b) => b.booting);
  const totalFields = blocks.reduce((n, b) => n + b.envs.length, 0);
  const maxGen = taskSpec?.budget?.generations ?? null;

  const pickedEnv = useMemo(() => {
    if (!picked) return null;
    const b = blocks.find((x) => x.runId === picked.runId);
    return b?.envs.find((e) => e.env === picked.env) ?? null;
  }, [picked, blocks]);

  const report = useMemo(() => {
    const row = [...voice].reverse().find((v) => v.purpose.includes("report"));
    return { transcript: row?.transcript ?? null, clipId: row?.clip_id ?? null };
  }, [voice]);

  const onPick = useCallback((runId: string, env: number) => setPicked({ runId, env }), []);

  return (
    <main className="h-screen w-screen flex flex-col overflow-hidden"
      style={{ background: C.soil950, color: C.chaff200 }}>

      {/* ── 48px top bar ── */}
      <header className="h-12 shrink-0 flex items-center gap-3 px-4 border-b"
        style={{ borderColor: C.soil700 }}>
        <Link href="/" className="font-medium tracking-wide" style={{ color: C.chaff200 }}>ACCELERATE.AI</Link>
        <span style={{ color: C.chaff600 }}>▸</span>
        <span className="truncate max-w-[42ch]" title={goalText} style={{ color: C.chaff400 }}>
          {goalText || id}
        </span>

        <span
          className="chip num"
          style={{
            color: replayMode ? C.sky400 : connected ? C.signal400 : C.chaff600,
            borderColor: replayMode ? `${C.sky400}66` : connected ? `${C.signal400}66` : C.soil700,
          }}
          title={replayMode ? "frozen demo branch" : connected ? "live SSE stream" : "reconnecting"}
        >
          <span className={connected && !replayMode ? "pulse-live inline-block mr-1" : "inline-block mr-1"}>●</span>
          {replayMode ? "REPLAY" : connected ? "LIVE" : "CONNECTING"}
        </span>

        <span className="num text-[12px]" style={{ color: C.chaff400 }}>
          gen <span style={{ color: C.chaff200 }}>{generation}</span>
          {maxGen !== null ? ` / ${maxGen - 1}` : ""}
        </span>
        <span className="chip num text-[11px]" style={{ color: C.chaff400 }}>{status}</span>

        <div className="ml-auto flex items-center gap-2">
          <span className="num text-[11px]" style={{ color: C.chaff600 }}>
            {totalFields ? `${totalFields} fields` : "0 fields"}
          </span>
          <button
            onClick={() => setMode((mo) => (mo === "farm" ? "test" : "farm"))}
            className="chip hover:border-chaff-400 transition-colors"
            style={{ color: mode === "test" ? C.sky400 : C.chaff400 }}
          >
            {mode === "farm" ? "Show test split" : "Back to farm"}
          </button>
          <button
            onClick={() => setDrawer("sources")}
            className="chip hover:border-chaff-400 transition-colors"
            style={{ color: C.signal400, borderColor: `${C.signal400}66` }}
          >
            Evidence
          </button>
          <button
            onClick={() => router.push(`/m/${id}/compare${replayMode ? "?replay=1" : ""}`)}
            className="chip hover:border-chaff-400 transition-colors"
            style={{ color: C.sky400, borderColor: `${C.sky400}66` }}
          >
            Compare
          </button>
        </div>
      </header>

      <PhaseRail phase={phase} phaseDetail={phaseDetail} />

      {/* ── body ── */}
      <div className="flex-1 min-h-0 flex">
        <div
          className="shrink-0 overflow-hidden transition-[width] duration-200 ease-out flex"
          style={{ width: leftOpen ? 320 : 0 }}
        >
          <ForemanColumn missionId={id} goalText={goalText} taskSpec={taskSpec} />
        </div>
        <button
          onClick={() => setLeftOpen((v) => !v)}
          title={leftOpen ? "Hide goal panel" : "Show goal panel"}
          className="w-6 shrink-0 border-r flex items-start justify-center pt-3 hover:bg-soil-900 transition-colors"
          style={{ borderColor: C.soil700, color: C.chaff600 }}
        >
          <span className="text-[13px]">{leftOpen ? "‹" : "›"}</span>
        </button>

        <section className="flex-1 min-w-0 relative">
          <FarmPane blocks={blocks} mode={mode} onPick={onPick} />

          {booting && (
            <BootingOverlay
              blocks={blocks} phaseDetail={phaseDetail} connected={connected} status={status}
            />
          )}

          {!booting && (
            <div className="pointer-events-none absolute left-4 bottom-4 panel px-3 py-2 text-[11px]"
              style={{ color: C.chaff400 }}>
              <div className="flex items-center gap-3">
                <span><span style={{ color: C.leaf400 }}>●</span> crop</span>
                <span><span style={{ color: C.bloom400 }}>▲</span> weed</span>
                <span><span style={{ color: C.signal400 }}>▮</span> trained rover</span>
                <span><span style={{ color: C.sky400 }}>▮</span> baseline rover</span>
              </div>
              <div className="mt-1">
                tile border = live score ·{" "}
                <span style={{ color: C.blight500 }}>red</span> →{" "}
                <span style={{ color: C.signal400 }}>amber</span> →{" "}
                <span style={{ color: C.leaf400 }}>green</span>
              </div>
            </div>
          )}

          {pickedEnv && (
            <div className="absolute right-4 bottom-4 panel px-3 py-2 text-[11px]">
              <div className="flex items-center gap-2">
                <span className="num" style={{ color: C.chaff200 }}>
                  {picked?.runId} · env {pickedEnv.env}
                </span>
                <button onClick={() => setPicked(null)} className="chip"
                  style={{ color: C.chaff600 }}>✕</button>
              </div>
              <div className="num mt-1" style={{ color: C.chaff400 }}>
                seed {pickedEnv.seed} · {pickedEnv.plants.length} plants ·{" "}
                {pickedEnv.policy === "base" ? "baseline" : "trained"} · score{" "}
                <span style={{ color: scoreColor(pickedEnv.score) }}>
                  {pickedEnv.score === null ? EM_DASH : pickedEnv.score.toFixed(2)}
                </span>
              </div>
            </div>
          )}

          {mode === "test" && (
            <div className="pointer-events-none absolute inset-x-0 top-3 flex justify-around px-8">
              <div className="text-center">
                <div className="text-xs tracking-widest" style={{ color: C.sky400 }}>
                  BEFORE · BASELINE
                </div>
              </div>
              <div className="text-center">
                <div className="text-xs tracking-widest" style={{ color: C.signal400 }}>
                  AFTER · TRAINED
                </div>
              </div>
            </div>
          )}
        </section>

        <button
          onClick={() => setRightOpen((v) => !v)}
          title={rightOpen ? "Hide agent trace" : "Show agent trace"}
          className="w-6 shrink-0 border-l flex items-start justify-center pt-3 hover:bg-soil-900 transition-colors"
          style={{ borderColor: C.soil700, color: C.chaff600 }}
        >
          <span className="text-[13px]">{rightOpen ? "›" : "‹"}</span>
        </button>
        <aside
          className="shrink-0 border-l flex flex-col min-h-0 overflow-hidden transition-[width] duration-200 ease-out"
          style={{ borderColor: C.soil700, width: rightOpen ? 360 : 0 }}>
          <div className="h-8 shrink-0 flex items-center px-3 border-b text-[11px] uppercase tracking-wider"
            style={{ borderColor: C.soil700, color: C.chaff600 }}>
            Agent trace
            <span className="num ml-auto">{events.length}</span>
          </div>
          <div className="shrink-0 border-b" style={{ borderColor: C.soil700 }}>
            <MetricsStrip evals={evals} metrics={metrics} ingest={ingest} />
          </div>
          <div className="flex-1 min-h-0">
            <AgentTrace events={events} onOpenSource={() => setDrawer("sources")} />
          </div>
        </aside>
      </div>

      {/* The Impact card floats over the arena when the mission lands; there is
          no longer a permanent bottom strip competing with the simulation. */}
      {status === "done" && impactOpen && (
        <div className="absolute inset-x-0 bottom-0 z-30 flex justify-center px-4 pb-3 pointer-events-none">
            <ImpactCard
              missionId={id}
              evals={evals}
              replayMode={replayMode}
              reportText={report.transcript}
              onOpenCompare={() => router.push(`/m/${id}/compare${replayMode ? "?replay=1" : ""}`)}
              onTryAnother={() => router.push("/")}
            onClose={() => setImpactOpen(false)}
          />
        </div>
      )}

      <EvidenceDrawer
        missionId={id}
        open={drawer !== null}
        tab={drawer ?? "sources"}
        onTabChange={(t) => setDrawer(t)}
        onClose={() => setDrawer(null)}
        replayMode={replayMode}
      />
    </main>
  );
}

export default function MissionPage(props: { params: Promise<{ id: string }> }) {
  const { id } = use(props.params);
  return (
    <Suspense
      fallback={
        <main className="h-screen grid place-items-center" style={{ background: C.soil950 }}>
          <span className="num text-xs" style={{ color: C.chaff600 }}>opening mission {id}…</span>
        </main>
      }
    >
      <Console id={id} />
    </Suspense>
  );
}
