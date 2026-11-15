/** Replay decoding (SCHEMA.md §3). Client-side, no deps. */
import type { Replay, EventType } from "./contracts";

export function b64ToFloat32(s: string): Float32Array {
  const bin = atob(s);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Float32Array(bytes.buffer);
}

export function b64ToUint16(s: string): Uint16Array {
  const bin = atob(s);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Uint16Array(bytes.buffer);
}

export function b64ToUint8(s: string): Uint8Array {
  const bin = atob(s);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

export type PlantState = {
  id: number; x: number; y: number; cls: 0 | 1; radius: number;
  pTarget: number; imageId: string | null;
  alive: boolean; damaged: boolean; trampled: boolean;
};

export type DecodedReplay = {
  seed: number; dt: number; frames: number;
  field: Replay["field"];
  plants: PlantState[];
  /** [x, y, theta, act] per frame */
  rover: Float32Array;
  events: [number, number, EventType][];
  reward?: Float32Array;
  roverAt(t: number): { x: number; y: number; theta: number; act: boolean };
  plantsAt(t: number): PlantState[];
  rewardUpTo(t: number): number;
};

export function decodeReplay(r: Replay): DecodedReplay {
  const rover = b64ToFloat32(r.rover);
  const reward = r.reward ? b64ToFloat32(r.reward) : undefined;
  const frames = Math.floor(rover.length / 4);

  const base: PlantState[] = r.plants.map((p, i) => ({
    id: i, x: p[0], y: p[1], cls: (p[2] as 0 | 1), radius: p[3],
    pTarget: p[4], imageId: p[5], alive: true, damaged: false, trampled: false,
  }));

  const events = r.events as [number, number, EventType][];

  return {
    seed: r.seed, dt: r.dt, frames, field: r.field, plants: base, rover, events, reward,
    roverAt(t: number) {
      const i = Math.max(0, Math.min(frames - 1, Math.floor(t))) * 4;
      return { x: rover[i], y: rover[i + 1], theta: rover[i + 2], act: rover[i + 3] > 0.5 };
    },
    /** Plant state at frame t = initial state with every event where t_event ≤ t applied. */
    plantsAt(t: number) {
      const out = base.map((p) => ({ ...p }));
      for (const [et, pid, kind] of events) {
        if (et > t || pid < 0 || pid >= out.length) continue;
        if (kind === "removed_target") out[pid].alive = false;
        else if (kind === "removed_protect") { out[pid].alive = false; out[pid].damaged = true; }
        else if (kind === "trampled_protect") { out[pid].trampled = true; out[pid].damaged = true; }
      }
      return out;
    },
    rewardUpTo(t: number) {
      if (!reward) return 0;
      let s = 0;
      for (let i = 0; i <= Math.min(t, reward.length - 1); i++) s += reward[i];
      return s;
    },
  };
}
