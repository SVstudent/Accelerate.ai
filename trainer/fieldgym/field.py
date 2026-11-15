"""Field layout generation — deterministic per seed (CLAUDE.md §5)."""
from __future__ import annotations

import numpy as np

import sys, os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from contracts import EnvConfig, PLANT_PROTECT, PLANT_TARGET  # noqa: E402


class Plants:
    """Struct-of-arrays plant state. Index = plant id, stable for the episode."""

    __slots__ = ("x", "y", "cls", "radius", "root_zone", "alive", "p_target",
                 "image_id", "trampled")

    def __init__(self, x, y, cls, radius, root_zone, p_target, image_id):
        self.x = np.asarray(x, dtype=np.float32)
        self.y = np.asarray(y, dtype=np.float32)
        self.cls = np.asarray(cls, dtype=np.int8)
        self.radius = np.asarray(radius, dtype=np.float32)
        self.root_zone = np.asarray(root_zone, dtype=np.float32)
        self.p_target = np.asarray(p_target, dtype=np.float32)
        self.image_id = list(image_id)
        self.alive = np.ones(len(self.x), dtype=bool)
        # a crop counts once toward damage no matter how often it is run over
        self.trampled = np.zeros(len(self.x), dtype=bool)

    def __len__(self) -> int:
        return int(self.x.shape[0])

    @property
    def is_target(self):
        return self.cls == PLANT_TARGET

    @property
    def is_protect(self):
        return self.cls == PLANT_PROTECT


def build_field(cfg: EnvConfig, rng: np.random.Generator, perception=None) -> tuple[Plants, dict]:
    """Lay out crops on rows and scatter weeds at the configured density.

    Returns (plants, geometry) where geometry carries the bed dimensions the
    replay format needs (SCHEMA.md §3).
    """
    f = cfg.field
    length = float(f.length_m)
    rows = int(f.rows)
    row_spacing = f.row_spacing_m.sample(rng)
    in_row = f.in_row_spacing_m.sample(rng)
    crop_r = f.crop_radius_m.sample(rng)
    root_r = f.root_zone_radius_m.sample(rng)
    density = f.weed_density_per_m2.sample(rng)
    jitter = float(cfg.randomize.spacing_jitter)
    missing_p = float(cfg.randomize.missing_crop_prob)

    # Bed is a margin of one row spacing wider than the outermost rows.
    rows_y = [float(row_spacing * (i + 0.5)) for i in range(rows)]
    width = float(row_spacing * rows)

    xs: list[float] = []
    ys: list[float] = []
    cls: list[int] = []
    radius: list[float] = []
    rootz: list[float] = []

    # ── crops: in-row at `in_row` spacing, with jitter and gaps ──
    for ry in rows_y:
        n = max(1, int(length / max(0.05, in_row)))
        for i in range(n):
            if rng.random() < missing_p:
                continue
            x = (i + 0.5) * in_row + rng.normal(0.0, jitter * in_row)
            y = ry + rng.normal(0.0, jitter * row_spacing * 0.25)
            if not (0.0 <= x <= length):
                continue
            xs.append(float(np.clip(x, 0.0, length)))
            ys.append(float(np.clip(y, 0.0, width)))
            cls.append(PLANT_PROTECT)
            radius.append(float(max(0.02, crop_r * rng.uniform(0.85, 1.15))))
            rootz.append(float(root_r))

    # ── weeds: Poisson count over the bed area, uniform placement ──
    area = length * width
    n_weeds = int(rng.poisson(max(0.0, density) * area))
    for _ in range(n_weeds):
        xs.append(float(rng.uniform(0.0, length)))
        ys.append(float(rng.uniform(0.0, width)))
        cls.append(PLANT_TARGET)
        radius.append(float(f.weed_radius_m.sample(rng)))
        rootz.append(0.0)

    cls_arr = np.asarray(cls, dtype=np.int8)

    # ── p_target: the ONLY thing the policy learns from (CLAUDE.md §2) ──
    p_target, image_id = _draw_perception(cfg, cls_arr, rng, perception)

    plants = Plants(xs, ys, cls_arr, radius, rootz, p_target, image_id)
    geom = {
        "length_m": length,
        "width_m": width,
        "rows_y": rows_y,
        "row_spacing_m": row_spacing,
        "in_row_spacing_m": in_row,
    }
    return plants, geom


def _draw_perception(cfg: EnvConfig, cls_arr, rng, perception):
    """Each plant draws a real held-out web image of its true class and carries
    that image's perception probability. The label itself never reaches the obs."""
    n = int(cls_arr.shape[0])
    if n == 0:
        return np.zeros(0, dtype=np.float32), []

    if perception is not None and cfg.perception.mode == "pool":
        return perception.draw(cls_arr, rng)

    # Uninformative perception: near chance, slight spread so obs is not constant.
    # This is what the base policy was pretrained on (CLAUDE.md §5.1).
    p = rng.normal(0.5, 0.08, size=n).astype(np.float32)
    return np.clip(p, 0.02, 0.98), [None] * n
