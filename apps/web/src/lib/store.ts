"use client";
/**
 * One zustand store hydrated from the SSE stream (DESIGN.md §8).
 * Components never query the database directly, except useReplay for the big
 * replay blobs.
 */
import { create } from "zustand";
import { decodeLiveFrame, type EnvState, type FarmPlant } from "./live-frame";
import type { LiveFrame, IngestCounters, EvalMetrics, TaskSpec, Phase } from "./contracts";

export type AgentEventRow = {
  id: string; missionId?: string; mission_id?: string; agent: string; kind: string;
  title: string; payload?: Record<string, unknown>;
  refTable?: string | null; refId?: string | null; ts: string;
};

export type RunRow = {
  id: string; generation: number; variant: number; status: string;
  progress: number; sandbox_id?: string | null; reward_spec_id?: string; error?: string | null;
};

export type MetricPoint = {
  run_id: string; bucket: string; score: number | null; removal: number | null;
  damage: number | null; episodes: number; phase?: string; policy?: string;
};

export type EvalRow = { id: string; policy_id: string; is_baseline: boolean; metrics: EvalMetrics };

type RunLive = {
  runId: string;
  phase: string;
  envs: Map<number, EnvState>;
  /** 2 s jitter buffer: windows queued for playback (SCHEMA.md §3.1) */
  queue: ReturnType<typeof decodeLiveFrame>[];
  lastSeq: number;
};

type State = {
  connected: boolean;
  /** run whose frames arrived most recently — the sandbox working right now */
  activeRunId: string | null;
  activeAt: number;
  missionId: string | null;
  goalText: string;
  taskSpec: TaskSpec | null;
  status: string;
  phase: Phase | null;
  phaseDetail: string | null;
  generation: number;
  bestPolicyId: string | null;

  events: AgentEventRow[];
  runs: Map<string, RunRow>;
  metrics: MetricPoint[];
  heat: Map<string, number>;          // `${run_id}:${env}` → score
  split: { base?: Record<string, number>; cand?: Record<string, number> };
  evals: EvalRow[];
  ingest: IngestCounters;
  voice: { clip_id: string; purpose: string; transcript: string; lang?: string }[];
  replays: { id: string; runId: string | null; step: number | null; kind: string; summary: unknown }[];
  live: Map<string, RunLive>;

  apply: (event: string, data: unknown) => void;
  reset: (missionId: string) => void;
  farmBlocks: () => { runId: string; label: string; envs: EnvState[]; booting: boolean }[];
};

const EMPTY_INGEST: IngestCounters = {
  queries: 0, pages: 0, images_raw: 0, images_kept: 0, facts: 0,
  regions: 0, hard_negatives: 0,
};

export const useMission = create<State>((set, get) => ({
  connected: false,
  missionId: null,
  goalText: "",
  taskSpec: null,
  status: "draft",
  phase: null,
  phaseDetail: null,
  generation: 0,
  bestPolicyId: null,
  events: [],
  /** run whose frames arrived most recently — the sandbox working right now */
  activeRunId: null as string | null,
  activeAt: 0,
  runs: new Map(),
  metrics: [],
  heat: new Map(),
  split: {},
  evals: [],
  ingest: EMPTY_INGEST,
  voice: [],
  replays: [],
  live: new Map(),

  reset: (missionId) => set({
    missionId, events: [], runs: new Map(), metrics: [], heat: new Map(), split: {},
    activeRunId: null, activeAt: 0,
    evals: [], ingest: EMPTY_INGEST, voice: [], replays: [], live: new Map(),
    status: "draft", phase: null, phaseDetail: null, generation: 0, bestPolicyId: null,
  }),

  apply: (event, data) => {
    const d = data as Record<string, unknown>;
    switch (event) {
      case "mission": {
        if (d.hello) { set({ connected: true }); return; }
        set({
          goalText: String(d.goal_text ?? get().goalText),
          taskSpec: (d.task_spec as TaskSpec) ?? get().taskSpec,
          status: String(d.status ?? get().status),
          phase: (d.phase as Phase) ?? get().phase,
          phaseDetail: (d.phase_detail as string) ?? null,
          generation: Number(d.generation ?? 0),
          bestPolicyId: (d.best_policy_id as string) ?? null,
        });
        return;
      }
      case "agent_event": {
        const row = d as unknown as AgentEventRow;
        // a reconnect (or a second EventSource) replays the whole trace, so the
        // same row can arrive twice — key on id, not arrival
        if (get().events.some((e) => e.id === row.id)) return;
        const events = [row, ...get().events].slice(0, 400);
        set({ events });
        return;
      }
      case "run": {
        const runs = new Map(get().runs);
        runs.set(String(d.id), d as unknown as RunRow);
        set({ runs });
        return;
      }
      case "metric": {
        const metrics = [...get().metrics, d as unknown as MetricPoint].slice(-4000);
        set({ metrics });
        return;
      }
      case "heat": {
        const heat = new Map(get().heat);
        for (const h of data as { run_id: string; env: number; score: number | null }[]) {
          if (h.score !== null) heat.set(`${h.run_id}:${h.env}`, h.score);
        }
        set({ heat });
        return;
      }
      case "split": {
        set({ split: data as State["split"] });
        return;
      }
      case "eval": {
        const evals = [...get().evals.filter((e) => e.id !== d.id), d as unknown as EvalRow];
        set({ evals });
        return;
      }
      case "ingest": {
        set({ ingest: d as unknown as IngestCounters });
        return;
      }
      case "voice": {
        const v = d as unknown as State["voice"][number];
        if (!get().voice.some((x) => x.clip_id === v.clip_id)) set({ voice: [...get().voice, v] });
        return;
      }
      case "replay": {
        const r = d as unknown as State["replays"][number];
        if (!get().replays.some((x) => x.id === r.id)) set({ replays: [...get().replays, r] });
        return;
      }
      case "live": {
        const runId = String(d.run_id);
        const decoded = decodeLiveFrame(d.data as LiveFrame);
        const live = new Map(get().live);
        const entry = live.get(runId) ?? {
          runId, phase: String(d.phase ?? "train"),
          envs: new Map<number, EnvState>(), queue: [], lastSeq: -1,
        };
        const seq = Number(d.seq ?? 0);
        if (seq <= entry.lastSeq) return;           // out-of-order / duplicate
        entry.lastSeq = seq;
        entry.phase = String(d.phase ?? entry.phase);

        // plant layouts arrive on reset / resync
        for (const r of decoded.resets) {
          const prev = entry.envs.get(r.env);
          entry.envs.set(r.env, {
            env: r.env,
            policy: decoded.policy[r.env] ?? "cand",
            seed: r.seed,
            plants: r.plants as FarmPlant[],
            pose: prev?.pose ?? [],
            score: prev?.score ?? null,
          });
        }
        // poses for this window
        for (let e = 0; e < decoded.nEnvs; e++) {
          const cur = entry.envs.get(e) ?? {
            env: e, policy: decoded.policy[e] ?? "cand", seed: 0,
            plants: [], pose: [], score: null,
          };
          cur.pose = decoded.pose[e] ?? cur.pose;
          cur.policy = decoded.policy[e] ?? cur.policy;
          entry.envs.set(e, cur);
        }
        for (const [env, score] of decoded.epScores) {
          const cur = entry.envs.get(env);
          if (cur) cur.score = score;
        }
        // Events remove / damage plants so the arena matches the sim.
        // We FLAG rather than splice: plant_id is an index into the layout the
        // sandbox sent at reset, so removing an element would shift every later
        // index and corrupt all subsequent events in the episode.
        for (const [env, , plantId, kind] of decoded.events) {
          const cur = entry.envs.get(env);
          if (!cur || plantId < 0 || plantId >= cur.plants.length) continue;
          const plant = cur.plants[plantId];
          if (kind === "removed_target" || kind === "removed_protect") {
            // stamp the moment so the arena can play a visible cut instead of
            // the plant silently vanishing between two frames
            if (!plant.removed) plant.removedAt = performance.now();
            plant.removed = true;
          } else if (kind === "trampled_protect") {
            plant.damaged = true;
          }
        }
        live.set(runId, entry);
        set({ activeRunId: runId, activeAt: Date.now() });
        set({ live });
        return;
      }
    }
  },

  /** Shape the live map into what FarmScene draws. */
  farmBlocks: () => {
    const { live, runs, heat } = get();
    const ids = [...new Set([...runs.keys(), ...live.keys()])].sort();
    return ids.map((runId) => {
      const entry = live.get(runId);
      const run = runs.get(runId);
      const envs = entry ? [...entry.envs.values()].sort((a, b) => a.env - b.env) : [];
      for (const e of envs) {
        const h = heat.get(`${runId}:${e.env}`);
        if (h !== undefined) e.score = h;
      }
      const pct = run ? Math.round((run.progress ?? 0) * 100) : 0;
      return {
        runId,
        label: `sandbox ${run?.variant ?? "?"} · reward v${run?.variant ?? 0} · ${pct}%`,
        envs,
        booting: !entry || envs.length === 0,
      };
    });
  },
}));
