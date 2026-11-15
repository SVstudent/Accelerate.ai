import { config } from "dotenv";
import { Daytona } from "@daytonaio/sdk";
config({ path: new URL("../../../.env.local", import.meta.url).pathname, quiet: true });
const u = (d) => { const x = new URL(d.replace(/^postgres(ql)?:\/\//, "https://")); return x; };
const n = u(process.env.DATABASE_URL), t = u(process.env.TIGER_DATABASE_URL);
const PY = `
import socket, urllib.request, json
def tcp(h,p,l):
    try:
        s=socket.create_connection((h,int(p)),timeout=10); s.close(); print(f"  OK   {l} {h}:{p}")
    except Exception as e: print(f"  FAIL {l} {h}:{p} {type(e).__name__}")
def http(url,l,hdr=None,data=None):
    try:
        req=urllib.request.Request(url, data=data, headers=hdr or {})
        r=urllib.request.urlopen(req,timeout=20); b=r.read()[:120]
        print(f"  OK   {l} HTTP {r.status} {b[:80]!r}")
    except urllib.error.HTTPError as e: print(f"  HTTP {e.code} {l} {e.read()[:80]!r}")
    except Exception as e: print(f"  FAIL {l} {type(e).__name__}: {str(e)[:60]}")
print("-- TCP 443 --")
tcp("${n.hostname}","443","Neon 443 ")
tcp("${t.hostname}","443","Tiger 443")
tcp("${t.hostname}","${t.port}","Tiger pg ")
print("-- HTTPS hosts --")
http("https://api.tokenrouter.com/v1/models","tokenrouter")
http("https://api.vultrinference.com/v1/models","vultr    ")
http("https://console.cloud.tigerdata.com","tiger cp ")
print("-- Neon SQL over HTTP --")
http("https://${n.hostname}/sql","neon /sql",
     {"Content-Type":"application/json","Neon-Connection-String":"${process.env.DATABASE_URL}"},
     json.dumps({"query":"select 1 as ok","params":[]}).encode())
`;
const d = new Daytona({ apiKey: process.env.DAYTONA_API_KEY, apiUrl: process.env.DAYTONA_API_URL });
let sb;
try {
  sb = await d.create({ language: "python", autoStopInterval: 15 });
  await sb.process.executeCommand(`cat > /tmp/p2.py <<'PYEOF'\n${PY}\nPYEOF`);
  const r = await sb.process.executeCommand("python3 /tmp/p2.py 2>&1");
  console.log(r.result);
} catch (e) { console.error("ERR", e?.message); process.exitCode = 1; }
finally { if (sb) await sb.delete().catch(() => {}); }
