/**
 * Agent trace writer. Every meaningful agent step writes exactly one
 * agent_events row with a short human-readable title (CLAUDE.md §12) — the UI
 * depends on it, and the "via Bright Data" chip is rendered from payload.via.
 */
import { eq, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import { newId } from "@/lib/ids";
import type { MissionStatus } from "@/lib/contracts";

export type EventKind =
  | "thought" | "tool" | "result" | "decision" | "error" | "report" | "speech";

export type AgentName =
  | "foreman" | "scout" | "curator" | "architect" | "trainer" | "judge" | "system";

export type EventInput = {
  agent: AgentName;
  kind: EventKind;
  title: string;
  payload?: Record<string, unknown>;
  refTable?: string;
  refId?: string;
  voiceClipId?: string;
};

export type EventSink = (e: EventInput) => Promise<void>;

/** A sink bound to one mission; hand this to every agent as `onEvent`. */
export function eventSink(missionId: string): EventSink {
  return async (e) => {
    try {
      await db.insert(schema.agentEvents).values({
        id: newId("event"),
        missionId,
        agent: e.agent,
        kind: e.kind,
        title: e.title.slice(0, 300),
        payload: e.payload ?? {},
        refTable: e.refTable ?? null,
        refId: e.refId ?? null,
        voiceClipId: e.voiceClipId ?? null,
      });
    } catch (err) {
      // the trace is for humans; never fail a mission because it could not write
      console.warn("[events] write failed:", (err as Error).message);
    }
  };
}

export async function setMissionStatus(
  missionId: string,
  status: MissionStatus,
  phaseDetail?: string | null,
  extra: Partial<{ generation: number; bestPolicyId: string; baselineEvalId: string }> = {},
) {
  await db.update(schema.missions).set({
    status,
    phaseDetail: phaseDetail ?? null,
    updatedAt: new Date(),
    ...(extra.generation !== undefined ? { generation: extra.generation } : {}),
    ...(extra.bestPolicyId ? { bestPolicyId: extra.bestPolicyId } : {}),
    ...(extra.baselineEvalId ? { baselineEvalId: extra.baselineEvalId } : {}),
  }).where(eq(schema.missions.id, missionId));
}

/** impact_stat facts are the ONLY source of real-world context (§6). */
export async function impactFacts(missionId: string) {
  const rows = await db.execute(sql`
    select f.id, f.value, f.quote, s.domain, s.url
    from facts f join sources s on s.id = f.source_id
    where f.mission_id = ${missionId} and f.key = 'impact_stat'
    order by f.confidence desc limit 6`);
  return ((rows.rows ?? rows) as Record<string, unknown>[]).map((r) => ({
    id: String(r.id), value: r.value, quote: r.quote ? String(r.quote) : null,
    domain: r.domain ? String(r.domain) : null, url: String(r.url ?? ""),
  }));
}
