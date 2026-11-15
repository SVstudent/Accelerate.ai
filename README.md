# Furrow — web data in, field skills out

A farmer asks for one skill they need from their field robot. A team of agents
researches it on the open web with **Bright Data**, builds a perception model
from real web images, writes the reward and environment from published agronomy
guidance, then fine-tunes the robot's policy in parallel **Daytona** sandboxes —
and shows every training run live in a Three.js arena next to the baseline it is
beating.

Specs: [`CLAUDE.md`](CLAUDE.md) · [`SCHEMA.md`](SCHEMA.md) · [`DESIGN.md`](DESIGN.md)

---

## What is verified working

Every number below was measured on this machine, against the live services.
Nothing here is a mock or a placeholder.

| Piece | Evidence |
|---|---|
| **Bright Data SERP** (`serp_api1`) | 8 organic results for a pigweed-ID query; found the real `ipm.ucanr.edu` guide |
| **Bright Data Unlocker** (`web_unlocker1`) | 10,640 bytes of markdown from UC IPM, containing the spacing + seedling numbers |
| **Bright Data image SERP** | 98–100 direct image URLs per query (colostate.edu, growiwm.org, sare.org …) |
| **Response cache** | second identical call returns `cached: true` — demo reruns cost nothing |
| **Scout** | 88 s · 13 queries · 9 pages · **17 cited facts**, e.g. `row_spacing_cm [90,120]` from *"90 to 120cm (3 to 4 ft) between rows"* |
| **Curator** | 114 images downloaded through Unlocker, deduped by perceptual hash |
| **Gemini label QA** (via TokenRouter) | **66 verified / 22 rejected**; rejects a red circle claimed as pigweed with a reason |
| **Perception** | CLIP ViT-B/32 + logistic probe fitted in a sandbox; `perception_pool.npz` stored as an artifact |
| **Foreman** (Vultr `glm-5.3`) | English *and* Spanish → correct binomials (`Amaranthus retroflexus`, `Portulaca oleracea`), `avoid_damage 0.95` |
| **FieldGym** | 3,283 steps/s locally, **13,034 steps/s** in a sandbox; deterministic per seed |
| **Reward sandbox** | blocks `import`, `open('/etc/passwd')` (NameError), constant rewards and NaN |
| **PPO in Daytona** | **4,965 fps**; 500k-step base policy trained in **67 s** and registered as `rover-base-v1` |
| **Learning (synthetic perception fixture)** | act_precision **0.197 → 0.755**, crop damage 0.456 → 0.330 |
| **Learning (real web perception)** | score **−0.649 → −0.504**, weeds removed **0.340 → 0.401** at identical crop damage |
| **Perception calibration fix** | `pool_separation` **0.299 → 0.707** (2.4x) on the same images — `C=1.0` was collapsing probabilities toward 0.5 at `AUC 1.00` |
| **Coverage ceiling fix** | travel budget 24 m → **72 m**, swath 0.36 → **0.50 m**, coverable area 8.6 → **36 m²**; a scripted sweeper now reaches **60.6% removal** where the old geometry capped it at 46% |
| **Full mission** | completed end to end: 8 sandboxes, 2 generations, paired Before\|After test, Field Report, pinned to a frozen `demo-golden` Neon branch |
| **Telemetry** | sandbox → Neon → Tiger hypertables, `written=89 dropped=0` |
| **Tiger Data** | 3 hypertables, `curve_5s` continuous aggregate, `farm_heat` / `test_split` views, compression policies |
| **Live UI** | `/m/<id>` serves 200; SSE emitted 48 `agent_event` + 5 `ingest` + 2 `mission` in a 6 s sample |
| **Arena** | 256 instanced fields at `/farm`, score halos red → green, test-split reflow |

## Deliberate deviations from the spec, and why

These are engineering decisions forced by measurement, not shortcuts.

1. **Sandboxes reach Neon over HTTPS; telemetry relays through Neon.**
   A Daytona sandbox egresses on `:443` only. Neon's SQL-over-HTTP endpoint works
   there (verified `HTTP 200`); Tiger Cloud exposes only its Postgres port, which
   is unreachable. So `trainer/db_neon.py` speaks HTTP when `FURROW_DB_TRANSPORT=http`,
   telemetry lands in `telemetry_inbox` (`db/migrations/0002`), and the app drains
   it into Tiger's hypertables. Tiger still owns every aggregate the UI reads.
   `api.brightdata.com` is also blocked from sandboxes, so **all** web fetching
   happens in the app and image bytes are uploaded into the sandbox.

2. **BLAS/torch threads are pinned to the cgroup quota** (`trainer/cpu_tune.py`).
   A sandbox reports `nproc 64` but is capped at ~1 CPU. torch spawned 32 threads
   and thrashed: **3 env-steps/s**. Pinned, the same run does **~5,000 fps**.

3. **Rover body radius 0.10 m → 0.05 m.** With 30 cm rows the furrow centre is
   15 cm from the crop line, so a 0.10 radius body plus an 8 cm root zone (18 cm)
   made trampling unavoidable and taught policies to freeze. 0.05 + 0.08 = 13 cm
   clears it.

4. **`protect_damage_rate` counts unique damaged crops.** Summing removals and
   tramples double-counted a crop that was trampled then removed, letting damage
   exceed 1.0 (measured 1.236) and over-penalising action.

5. **Field length is derived from the travel budget**, not fixed at 12 m. At
   400 steps × 0.1 s × 0.6 m/s the rover can cover 24 m, but three 12 m rows need
   36 m — full coverage was arithmetically impossible, capping removal.

6. **CLIP comes from `transformers`, not `open_clip_torch`.** open_clip pulls
   torchvision and the CUDA stack (triton alone is 285 MB) and filled the
   sandbox's 3 GB disk (`[Errno 28]`). Same ViT-B/32 weights, 1.2 GB. CLIP's
   preprocessing is reimplemented in numpy/PIL because transformers v5 removed the
   slow image processor and the fast one needs torchvision.

7. **Structured LLM output goes through tool calling** (`structured()` in
   `src/mastra/tools/llm.ts`). Vultr rejects JSON-schema `response_format`
   (`response did not match schema`); the Gemini gateway rejects the `$schema`
   key in tool parameters but answers plain JSON. One helper, three fallbacks.

8. **Gemini is reached through TokenRouter**, an OpenAI-compatible gateway. The
   model is Gemini (`google/gemini-3.7-flash`); the gateway is how we bill it.

9. **Next.js 16 / React 19**, not Next 15 — that is what `create-next-app` ships.

## Honest gaps

- **Perception before/after is not the spec's 58% → 91%.** On this task
  zero-shot CLIP already scores ~100%: strawberry vs pigweed is easy for CLIP.
  The web data's measurable effect shows up at the *policy* level instead
  (precision 0.197 → 0.755). Do not quote a perception improvement that the run
  did not produce.
- **`act_precision` falls when the policy improves**, and this is a metric
  artefact worth stating: its denominator includes *misses*, so a policy that
  fires more, removes 18% more weeds and harms no extra crops still scores
  worse. The agronomically honest number is **crop damage per weed removed**,
  which improved 1.18 → 1.00. Both are now reported.
- **Generation 1 did not beat generation 0** on the old geometry. That was the
  signature of the coverage ceiling, not of a broken reward loop: no reward can
  buy coverage the travel budget forbids.
- A full end-to-end mission takes **~10–15 minutes**, not the 3-minute pitch. Show
  recorded segments plus replay mode and say so.

## Running it

```bash
# 1. deps
cd apps/web && npm install

# 2. schema (already applied to the live project)
node scripts/../../../scripts/...   # see db/migrations/0001_init.sql, 0002, tiger_0001

# 3. base policy — every mission fine-tunes from this
node apps/web/scripts/pretrain_base.mjs       # 500k steps, ~70s in a sandbox

# 4. dev server
cd apps/web && npx next dev

# 5. a mission
curl -XPOST localhost:3000/api/missions -H 'content-type: application/json' \
  -d '{"goal_text":"Pull pigweed out of my strawberry beds without touching the strawberries"}'
curl -XPOST localhost:3000/api/missions/<id>/run -d '{}'
open http://localhost:3000/m/<id>
```

### Surviving a restart, and forking a mission

The workflow runs inside the Next.js server process, so a rebuild or a crash
used to kill every in-flight mission silently — the row kept saying `training`
forever. Progress is now reconstructed from Postgres (the mission row,
`agent_events`, and the per-stage output tables), and a mission can be picked
back up at the first stage whose durable product is missing:

```bash
# what survived, and where a resume would start (read-only)
curl localhost:3000/api/missions/<id>/resume

# continue — reuses scraped sources and facts, curated images, the fitted
# perception model, written reward specs, completed runs and recorded evals
curl -XPOST localhost:3000/api/missions/<id>/resume -d '{}'
curl -XPOST localhost:3000/api/missions/<id>/resume \
  -d '{"from":"generation","overrides":{"budget":{"steps_per_run":100000}}}'
```

GET `/api/missions` reports a working-state mission as `stalled` when neither an
`agent_event` nor `missions.heartbeat_at` (written every 20s by the live stage
runner) has been seen for 10 minutes.

"Fork this mission" answers *what if I told it to be more cautious?* with a real
Neon branch of the database at that mission's state — every source, fact,
curated image, perception model and artifact comes along copy-on-write, so
nothing is re-scraped — and re-runs the chosen stage inside the branch with
different parameters:

```bash
curl -XPOST localhost:3000/api/missions/<id>/fork -H 'content-type: application/json' \
  -d '{"from_stage":"design","overrides":{"priorities":{"avoid_damage":1.0},
        "budget":{"variants":1,"generations":1}},"label":"more cautious"}'
curl 'localhost:3000/api/missions/<id>/compare?fork_id=fork_…'
curl -XDELETE 'localhost:3000/api/missions/<id>/fork?fork_id=fork_…'
```

Branching needs the Neon control plane: set `NEON_API_KEY` in `.env.local`
(`neon api-keys create --name furrow`), or stay logged in with the `neon` CLI —
without a key the client falls back to the CLI's authenticated passthrough.

### Cost discipline

Sandboxes are created once per mission, reused across generations, auto-stop
after 15 idle minutes and are deleted when the mission ends.
`node apps/web/scripts/daytona_cleanup.mjs --delete` removes any stragglers.
Fork branches cost Neon storage: `node apps/web/scripts/neon_branches.mjs` lists
every branch with size, age and whether Furrow created it, and only deletes with
`--delete`. `main` and `demo-golden` are excluded by name AND by id, so that
script cannot delete them whatever it is passed.
Bright Data responses are cached by URL hash and capped per mission
(`BRIGHTDATA_MAX_REQUESTS_PER_MISSION`). Vision QA downscales to 320 px first.
`tiger service delete ka4c7529hx` when the event is over.
