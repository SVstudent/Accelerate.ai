/**
 * Train the base policy in a Daytona sandbox and register it in Neon as
 * policies(kind='base', name='rover-base-v1') — CLAUDE.md §5.1.
 * Every mission fine-tunes from this checkpoint.
 */
import { config } from "dotenv";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { Daytona } from "@daytonaio/sdk";
config({ path: new URL("../../../.env.local", import.meta.url).pathname, quiet: true });

const ROOT = new URL("../../../", import.meta.url).pathname;
const STEPS = Number(process.env.BASE_STEPS || 500000);
const ENVS = Number(process.env.BASE_ENVS || 32);
const clean = (v) => (v || "").trim().replace(/^["']|["']$/g, "");

function walk(d, o = []) {
  for (const e of readdirSync(d)) {
    if (e === "__pycache__" || e.endsWith(".pyc")) continue;
    const p = join(d, e);
    statSync(p).isDirectory() ? walk(p, o) : o.push(p);
  }
  return o;
}

const d = new Daytona({ apiKey: process.env.DAYTONA_API_KEY, apiUrl: process.env.DAYTONA_API_URL });
let sb;
try {
  sb = await d.create({ language: "python", autoStopInterval: 30, labels: { furrow_role: "pretrain" } });
  console.log("sandbox", sb.id);

  const trainer = join(ROOT, "trainer");
  await sb.fs.uploadFiles(walk(trainer).map((p) => ({
    source: readFileSync(p), destination: join("/home/daytona/trainer", relative(trainer, p)),
  })));
  await sb.fs.uploadFile(
    readFileSync(join(ROOT, "scripts/pretrain_base.py")),
    "/home/daytona/pretrain_base.py",
  );
  console.log("uploaded trainer + pretrain script");

  const inst = await sb.process.executeCommand(
    "pip install -q numpy gymnasium pydantic torch 'stable-baselines3>=2.3' 'psycopg[binary]' 2>&1 | tail -1",
    undefined, undefined, 1200);
  console.log("deps:", (inst.result || "").trim() || "ok");

  console.log(`training base policy: ${STEPS} steps x ${ENVS} envs…`);
  const t0 = Date.now();
  const run = await sb.process.executeCommand(
    `cd /home/daytona && DATABASE_URL='${clean(process.env.DATABASE_URL)}' FURROW_DB_TRANSPORT=http ` +
    `python3 pretrain_base.py --steps ${STEPS} --envs ${ENVS} --register 2>&1 | tail -16`,
    undefined, undefined, 5400);
  console.log(run.result);
  console.log(`wall clock ${((Date.now() - t0) / 1000).toFixed(0)}s`);
} catch (e) {
  console.error("FAILED:", e?.message || e);
  process.exitCode = 1;
} finally {
  if (sb) { await sb.delete().catch(() => {}); console.log("sandbox deleted"); }
}
