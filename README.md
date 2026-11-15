# Accelerate.ai

**Natural-language reinforcement learning for physical AI.** Upload the control
policy your machine already runs, describe in one sentence what you want it to
do better, and get back a measurably improved policy — with every number traced
to the row it came from.

Agriculture is the demo vertical. Nothing in the pipeline is agricultural.

---

## Why this exists

A strawberry grower can buy a weeding robot today. What they cannot buy is a
better version of the one they already own.

Every embodied system — field robots, harvesters, haul trucks, pick-and-place
arms, inspection drones — ships with a control policy, and the moment it is
deployed, improving it becomes a specialist's job. The operator owns the weights
and has no path forward. They would need four things at once:

| What you need | Why you don't have it |
|---|---|
| Domain knowledge | Row spacing, growth stages, how the work is really done — published on extension sites and in papers, not behind any API |
| A labelled dataset | No public weed-vs-strawberry dataset exists. Hand-labelling one is weeks of work *per vertical* |
| A reward function | The code defining "a good job". This is the specialist skill, and the part that actually breaks |
| Training infrastructure | Parallel envs, a fair evaluation harness, trustworthy telemetry — months of platform work before anything is learned |

The conventional answer is to hire an ML consultant for months. **Accelerate.ai
supplies all four from one sentence, for cents of compute.**

The design bet: of those four, three are solvable with infrastructure that
already exists. The fourth — writing the reward function — is the one everyone
treats as irreducibly human. So we made it the thing being searched.

---

## What it actually does

Seven agents, one pipeline. The user supplies weights + one sentence; everything
below is automatic.

```
Foreman    sentence -> structured task spec (target class, protected class, priorities)
Scout      reads the open web, extracts measurements, stores each with its source URL
Curator    mines + verifies an image set for THIS task, fits a CLIP probe
Architect  writes the reward function and env config as code, dry-runs it
Trainer    PPO across parallel sandboxes, 32 vectorised envs each
Judge      reads per-component reward magnitudes, rewrites the reward, re-ranks
Report     plain-language result, every figure cited back to a database row
```

**The core idea: the reward function is part of the search space.** Most RL
projects hand-write one reward and train against it. Here four candidates are
generated per generation, raced on identical seeds, then rewritten by a Judge
agent that reads the measured per-component breakdown. Three generations deep.

A real failure this caught: generation 0 priced a trampled crop at `−0.0007`
and a pulled weed at `+0.0164`, so the policy correctly concluded it should
drive straight over the strawberries. It was not broken — it was obeying a badly
written law. The Judge found it and raised the trample penalty ~20×.

---

## Results

Mission `msn_6K0A4ufY3dsf`. **Both policies evaluated on the same 32 fixed seeds
through the same perception model** — no handicap on the baseline.

| Measurement | Uploaded model | After Accelerate.ai | Meaning |
|---|---|---|---|
| Act precision | 22.6% | **75.5%** | Of 100 actuations, 23 used to hit a weed; now 75 do |
| Weed detection | 73.2% | **89.3%** | Zero-shot CLIP vs. probe fitted on web images |
| Miss rate | 0.697 | **0.226** | Weeds driven past and left standing |
| Damage per weed removed | 1.117 | **0.889** | Crosses below 1.0 — net beneficial |
| Crop damage rate | 88.8% | **73.5%** | Improved, still not shippable |
| Weeds removed | 79.5% | **82.7%** | Smallest gain; coverage was never the bottleneck |

3 generations · 14 trained controllers · 19 evaluations · 793,600 steps each ·
~3,283 steps/sec/core · **$0.09 total compute**.

**Reported honestly:** crop damage at 73.5% is not production-ready. The
hard-negative ablation improved held-out look-alike accuracy 75.0% → 87.5% but
made `pool_separation` *worse* by 0.039. Measurements that moved the wrong way
are shown next to the ones that moved the right way, in the UI and here.

---

## The stack, and why each piece is there

### Bright Data — the ground-truth layer
The project does not work without it. There is no dataset for this vertical, so
one is built per mission from the open web.

- **SERP API** (`serp_api1`) finds authoritative sources; **Web Unlocker**
  (`web_unlocker1`) retrieves extension-service pages that block naive scrapers.
- **Provenance is enforced:** every measurement that shapes the simulator is
  stored with the page it came from. The UI labels each parameter `cited` or
  `assumed`. No figure enters the system without a source row.
- **Hard-negative mining** is the novel part. Rather than scraping clean
  examples, an LLM is asked which classes are *visually confusable* with which,
  and those are scraped specifically. Measured: held-out look-alike accuracy
  **75.0% → 87.5%**. The mining prompt contains no agricultural vocabulary — it
  speaks of a *target* and a *protected* class, so it transfers to ore vs. waste
  rock or pallets vs. people.
- **Multi-region targeting** (`gl`/`hl`): the system picks which countries
  publish authoritative guidance for this system and repeats core queries there.
  Cross-region disagreement >15% is surfaced, not silently resolved.

This run: 54 SERP queries · 64 pages · 11 domains · 301 images (265 verified,
36 rejected) · 14 cited facts.

### Tiger Data (TimescaleDB) — the telemetry engine
Training emits a firehose that ordinary Postgres degrades on. This run wrote
**16,514 episode records, 3,324 arena frames, 2,647 metric rows**.

- **Hypertables** partition by time automatically.
- **Continuous aggregates** (`curve_5s`) keep rollups warm without rescanning.
- **`lttb()`** downsamples a curve to what a screen can draw while preserving
  its visual shape — averaging would flatten exactly the spikes that matter.
  The chart labels itself `Tiger · LTTB 3,840→121`.
- **`stats_agg` / `percentile_agg`** give spread without a table scan. This
  matters: two runs here had near-identical means (−0.781 vs −0.785) but **1.6×
  different variance**. A bare mean hides that completely.
- **Compression + retention policies** run as background jobs.

### Neon — the spine, not just storage
- Every agent writes to Postgres, so a mission is **fully reconstructable from
  rows** (143 agent events, 18 policies, 33 replays here).
- **Serverless branching (copy-on-write)** powers *fork this mission*: branch at
  a finished state, re-run from any stage with different priorities, compare
  side by side. A fork branch held all sources, facts and images with nothing
  re-scraped, and writes inside it left `main` byte-identical.
- Trainers claim work atomically with `FOR UPDATE SKIP LOCKED`.
- Because state lives in Postgres rather than memory, **a mission survives the
  server restarting** — which it did, repeatedly, during the build.

### Vultr Serverless Inference — reward and environment authoring
OpenAI-compatible endpoint with tool calling, so reward code and env config come
back as structured calls rather than parsed prose. Every candidate reward is
compiled and **dry-run for 1,000 steps in a sandbox** before it costs any
training compute. Rewards that crash, return constants or emit NaN are rejected.

### Daytona — ephemeral training sandboxes
One sandbox per reward variant, 32 vectorised environments inside each, deleted
the moment the run finishes. Isolation matters twice over: four rewards must be
compared under identical conditions, and LLM-written code should execute
somewhere it cannot touch anything else. CPU only — no GPU anywhere in this
project.

### Built with
- **Grok / Grokbot** — fast teammate for ideation, design and triage: second
  opinion on reward-function logic and on diagnosing why a training run had
  collapsed, plus connective tissue across codespaces and resources.
- **Cursor** — multi-file refactors across the agent pipeline, keeping the
  schema, tool contracts and call sites in sync as the contract moved.
- Next.js 16 · React 19 · Three.js / react-three-fiber · Mastra (agent
  orchestration) · Drizzle ORM · PyTorch · stable-baselines3 · CLIP ViT-B/32 +
  scikit-learn logistic probe.

---

## Reproducibility

Everything below was measured on real services, not mocked. The repo contains no
credentials; `.env.example` documents all 35 variables with secrets left blank.

### 1. Prerequisites
- Node 20+, Python 3.11+
- Accounts: Neon, Tiger Data (TimescaleDB), Bright Data, Vultr, Daytona

### 2. Configure
```bash
cp .env.example .env.local
# fill in every value marked "# SECRET"
```

### 3. Install
```bash
npm install
cd apps/web && npm install
python3 -m venv .venv && source .venv/bin/activate
pip install -r trainer/requirements.txt
```

### 4. Migrate
```bash
# Neon (agent backend)
psql "$DATABASE_URL_UNPOOLED" -f db/migrations/0001_init.sql
psql "$DATABASE_URL_UNPOOLED" -f db/migrations/0002_telemetry_inbox.sql
psql "$DATABASE_URL_UNPOOLED" -f db/migrations/0003_region_provenance.sql
psql "$DATABASE_URL_UNPOOLED" -f db/migrations/0004_resume_and_forks.sql

# Tiger (telemetry) — requires timescaledb + timescaledb_toolkit
for f in db/migrations/tiger_*.sql; do psql "$TIGER_DATABASE_URL" -f "$f"; done
```

### 5. Train the base policy the demo improves on
```bash
node apps/web/scripts/pretrain_base.mjs     # registers rover-base-v1
```

### 6. Run
```bash
cd apps/web && npm run build && npm start   # http://localhost:3200
```
Open `/`, type a goal, press **Teach it**. Watch `/observatory`.

> **Note:** build into a separate directory if a mission is in flight —
> `next build` replaces `.next` underneath a running `next start` and will kill
> live runs. Use `NEXT_DIST_DIR=.next-new npm run build`.

### Verifying the claims yourself
| Claim | Command |
|---|---|
| Perception gain is real, not fitting noise | `node apps/web/scripts/perception_ablation.mjs` |
| The policy actually learns | `node apps/web/scripts/learning_proof.mjs` |
| Telemetry is not double-counted | `node apps/web/scripts/drain_backfill.mjs` |
| Neon branches are isolated | `node apps/web/scripts/neon_branches.mjs` |
| Sandboxes are cleaned up | `node apps/web/scripts/daytona_cleanup.mjs` |
| Orphaned runs reaped safely (dry-run default) | `node apps/web/scripts/reap_orphan_runs.mjs` |

Determinism: FieldGym is seeded per environment, so the same seed yields the
same field. Baseline and candidate always share the seed set and the perception
model — that is what makes the before/after table a fair comparison rather than
a flattering one.

---

## Known limitations

- Crop damage (73.5%) is improved but not production-ready.
- Results are measured **in simulation**, grounded on scraped data. No
  hardware-in-the-loop evaluation yet.
- Three generations of four variants is a small search; the reward-search loop
  has the most headroom of anything here.
- Some environment parameters are `assumed` rather than `cited` when the web had
  no figure. The UI labels which is which.

## Layout

```
apps/web/          Next.js console, agents (Mastra), API routes, 3D arena
apps/web/scripts/  verification + maintenance scripts
trainer/           PPO, FieldGym env, perception, telemetry clients
db/migrations/     Neon + Tiger schemas
scripts/           base-policy pretraining
```

## License

No license granted yet — all rights reserved pending a decision. Open an issue
if you want to use this.
