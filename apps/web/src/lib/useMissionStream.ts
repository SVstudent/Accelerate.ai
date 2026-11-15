"use client";
/** SSE → store (SCHEMA.md §7). One connection per mission. */
import { useEffect } from "react";
import { useMission } from "./store";
import { SSE_EVENTS } from "./contracts";

export function useMissionStream(missionId: string | null, replay = false) {
  const apply = useMission((s) => s.apply);
  const reset = useMission((s) => s.reset);

  useEffect(() => {
    if (!missionId) return;
    reset(missionId);
    const url = `/api/missions/${missionId}/stream${replay ? "?replay=1" : ""}`;
    const es = new EventSource(url);
    const handlers: { name: string; fn: (e: MessageEvent) => void }[] = [];

    for (const name of SSE_EVENTS) {
      const fn = (e: MessageEvent) => {
        try { apply(name, JSON.parse(e.data)); } catch { /* ignore malformed frame */ }
      };
      es.addEventListener(name, fn as EventListener);
      handlers.push({ name, fn });
    }
    return () => {
      for (const h of handlers) es.removeEventListener(h.name, h.fn as EventListener);
      es.close();
    };
  }, [missionId, replay, apply, reset]);
}
