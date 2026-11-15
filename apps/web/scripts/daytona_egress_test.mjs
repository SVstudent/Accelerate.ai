/**
 * CLAUDE.md §8 step 2: prove a Daytona sandbox can reach Neon, Tiger Data,
 * PyPI and HuggingFace. If it cannot, we bake CLIP weights into the snapshot
 * or fall back to SANDBOX_MODE=local — and we need to know in the first hour.
 */
import { config } from "dotenv";
import { Daytona } from "@daytonaio/sdk";
import { URL } from "node:url";

config({ path: new URL("../../../.env.local", import.meta.url).pathname, quiet: true });

const hostPort = (dsn) => {
  if (!dsn) return null;
  const u = new URL(dsn.replace(/^postgres(ql)?:\/\//, "https://"));
  return { host: u.hostname, port: u.port || "5432" };
};

const neon = hostPort(process.env.DATABASE_URL);
const tiger = hostPort(process.env.TIGER_DATABASE_URL);

const PY = `
import socket, ssl, urllib.request, sys, platform
def tcp(host, port, label):
    try:
        s = socket.create_connection((host, int(port)), timeout=12); s.close()
        print(f"  OK    {label} {host}:{port}")
    except Exception as e:
        print(f"  FAIL  {label} {host}:{port} -> {type(e).__name__}: {e}")
def http(url, label):
    try:
        r = urllib.request.urlopen(url, timeout=20)
        print(f"  OK    {label} HTTP {r.status}")
    except Exception as e:
        print(f"  FAIL  {label} -> {type(e).__name__}: {str(e)[:80]}")
print("python", platform.python_version())
${neon ? `tcp("${neon.host}", "${neon.port}", "Neon    ")` : 'print("  SKIP  Neon (no DATABASE_URL)")'}
${tiger ? `tcp("${tiger.host}", "${tiger.port}", "Tiger   ")` : 'print("  SKIP  Tiger (no TIGER_DATABASE_URL)")'}
http("https://pypi.org/simple/", "PyPI    ")
http("https://huggingface.co", "HuggingFace")
http("https://api.brightdata.com", "BrightData")
`;

const daytona = new Daytona({
  apiKey: process.env.DAYTONA_API_KEY,
  apiUrl: process.env.DAYTONA_API_URL,
});

let sandbox;
try {
  console.log("creating sandbox…");
  const t0 = Date.now();
  sandbox = await daytona.create({
    language: "python",
    autoStopInterval: 15,
  });
  console.log(`sandbox ${sandbox.id} up in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  const write = await sandbox.process.executeCommand(
    `cat > /tmp/egress.py <<'PYEOF'\n${PY}\nPYEOF\necho written`,
  );
  console.log("write:", (write.result || "").trim());

  const res = await sandbox.process.executeCommand("python3 /tmp/egress.py 2>&1");
  console.log("── egress from inside the sandbox ──");
  console.log(res.result);

  const pip = await sandbox.process.executeCommand(
    "pip install --quiet 'psycopg[binary]' 2>&1 | tail -3; python3 -c \"import psycopg; print('psycopg import OK')\"",
  );
  console.log("── pip ──");
  console.log(pip.result);
} catch (err) {
  console.error("FAILED:", err?.message || err);
  process.exitCode = 1;
} finally {
  if (sandbox) {
    try { await sandbox.delete(); console.log("sandbox deleted"); }
    catch (e) { console.warn("delete failed:", e?.message); }
  }
}
