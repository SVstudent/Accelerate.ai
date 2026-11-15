#!/usr/bin/env python3
"""Fixed-seed evaluation (CLAUDE.md §4, SCHEMA.md §6).

N = 32 episodes on EVAL_SEEDS = [1000..1031] for every policy, so the Judge
ranks like-for-like and the compare view shows the same field.
"""
from __future__ import annotations

import argparse
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import cpu_tune  # noqa: E402  — must precede numpy/torch

import numpy as np  # noqa: E402

from contracts import (  # noqa: E402
    SandboxJob, EnvConfig, EVAL_SEEDS, episode_score,
    damage_per_weed_removed, miss_rate,
)
from fieldgym.env import FieldGym  # noqa: E402
from reward_runtime import build_reward  # noqa: E402
from perception import PerceptionPool  # noqa: E402
from db_neon import NeonWriter  # noqa: E402
from db_tiger import TigerWriter  # noqa: E402


def mean_ci(xs: list[float]) -> dict:
    a = np.asarray(xs, dtype=np.float64)
    n = max(1, a.size)
    mean = float(a.mean()) if a.size else 0.0
    sd = float(a.std(ddof=1)) if a.size > 1 else 0.0
    return {"mean": round(mean, 5), "ci95": round(1.96 * sd / math.sqrt(n), 5)}


def run_eval(model, cfg: EnvConfig, pool, seeds, reward_fn=None, record_first=True):
    per: dict[str, list[float]] = {
        "target_removal_rate": [], "protect_damage_rate": [], "trample_rate": [],
        "act_precision": [], "steps_used": [], "score": [],
    }
    acts_total = 0
    misses_total = 0
    plants_total = 0
    first_replay = None
    first_summary = None
    episodes = []

    for i, seed in enumerate(seeds):
        want_record = record_first and i == 0
        env = FieldGym(cfg, reward_fn=reward_fn, perception=pool, seed=int(seed), record=want_record)
        obs, _ = env.reset(seed=int(seed))
        for _ in range(int(cfg.episode_steps)):
            if model is None:
                a = env.action_space.sample()
            else:
                a, _ = model.predict(obs, deterministic=True)
            obs, r, term, trunc, _ = env.step(a)
            if term or trunc:
                break
        s = env.summary()
        # §6 reporting metrics the simulator's summary() does not produce.
        # Per episode, from that episode's own rates and counts.
        ep_acts = int(s["removed_target"]) + int(s["removed_protect"]) + int(s["misses"])
        # An episode that removed no weeds has NO damage-per-weed: the epsilon in
        # the formula keeps it finite, not meaningful. Omit the key so the UI
        # renders an em dash instead of an invented 100000.
        if s["target_removal_rate"] > 0.0:
            s["damage_per_weed_removed"] = round(damage_per_weed_removed(
                s["protect_damage_rate"], s["target_removal_rate"]), 5)
        s["miss_rate"] = round(miss_rate(int(s["misses"]), ep_acts), 5)
        episodes.append(s)
        for k in per:
            per[k].append(float(s[k]))
        acts_total += ep_acts
        misses_total += int(s["misses"])
        plants_total += s["targets_total"] + s["protect_total"]
        if want_record:
            first_replay, first_summary = env.replay(), s

    metrics = {k: mean_ci(v) for k, v in per.items()}
    metrics["n_episodes"] = len(seeds)
    metrics["policy_acts"] = int(acts_total)
    metrics["plants_total"] = int(plants_total)
    # Impact card (§6): blanket spraying treats every plant.
    metrics["applications_avoided_pct"] = round(
        max(0.0, 1.0 - acts_total / max(1, plants_total)), 5)
    # §6 honest headline: crop damage paid per weed removed, lower is better.
    # Computed as the RATIO OF THE MEAN RATES (not the mean of the per-episode
    # ratios, which a single zero-removal episode would blow up to epsilon-scale
    # nonsense). On the measured run: baseline 0.400/0.340 = 1.176, trained
    # 0.403/0.401 = 1.005 — a real improvement that score and act_precision hide.
    # Omitted, never faked, for a policy that removed nothing at all: the whole
    # point of the metric is the cost of a weed, and there was no weed.
    if metrics["target_removal_rate"]["mean"] > 0.0:
        metrics["damage_per_weed_removed"] = round(damage_per_weed_removed(
            metrics["protect_damage_rate"]["mean"],
            metrics["target_removal_rate"]["mean"]), 5)
    # Misses made visible on their own, instead of only inside act_precision's
    # denominator where they masquerade as crop damage.
    metrics["miss_rate"] = round(miss_rate(misses_total, acts_total), 5)
    return metrics, first_replay, first_summary, episodes


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--job", required=True)
    args = ap.parse_args()
    job = SandboxJob.model_validate_json(open(args.job).read())
    assert job.job == "eval", f"evaluate.py got job={job.job}"

    cfg: EnvConfig = job.env_config
    seeds = job.eval_seeds or EVAL_SEEDS
    neon = NeonWriter()
    tiger = TigerWriter(relay=neon)

    pool = None
    if job.perception_pool_artifact_id:
        blob = neon.get_artifact(job.perception_pool_artifact_id)
        if blob:
            open("/tmp/pool.npz", "wb").write(blob)
            pool = PerceptionPool.load("/tmp/pool.npz")

    from stable_baselines3 import PPO
    cpu_tune.tune_torch()
    model = None
    is_baseline = True
    if job.init_policy_artifact_id:
        blob = neon.get_artifact(job.init_policy_artifact_id)
        if blob:
            open("/tmp/eval_policy.zip", "wb").write(blob)
            model = PPO.load("/tmp/eval_policy.zip", device="cpu")
    policy_kind = os.environ.get("FURROW_EVAL_KIND", "baseline")
    is_baseline = policy_kind == "baseline"

    reward_fn = build_reward(job.reward_code) if job.reward_code else None
    metrics, replay, summary, episodes = run_eval(model, cfg, pool, seeds, reward_fn)

    # the test phase streams paired-seed episodes so the UI can count live
    phase = os.environ.get("FURROW_PHASE", "")
    if phase == "test":
        pol = "base" if is_baseline else "cand"
        for i, s in enumerate(episodes):
            tiger.episode(job.mission_id, job.run_id or "run_eval", i, "test", pol,
                          s.get("seed", seeds[i]), 0, s)

    policy_id = os.environ.get("FURROW_POLICY_ID")
    env_config_id = os.environ.get("FURROW_ENV_CONFIG_ID")
    if policy_id and env_config_id:
        eid = neon.put_evaluation(job.mission_id, policy_id, env_config_id,
                                  list(seeds), metrics, is_baseline,
                                  os.environ.get("FURROW_PERCEPTION_MODEL_ID"))
        print(f"[eval] evaluation {eid}", flush=True)
    if replay:
        neon.put_replay(job.mission_id, replay, summary,
                        "baseline" if is_baseline else "eval",
                        run_id=job.run_id, policy_id=policy_id)

    print("[eval] " + ", ".join(
        f"{k}={metrics[k]['mean']:.3f}" for k in
        ("score", "target_removal_rate", "protect_damage_rate", "act_precision"))
        + (f", damage_per_weed_removed={metrics['damage_per_weed_removed']:.3f}"
           if "damage_per_weed_removed" in metrics else ", damage_per_weed_removed=n/a")
        + f", miss_rate={metrics['miss_rate']:.3f}", flush=True)
    import json
    print("EVAL_METRICS_JSON=" + json.dumps(metrics), flush=True)
    tiger.close(); neon.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
