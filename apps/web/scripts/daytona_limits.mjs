import { config } from "dotenv";
import { Daytona } from "@daytonaio/sdk";
config({ path: new URL("../../../.env.local", import.meta.url).pathname, quiet: true });
const d = new Daytona({ apiKey: process.env.DAYTONA_API_KEY, apiUrl: process.env.DAYTONA_API_URL });

console.log("existing sandboxes:");
let n = 0;
for await (const sb of await d.list()) {
  n++;
  console.log(` ${sb.id} state=${sb.state} disk=${sb.disk ?? "?"} cpu=${sb.cpu ?? "?"} mem=${sb.memory ?? "?"}`);
}
if (!n) console.log(" (none)");

console.log("\ncreating one default sandbox to read its resource allocation…");
const sb = await d.create({ language: "python", autoStopInterval: 5 });
console.log(` id=${sb.id} disk=${sb.disk ?? "?"}GiB cpu=${sb.cpu ?? "?"} memory=${sb.memory ?? "?"}GiB`);
const perSandbox = Number(sb.disk ?? 0);
if (perSandbox > 0) {
  console.log(` => 30GiB cap / ${perSandbox}GiB each = ${Math.floor(30 / perSandbox)} concurrent sandboxes max`);
}
await sb.delete();
console.log("deleted");
