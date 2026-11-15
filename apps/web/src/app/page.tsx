"use client";
/**
 * Home composer (DESIGN.md §6).
 *
 * One sentence in, one trained skill out. The field is the whole page: a
 * headline, the goal box with its mic, example briefings (including a Spanish
 * one, because the Foreman reads the goal in the operator's language), the
 * missions already on record, and the sponsor line.
 */
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight } from "lucide-react";
import { C } from "@/lib/colors";
import type { MissionListRow } from "@/app/api/missions/route";

const EM_DASH = "—";

const EXAMPLES: { text: string; lang: string; note: string }[] = [
  {
    text: "Pull the purslane out of my lettuce rows without bruising the lettuce.",
    lang: "en",
    note: "selective removal · lettuce",
  },
  {
    text: "Weed my carrot beds at the two-leaf stage and keep every carrot.",
    lang: "en",
    note: "early window · carrots",
  },
  {
    text: "Quita la verdolaga de mis filas de lechuga sin dañar las lechugas.",
    lang: "es",
    note: "español · the Foreman answers in Spanish",
  },
  {
    text: "Clear redroot pigweed from my sugar beet rows, damage under 2%.",
    lang: "en",
    note: "hard damage budget · sugar beet",
  },
];

const STATUS_COLOR: Record<string, string> = {
  done: C.leaf400, failed: C.blight500, draft: C.chaff600, awaiting_confirm: C.signal400,
  // a mission whose run died with the server process: not live work, and
  // recoverable from Postgres (POST /api/missions/<id>/resume)
  stalled: C.blight500,
};

function ago(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${Math.floor(s)}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86_400)}d ago`;
}

export default function Home() {
  const router = useRouter();
  const [goal, setGoal] = useState("");
  const [lang, setLang] = useState("en");
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [missions, setMissions] = useState<MissionListRow[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  /** which stalled mission is being picked back up */
  const [resuming, setResuming] = useState<string | null>(null);

  useEffect(() => {
    let gone = false;
    (async () => {
      try {
        const res = await fetch("/api/missions?limit=12", { cache: "no-store" });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error ?? `HTTP ${res.status}`);
        }
        const body = (await res.json()) as { missions: MissionListRow[] };
        if (!gone) setMissions(body.missions ?? []);
      } catch (err) {
        if (!gone) { setMissions([]); setListError((err as Error).message); }
      }
    })();
    return () => { gone = true; };
  }, []);

  /**
   * Pick an interrupted mission back up. Its row still holds every stage's
   * output, so the pipeline continues from the first missing one instead of
   * re-scraping the web.
   */
  const resume = useCallback(async (id: string) => {
    if (resuming) return;
    setResuming(id);
    setNote(null);
    try {
      const res = await fetch(`/api/missions/${id}/resume`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const body = (await res.json().catch(() => ({}))) as {
        resuming_from?: string; reusing?: string[]; error?: string;
      };
      if (!res.ok) {
        setNote(`could not resume · ${body.error ?? `HTTP ${res.status}`}`);
        setResuming(null);
        return;
      }
      setNote(
        `resuming from ${body.resuming_from ?? "the last completed stage"}` +
        (body.reusing?.length ? ` · reusing ${body.reusing.join(", ")}` : ""),
      );
      router.push(`/m/${id}`);
    } catch (err) {
      setNote(`could not resume · ${(err as Error).message}`);
      setResuming(null);
    }
  }, [resuming, router]);

  const launch = useCallback(async () => {
    const text = goal.trim();
    if (!text || busy) return;
    setBusy(true);
    setNote(null);
    try {
      const res = await fetch("/api/missions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ goal_text: text, goal_lang: lang }),
      });
      if (res.status === 404) {
        setNote("/api/missions is not available — the mission could not be created");
        setBusy(false);
        return;
      }
      const body = (await res.json().catch(() => ({}))) as { id?: string; error?: string };
      if (!res.ok || !body.id) {
        setNote(`could not start the mission · ${body.error ?? `HTTP ${res.status}`}`);
        setBusy(false);
        return;
      }
      router.push(`/m/${body.id}`);
    } catch (err) {
      setNote(`could not start the mission · ${(err as Error).message}`);
      setBusy(false);
    }
  }, [goal, lang, busy, router]);

  return (
    <main className="flex-1 flex flex-col" style={{ background: C.soil950, color: C.chaff200 }}>
      <header className="h-14 shrink-0 flex items-center gap-4 px-7 border-b"
        style={{ borderColor: C.soil800 }}>
        <span className="text-[15px] font-medium" style={{ letterSpacing: "0.22em" }}>
          ACCELERATE.AI
        </span>
        <span className="h-3 w-px" style={{ background: C.soil700 }} />
        <span className="num text-[11px]" style={{ color: C.chaff600 }}>
          autonomous optimization
        </span>
        <div className="ml-auto flex items-center gap-4">
          <a href="/observatory" className="text-[12px] hover:opacity-70 transition-opacity"
            style={{ color: C.chaff400 }}>
            Observatory
          </a>
          <a href="/farm" className="text-[12px] hover:opacity-70 transition-opacity"
            style={{ color: C.chaff400 }}>
            Training farm
          </a>
        </div>
      </header>

      <div className="flex-1 w-full max-w-[880px] mx-auto px-7 py-12 flex flex-col gap-9">
        <section className="pt-6">
          <h1 className="text-[44px] leading-[1.06] font-medium tracking-[-0.02em] max-w-[18ch]">
            Teach a machine
            <br />
            one new skill.
          </h1>
          <p className="mt-5 text-[16px] leading-[1.6] max-w-[58ch]" style={{ color: C.chaff400 }}>
            Describe the job in a sentence. Agents read the open web for how the work is
            actually done, build a perception model from real images, write the objective,
            and train a policy in parallel sandboxes until it beats the baseline.
          </p>
          <p className="mt-3 text-[13px] max-w-[58ch]" style={{ color: C.chaff600 }}>
            No ML expertise. No consultant. Every number traces back to the page it came from.
          </p>
        </section>

        {/* ── the request. Spoken first, typed only if you would rather ── */}
        <section>
          <div className="panel p-4">
            <div className="flex items-center justify-between gap-4 flex-wrap">
              <button
                onClick={() => void launch()}
                disabled={!goal.trim() || busy}
                className="shrink-0 h-11 px-5 rounded-full flex items-center gap-2 text-[14px] disabled:opacity-40 transition-colors"
                style={{
                  background: "rgba(242,179,61,0.14)",
                  border: `1px solid ${C.signal400}`,
                  color: C.signal400,
                }}
              >
                {busy ? "starting…" : "Teach it"}
                <ArrowRight size={16} />
              </button>
            </div>

            <div className="mt-3 pt-3 border-t" style={{ borderColor: C.soil700 }}>
              <div className="text-[10px] uppercase tracking-wider mb-1" style={{ color: C.chaff600 }}>
                {goal ? "what we heard — edit it if we got it wrong" : "or type it instead"}
              </div>
              <textarea
                value={goal}
                onChange={(e) => setGoal(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void launch(); }
                }}
                rows={3}
                placeholder="Pull the purslane out of my lettuce rows without bruising the lettuce."
                className="w-full resize-none bg-transparent text-[17px] leading-snug outline-none"
                style={{ color: C.chaff200 }}
              />
            </div>

            <div className="flex items-center gap-3 pt-1 text-[11px]" style={{ color: C.chaff600 }}>
              <span>⌘↵ to launch</span>
              <span>·</span>
              <label className="flex items-center gap-1">
                language
                <select
                  value={lang}
                  onChange={(e) => setLang(e.target.value)}
                  className="num bg-transparent outline-none"
                  style={{ color: C.chaff400 }}
                >
                  <option value="en">en</option>
                  <option value="es">es</option>
                  <option value="pt">pt</option>
                  <option value="fr">fr</option>
                  <option value="de">de</option>
                </select>
              </label>
            </div>
          </div>
          {note && (
            <div className="mt-2 text-[12px]" style={{ color: C.blight500 }}>{note}</div>
          )}
        </section>

        <section className="border-t pt-6" style={{ borderColor: C.soil800 }}>
          <div className="grid grid-cols-4 gap-5">
            {[
              ["01", "Read", "SERP and unlocked pages for how the work is really done"],
              ["02", "See", "a perception model trained on real images from those pages"],
              ["03", "Define", "the objective, written from the facts and cited"],
              ["04", "Train", "parallel sandboxes until the baseline is beaten"],
            ].map(([n, verb, what]) => (
              <div key={n}>
                <div className="num text-[10px] mb-1.5" style={{ color: C.signal400 }}>{n}</div>
                <div className="text-[13px] mb-1" style={{ color: C.chaff200 }}>{verb}</div>
                <div className="text-[11px] leading-[1.5]" style={{ color: C.chaff600 }}>{what}</div>
              </div>
            ))}
          </div>
        </section>

        <section className="border-t pt-6" style={{ borderColor: C.soil800 }}>
          <div className="text-[11px] uppercase tracking-[0.14em] mb-3" style={{ color: C.chaff600 }}>
            Try one
          </div>
          <div className="grid grid-cols-2 gap-x-6 gap-y-1">
            {EXAMPLES.map((ex) => (
              <button
                key={ex.text}
                onClick={() => { setGoal(ex.text); setLang(ex.lang); }}
                className="text-left pl-3 py-2 border-l transition-colors hover:border-l-[color:var(--sig)]"
                style={{ borderColor: C.soil700, ["--sig" as string]: C.signal400 }}
              >
                <div className="text-[13px] leading-snug" style={{ color: C.chaff200 }}>
                  {ex.text}
                </div>
                <div className="num text-[10px] mt-1" style={{ color: C.chaff600 }}>{ex.note}</div>
              </button>
            ))}
          </div>
        </section>

        <section className="border-t pt-6" style={{ borderColor: C.soil800 }}>
          <div className="flex items-baseline gap-2 mb-3">
            <span className="text-[11px] uppercase tracking-[0.14em]" style={{ color: C.chaff600 }}>
              Past missions
            </span>
            {missions && (
              <span className="num text-[11px]" style={{ color: C.chaff600 }}>
                {missions.length}
              </span>
            )}
          </div>

          {missions === null && (
            <div className="text-[12px]" style={{ color: C.chaff600 }}>loading missions…</div>
          )}
          {missions !== null && missions.length === 0 && (
            <div className="panel px-3 py-2 text-[12px]" style={{ color: C.chaff600 }}>
              {listError
                ? `mission list unavailable · ${listError}`
                : "No missions yet. The first one you teach shows up here."}
            </div>
          )}
          {missions !== null && missions.length > 0 && (
            <ul className="divide-y" style={{ borderColor: C.soil800 }}>
              {missions.map((m) => (
                <li key={m.id}>
                  <div className="flex items-center gap-3 py-2 px-1 hover:bg-soil-900 transition-colors">
                    <a
                      href={`/m/${m.id}`}
                      className="truncate flex-1 text-[13px]"
                      style={{ color: C.chaff200 }}
                    >
                      {m.goal_text || EM_DASH}
                    </a>
                    {/* a finished mission can be listened to from here, without
                        opening the console — the loop closes with your ears */}
                    {/* its process died with the server; everything it had
                        already paid for is still in Postgres */}
                    {m.status === "stalled" && (
                      <button
                        onClick={() => resume(m.id)}
                        disabled={resuming === m.id}
                        className="chip num text-[10px] hover:border-chaff-400 transition-colors"
                        style={{ color: C.signal400, borderColor: `${C.signal400}55` }}
                        title={`no agent event for ${m.stalled_minutes ?? "?"} minutes — continue from the last completed stage`}
                      >
                        {resuming === m.id ? "resuming…" : "resume"}
                      </button>
                    )}
                    {m.crop && (
                      <span className="chip num text-[10px]" style={{ color: C.leaf400 }}>
                        {m.crop}
                      </span>
                    )}
                    {m.is_demo && (
                      <span className="chip num text-[10px]" style={{ color: C.sky400 }}>demo</span>
                    )}
                    <span className="num text-[11px] w-[110px] text-right"
                      style={{ color: STATUS_COLOR[m.status] ?? C.chaff400 }}>
                      {m.status}
                    </span>
                    <span className="num text-[11px] w-[70px] text-right" style={{ color: C.chaff600 }}>
                      {ago(m.created_at)}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <footer className="shrink-0 border-t px-6 py-5" style={{ borderColor: C.soil700 }}>
        <div className="max-w-[920px] mx-auto">
          <div className="text-[20px] font-medium tracking-tight" style={{ color: C.signal400 }}>
            Powered by Bright Data web data
          </div>
          <div className="mt-1 text-[12px]" style={{ color: C.chaff400 }}>
            Bright Data web ingest · Daytona sandboxes · Tiger Data telemetry ·
            Neon state · Vultr inference · Mastra agents
          </div>
        </div>
      </footer>
    </main>
  );
}
