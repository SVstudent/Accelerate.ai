"""Pin BLAS/torch threads to the container's real CPU quota.

Daytona sandboxes report nproc = 64 but are capped by a cgroup quota of ~1 CPU.
torch and OpenBLAS read nproc, spawn 32+ threads, and thrash: measured 3
env-steps/s with default threading vs 13,034 steps/s for the bare sim. Import
this module BEFORE numpy or torch so the env vars are read at load time.
"""
from __future__ import annotations

import os


def cpu_quota() -> int:
    """Cores actually available, from cgroup v2/v1, falling back to affinity."""
    try:
        with open("/sys/fs/cgroup/cpu.max") as f:
            quota, period = f.read().split()
            if quota != "max":
                return max(1, int(float(quota) / float(period)))
    except Exception:
        pass
    try:
        with open("/sys/fs/cgroup/cpu/cpu.cfs_quota_us") as f:
            q = int(f.read().strip())
        with open("/sys/fs/cgroup/cpu/cpu.cfs_period_us") as f:
            p = int(f.read().strip())
        if q > 0:
            return max(1, q // p)
    except Exception:
        pass
    try:
        return max(1, len(os.sched_getaffinity(0)))
    except Exception:
        return max(1, os.cpu_count() or 1)


N = cpu_quota()

for var in ("OMP_NUM_THREADS", "MKL_NUM_THREADS", "OPENBLAS_NUM_THREADS",
            "NUMEXPR_NUM_THREADS", "VECLIB_MAXIMUM_THREADS"):
    os.environ.setdefault(var, str(N))


def tune_torch() -> int:
    """Call after torch is imported. Returns the thread count applied."""
    try:
        import torch
        torch.set_num_threads(N)
        try:
            torch.set_num_interop_threads(1)
        except Exception:
            pass  # only settable once per process
        return N
    except Exception:
        return N
