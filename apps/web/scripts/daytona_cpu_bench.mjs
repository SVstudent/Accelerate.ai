import { config } from "dotenv";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { Daytona } from "@daytonaio/sdk";
config({ path: new URL("../../../.env.local", import.meta.url).pathname, quiet: true });
const ROOT = new URL("../../../", import.meta.url).pathname;
const TRAINER = join(ROOT, "trainer");
function walk(d, o = []) { for (const e of readdirSync(d)) { if (e === "__pycache__" || e.endsWith(".pyc")) continue; const p = join(d, e); statSync(p).isDirectory() ? walk(p, o) : o.push(p); } return o; }

const BENCH = `
import os, time, sys
sys.path.insert(0, "/home/daytona/trainer")
print("nproc:", os.cpu_count(), "| affinity:", len(os.sched_getaffinity(0)) if hasattr(os,'sched_getaffinity') else '?')
try:
    print("cpu.max:", open("/sys/fs/cgroup/cpu.max").read().strip())
except Exception as e: print("cpu.max unreadable:", e)
import numpy as np
a = np.random.rand(600,600)
t0=time.perf_counter(); [a@a for _ in range(5)]; print(f"numpy 600x600 matmul x5: {time.perf_counter()-t0:.2f}s")
from contracts import default_env_config
from fieldgym.env import FieldGym
cfg=default_env_config(); env=FieldGym(cfg,seed=1); env.reset(seed=1)
acts=[env.action_space.sample() for _ in range(600)]
t0=time.perf_counter(); n=0
for x in acts:
    _,_,te,tr,_=env.step(x); n+=1
    if te or tr: env.reset()
d=time.perf_counter()-t0
print(f"FieldGym: {n/d:.0f} steps/s single env")
import torch
print("torch threads:", torch.get_num_threads())
t0=time.perf_counter(); torch.mm(torch.rand(600,600), torch.rand(600,600)); print(f"torch mm: {time.perf_counter()-t0:.3f}s")
`;
const d = new Daytona({ apiKey: process.env.DAYTONA_API_KEY, apiUrl: process.env.DAYTONA_API_URL });
let sb;
try {
  sb = await d.create({ language: "python", autoStopInterval: 10 });
  console.log("sandbox", sb.id);
  await sb.fs.uploadFiles(walk(TRAINER).map((p) => ({ source: readFileSync(p), destination: join("/home/daytona/trainer", relative(TRAINER, p)) })));
  await sb.fs.uploadFile(Buffer.from(BENCH), "/home/daytona/bench.py");
  const r = await sb.process.executeCommand("pip install -q numpy gymnasium pydantic torch 2>&1 | tail -1; python3 /home/daytona/bench.py 2>&1", undefined, undefined, 900);
  console.log(r.result);
} catch (e) { console.error("ERR", e?.message); process.exitCode = 1; }
finally { if (sb) await sb.delete().catch(() => {}); }
