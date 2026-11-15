#!/usr/bin/env python3
"""Train the "pre-trained but bad" base policy (CLAUDE.md §5.1).

Generic fields, random spacing, UNINFORMATIVE perception (p_target near chance),
and a reward that pays for acting on ANY plant. The result drives rows and
operates the tool competently, which is exactly what makes it bad at the
specific skill: it cannot tell a strawberry from a pigweed.

Every mission then fine-tunes from this checkpoint.
"""
from __future__ import annotations

import argparse
import os
import sys

def _trainer_dir() -> str:
    """Find trainer/ whether we run from the repo or from a sandbox upload."""
    here = os.path.dirname(os.path.abspath(__file__))
    for cand in (
        os.environ.get("FURROW_TRAINER_DIR"),
        os.path.join(here, "trainer"),                     # sandbox: /home/daytona/trainer
        os.path.join(os.path.dirname(here), "trainer"),    # repo: <root>/trainer
        os.path.join(os.getcwd(), "trainer"),
    ):
        if cand and os.path.isdir(cand):
            return cand
    raise SystemExit("cannot locate trainer/ — set FURROW_TRAINER_DIR")


sys.path.insert(0, _trainer_dir())

import cpu_tune  # noqa: E402  — before numpy/torch

from contracts import default_env_config, RunHyperparams  # noqa: E402
from fieldgym.env import FieldGym  # noqa: E402


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--steps", type=int, default=500_000)
    ap.add_argument("--envs", type=int, default=32)
    ap.add_argument("--out", default="/tmp/rover-base-v1.zip")
    ap.add_argument("--register", action="store_true",
                    help="store as artifacts + policies(kind='base') in Neon")
    args = ap.parse_args()

    from stable_baselines3 import PPO
    from stable_baselines3.common.vec_env import DummyVecEnv
    print(f"[pretrain] torch threads {cpu_tune.tune_torch()}", flush=True)

    cfg = default_env_config()           # uninformative perception by default
    venv = DummyVecEnv([
        (lambda i=i: FieldGym(cfg, reward_fn=None, perception=None, seed=4242 + i))
        for i in range(args.envs)
    ])
    hp = RunHyperparams(total_steps=args.steps, n_envs=args.envs)
    # Architecture MUST match trainer/train.py, or PPO.load cannot restore the
    # weights into the fine-tuning model and every mission silently trains from
    # scratch instead of from this checkpoint.
    model = PPO(
        "MlpPolicy", venv, device="cpu", seed=7, learning_rate=hp.lr,
        n_steps=max(64, hp.n_steps // args.envs), batch_size=hp.batch_size,
        gamma=hp.gamma, ent_coef=hp.ent_coef, clip_range=hp.clip_range,
        n_epochs=12, gae_lambda=0.97, max_grad_norm=0.5, vf_coef=0.6,
        policy_kwargs={"net_arch": {"pi": [256, 256], "vf": [256, 256]}},
        verbose=1,
    )
    model.learn(total_timesteps=args.steps, progress_bar=False)
    model.save(args.out)
    print(f"[pretrain] saved {args.out}", flush=True)

    if args.register:
        from db_neon import NeonWriter
        neon = NeonWriter()
        blob = open(args.out, "rb").read()
        art = neon.put_artifact("policy_zip", "application/zip", blob)
        pol = neon.put_policy("rover-base-v1", "base", art or "art_missing")
        print(f"BASE_POLICY_ID={pol}\nBASE_ARTIFACT_ID={art}", flush=True)
        neon.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
