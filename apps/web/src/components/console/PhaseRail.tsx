"use client";
/** Eight steps mapped to MissionStatus (DESIGN.md §3.2). */
import { PHASES, type Phase } from "@/lib/contracts";
import { C } from "@/lib/colors";

const LABEL: Record<Phase, string> = {
  ask: "Ask", research: "Research", curate: "Curate", perceive: "Perceive",
  design: "Design", train_g0: "Train g0", train_g1: "Train g1", report: "Report",
};

export function PhaseRail({ phase, phaseDetail, onPick }: {
  phase: Phase | null; phaseDetail?: string | null; onPick?: (p: Phase) => void;
}) {
  const idx = phase ? PHASES.indexOf(phase) : -1;
  return (
    <div className="h-10 shrink-0 flex items-center gap-1 px-3 border-b border-soil-700 text-xs">
      {PHASES.map((p, i) => {
        const done = i < idx;
        const active = i === idx;
        const color = done ? C.leaf400 : active ? C.signal400 : C.soil700;
        return (
          <button
            key={p}
            onClick={() => onPick?.(p)}
            title={active && phaseDetail ? phaseDetail : LABEL[p]}
            className="flex items-center gap-1.5 px-2 py-1 rounded-full transition-colors"
            style={{
              color: done || active ? color : C.chaff600,
              background: active ? "rgba(242,179,61,0.12)" : "transparent",
              border: `1px solid ${active ? color : "transparent"}`,
            }}
          >
            <span style={{ color }}>{done ? "✓" : active ? "●" : "○"}</span>
            <span className="whitespace-nowrap">{i + 1}. {LABEL[p]}</span>
          </button>
        );
      })}
      {phaseDetail && (
        <span className="ml-3 num truncate" style={{ color: C.chaff400 }}>{phaseDetail}</span>
      )}
    </div>
  );
}
