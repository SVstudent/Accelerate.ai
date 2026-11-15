#!/usr/bin/env python3
"""PPO fine-tune from the base policy (CLAUDE.md §5.3).

One sandbox = one training variant: FieldGym with n_envs = 32 in a DummyVecEnv.
State goes to Neon, telemetry to Tiger Data, live frames to Tiger Data.
Entry point takes a single --job job.json (CLAUDE.md §12).
"""
from __future__ import annotations

import argparse
import io
import json
import math
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import cpu_tune  # noqa: E402  — must precede numpy/torch

import numpy as np  # noqa: E402

from contracts import SandboxJob, EnvConfig, RunHyperparams, EVAL_SEEDS  # noqa: E402
from fieldgym.env import FieldGym  # noqa: E402
from reward_runtime import build_reward, RewardError  # noqa: E402
from perception import PerceptionPool  # noqa: E402
from db_neon import NeonWriter  # noqa: E402
from db_tiger import TigerWriter  # noqa: E402
from live_stream import LiveStreamer, encode_plants  # noqa: E402


def make_env(cfg: EnvConfig, reward_fn, pool, seed: int):
    def _f():
        return FieldGym(cfg, reward_fn=reward_fn, perception=pool, seed=seed)
    return _f


def load_pool(neon: NeonWriter, artifact_id: str | None):
    if not artifact_id:
        return None
    blob = neon.get_artifact(artifact_id)
    if not blob:
        print("[train] no perception pool artifact; falling back to uninformative", flush=True)
        return None
    path = "/tmp/perception_pool.npz"
    with open(path, "wb") as f:
        f.write(blob)
    return PerceptionPool.load(path)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--job", required=True)
    args = ap.parse_args()

    job = SandboxJob.model_validate_json(open(args.job).read())
    assert job.job == "train", f"train.py got job={job.job}"
    run_id = job.run_id or "run_local"
    hp: RunHyperparams = job.hyperparams or RunHyperparams()
    cfg: EnvConfig = job.env_config
    phase = os.environ.get("FURROW_PHASE", "train")

    neon = NeonWriter()
    tiger = TigerWriter(relay=neon)
    neon.run_status(run_id, "booting", 0.0, sandbox_id=os.environ.get("DAYTONA_SANDBOX_ID"))

    # ── reward: LLM-written, compiled in the sandbox's restricted namespace ──
    reward_fn = None
    if job.reward_code:
        try:
            reward_fn = build_reward(job.reward_code)
        except RewardError as exc:
            neon.run_status(run_id, "failed", 0.0, error=f"reward rejected: {exc}")
            tiger.close()
            print(f"[train] reward rejected: {exc}", flush=True)
            return 2

    pool = load_pool(neon, job.perception_pool_artifact_id)
    if pool is not None:
        print(f"[train] perception pool separation {pool.separation:.3f}", flush=True)

    # ── vectorised envs ──
    from stable_baselines3 import PPO
    from stable_baselines3.common.vec_env import DummyVecEnv
    print(f"[train] torch threads pinned to {cpu_tune.tune_torch()} (cgroup quota)", flush=True)

    n_envs = int(hp.n_envs)
    venv = DummyVecEnv([
        make_env(cfg, reward_fn, pool, hp.seed * 1000 + i) for i in range(n_envs)
    ])

    # ── init from the current best policy ──
    model = None
    if job.init_policy_artifact_id:
        blob = neon.get_artifact(job.init_policy_artifact_id)
        if blob:
            p = "/tmp/init_policy.zip"
            open(p, "wb").write(blob)
            try:
                model = PPO.load(p, env=venv, device="cpu")
                model.learning_rate = hp.lr
                print("[train] loaded init policy", flush=True)
            except Exception as exc:
                print(f"[train] init policy load failed ({exc}); training fresh", flush=True)
    if model is None:
        model = PPO(
            "MlpPolicy", venv, device="cpu", seed=hp.seed, learning_rate=hp.lr,
            n_steps=max(64, hp.n_steps // n_envs), batch_size=hp.batch_size,
            gamma=hp.gamma, ent_coef=hp.ent_coef, clip_range=hp.clip_range,
            # Tuned for this task rather than left at SB3 defaults:
            #  · n_epochs 12 (vs 10): episodes are long (800 steps) and rollouts
            #    are expensive at ~7k fps, so squeeze more from each batch.
            #  · gae_lambda 0.97: credit for avoiding a crop has to travel back
            #    several steps to the steering that avoided it.
            #  · max_grad_norm 0.5 and vf_coef 0.6: the value function has to
            #    predict a reward dominated by rare discrete events.
            #  · a wider net: 53-dim obs with 8 plant slots needs capacity to
            #    represent "which of these is a weed and where is the furrow".
            n_epochs=12, gae_lambda=0.97, max_grad_norm=0.5, vf_coef=0.6,
            policy_kwargs={"net_arch": {"pi": [256, 256], "vf": [256, 256]}},
            verbose=0,
        )

    streamer = LiveStreamer(tiger, job.mission_id, run_id, n_envs, phase=phase)
    neon.run_status(run_id, "training", 0.0)
    neon.event(job.mission_id, "trainer", "result", f"Run {run_id} training on {n_envs} envs")

    # ── callback: telemetry + live frames, never blocking ──
    from stable_baselines3.common.callbacks import BaseCallback

    class Stream(BaseCallback):
        def __init__(self):
            super().__init__()
            self.t0 = time.time()
            self.last_metrics = 0
            self.last_status = 0.0
            self._ev_cursor: dict[int, int] = {}

        def _on_step(self) -> bool:
            envs = self.training_env
            try:
                xs = envs.get_attr("x"); ys = envs.get_attr("y")
                ths = envs.get_attr("theta")
            except Exception:
                return True
            poses = np.stack([np.asarray(xs), np.asarray(ys), np.asarray(ths)], axis=1)
            acts = np.asarray([
                1 if (a is not None and float(np.asarray(a).reshape(-1)[2]) > 0) else 0
                for a in self.locals.get("clipped_actions", [None] * len(xs))
            ], dtype=np.uint8) if self.locals.get("clipped_actions") is not None else np.zeros(len(xs), np.uint8)
            streamer.observe(poses, acts, self.num_timesteps)

            # Forward newly recorded sim events so the browser can show a weed
            # actually being cut. FieldGym appends to env.events; we keep a
            # per-env cursor and ship only what is new. Without this the arena
            # renders plants that never disappear.
            try:
                ev_lists = envs.get_attr("events")
                for i, evs in enumerate(ev_lists):
                    seen = self._ev_cursor.get(i, 0)
                    if len(evs) < seen:        # env reset: its list restarted
                        seen = 0
                    for (t_step, plant_id, kind) in evs[seen:]:
                        if plant_id >= 0:
                            streamer.on_event(i, int(plant_id), str(kind))
                    self._ev_cursor[i] = len(evs)
            except Exception:
                pass

            # episode ends: infos carry our summary
            for i, info in enumerate(self.locals.get("infos", [])):
                s = info.get("episode_summary")
                if s:
                    streamer.on_episode_end(i, s)
                    tiger.episode(job.mission_id, run_id, i, phase, "cand",
                                  s.get("seed", 0), self.num_timesteps, s)

            # periodic resync of plant layouts so a new browser client can draw
            if streamer.needs_resync():
                try:
                    plants = envs.get_attr("plants")
                    seeds = envs.get_attr("episode_seed")
                    for i, (p, sd) in enumerate(zip(plants, seeds)):
                        self._ev_cursor[i] = 0
                        streamer.on_reset(i, int(sd),
                                          encode_plants(p.x[p.alive], p.y[p.alive], p.cls[p.alive],
                                                        p.radius[p.alive], p.p_target[p.alive]),
                                          resync=True)
                except Exception:
                    pass

            if self.num_timesteps - self.last_metrics >= hp.metrics_every:
                self.last_metrics = self.num_timesteps
                fps = self.num_timesteps / max(1e-6, time.time() - self.t0)
                lg = self.logger.name_to_value if self.logger else {}
                tiger.metrics(run_id, self.num_timesteps, {
                    "ep_return_mean": lg.get("rollout/ep_rew_mean"),
                    "fps": fps,
                    "policy_loss": lg.get("train/policy_gradient_loss"),
                    "value_loss": lg.get("train/value_loss"),
                    "entropy": lg.get("train/entropy_loss"),
                    "approx_kl": lg.get("train/approx_kl"),
                })
                prog = min(1.0, self.num_timesteps / max(1, hp.total_steps))
                if prog - self.last_status >= 0.02:
                    self.last_status = prog
                    neon.run_status(run_id, "training", prog)
                print(f"[train] {self.num_timesteps}/{hp.total_steps} fps={fps:.0f}", flush=True)
            return True

    # linear LR decay: explore steering early, then stop thrashing once the
    # furrow-following behaviour has been found
    try:
        base_lr = float(hp.lr)
        model.learning_rate = lambda progress_remaining: base_lr * (0.15 + 0.85 * progress_remaining)
        model._setup_lr_schedule()
    except Exception:
        pass

    try:
        model.learn(total_timesteps=int(hp.total_steps), callback=Stream(), progress_bar=False)
    except Exception as exc:
        streamer.flush(0)
        neon.run_status(run_id, "failed", error=f"{type(exc).__name__}: {exc}")
        tiger.close(); neon.close()
        print(f"[train] FAILED: {exc}", flush=True)
        return 1

    streamer.flush(int(hp.total_steps))

    # ── save the resulting policy as an artifact + policy row ──
    buf = "/tmp/result_policy.zip"
    model.save(buf)
    blob = open(buf, "rb").read()
    art = neon.put_artifact("policy_zip", "application/zip", blob)
    pol = neon.put_policy(f"{job.mission_id}/{run_id}", "candidate", art or "art_missing",
                          mission_id=job.mission_id)
    if pol:
        neon.set_run_result_policy(run_id, pol)

    # ── one replay at the fixed seed so the UI can show this variant ──
    try:
        rec = FieldGym(cfg, reward_fn=reward_fn, perception=pool, seed=hp.replay_seed, record=True)
        obs, _ = rec.reset(seed=hp.replay_seed)
        for _ in range(int(cfg.episode_steps)):
            a, _ = model.predict(obs, deterministic=True)
            obs, r, term, trunc, _ = rec.step(a)
            if term or trunc:
                break
        neon.put_replay(job.mission_id, rec.replay(), rec.summary(), "checkpoint",
                        run_id=run_id, policy_id=pol, step=int(hp.total_steps))
    except Exception as exc:
        print(f"[train] replay export failed (ignored): {exc}", flush=True)

    neon.run_status(run_id, "done", 1.0)
    neon.event(job.mission_id, "trainer", "result", f"Run {run_id} finished")
    tiger.close(); neon.close()
    print("[train] done", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
