/**
 * LiveFrame decoding + a synthetic generator (SCHEMA.md §3.1).
 * The generator lets the Farm view be built and rehearsed before any backend
 * exists (DESIGN.md §11 step 2); swap in the SSE feed and nothing else changes.
 */
import type { LiveFrame, EventType } from "./contracts";
import { b64ToUint16, b64ToUint8 } from "./replay-decode";

export type FarmPlant = {
  /** performance.now() when the removal event arrived, for the cut animation */
  removedAt?: number;
  x: number; y: number; cls: 0 | 1; radius: number; pTarget: number;
  /** set when the sim reports this plant pulled — the arena draws a soil patch */
  removed?: boolean;
  /** set when a crop is trampled — the arena droops and reddens it */
  damaged?: boolean;
};

export type EnvState = {
  env: number;
  policy: "cand" | "base";
  seed: number;
  plants: FarmPlant[];
  /** pose per frame in this window */
  pose: { x: number; y: number; theta: number; act: boolean }[];
  score: number | null;
};

export function decodePlants(b64: string): FarmPlant[] {
  const a = b64ToUint16(b64);
  const n = Math.floor(a.length / 4);
  const out: FarmPlant[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const packed = a[i * 4 + 2];
    out[i] = {
      x: a[i * 4] / 100,
      y: a[i * 4 + 1] / 100,
      cls: ((packed >> 15) & 1) as 0 | 1,
      radius: (packed & 0x7fff) / 1000,
      pTarget: a[i * 4 + 3] / 65535,
    };
  }
  return out;
}

export type DecodedFrame = {
  nEnvs: number; frames: number; stride: number;
  policy: ("cand" | "base")[];
  /** pose[env][frame] */
  pose: { x: number; y: number; theta: number; act: boolean }[][];
  resets: { env: number; frame: number; seed: number; plants: FarmPlant[]; resync?: boolean }[];
  events: [number, number, number, EventType][];
  epScores: [number, number][];
  agg: LiveFrame["agg"];
};

export function decodeLiveFrame(f: LiveFrame): DecodedFrame {
  const pose16 = b64ToUint16(f.pose);
  const ta8 = b64ToUint8(f.theta_act);
  const n = f.n_envs, F = f.frames;
  const pose: DecodedFrame["pose"] = [];
  for (let e = 0; e < n; e++) {
    const row: DecodedFrame["pose"][number] = [];
    for (let t = 0; t < F; t++) {
      const pi = (e * F + t) * 2;
      const ti = (e * F + t) * 2;
      row.push({
        x: pose16[pi] / 100,
        y: pose16[pi + 1] / 100,
        theta: (ta8[ti] / 255) * 2 * Math.PI - Math.PI,
        act: ta8[ti + 1] > 0,
      });
    }
    pose.push(row);
  }
  return {
    nEnvs: n, frames: F, stride: f.stride,
    policy: f.env_policy as ("cand" | "base")[],
    pose,
    resets: (f.resets ?? []).map((r) => ({
      env: r.env, frame: r.frame, seed: r.seed, plants: decodePlants(r.plants), resync: r.resync,
    })),
    events: (f.events ?? []) as [number, number, number, EventType][],
    epScores: (f.ep_scores ?? []) as [number, number][],
    agg: f.agg,
  };
}

/* ── synthetic generator: random-walk rovers, for building the Farm view ── */
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function syntheticField(seed: number): FarmPlant[] {
  const rnd = mulberry32(seed);
  const plants: FarmPlant[] = [];
  const rowsY = [0.15, 0.45, 0.75];
  for (const y of rowsY) {
    for (let i = 0; i < 40; i++) {
      if (rnd() < 0.05) continue;
      plants.push({
        x: (i + 0.5) * 0.3 + (rnd() - 0.5) * 0.08,
        y: y + (rnd() - 0.5) * 0.04,
        cls: 0, radius: 0.1 + rnd() * 0.04, pTarget: 0.05 + rnd() * 0.2,
      });
    }
  }
  const nWeeds = 30 + Math.floor(rnd() * 30);
  for (let i = 0; i < nWeeds; i++) {
    plants.push({
      x: rnd() * 12, y: rnd() * 0.9, cls: 1,
      radius: 0.02 + rnd() * 0.04, pTarget: 0.7 + rnd() * 0.29,
    });
  }
  return plants;
}

/** Drives a plausible farm while no sandbox is streaming yet. */
export class SyntheticFarm {
  private t = 0;
  readonly envs: EnvState[];
  constructor(readonly nEnvs = 32, readonly runSeed = 1) {
    this.envs = Array.from({ length: nEnvs }, (_, e) => ({
      env: e, policy: "cand" as const, seed: runSeed * 1000 + e,
      plants: syntheticField(runSeed * 1000 + e),
      pose: [{ x: 0, y: 0.15, theta: 0, act: false }],
      score: null,
    }));
  }
  /** Advance and return one window of ~20 frames, as the browser would receive it. */
  step(frames = 20, learning = 0): EnvState[] {
    const rnd = mulberry32(this.runSeed * 7919 + this.t);
    for (const s of this.envs) {
      s.pose = [];
      let { x, y, theta } = this.envs[s.env].pose[0] ?? { x: 0, y: 0.15, theta: 0 };
      for (let f = 0; f < frames; f++) {
        theta += (rnd() - 0.5) * 0.25;
        x += Math.cos(theta) * 0.06;
        y += Math.sin(theta) * 0.02;
        if (x > 12) { x = 0; }
        if (y < 0.05 || y > 0.85) { y = Math.min(0.85, Math.max(0.05, y)); theta = -theta; }
        s.pose.push({ x, y, theta, act: rnd() < 0.08 });
      }
      // score drifts upward with `learning` so the farm visibly turns red → green
      const noise = (rnd() - 0.5) * 0.25;
      s.score = Math.max(-0.2, Math.min(1, -0.1 + learning * 0.9 + noise));
    }
    this.t++;
    return this.envs;
  }
}
