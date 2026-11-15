"""Executes LLM-written reward code inside the sandbox (CLAUDE.md §5, SCHEMA.md §4).

The ONLY names the reward sees are `math`, `np` and its `info` argument.
No imports, no I/O, no builtins beyond a tiny safe set. This is the real reason
the project needs Daytona: never run this outside a sandbox.
"""
from __future__ import annotations

import math
import time

import numpy as np

# Builtins a numeric reward legitimately needs. Everything else is withheld,
# including __import__, open, eval, exec, getattr and friends.
_SAFE_BUILTINS = {
    "abs": abs, "min": min, "max": max, "sum": sum, "len": len, "round": round,
    "float": float, "int": int, "bool": bool, "pow": pow, "range": range,
    "enumerate": enumerate, "zip": zip, "sorted": sorted, "any": any, "all": all,
    "True": True, "False": False, "None": None,
}

MAX_ABS_MEAN = 100.0
MIN_STD = 1e-6
MAX_MS_PER_CALL = 2.0


class RewardError(RuntimeError):
    pass


def build_reward(code: str):
    """Compile `code` and return its `reward(info) -> (float, dict)` callable."""
    if "import" in code:
        # A plain textual check: the restricted namespace already blocks imports,
        # this just fails fast with a clear message for the Architect to read.
        raise RewardError("reward code must not import anything")
    ns: dict = {
        "__builtins__": _SAFE_BUILTINS,
        "math": math,
        "np": np,
        "numpy": np,
    }
    try:
        compiled = compile(code, "<reward_spec>", "exec")
        exec(compiled, ns)  # noqa: S102 — sandboxed namespace, sandboxed machine
    except Exception as exc:
        raise RewardError(f"reward code failed to compile: {exc}") from exc

    fn = ns.get("reward")
    if not callable(fn):
        raise RewardError("reward code must define reward(info)")

    def wrapped(info):
        out = fn(info)
        if isinstance(out, tuple):
            r, comp = out
        else:
            r, comp = out, {}
        return float(r), (comp if isinstance(comp, dict) else {})

    return wrapped


def dry_run(code: str, cfg, seeds=(0, 1, 2), steps: int = 1000) -> dict:
    """1,000 random-action steps over 3 seeds (SCHEMA.md §4 validation).

    Rejects: raises, NaN/inf, |mean| > 100, std < 1e-6 (constant), > 2 ms/call.
    Returns the dict stored in reward_specs.dry_run.
    """
    import sys, os
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    from fieldgym.env import FieldGym

    try:
        fn = build_reward(code)
    except RewardError as exc:
        return {"ok": False, "error": str(exc)}

    values: list[float] = []
    components: dict[str, float] = {}
    t0 = time.perf_counter()
    n_calls = 0

    try:
        for seed in seeds:
            env = FieldGym(cfg, reward_fn=None, seed=int(seed))
            env.reset(seed=int(seed))
            per_seed = max(1, steps // len(seeds))
            for _ in range(per_seed):
                act = env.action_space.sample()
                _, _, term, trunc, info = env.step(act)
                r, comp = fn(info)
                n_calls += 1
                if not math.isfinite(r):
                    return {"ok": False, "error": "reward returned NaN or inf"}
                values.append(float(r))
                for k, v in comp.items():
                    if isinstance(v, (int, float)) and math.isfinite(float(v)):
                        components[k] = components.get(k, 0.0) + float(v)
                if term or trunc:
                    env.reset()
    except Exception as exc:
        return {"ok": False, "error": f"reward raised: {type(exc).__name__}: {exc}"}

    elapsed_ms = (time.perf_counter() - t0) * 1000.0
    ms_per_call = elapsed_ms / max(1, n_calls)
    arr = np.asarray(values, dtype=np.float64)
    mean, std = float(arr.mean()), float(arr.std())

    if abs(mean) > MAX_ABS_MEAN:
        return {"ok": False, "error": f"|mean| {abs(mean):.1f} exceeds {MAX_ABS_MEAN}", "mean": mean}
    if std < MIN_STD:
        return {"ok": False, "error": "reward is constant (std < 1e-6)", "mean": mean, "std": std}
    if ms_per_call > MAX_MS_PER_CALL:
        return {"ok": False, "error": f"{ms_per_call:.2f} ms per call exceeds {MAX_MS_PER_CALL} ms"}

    return {
        "ok": True,
        "mean": mean, "std": std,
        "min": float(arr.min()), "max": float(arr.max()),
        "ms_per_call": round(ms_per_call, 4),
        "n_calls": n_calls,
        "components": {k: round(v / max(1, n_calls), 6) for k, v in components.items()},
    }
