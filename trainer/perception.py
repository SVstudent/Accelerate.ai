"""Perception pool — the web-data → policy link (CLAUDE.md §2).

curate.py writes perception_pool.npz: for each class, the p_target values the
linear probe assigned to held-out web images, plus their dataset_items ids.
Every simulated plant draws one of those real images; the policy sees only its
p_target, never the label. Better web data ⇒ better p_target ⇒ better policy.
"""
from __future__ import annotations

import numpy as np

PLANT_PROTECT = 0
PLANT_TARGET = 1


class PerceptionPool:
    def __init__(self, p_target_for_targets, ids_for_targets,
                 p_target_for_protect, ids_for_protect):
        self.pt_t = np.asarray(p_target_for_targets, dtype=np.float32)
        self.id_t = list(ids_for_targets)
        self.pt_p = np.asarray(p_target_for_protect, dtype=np.float32)
        self.id_p = list(ids_for_protect)
        if self.pt_t.size == 0 or self.pt_p.size == 0:
            raise ValueError("perception pool needs held-out images of both classes")

    @classmethod
    def load(cls, path: str) -> "PerceptionPool":
        z = np.load(path, allow_pickle=True)
        return cls(z["p_target_target"], list(z["ids_target"]),
                   z["p_target_protect"], list(z["ids_protect"]))

    def save(self, path: str) -> None:
        np.savez_compressed(
            path,
            p_target_target=self.pt_t, ids_target=np.array(self.id_t, dtype=object),
            p_target_protect=self.pt_p, ids_protect=np.array(self.id_p, dtype=object),
        )

    def draw(self, cls_arr, rng):
        """Draw one held-out image per plant. Returns (p_target, image_ids)."""
        n = int(np.asarray(cls_arr).shape[0])
        p = np.empty(n, dtype=np.float32)
        ids: list[str | None] = [None] * n
        is_t = np.asarray(cls_arr) == PLANT_TARGET
        it = np.flatnonzero(is_t)
        ip = np.flatnonzero(~is_t)
        if it.size:
            pick = rng.integers(0, self.pt_t.size, size=it.size)
            p[it] = self.pt_t[pick]
            for k, i in enumerate(it):
                ids[int(i)] = self.id_t[int(pick[k])]
        if ip.size:
            pick = rng.integers(0, self.pt_p.size, size=ip.size)
            p[ip] = self.pt_p[pick]
            for k, i in enumerate(ip):
                ids[int(i)] = self.id_p[int(pick[k])]
        return p, ids

    @property
    def separation(self) -> float:
        """Mean p_target gap between classes — how much signal the policy gets."""
        return float(self.pt_t.mean() - self.pt_p.mean())


def synthetic_pool(accuracy: float = 0.91, n: int = 120, seed: int = 0) -> PerceptionPool:
    """A stand-in pool with a given separability, for local spikes before the
    real Bright Data images exist. Never used when a real pool is available."""
    rng = np.random.default_rng(seed)
    spread = 0.18
    centre = 0.5 + 0.5 * (2 * accuracy - 1)
    pt_t = np.clip(rng.normal(centre, spread, n), 0.01, 0.99)
    pt_p = np.clip(rng.normal(1.0 - centre, spread, n), 0.01, 0.99)
    return PerceptionPool(pt_t, [f"img_syn_t{i}" for i in range(n)],
                          pt_p, [f"img_syn_p{i}" for i in range(n)])
