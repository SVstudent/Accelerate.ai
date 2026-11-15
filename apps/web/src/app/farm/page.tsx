"use client";
/**
 * Training Farm rehearsal page (DESIGN.md §11 step 2).
 * 256 synthetic fields with score halos, so the hero view can be built and
 * practised before any sandbox streams. Swap the generator for the SSE feed
 * and nothing else changes.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { FarmScene, type FarmBlock, type FarmMode } from "@/components/arena/FarmScene";
import { SyntheticFarm } from "@/lib/live-frame";
import { C, scoreColor } from "@/lib/colors";

const N_BLOCKS = 8;        // 8 sandboxes
const N_ENVS = 32;         // x 32 envs = 256 live fields (the `demo` preset)

export default function FarmRehearsal() {
  const farms = useMemo(
    () => Array.from({ length: N_BLOCKS }, (_, i) => new SyntheticFarm(N_ENVS, i + 1)),
    [],
  );
  const [blocks, setBlocks] = useState<FarmBlock[]>([]);
  const [frame, setFrame] = useState(0);
  const [mode, setMode] = useState<FarmMode>("farm");
  const [learning, setLearning] = useState(0);
  const learnRef = useRef(0);

  useEffect(() => {
    const tick = () => {
      learnRef.current = Math.min(1, learnRef.current + 0.035);
      setLearning(learnRef.current);
      setBlocks(farms.map((f, i) => ({
        runId: `run_${i}`,
        label: `sandbox ${i} · reward v${i} · ${Math.round(learnRef.current * 100)}%`,
        envs: f.step(20, learnRef.current).map((e) => ({
          ...e,
          policy: (mode === "test" ? (e.env < N_ENVS / 2 ? "base" : "cand") : "cand") as "base" | "cand",
        })),
        booting: false,
      })));
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [farms, mode]);

  useEffect(() => {
    const id = setInterval(() => setFrame((f) => (f + 1) % 20), 50);
    return () => clearInterval(id);
  }, []);

  const scores = blocks.flatMap((b) => b.envs.map((e) => e.score ?? 0));
  const mean = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;

  return (
    <main className="h-screen w-screen flex flex-col bg-soil-950 text-chaff-200">
      <header className="h-12 shrink-0 flex items-center gap-4 px-4 border-b border-soil-700">
        <span className="font-medium tracking-wide">ACCELERATE.AI</span>
        <span className="text-chaff-600">▸</span>
        <span className="text-chaff-400">Training Farm rehearsal · synthetic frames</span>
        <span className="chip ml-2" style={{ color: C.signal400, borderColor: C.signal400 }}>
          <span className="pulse-live inline-block mr-1">●</span>LIVE
        </span>
        <div className="ml-auto flex items-center gap-3">
          <span className="num text-chaff-400">
            {blocks.length * N_ENVS} fields · mean score{" "}
            <span style={{ color: scoreColor(mean) }}>{mean.toFixed(2)}</span>
          </span>
          <button
            onClick={() => setMode((m) => (m === "farm" ? "test" : "farm"))}
            className="chip hover:border-chaff-400 transition-colors"
            style={{ color: mode === "test" ? C.sky400 : C.chaff400 }}
          >
            {mode === "farm" ? "Show test split" : "Back to farm"}
          </button>
        </div>
      </header>

      <div className="relative flex-1 min-h-0">
        <FarmScene blocks={blocks} mode={mode} frame={frame} />

        {mode === "test" && (
          <div className="pointer-events-none absolute inset-x-0 top-3 flex justify-around px-8">
            <div className="text-center">
              <div className="text-xs tracking-widest" style={{ color: C.sky400 }}>
                BEFORE · BASE POLICY
              </div>
              <div className="hero-num" style={{ color: C.sky400 }}>
                {(blocks.length * N_ENVS) / 2}
              </div>
            </div>
            <div className="text-center">
              <div className="text-xs tracking-widest" style={{ color: C.signal400 }}>
                AFTER · TRAINED
              </div>
              <div className="hero-num" style={{ color: C.signal400 }}>
                {(blocks.length * N_ENVS) / 2}
              </div>
            </div>
          </div>
        )}

        <div className="pointer-events-none absolute left-4 bottom-4 panel px-3 py-2 text-xs text-chaff-400">
          <div className="flex items-center gap-3">
            <span><span style={{ color: C.leaf400 }}>●</span> crop</span>
            <span><span style={{ color: C.bloom400 }}>▲</span> weed</span>
            <span><span style={{ color: C.signal400 }}>▮</span> trained rover</span>
            <span><span style={{ color: C.sky400 }}>▮</span> baseline rover</span>
          </div>
          <div className="mt-1">
            tile border = live score,{" "}
            <span style={{ color: C.blight500 }}>red</span> →{" "}
            <span style={{ color: C.signal400 }}>amber</span> →{" "}
            <span style={{ color: C.leaf400 }}>green</span>
            {"  ·  learning "}
            <span className="num">{Math.round(learning * 100)}%</span>
          </div>
        </div>
      </div>
    </main>
  );
}
