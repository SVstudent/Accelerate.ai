"""LiveFrame encoder — sandbox → Tiger Data → browser (SCHEMA.md §3.1).

Every env records (x, y, theta, act) each step. Every ~1.0 s the sandbox flushes
ONE row holding a contiguous window for all of its envs, subsampled so playback
runs at ~20 fps. Coordinates are quantised (uint16 cm, uint8 theta), which is
about 4 KB/s per sandbox — ~30 MB for a whole mission.
"""
from __future__ import annotations

import base64
import math
import time

import numpy as np

TARGET_PLAYBACK_FPS = 20.0
# A busy window can produce thousands of removal events (measured: ~1,900 per
# flush across 32 envs), which would push a frame from ~4 KB to ~57 KB. Cap it:
# the browser only needs enough to show plants disappearing, and the full plant
# layout is resynced every RESYNC_EVERY_S anyway, so anything dropped is
# corrected within 10 seconds.
MAX_EVENTS_PER_FLUSH = 800
FLUSH_EVERY_S = 1.0
RESYNC_EVERY_S = 10.0


def _b64(arr: np.ndarray) -> str:
    return base64.b64encode(arr.tobytes()).decode("ascii")


def encode_plants(x, y, cls, radius, p_target) -> str:
    """Uint16 [n][x_cm, y_cm, cls<<15 | r_mm, p_target*65535]."""
    n = len(x)
    out = np.zeros((n, 4), dtype=np.uint16)
    out[:, 0] = np.clip(np.asarray(x) * 100.0, 0, 65535).astype(np.uint16)
    out[:, 1] = np.clip(np.asarray(y) * 100.0, 0, 65535).astype(np.uint16)
    r_mm = np.clip(np.asarray(radius) * 1000.0, 0, 32767).astype(np.uint16)
    out[:, 2] = (np.asarray(cls).astype(np.uint16) << 15) | r_mm
    out[:, 3] = np.clip(np.asarray(p_target) * 65535.0, 0, 65535).astype(np.uint16)
    return _b64(out)


class LiveStreamer:
    def __init__(self, tiger, mission_id: str, run_id: str, n_envs: int,
                 phase: str = "train", env_policy: list[str] | None = None):
        self.tiger = tiger
        self.mission_id = mission_id
        self.run_id = run_id
        self.n_envs = int(n_envs)
        self.phase = phase
        self.env_policy = env_policy or ["cand"] * self.n_envs
        self.seq = 0
        self.stride = 1
        self._step_count = 0
        self._poses: list[np.ndarray] = []     # each (n_envs, 3)
        self._acts: list[np.ndarray] = []      # each (n_envs,)
        self._resets: list[dict] = []
        self._events: list[list] = []
        self._scores: list[list] = []
        self._agg = {"episodes": 0, "score_sum": 0.0, "removal_sum": 0.0, "damage_sum": 0.0}
        self._last_flush = time.monotonic()
        self._last_resync = time.monotonic()
        self._fps_t0 = time.monotonic()
        self._fps_steps = 0

    # ── per-step capture ─────────────────────────────────────────────────
    def observe(self, poses: np.ndarray, acts: np.ndarray, global_step: int):
        """poses: (n_envs, 3) of x, y, theta. acts: (n_envs,) of 0/1."""
        self._step_count += 1
        self._fps_steps += 1

        # keep the window at ~20 playback fps regardless of training speed
        dt = time.monotonic() - self._fps_t0
        if dt >= 2.0:
            sps = self._fps_steps / dt
            self.stride = max(1, int(math.ceil(sps / TARGET_PLAYBACK_FPS)))
            self._fps_t0 = time.monotonic()
            self._fps_steps = 0

        if self._step_count % self.stride == 0:
            self._poses.append(np.asarray(poses, dtype=np.float32).copy())
            self._acts.append(np.asarray(acts, dtype=np.uint8).copy())

        if time.monotonic() - self._last_flush >= FLUSH_EVERY_S:
            self.flush(global_step)

    def on_reset(self, env: int, seed: int, plants_b64: str, resync: bool = False):
        self._resets.append({
            "env": int(env), "frame": max(0, len(self._poses) - 1),
            "seed": int(seed), "plants": plants_b64,
            **({"resync": True} if resync else {}),
        })

    def on_event(self, env: int, plant_id: int, kind: str):
        self._events.append([int(env), max(0, len(self._poses) - 1), int(plant_id), kind])

    def on_episode_end(self, env: int, summary: dict):
        self._scores.append([int(env), round(float(summary.get("score", 0.0)), 4)])
        self._agg["episodes"] += 1
        self._agg["score_sum"] += float(summary.get("score", 0.0))
        self._agg["removal_sum"] += float(summary.get("target_removal_rate", 0.0))
        self._agg["damage_sum"] += float(summary.get("protect_damage_rate", 0.0))

    def needs_resync(self) -> bool:
        if time.monotonic() - self._last_resync >= RESYNC_EVERY_S:
            self._last_resync = time.monotonic()
            return True
        return False

    # ── flush one window ─────────────────────────────────────────────────
    def flush(self, global_step: int = 0):
        self._last_flush = time.monotonic()
        frames = len(self._poses)
        if frames == 0:
            return
        pose = np.zeros((self.n_envs, frames, 2), dtype=np.uint16)
        theta_act = np.zeros((self.n_envs, frames, 2), dtype=np.uint8)
        for f, (p, a) in enumerate(zip(self._poses, self._acts)):
            pose[:, f, 0] = np.clip(p[:, 0] * 100.0, 0, 65535).astype(np.uint16)
            pose[:, f, 1] = np.clip(p[:, 1] * 100.0, 0, 65535).astype(np.uint16)
            th = (p[:, 2] + math.pi) / (2 * math.pi)        # θ → 256 bins
            theta_act[:, f, 0] = np.clip(th * 255.0, 0, 255).astype(np.uint8)
            theta_act[:, f, 1] = a
        n = max(1, self._agg["episodes"])
        frame = {
            "v": 1,
            "n_envs": self.n_envs,
            "stride": int(self.stride),
            "frames": frames,
            "env_policy": self.env_policy,
            "pose": _b64(pose),
            "theta_act": _b64(theta_act),
            "resets": self._resets,
            "events": (
                self._events
                if len(self._events) <= MAX_EVENTS_PER_FLUSH
                else self._events[-MAX_EVENTS_PER_FLUSH:]
            ),
            "ep_scores": self._scores,
            "events_dropped": max(0, len(self._events) - MAX_EVENTS_PER_FLUSH),
            "agg": {
                "episodes": self._agg["episodes"],
                "score_mean": round(self._agg["score_sum"] / n, 4),
                "removal": round(self._agg["removal_sum"] / n, 4),
                "damage": round(self._agg["damage_sum"] / n, 4),
            },
        }
        if self.tiger is not None:
            self.tiger.live_frame(self.mission_id, self.run_id, self.seq,
                                  self.phase, global_step, frame)
        self.seq += 1
        self._poses.clear(); self._acts.clear()
        self._resets = []; self._events = []; self._scores = []
        self._agg = {"episodes": 0, "score_sum": 0.0, "removal_sum": 0.0, "damage_sum": 0.0}
