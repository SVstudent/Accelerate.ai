import { config } from "dotenv";
import { Daytona } from "@daytonaio/sdk";
config({ path: new URL("../../../.env.local", import.meta.url).pathname, quiet: true });
const d = new Daytona({ apiKey: process.env.DAYTONA_API_KEY, apiUrl: process.env.DAYTONA_API_URL });
let sb;
try {
  sb = await d.create({ language: "python", autoStopInterval: 15 });
  console.log("sandbox", sb.id);
  const df = await sb.process.executeCommand("df -h / /tmp 2>&1 | tail -3", undefined, undefined, 120);
  console.log("disk:\n" + (df.result || "").trim());
  const t0 = Date.now();
  // transformers' CLIP needs only torch + PIL + numpy: no torchvision, no CUDA stack
  const r = await sb.process.executeCommand(
    "pip install --no-cache-dir transformers scikit-learn pillow 2>&1 | tail -3", undefined, undefined, 1800);
  console.log(`install (${((Date.now()-t0)/1000).toFixed(0)}s): ` + (r.result || "").trim());
  const t1 = Date.now();
  const v = await sb.process.executeCommand(
    `python3 - <<'PY' 2>&1 | tail -8
import os
os.environ.setdefault("OMP_NUM_THREADS","1")
import torch, numpy as np
torch.set_num_threads(1)
from transformers import CLIPModel, CLIPProcessor
from PIL import Image
m = CLIPModel.from_pretrained("openai/clip-vit-base-patch32")
p = CLIPProcessor.from_pretrained("openai/clip-vit-base-patch32")
m.eval()
imgs = [Image.new("RGB",(224,224),(i*40%255, 80, 120)) for i in range(4)]
with torch.no_grad():
    ii = p(images=imgs, return_tensors="pt")
    f = m.get_image_features(**ii)
    tt = p(text=["a photo of a weed","a photo of a strawberry plant"], return_tensors="pt", padding=True)
    t = m.get_text_features(**tt)
print("image features", tuple(f.shape), "text features", tuple(t.shape))
print("CLIP OK")
PY`, undefined, undefined, 1800);
  console.log(`clip load+embed (${((Date.now()-t1)/1000).toFixed(0)}s):\n` + (v.result || "").trim());
  const df2 = await sb.process.executeCommand("df -h / | tail -1", undefined, undefined, 120);
  console.log("disk after:", (df2.result || "").trim());
} catch (e) { console.error("ERR", e?.message); process.exitCode = 1; }
finally { if (sb) await sb.delete().catch(()=>{}); console.log("deleted"); }
