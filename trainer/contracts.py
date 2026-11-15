"""Furrow · Python mirror of apps/web/src/lib/contracts.ts (SCHEMA.md Part 2).
If you change one, change all three in the same commit."""
from __future__ import annotations

from typing import Literal, Sequence
from pydantic import BaseModel, Field

OBS_VERSION = 1
K_NEAREST = 8                      # plants in the observation
OBS_DIM = 5 + K_NEAREST * 6        # 53, fixed forever so checkpoints stay compatible
EVAL_SEEDS: list[int] = list(range(1000, 1032))

PLANT_PROTECT = 0
PLANT_TARGET = 1

EventType = Literal["removed_target", "removed_protect", "trampled_protect", "miss"]


class Sourced(BaseModel):
    value: float | tuple[float, float] | list[float]
    fact_id: str | None = None
    assumed: bool | None = None

    def sample(self, rng) -> float:
        v = self.value
        if isinstance(v, (list, tuple)):
            lo, hi = float(v[0]), float(v[1])
            return float(rng.uniform(lo, hi))
        return float(v)

    def mid(self) -> float:
        v = self.value
        if isinstance(v, (list, tuple)):
            return (float(v[0]) + float(v[1])) / 2.0
        return float(v)


class FieldSpec(BaseModel):
    length_m: float = 12.0
    rows: int = 3
    row_spacing_m: Sourced
    in_row_spacing_m: Sourced
    crop_radius_m: Sourced
    root_zone_radius_m: Sourced
    weed_density_per_m2: Sourced
    weed_radius_m: Sourced


class RoverSpec(BaseModel):
    """A narrow inter-row tool carrier.

    body_radius 0.05 (a 10 cm wide chassis) is not cosmetic: with 30 cm rows the
    furrow centre sits 15 cm from the crop line, so a 0.10 radius body plus an
    8 cm root zone (18 cm) made trampling unavoidable and taught policies to
    freeze. 0.05 + 0.08 = 13 cm clears the furrow with 2 cm to spare, so staying
    on line is a skill the policy can actually learn. DO NOT RAISE IT.

    max_speed_mps and reach_m were raised from 0.6 / 0.18 after a measured run
    showed target_removal_rate pinned at a geometric ceiling, not a policy one.
    With rows=2, length 9 m and ~1.05 m row spacing the bed is 18.9 m^2, while
    400 steps * 0.1 s * 0.6 m/s = 24 m of travel times a 2 * 0.18 = 0.36 m swath
    covers only 8.64 m^2 = 46% of it. Measured removal was 0.401, i.e. ~87% of
    that arithmetic maximum: the policy was already near-optimal and could only
    "improve" by firing more often, which is what sank act_precision.
    0.9 m/s is inside the 0.5-1.5 m/s commercial inter-row weeders work at, and
    a 0.25 m reach is a multi-nozzle/multi-tine implement rather than a single
    point tool (0.5 m swath). With episode_steps 800 that is 72 m * 0.5 m =
    36 m^2 coverable against an 18.9 m^2 bed (190%), so 60-70% removal is
    reachable by a good policy and still out of reach of a sloppy one.
    """

    max_speed_mps: float = 0.9
    max_turn_rps: float = 1.2
    body_radius_m: float = 0.05
    reach_m: float = 0.25


class PerceptionSpec(BaseModel):
    mode: Literal["pool", "uninformative"] = "uninformative"
    perception_model_id: str | None = None


class Randomize(BaseModel):
    spacing_jitter: float = 0.15
    missing_crop_prob: float = 0.05


class EnvConfig(BaseModel):
    obs_version: Literal[1] = 1
    field: FieldSpec
    rover: RoverSpec = RoverSpec()
    perception: PerceptionSpec = PerceptionSpec()
    # 800 * dt 0.1 = an 80 s pass over the bed. 400 steps (40 s) is what capped
    # achievable coverage at ~46% of the bed — see RoverSpec's docstring.
    episode_steps: int = 800
    dt: float = 0.1
    randomize: Randomize = Randomize()


class RunHyperparams(BaseModel):
    algo: Literal["PPO"] = "PPO"
    total_steps: int = 200_000
    n_envs: int = 32
    lr: float = 3e-4
    n_steps: int = 1024
    batch_size: int = 2048
    gamma: float = 0.99
    ent_coef: float = 0.005
    clip_range: float = 0.2
    seed: int = 7
    metrics_every: int = 5000
    replay_every: int = 25_000
    replay_seed: int = 1000


class SandboxJob(BaseModel):
    job: Literal["train", "curate", "eval", "dry_run_reward"]
    mission_id: str
    run_id: str | None = None
    init_policy_artifact_id: str | None = None
    env_config: EnvConfig | None = None
    reward_code: str | None = None
    perception_pool_artifact_id: str | None = None
    hyperparams: RunHyperparams | None = None
    eval_seeds: list[int] | None = None
    dataset: list[dict] | None = None
    classes: dict[str, str] | None = None


#: Divide-by-zero guard for the ratio metrics below (mirror: RATE_EPSILON).
RATE_EPSILON = 1e-6


class EpisodeSummary(BaseModel):
    target_removal_rate: float
    protect_damage_rate: float
    trample_rate: float
    act_precision: float
    steps_used: int
    score: float
    # Optional: fieldgym's own summary() predates them, evaluate.py fills them in.
    damage_per_weed_removed: float | None = None
    miss_rate: float | None = None


class MeanCI(BaseModel):
    mean: float
    ci95: float


class EvalMetrics(BaseModel):
    """SCHEMA.md §6 — the `evaluations.metrics` jsonb. Mirror of contracts.ts."""

    n_episodes: int
    target_removal_rate: MeanCI
    protect_damage_rate: MeanCI
    trample_rate: MeanCI
    act_precision: MeanCI
    steps_used: MeanCI
    score: MeanCI
    # Impact card (§6)
    applications_avoided_pct: float | None = None
    policy_acts: int | None = None
    plants_total: int | None = None
    # §6 honest headline — ratio of the MEAN rates, not the mean of per-episode
    # ratios (a zero-removal episode would blow that up). Lower is better.
    damage_per_weed_removed: float | None = None
    # misses / max(1, acts) across the whole eval. Lower is better.
    miss_rate: float | None = None


def damage_per_weed_removed(
    protect_damage_rate: float,
    target_removal_rate: float,
) -> float:
    """Crop damage paid per weed removed — LOWER IS BETTER. Keep identical to contracts.ts.

    The honest headline `act_precision` cannot be, because
    act_precision = removed_target / (removed_target + removed_protect + misses)
    and MISSES dominate that denominator: a policy that barely fires barely
    misses and scores high, while a policy that fires often, removes far more
    weeds and harms no extra crops is punished for trigger discipline alone.
    Measured: baseline 0.400/0.340 = 1.18, trained 0.403/0.401 = 1.00 — the
    trained policy buys each weed at 15% less crop damage.

    This is a REPORTING metric. `score` (episode_score below) stays exactly as
    it is, because policies are ranked by it.
    """
    return float(protect_damage_rate) / max(RATE_EPSILON, float(target_removal_rate))


def miss_rate(misses: float, acts: float) -> float:
    """Fraction of tool firings that hit nothing — LOWER IS BETTER.

    Reported separately from crop damage so that "fires too eagerly" and
    "hurts the crop" can never again be read off the same number.
    """
    return float(misses) / max(1.0, float(acts))


def episode_score(
    target_removal_rate: float,
    protect_damage_rate: float,
    steps_used: int,
    episode_steps: int,
    damage_weight: float = 2.0,
) -> float:
    """SCHEMA.md §6 — the single ranking statistic. Keep identical to contracts.ts."""
    return (
        target_removal_rate
        - damage_weight * protect_damage_rate
        - 0.1 * (steps_used / max(1, episode_steps))
    )


def default_env_config(perception: PerceptionSpec | None = None) -> EnvConfig:
    """Generic field used by scripts/pretrain_base.py (CLAUDE.md §5.1)."""
    return EnvConfig(
        field=FieldSpec(
            length_m=12.0,
            rows=3,
            row_spacing_m=Sourced(value=[0.25, 0.40], assumed=True),
            in_row_spacing_m=Sourced(value=[0.20, 0.40], assumed=True),
            crop_radius_m=Sourced(value=[0.08, 0.16], assumed=True),
            root_zone_radius_m=Sourced(value=[0.06, 0.10], assumed=True),
            weed_density_per_m2=Sourced(value=[2.0, 6.0], assumed=True),
            weed_radius_m=Sourced(value=[0.02, 0.06], assumed=True),
        ),
        perception=perception or PerceptionSpec(mode="uninformative"),
    )
