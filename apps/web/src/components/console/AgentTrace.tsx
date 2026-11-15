"use client";
/** Reverse-chronological agent_events feed (DESIGN.md §3.4). */
import { AGENT_COLOR, C } from "@/lib/colors";
import type { AgentEventRow } from "@/lib/store";

function ago(ts: string): string {
  const s = Math.max(0, (Date.now() - new Date(ts).getTime()) / 1000);
  if (s < 60) return `${Math.floor(s)}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h`;
}

/** The Bright Data tag has to read from a judge's distance — it IS the track. */
function viaTag(e: AgentEventRow): string | null {
  const p = (e.payload ?? {}) as Record<string, unknown>;
  const via = p.via ? String(p.via) : null;
  if (!via) return null;
  const label = via === "serp" ? "SERP"
    : via === "serp_images" ? "SERP images"
    : via === "unlocker" ? "Unlocker"
    : via;
  return `via Bright Data · ${label}`;
}

export function AgentTrace({ events, onOpenSource }: {
  events: AgentEventRow[]; onOpenSource?: (table: string, id: string) => void;
}) {
  return (
    <div className="h-full overflow-y-auto">
      {events.length === 0 && (
        <div className="p-4 text-xs" style={{ color: C.chaff600 }}>
          Waiting for the first agent step…
        </div>
      )}
      {events.map((e) => {
        const color = AGENT_COLOR[e.agent] ?? C.chaff400;
        const tag = viaTag(e);
        const isDecision = e.kind === "decision";
        const isError = e.kind === "error";
        const isReport = e.kind === "report";
        return (
          <div
            key={e.id}
            className="row-in px-3 py-2 border-b flex gap-2 items-start"
            style={{
              borderColor: C.soil800,
              borderLeft: isDecision ? `2px solid ${C.signal400}`
                : isError ? `2px solid ${C.blight500}` : "2px solid transparent",
              background: isReport ? "rgba(182,156,255,0.06)" : undefined,
            }}
          >
            <span
              className="shrink-0 mt-0.5 w-5 h-5 rounded-full grid place-items-center text-[10px] font-semibold"
              style={{ background: `${color}22`, color, border: `1px solid ${color}55` }}
              title={e.agent}
            >
              {e.agent.slice(0, 1).toUpperCase()}
            </span>
            <div className="min-w-0 flex-1">
              <div
                className={isDecision ? "font-medium" : ""}
                style={{ color: isError ? C.blight500 : C.chaff200 }}
              >
                {e.title}
              </div>
              {tag && (
                <button
                  onClick={() => e.refTable && e.refId && onOpenSource?.(e.refTable, e.refId)}
                  className="chip mt-1 inline-block"
                  style={{ color: C.signal400, borderColor: `${C.signal400}66` }}
                >
                  {tag}
                </button>
              )}
              {isError && (
                <div className="text-[11px] mt-0.5" style={{ color: C.chaff600 }}>retrying…</div>
              )}
            </div>
            <span className="num shrink-0 text-[11px]" style={{ color: C.chaff600 }}>
              {ago(e.ts)}
            </span>
          </div>
        );
      })}
    </div>
  );
}
