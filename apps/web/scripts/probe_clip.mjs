import { config } from "dotenv";
import { Daytona } from "@daytonaio/sdk";
config({ path: new URL("../../../.env.local", import.meta.url).pathname, quiet: true });
const d = new Daytona({ apiKey: process.env.DAYTONA_API_KEY, apiUrl: process.env.DAYTONA_API_URL });
let sb;
try {
  sb = await d.create({ language: "python", autoStopInterval: 15 });
  console.log("sandbox", sb.id);
  const pre = await sb.process.executeCommand(
    "python3 -c \"import torch, torchvision; print('torch', torch.__version__, 'tv', torchvision.__version__)\" 2>&1 | tail -2",
    undefined, undefined, 300);
  console.log("preinstalled:", (pre.result || "").trim());
  const t0 = Date.now();
  const r = await sb.process.executeCommand(
    "pip install --no-cache-dir open_clip_torch scikit-learn pillow 2>&1 | tail -12",
    undefined, undefined, 2400);
  console.log(`install (${((Date.now()-t0)/1000).toFixed(0)}s):\n` + (r.result || "").trim());
  const v = await sb.process.executeCommand(
    "python3 -c \"import open_clip, sklearn, PIL; print('OK', open_clip.__version__)\" 2>&1 | tail -3",
    undefined, undefined, 300);
  console.log("verify:", (v.result || "").trim());
} catch (e) { console.error("ERR", e?.message); process.exitCode = 1; }
finally { if (sb) await sb.delete().catch(()=>{}); console.log("deleted"); }
