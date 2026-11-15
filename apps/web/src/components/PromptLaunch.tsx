"use client";
/**
 * The front door.
 *
 * The product is: describe a system you want improved, in plain language, and
 * a multi-agent pipeline researches the domain, builds the perception model,
 * writes the objective and trains the controller. No ML knowledge, no
 * consultant. Agriculture is the vertical we demo; nothing here is specific
 * to it.
 *
 * Typing a request here opens the REPLAY of a real completed run — the frames
 * were written by actual Daytona sandboxes during actual PPO training. It is
 * labelled as a replay rather than dressed up as a fresh run starting.
 */
import { useEffect, useMemo, useState } from "react";
import { C } from "@/lib/colors";

export type LaunchTarget = { id: string; goal_text: string; status: string };

const VERTICALS = [
  "agriculture",
  "robotics",
  "mining",
  "logistics",
  "inspection",
];

export function PromptLaunch({
  missions,
  onLaunch,
}: {
  missions: LaunchTarget[];
  onLaunch: (missionId: string, prompt: string) => void;
}) {
  const [text, setText] = useState("");
  const [vertIdx, setVertIdx] = useState(0);
  const [busy, setBusy] = useState(false);
  /** live partial speech, and why voice is unavailable when it is */
  const [interim, setInterim] = useState("");
  const [voiceNote, setVoiceNote] = useState<string | null>(null);

  // the rotating word is only in the subtitle: it says the platform is not
  // agriculture-specific without claiming we are running those verticals now
  useEffect(() => {
    const t = setInterval(() => setVertIdx((i) => (i + 1) % VERTICALS.length), 1800);
    return () => clearInterval(t);
  }, []);

  // Prefer a finished run; fall back to whatever is furthest along, so the
  // launcher is never a dead end.
  const target = useMemo(() => {
    const done = missions.find((m) => m.status === "done");
    return done ?? missions[0] ?? null;
  }, [missions]);

  const suggested = target?.goal_text
    ?? "Remove weeds from my strawberry beds without damaging the crop";

  const submit = () => {
    if (!target || busy) return;
    setBusy(true);
    onLaunch(target.id, text.trim() || suggested);
  };

  return (
    <div className="absolute inset-0 z-30 flex items-center justify-center bg-soil-950/95 backdrop-blur-sm">
      <div className="w-full max-w-2xl px-8">
        <div className="text-center mb-8">
          <div className="text-[13px] uppercase tracking-[0.3em] text-chaff-600 mb-3">
            Accelerate.ai
          </div>
          <h1 className="text-[28px] leading-tight text-chaff-200 font-medium">
            Describe a system you want improved.
          </h1>
          <p className="text-[14px] text-chaff-400 mt-3">
            Agents research the domain on the open web, build the perception model,
            write the objective and train the controller.
            <br />
            No ML expertise, no consultant —{" "}
            <span className="num" style={{ color: C.signal400 }}>
              {VERTICALS[vertIdx]}
            </span>{" "}
            or anything else.
          </p>
        </div>

        <div
          className="flex items-center gap-2 rounded-lg border px-4 py-3"
          style={{ borderColor: C.soil700, background: C.soil900 }}
        >
          <span className="text-chaff-600 text-[15px]">▸</span>
          <input
            autoFocus
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
            placeholder={suggested}
            disabled={busy}
            className="flex-1 bg-transparent outline-none text-[15px] text-chaff-200 placeholder:text-chaff-600"
          />
          <button
            onClick={submit}
            disabled={!target || busy}
            className="chip hover:border-chaff-400 transition-colors disabled:opacity-40"
            style={{ color: C.signal400, borderColor: C.signal400 }}
          >
            {busy ? "opening…" : "Enter ↵"}
          </button>
        </div>

        {(interim || voiceNote) && (
          <div className="mt-2 text-center text-[12px]"
            style={{ color: interim ? C.chaff400 : C.chaff600 }}>
            {interim ? `${interim}…` : voiceNote}
          </div>
        )}

        <div className="mt-4 text-center text-[12px] text-chaff-600">
          {target ? (
            <>
              Opens the recorded run for{" "}
              <span className="num text-chaff-400">{target.id}</span> — real frames
              written by Daytona sandboxes during PPO training, replayed from Tiger.
            </>
          ) : (
            <>No recorded run available yet.</>
          )}
        </div>
      </div>
    </div>
  );
}
