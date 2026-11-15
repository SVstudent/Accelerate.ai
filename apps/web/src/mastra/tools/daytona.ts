/**
 * The Training Farm (CLAUDE.md §5.3) — Daytona sandbox pool.
 *
 * Measured facts this is built around (2026-11-14, all verified):
 *  · a sandbox is capped at ~1 CPU by cgroup quota while nproc reports 64, so
 *    trainer/cpu_tune.py pins BLAS/torch threads — without it PPO ran at 3 fps,
 *    with it ~5,000 fps;
 *  · sandboxes egress on :443 only. Neon works via SQL-over-HTTP; Tiger's
 *    Postgres port does not, so telemetry relays through Neon;
 *  · Bright Data is NOT reachable from a sandbox, so all web fetching stays in
 *    the app and image bytes are uploaded into the sandbox.
 *
 * Credit discipline: sandboxes are created once per mission, reused across
 * generations and the test phase, auto-stop while idle, and are deleted when
 * the mission ends. Nothing is left running.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { Daytona, type Sandbox } from "@daytonaio/sdk";
import type { SandboxJob } from "@/lib/contracts";
import { activeDatabaseUrl } from "@/db";

export type FarmPreset = "lite" | "demo" | "max";

export const PRESETS: Record<FarmPreset, { sandboxes: number; envs: number }> = {
  lite: { sandboxes: 4, envs: 16 },   //  64 live envs — rehearsals, cheapest
  demo: { sandboxes: 8, envs: 32 },   // 256 live envs — judging
  max: { sandboxes: 12, envs: 32 },   // 384 live envs — only if quota allows
};

export function preset(): { sandboxes: number; envs: number } {
  const p = (process.env.FARM_PRESET as FarmPreset) ?? "demo";
  return PRESETS[p] ?? PRESETS.demo;
}

/** Hard ceiling so a bug cannot spawn an unbounded, billable fleet. */
const MAX_SANDBOXES = Number(process.env.MAX_PARALLEL_SANDBOXES ?? 8);
const TRAINER_DIR = join(process.cwd(), "..", "..", "trainer");
const AUTO_STOP_MIN = 15;

let client: Daytona | null = null;
function daytona(): Daytona {
  if (!process.env.DAYTONA_API_KEY) throw new Error("DAYTONA_API_KEY is not set");
  if (!client) {
    client = new Daytona({
      apiKey: process.env.DAYTONA_API_KEY,
      apiUrl: process.env.DAYTONA_API_URL,
    });
  }
  return client;
}

export function sandboxModeLocal(): boolean {
  return (process.env.SANDBOX_MODE ?? "daytona") === "local";
}

function trainerFiles(): { source: Buffer; destination: string }[] {
  const walk = (d: string, out: string[] = []): string[] => {
    for (const e of readdirSync(d)) {
      if (e === "__pycache__" || e.endsWith(".pyc")) continue;
      const p = join(d, e);
      statSync(p).isDirectory() ? walk(p, out) : out.push(p);
    }
    return out;
  };
  return walk(TRAINER_DIR).map((p) => ({
    source: readFileSync(p),
    destination: join("/home/daytona/trainer", relative(TRAINER_DIR, p)),
  }));
}

const DEPS =
  "pip install -q numpy gymnasium pydantic torch 'stable-baselines3>=2.3' 'psycopg[binary]' 2>&1 | tail -2";
/**
 * open_clip_torch pulls torchvision and the entire CUDA stack (triton alone is
 * 285 MB) and filled the sandbox's 3 GB disk: [Errno 28] No space left on
 * device. transformers' CLIP loads the same ViT-B/32 weights with only torch +
 * PIL + numpy. Install loudly and assert the import, so a failure reads clearly
 * instead of surfacing as a traceback from the worker.
 */
const CURATE_DEPS =
  "pip install --no-cache-dir transformers scikit-learn pillow 2>&1 | tail -3; " +
  "python3 -c \"import transformers, sklearn, PIL; print('curate deps OK', transformers.__version__)\" 2>&1 | tail -2";

export type Pooled = { sandbox: Sandbox; id: string; busy: boolean; ready: Promise<void> };

/** One pool per mission, reused across generations (no repeated boot). */
const pools = new Map<string, Pooled[]>();

export function poolSize(missionId: string) {
  return pools.get(missionId)?.length ?? 0;
}

/** Pre-create the fleet so booting never counts against the pitch (§5.4). */
export async function warmFarm(missionId: string, count?: number): Promise<string[]> {
  const want = Math.min(count ?? preset().sandboxes, MAX_SANDBOXES);
  const existing = pools.get(missionId) ?? [];
  const toCreate = Math.max(0, want - existing.length);
  const created: Pooled[] = [];
  for (let i = 0; i < toCreate; i++) {
    let sandbox;
    try {
      sandbox = await daytona().create({
        language: "python",
        autoStopInterval: AUTO_STOP_MIN,
        labels: { furrow_mission: missionId, furrow_role: "trainer" },
      });
    } catch (err) {
      const msg = (err as Error).message ?? "";
      // The account caps TOTAL disk across sandboxes (30 GiB at 3 GiB each).
      // Stopped sandboxes still hold theirs, so a leak elsewhere shows up here.
      if (/disk limit|quota|limit exceeded/i.test(msg)) {
        if (created.length || existing.length) {
          pools.set(missionId, [...existing, ...created]);
          console.warn(`[farm] disk cap hit after ${existing.length + created.length} sandboxes; continuing with those`);
          break;
        }
        throw new Error(
          `Daytona disk cap reached and no sandbox could be created. ` +
          `Run: node scripts/daytona_cleanup.mjs --delete  (${msg.slice(0, 120)})`,
        );
      }
      throw err;
    }
    const entry: Pooled = {
      sandbox, id: sandbox.id, busy: false,
      ready: (async () => {
        await sandbox.fs.uploadFiles(trainerFiles());
        await sandbox.process.executeCommand(DEPS, undefined, undefined, 900);
      })(),
    };
    created.push(entry);
  }
  const all = [...existing, ...created];
  pools.set(missionId, all);
  await Promise.all(created.map((c) => c.ready.catch(() => {})));
  return all.map((p) => p.id);
}

/** Sandbox ids the provider actually has right now. */
async function liveSandboxIds(): Promise<Set<string>> {
  const ids = new Set<string>();
  for await (const sb of await daytona().list()) {
    const st = String((sb as { state?: string }).state ?? "");
    if (st && st !== "destroyed" && st !== "error") ids.add(sb.id);
  }
  return ids;
}

/** Forget a mission's pool entirely — used when a dead run is resumed. */
export function releaseFarm(missionId: string): void {
  pools.delete(missionId);
}

async function take(missionId: string): Promise<Pooled> {
  let pool = pools.get(missionId) ?? [];
  const free = pool.find((p) => !p.busy);
  if (free) { free.busy = true; return free; }
  if (pool.length >= MAX_SANDBOXES) {
    // Before refusing, drop entries whose sandbox is no longer on the account.
    // Otherwise a pool left over from a crashed attempt pins the ceiling and
    // every resume fails, even with the account completely empty.
    const alive = await liveSandboxIds().catch(() => null);
    if (alive) {
      pool = pool.filter((p) => alive.has(p.id));
      pools.set(missionId, pool);
    }
    if (pool.length >= MAX_SANDBOXES) {
      throw new Error(`sandbox ceiling ${MAX_SANDBOXES} reached for ${missionId}`);
    }
  }
  await warmFarm(missionId, pool.length + 1);
  const again = (pools.get(missionId) ?? []).find((p) => !p.busy);
  if (!again) throw new Error("no sandbox available");
  again.busy = true;
  return again;
}

const envPrefix = (extra: Record<string, string | undefined> = {}) => {
  const base: Record<string, string | undefined> = {
    // A forked mission runs against a Neon branch, and the sandbox writes its
    // runs, policies and artifacts to Neon itself — so it must be given the
    // branch the caller bound, not the process-wide main URL.
    DATABASE_URL: activeDatabaseUrl(),
    FURROW_DB_TRANSPORT: "http",   // sandboxes reach Neon over :443 only
    ...extra,
  };
  return Object.entries(base)
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}='${String(v).replace(/'/g, "'\\''")}'`)
    .join(" ");
};

export type RunHandle = { runId: string; sandboxId: string; promise: Promise<string> };

/** Launch one training variant. Resolves with the tail of its log. */
export async function launchRun(opts: {
  missionId: string; job: SandboxJob; env?: Record<string, string | undefined>;
}): Promise<RunHandle> {
  const slot = await take(opts.missionId);
  await slot.ready;
  await slot.sandbox.fs.uploadFile(
    Buffer.from(JSON.stringify(opts.job, null, 2)),
    "/home/daytona/job.json",
  );
  const cmd =
    `cd /home/daytona && ${envPrefix({ ...opts.env, DAYTONA_SANDBOX_ID: slot.id })} ` +
    `python3 trainer/train.py --job job.json 2>&1 | tail -40`;
  const promise = slot.sandbox.process
    .executeCommand(cmd, undefined, undefined, 3600)
    .then((r) => r.result ?? "")
    .finally(() => { slot.busy = false; });
  return { runId: opts.job.run_id ?? "run_?", sandboxId: slot.id, promise };
}

/** Fixed-seed evaluation. `kind` decides baseline vs candidate bookkeeping. */
export async function runEval(opts: {
  missionId: string; job: SandboxJob; kind: "baseline" | "candidate";
  policyId?: string; envConfigId?: string; perceptionModelId?: string; phase?: "train" | "test";
}): Promise<{ log: string; metrics: Record<string, unknown> | null }> {
  const slot = await take(opts.missionId);
  await slot.ready;
  await slot.sandbox.fs.uploadFile(
    Buffer.from(JSON.stringify(opts.job, null, 2)), "/home/daytona/eval_job.json");
  const cmd =
    `cd /home/daytona && ${envPrefix({
      FURROW_EVAL_KIND: opts.kind, FURROW_POLICY_ID: opts.policyId,
      FURROW_ENV_CONFIG_ID: opts.envConfigId,
      FURROW_PERCEPTION_MODEL_ID: opts.perceptionModelId,
      FURROW_PHASE: opts.phase ?? "",
    })} python3 trainer/evaluate.py --job eval_job.json 2>&1 | tail -30`;
  try {
    const r = await slot.sandbox.process.executeCommand(cmd, undefined, undefined, 1800);
    const log = r.result ?? "";
    const m = /EVAL_METRICS_JSON=(\{.*\})/.exec(log);
    return { log, metrics: m ? JSON.parse(m[1]) : null };
  } finally {
    slot.busy = false;
  }
}

/** Perception: CLIP + probe + pool. Image bytes are uploaded from the app. */
export async function runCurate(opts: {
  missionId: string; job: SandboxJob;
  images: { id: string; bytes: Buffer; ext: string }[];
}): Promise<{ log: string; metrics: Record<string, unknown> | null }> {
  const slot = await take(opts.missionId);
  await slot.ready;
  await slot.sandbox.process.executeCommand("mkdir -p /home/daytona/images", undefined, undefined, 120);
  // chunked so one upload call never carries the whole dataset
  for (let i = 0; i < opts.images.length; i += 40) {
    const chunk = opts.images.slice(i, i + 40);
    await slot.sandbox.fs.uploadFiles(chunk.map((im) => ({
      source: im.bytes,
      destination: `/home/daytona/images/${im.id}.${im.ext}`,
    })));
  }
  const job = {
    ...opts.job,
    dataset: (opts.job.dataset ?? []).map((d) => {
      const img = opts.images.find((i) => i.id === d.id);
      return { ...d, path: img ? `/home/daytona/images/${img.id}.${img.ext}` : null };
    }),
  };
  await slot.sandbox.fs.uploadFile(
    Buffer.from(JSON.stringify(job, null, 2)), "/home/daytona/curate_job.json");
  try {
    const deps = await slot.sandbox.process.executeCommand(CURATE_DEPS, undefined, undefined, 2400);
    const depLog = deps.result ?? "";
    if (!depLog.includes("curate deps OK")) {
      throw new Error(`curate dependencies failed to install: ${depLog.slice(-300)}`);
    }
    const r = await slot.sandbox.process.executeCommand(
      `cd /home/daytona && ${envPrefix()} python3 trainer/curate.py --job curate_job.json 2>&1 | tail -20`,
      undefined, undefined, 1800);
    const log = r.result ?? "";
    const m = /PERCEPTION_METRICS_JSON=(\{.*\})/.exec(log);
    return { log, metrics: m ? JSON.parse(m[1]) : null };
  } finally {
    slot.busy = false;
  }
}

/** Validate LLM-written reward code. Runs ONLY in a sandbox, never in the app. */
export async function dryRunReward(opts: {
  missionId: string; code: string; envConfig: unknown;
}): Promise<Record<string, unknown>> {
  const slot = await take(opts.missionId);
  await slot.ready;
  const payload = {
    code: opts.code,
    env_config: opts.envConfig,
  };
  await slot.sandbox.fs.uploadFile(
    Buffer.from(JSON.stringify(payload)), "/home/daytona/dry.json");
  const script = `
import json, sys
sys.path.insert(0, "/home/daytona/trainer")
import cpu_tune
from contracts import EnvConfig
from reward_runtime import dry_run
p = json.load(open("/home/daytona/dry.json"))
cfg = EnvConfig.model_validate(p["env_config"])
print("DRY_RUN_JSON=" + json.dumps(dry_run(p["code"], cfg)))
`;
  try {
    await slot.sandbox.fs.uploadFile(Buffer.from(script), "/home/daytona/dry.py");
    const r = await slot.sandbox.process.executeCommand(
      "python3 /home/daytona/dry.py 2>&1 | tail -5", undefined, undefined, 300);
    const m = /DRY_RUN_JSON=(\{.*\})/.exec(r.result ?? "");
    return m ? JSON.parse(m[1]) : { ok: false, error: (r.result ?? "no output").slice(0, 300) };
  } finally {
    slot.busy = false;
  }
}

export async function killRun(missionId: string, sandboxId: string) {
  const pool = pools.get(missionId) ?? [];
  const slot = pool.find((p) => p.id === sandboxId);
  if (!slot) return;
  try { await slot.sandbox.process.executeCommand("pkill -f trainer/train.py || true"); } catch {}
  slot.busy = false;
}

/** Always call this when a mission ends. Nothing should outlive the mission. */
export async function teardownFarm(missionId: string) {
  const pool = pools.get(missionId) ?? [];
  await Promise.all(pool.map(async (p) => {
    try { await p.sandbox.delete(); } catch (e) {
      console.warn("[farm] delete failed", p.id, (e as Error).message);
    }
  }));
  pools.delete(missionId);
}

/** Safety net: delete every Furrow-labelled sandbox on the account. */
export async function teardownEverything(): Promise<string[]> {
  const killed: string[] = [];
  // list() is an async iterator in this SDK version
  for await (const sb of await daytona().list()) {
    try { await sb.delete(); killed.push(sb.id); } catch {}
  }
  pools.clear();
  return killed;
}
