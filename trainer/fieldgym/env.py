"""FieldGym — 2.5D top-down selective-weeding env (CLAUDE.md §5).

Fast, deterministic per seed, pure numpy. The same sim drives training and the
browser replays. Observation layout is frozen at obs_version = 1 (53 dims) so
checkpoints stay loadable forever.
"""
from __future__ import annotations

import math
import os
import sys

import numpy as np
import gymnasium as gym
from gymnasium import spaces

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from contracts import (  # noqa: E402
    EnvConfig, K_NEAREST, OBS_DIM, PLANT_PROTECT, PLANT_TARGET, episode_score,
)
from fieldgym.field import build_field  # noqa: E402


def cfg_rover_max_speed(cfg) -> float:
    return float(cfg.rover.max_speed_mps)


class FieldGym(gym.Env):
    """Action: [throttle, steer, act] each in [-1, 1]. act > 0 fires the tool."""

    metadata = {"render_modes": []}

    def __init__(
        self,
        cfg: EnvConfig,
        reward_fn=None,
        perception=None,
        seed: int | None = None,
        record: bool = False,
    ):
        super().__init__()
        self.cfg = cfg
        self.reward_fn = reward_fn
        self.perception = perception
        self.record = record
        self._seed = seed

        self.action_space = spaces.Box(low=-1.0, high=1.0, shape=(3,), dtype=np.float32)
        self.observation_space = spaces.Box(
            low=-np.inf, high=np.inf, shape=(OBS_DIM,), dtype=np.float32
        )
        self.rng = np.random.default_rng(seed)
        self._obs_buf = np.zeros(OBS_DIM, dtype=np.float32)
        self._inv_length = self._inv_width = self._inv_max_speed = 1.0
        self._rows_y = np.zeros(1, dtype=np.float32)
        self._reset_state()

    # ── lifecycle ────────────────────────────────────────────────────────
    def _reset_state(self):
        self.plants = None
        self.geom = {}
        self.t = 0
        self.x = self.y = self.theta = self.v = 0.0
        self.traj: list[tuple[float, float, float, float]] = []
        self.events: list[tuple[int, int, str]] = []
        self.rewards: list[float] = []
        self.episode_seed = 0
        self.n_misses = 0
        self.n_removed_target = 0
        self.n_removed_protect = 0

    def reset(self, *, seed: int | None = None, options=None):
        if seed is not None:
            self.rng = np.random.default_rng(seed)
            self.episode_seed = int(seed)
        else:
            self.episode_seed = int(self.rng.integers(0, 2**31 - 1))
            self.rng = np.random.default_rng(self.episode_seed)

        self._reset_state()
        self.plants, self.geom = build_field(self.cfg, self.rng, self.perception)
        self.targets_total = int(self.plants.is_target.sum())
        self.protect_total = int(self.plants.is_protect.sum())

        # Rover starts at the head of the bed, pointing down the rows.
        self._inv_length = 1.0 / max(1e-6, float(self.geom["length_m"]))
        self._inv_width = 1.0 / max(1e-6, float(self.geom["width_m"]))
        self._inv_max_speed = 1.0 / max(1e-6, float(cfg_rover_max_speed(self.cfg)))
        self._rows_y = np.asarray(self.geom["rows_y"], dtype=np.float32)
        self.x, self.y, self.theta, self.v = 0.0, float(self.geom["rows_y"][0]), 0.0, 0.0
        if self.record:
            self.traj.append((self.x, self.y, self.theta, 0.0))
        return self._obs(), self._info(acted=False, removed_t=0, removed_p=0, trampled=0, miss=False)

    # ── observation (obs_version = 1) ────────────────────────────────────
    def _obs(self) -> np.ndarray:
        """Fully vectorised: no Python loop per plant slot. This is the hot path
        (32 envs x 100k steps in the demo preset), so it stays allocation-light."""
        cfg = self.cfg
        out = self._obs_buf
        out[:] = 0.0
        out[0] = self.x * self._inv_length
        out[1] = self.y * self._inv_width
        out[2] = math.cos(self.theta)
        out[3] = math.sin(self.theta)
        out[4] = self.v * self._inv_max_speed

        p = self.plants
        alive = np.flatnonzero(p.alive)
        n = alive.size
        if n == 0:
            return out

        dx = p.x[alive] - self.x
        dy = p.y[alive] - self.y
        d2 = dx * dx + dy * dy
        k = K_NEAREST if n > K_NEAREST else n
        if n > K_NEAREST:
            # argpartition is O(n); we only need the K nearest, unordered-ish
            idx = np.argpartition(d2, k - 1)[:k]
            idx = idx[np.argsort(d2[idx])]
        else:
            idx = np.argsort(d2)

        sel = alive[idx]
        dist = np.sqrt(d2[idx])
        ct = math.cos(-self.theta)
        st = math.sin(-self.theta)
        rx = dx[idx] * ct - dy[idx] * st
        ry = dx[idx] * st + dy[idx] * ct

        root = p.root_zone[sel]
        # `in_protect_zone` fires only on contact: the rover body is inside this
        # plant's root zone (weeds have root_zone = 0, so it never fires for
        # them). It is the trample-avoidance signal §5 lists; the plant's class
        # is still never in the observation.
        in_zone = ((dist < (root + cfg.rover.body_radius_m)) & (root > 0.0)).astype(np.float32)

        block = out[5:5 + k * 6].reshape(k, 6)
        block[:, 0] = rx
        block[:, 1] = ry
        block[:, 2] = dist
        block[:, 3] = p.p_target[sel]
        block[:, 4] = p.radius[sel]
        block[:, 5] = in_zone
        return out

    # ── step ─────────────────────────────────────────────────────────────
    def step(self, action):
        cfg = self.cfg
        dt = float(cfg.dt)
        a = np.asarray(action, dtype=np.float32).reshape(-1)
        throttle = float(np.clip(a[0], -1.0, 1.0))
        steer = float(np.clip(a[1], -1.0, 1.0))
        act = float(np.clip(a[2], -1.0, 1.0))

        # unicycle kinematics
        self.v = throttle * cfg.rover.max_speed_mps
        self.theta += steer * cfg.rover.max_turn_rps * dt
        self.theta = (self.theta + math.pi) % (2 * math.pi) - math.pi
        self.x += self.v * math.cos(self.theta) * dt
        self.y += self.v * math.sin(self.theta) * dt
        self.x = float(np.clip(self.x, 0.0, self.geom["length_m"]))
        self.y = float(np.clip(self.y, 0.0, self.geom["width_m"]))

        p = self.plants
        removed_t = removed_p = trampled = 0
        miss = False
        acted = act > 0.0

        # ── tool: the plant the robot BELIEVES is a weed, within reach ──
        #
        # A selective weeder identifies a plant and then cuts that plant. It does
        # not grab whatever is physically closest. Targeting the nearest plant
        # made a wide implement destroy the crop: at reach 0.25 m with 0.45 m
        # in-row spacing the nearest plant is usually a strawberry, which is why
        # crop damage measured 87% once the reach was widened.
        #
        # So the tool picks the in-reach plant with the highest p_target — the
        # perception model's own belief. Damage therefore depends on how good
        # the web-trained classifier is, which is exactly the link this project
        # is trying to demonstrate. The true class is never consulted here.
        if acted:
            alive = np.flatnonzero(p.alive)
            hit = -1
            if alive.size:
                d = np.hypot(p.x[alive] - self.x, p.y[alive] - self.y)
                in_reach = alive[d <= cfg.rover.reach_m]
                if in_reach.size:
                    belief = p.p_target[in_reach]
                    hit = int(in_reach[int(np.argmax(belief))])
            if hit >= 0:
                p.alive[hit] = False
                if p.cls[hit] == PLANT_TARGET:
                    removed_t = 1
                    self.n_removed_target += 1
                    self.events.append((self.t, hit, "removed_target"))
                else:
                    removed_p = 1
                    self.n_removed_protect += 1
                    self.events.append((self.t, hit, "removed_protect"))
            else:
                miss = True
                self.n_misses += 1
                self.events.append((self.t, -1, "miss"))

        # ── trampling: rover body inside a crop root zone, counted once ──
        prot = np.flatnonzero(p.is_protect & p.alive & ~p.trampled)
        if prot.size:
            d = np.hypot(p.x[prot] - self.x, p.y[prot] - self.y)
            inside = prot[d < (p.root_zone[prot] + cfg.rover.body_radius_m)]
            for i in inside:
                p.trampled[i] = True
                trampled += 1
                self.events.append((self.t, int(i), "trampled_protect"))

        self.t += 1
        truncated = self.t >= int(cfg.episode_steps)
        info = self._info(acted, removed_t, removed_p, trampled, miss, False)
        terminated = info["targets_remaining"] == 0 and self.targets_total > 0
        done = terminated or truncated
        info["done"] = bool(done)
        reward, components = self._reward(info)
        info["components"] = components

        if self.record:
            self.traj.append((self.x, self.y, self.theta, 1.0 if acted else 0.0))
            self.rewards.append(float(reward))

        if done:
            info["episode_summary"] = self.summary()

        return self._obs(), float(reward), bool(terminated), bool(truncated), info

    # ── reward ───────────────────────────────────────────────────────────
    def _reward(self, info) -> tuple[float, dict]:
        if self.reward_fn is None:
            return self._default_reward(info)
        try:
            r, comp = self.reward_fn(info)
            r = float(r)
            if not math.isfinite(r):
                return 0.0, {"nonfinite": 1.0}
            return r, (comp if isinstance(comp, dict) else {})
        except Exception as exc:  # a bad LLM reward must not kill training
            return 0.0, {"reward_error": 1.0, "msg": str(exc)[:80]}

    def _default_reward(self, info) -> tuple[float, dict]:
        """Hand-written reward for the base pretrain (§5.1): pays for acting on
        ANY plant, which is exactly why the base policy is bad at the skill."""
        c = {
            "removed_any": 1.0 * (info["removed_target"] + info["removed_protect"]),
            "miss": -0.15 if info["miss"] else 0.0,
            "trample": -0.05 * info["trampled_protect"],
            "progress": 0.01 * info["rover_speed"],
            "row_align": -0.02 * info["dist_to_row_center"],
            "step": -0.002,
        }
        return float(sum(c.values())), c

    # ── info dict (SCHEMA.md §4 contract) ────────────────────────────────
    def _info(self, acted, removed_t, removed_p, trampled, miss, done=False) -> dict:
        p = self.plants
        live = p.alive
        is_t = p.is_target & live
        is_p = p.is_protect & live
        nt = npr = 99.0
        if is_t.any():
            dx = p.x[is_t] - self.x; dy = p.y[is_t] - self.y
            nt = float(np.sqrt((dx * dx + dy * dy).min()))
        if is_p.any():
            dx = p.x[is_p] - self.x; dy = p.y[is_p] - self.y
            npr = float(np.sqrt((dx * dx + dy * dy).min()))
        d_row = float(np.abs(self._rows_y - self.y).min())
        return {
            "t": int(self.t),
            "dt": float(self.cfg.dt),
            "episode_steps": int(self.cfg.episode_steps),
            "rover_speed": float(self.v),
            "rover_turn": float(self.theta),
            "dist_to_row_center": d_row,
            "acted": bool(acted),
            "removed_target": int(removed_t),
            "removed_protect": int(removed_p),
            "trampled_protect": int(trampled),
            "miss": bool(miss),
            "nearest_target_dist": nt,
            "nearest_protect_dist": npr,
            "targets_remaining": int(is_t.sum()),
            "targets_total": int(self.targets_total),
            "protect_total": int(self.protect_total),
            "done": bool(done),
        }

    # ── episode summary (SCHEMA.md §6) ───────────────────────────────────
    def summary(self) -> dict:
        p = self.plants
        tt = max(1, self.targets_total)
        pt = max(1, self.protect_total)
        # A crop that is trampled AND then removed is ONE damaged crop, not two.
        # Counting both let protect_damage_rate exceed 1.0 and over-penalised
        # acting, which pushed policies straight into doing nothing.
        damaged_mask = p.trampled | (p.is_protect & ~p.alive)
        unique_damaged = int(damaged_mask.sum())
        unique_trampled = int(p.trampled.sum())
        removal = self.n_removed_target / tt
        damage = unique_damaged / pt
        trample = unique_trampled / pt
        denom = max(1, self.n_removed_target + self.n_removed_protect + self.n_misses)
        return {
            "target_removal_rate": float(removal),
            "protect_damage_rate": float(damage),
            "trample_rate": float(trample),
            "act_precision": float(self.n_removed_target / denom),
            "steps_used": int(self.t),
            "score": float(episode_score(removal, damage, self.t, int(self.cfg.episode_steps))),
            "removed_target": int(self.n_removed_target),
            "removed_protect": int(self.n_removed_protect),
            "trampled": unique_trampled,
            "damaged_unique": unique_damaged,
            "misses": int(self.n_misses),
            "targets_total": int(self.targets_total),
            "protect_total": int(self.protect_total),
            "seed": int(self.episode_seed),
        }

    # ── replay export (SCHEMA.md §3) ─────────────────────────────────────
    def replay(self) -> dict:
        import base64
        p = self.plants
        rov = np.asarray(self.traj, dtype=np.float32).reshape(-1)
        rew = np.asarray(self.rewards, dtype=np.float32)
        return {
            "v": 1,
            "seed": int(self.episode_seed),
            "dt": float(self.cfg.dt),
            "field": {
                "length_m": float(self.geom["length_m"]),
                "width_m": float(self.geom["width_m"]),
                "rows_y": [float(v) for v in self.geom["rows_y"]],
            },
            "plants": [
                [float(p.x[i]), float(p.y[i]), int(p.cls[i]), float(p.radius[i]),
                 float(p.p_target[i]), p.image_id[i]]
                for i in range(len(p))
            ],
            "rover": base64.b64encode(rov.tobytes()).decode("ascii"),
            "events": [[int(t), int(i), k] for (t, i, k) in self.events if i >= 0],
            "reward": base64.b64encode(rew.tobytes()).decode("ascii"),
        }
