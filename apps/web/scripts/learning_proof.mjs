/**
 * The central technical claim, tested for real in one Daytona sandbox:
 *   1. pretrain the base policy on UNINFORMATIVE perception (it cannot tell the
 *      classes apart, so it acts on any plant)
 *   2. fine-tune the SAME checkpoint on an INFORMATIVE perception pool
 *   3. evaluate both on the fixed EVAL_SEEDS and compare
 * If step 3 does not beat step 1 on damage and removal, the thesis is wrong and
 * we need to know now, not on Sunday morning.
 */
import { config } from "dotenv";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { Daytona } from "@daytonaio/sdk";
config({ path: new URL("../../../.env.local", import.meta.url).pathname, quiet: true });
const ROOT = new URL("../../../", import.meta.url).pathname;
function walk(d, o = []) { for (const e of readdirSync(d)) { if (e === "__pycache__" || e.endsWith(".pyc")) continue; const p = join(d, e); statSync(p).isDirectory() ? walk(p, o) : o.push(p); } return o; }

const BASE_STEPS = Number(process.env.BASE_STEPS || 200000);
const FT_STEPS = Number(process.env.FT_STEPS || 150000);

const PROOF = `
import sys, time, json
sys.path.insert(0, "/home/daytona/trainer")
import cpu_tune
from contracts import default_env_config, PerceptionSpec, EVAL_SEEDS
from fieldgym.env import FieldGym
from perception import synthetic_pool
from reward_runtime import build_reward
from stable_baselines3 import PPO
from stable_baselines3.common.vec_env import DummyVecEnv
print("threads", cpu_tune.tune_torch(), flush=True)

BASE_STEPS = ${BASE_STEPS}
FT_STEPS = ${FT_STEPS}
N = 16

# ---------- 1. base policy: uninformative perception, "act on anything" reward
cfg_base = default_env_config()
venv = DummyVecEnv([(lambda i=i: FieldGym(cfg_base, seed=4242+i)) for i in range(N)])
t0=time.time()
base = PPO("MlpPolicy", venv, device="cpu", seed=7, n_steps=64, batch_size=512, verbose=0)
base.learn(total_timesteps=BASE_STEPS)
base.save("/tmp/base.zip")
print(f"base trained in {time.time()-t0:.0f}s", flush=True)

# ---------- 2. fine-tune the same checkpoint with informative perception
pool = synthetic_pool(accuracy=0.91, seed=3)
print(f"pool separation {pool.separation:.3f}", flush=True)
cfg_ft = default_env_config(PerceptionSpec(mode="pool", perception_model_id="pm_proof"))
REWARD = '''
def reward(info):
    c = {}
    # pulling weeds has to out-earn the safety of standing still
    c["pull_weed"] = 3.0 * info["removed_target"]
    c["crop_hit"] = -4.0 * info["removed_protect"]
    c["trample"] = -0.8 * info["trampled_protect"]
    c["miss"] = -0.05 if info["miss"] else 0.0
    c["approach"] = 0.03 / (1.0 + info["nearest_target_dist"])
    c["row"] = -0.02 * info["dist_to_row_center"]
    # anti-idle: every step with weeds still standing costs, so freezing is not
    # a winning strategy (the failure mode the first proof run exposed)
    frac_left = info["targets_remaining"] / max(1, info["targets_total"])
    c["weeds_left"] = -0.02 * frac_left
    c["step"] = -0.001
    return sum(c.values()), c
'''
rfn = build_reward(REWARD)
venv_ft = DummyVecEnv([(lambda i=i: FieldGym(cfg_ft, reward_fn=rfn, perception=pool, seed=9000+i)) for i in range(N)])
t0=time.time()
ft = PPO.load("/tmp/base.zip", env=venv_ft, device="cpu")
ft.learn(total_timesteps=FT_STEPS)
print(f"fine-tuned in {time.time()-t0:.0f}s", flush=True)

# ---------- 3. evaluate both on the SAME fixed seeds, same env, same perception
def ev(model, label):
    agg = {"removal":0.0,"damage":0.0,"precision":0.0,"score":0.0,"acts":0,"plants":0}
    for s in EVAL_SEEDS:
        e = FieldGym(cfg_ft, reward_fn=rfn, perception=pool, seed=s)
        obs,_ = e.reset(seed=s)
        for _ in range(e.cfg.episode_steps):
            a,_ = model.predict(obs, deterministic=True)
            obs,r,te,tr,_ = e.step(a)
            if te or tr: break
        su = e.summary()
        agg["removal"] += su["target_removal_rate"]; agg["damage"] += su["protect_damage_rate"]
        agg["precision"] += su["act_precision"]; agg["score"] += su["score"]
        agg["acts"] += su["removed_target"]+su["removed_protect"]+su["misses"]
        agg["plants"] += su["targets_total"]+su["protect_total"]
    n = len(EVAL_SEEDS)
    out = {k: (v/n if k not in ("acts","plants") else v) for k,v in agg.items()}
    out["applications_avoided_pct"] = max(0.0, 1.0 - agg["acts"]/max(1,agg["plants"]))
    print(f"{label}: removal={out['removal']:.3f} damage={out['damage']:.3f} "
          f"precision={out['precision']:.3f} score={out['score']:.3f} "
          f"apps_avoided={out['applications_avoided_pct']:.3f}", flush=True)
    return out

b = ev(base, "BASE    ")
f = ev(ft,   "TRAINED ")
print("RESULT_JSON=" + json.dumps({"base": b, "trained": f,
      "delta_score": f["score"]-b["score"], "delta_removal": f["removal"]-b["removal"],
      "delta_damage": f["damage"]-b["damage"]}), flush=True)
`;

const d = new Daytona({ apiKey: process.env.DAYTONA_API_KEY, apiUrl: process.env.DAYTONA_API_URL });
let sb;
try {
  sb = await d.create({ language: "python", autoStopInterval: 30 });
  console.log("sandbox", sb.id);
  await sb.fs.uploadFiles(walk(join(ROOT, "trainer")).map((p) => ({
    source: readFileSync(p), destination: join("/home/daytona/trainer", relative(join(ROOT, "trainer"), p)),
  })));
  await sb.fs.uploadFile(Buffer.from(PROOF), "/home/daytona/proof.py");
  const inst = await sb.process.executeCommand(
    "pip install -q numpy gymnasium pydantic torch 'stable-baselines3>=2.3' 2>&1 | tail -1", undefined, undefined, 900);
  console.log("deps:", (inst.result || "").trim() || "ok");
  const r = await sb.process.executeCommand("python3 /home/daytona/proof.py 2>&1 | tail -20", undefined, undefined, 3000);
  console.log(r.result);
} catch (e) { console.error("ERR", e?.message); process.exitCode = 1; }
finally { if (sb) { await sb.delete().catch(() => {}); console.log("sandbox deleted"); } }
