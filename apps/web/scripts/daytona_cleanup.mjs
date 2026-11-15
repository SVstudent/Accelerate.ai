/**
 * Cost guardrail: list every Daytona sandbox on the account and delete the ones
 * Furrow leaked. A sandbox left running bills until it is stopped, so this runs
 * after every rehearsal and before leaving the laptop.
 *   node scripts/daytona_cleanup.mjs           # list only
 *   node scripts/daytona_cleanup.mjs --delete  # delete all Furrow sandboxes
 */
import { config } from "dotenv";
import { Daytona } from "@daytonaio/sdk";
config({ path: new URL("../../../.env.local", import.meta.url).pathname, quiet: true });

const DO_DELETE = process.argv.includes("--delete");
const d = new Daytona({ apiKey: process.env.DAYTONA_API_KEY, apiUrl: process.env.DAYTONA_API_URL });

// d.list() is an ASYNC ITERATOR. Iterating it with a plain for...of silently
// yields nothing, which made this script report "no sandboxes" while stopped
// ones sat on the account consuming the 30 GiB disk quota.
const list = [];
for await (const sb of await d.list()) list.push(sb);

if (!list.length) {
  console.log("no sandboxes on the account — nothing allocated");
  process.exit(0);
}
let disk = 0;
console.log(`${list.length} sandbox(es):`);
for (const sb of list) {
  disk += Number(sb.disk ?? 0);
  console.log(`  ${sb.id}  state=${sb.state ?? "?"}  disk=${sb.disk ?? "?"}GiB  cpu=${sb.cpu ?? "?"}  labels=${JSON.stringify(sb.labels ?? {})}`);
}
console.log(`total disk allocated: ${disk}GiB of the 30GiB account cap`);
// stopped sandboxes still hold their disk, so they still block new ones
if (DO_DELETE) {
  for (const sb of list) {
    try { await sb.delete(); console.log("deleted", sb.id); }
    catch (e) { console.warn("could not delete", sb.id, e?.message); }
  }
  console.log("done — disk released");
} else {
  console.log("\n(dry run — pass --delete to remove them)");
}
