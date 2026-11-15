/**
 * Missions collection route.
 *
 *   GET  /api/missions          → { missions: MissionListRow[] }
 *   POST /api/missions          → { id, status }            (create a draft)
 *   POST /api/missions {mission_id} → { id, event_id }      (operator reply)
 *
 * The home composer (DESIGN.md §6) lists from GET and creates from POST; the
 * mission console's Foreman column posts operator replies with `mission_id`.
 */
import { NextRequest } from "next/server";
import { desc, eq, inArray, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import { newId } from "@/lib/ids";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export type MissionListRow = {
  /** set when the run's process died: minutes of silence since its last event */
  stalled_minutes?: number;
  id: string;
  goal_text: string;
  goal_lang: string;
  status: string;
  generation: number;
  is_demo: boolean;
  crop: string | null;
  created_at: string;
  updated_at: string;
};

function cropOf(taskSpec: unknown): string | null {
  if (!taskSpec || typeof taskSpec !== "object") return null;
  const c = (taskSpec as Record<string, unknown>).crop;
  return typeof c === "string" && c.length ? c : null;
}

export async function GET(req: NextRequest) {
  const limit = Math.min(50, Math.max(1, Number(req.nextUrl.searchParams.get("limit") ?? 20) || 20));
  try {
    const rows = await db
      .select({
        id: schema.missions.id,
        goalText: schema.missions.goalText,
        goalLang: schema.missions.goalLang,
        taskSpec: schema.missions.taskSpec,
        status: schema.missions.status,
        generation: schema.missions.generation,
        isDemo: schema.missions.isDemo,
        createdAt: schema.missions.createdAt,
        updatedAt: schema.missions.updatedAt,
      })
      .from(schema.missions)
      .orderBy(desc(schema.missions.createdAt))
      .limit(limit);

    // A mission's workflow runs in THIS process. If the server restarted while
    // one was mid-flight, the row still says "training" forever and the UI
    // advertises a run that is not running. Detect that honestly: a mission in
    // a working state whose last agent event is older than STALE_MIN is
    // reported as "stalled", not as live work.
    const STALE_MIN = 10;
    const WORKING = new Set([
      "researching", "curating", "designing", "training",
      "evaluating", "redesigning", "testing", "awaiting_confirm",
    ]);
    const watched = rows.filter((m) => WORKING.has(m.status)).map((m) => m.id);
    const lastSeen = new Map<string, number>();
    if (watched.length) {
      const seen = await db
        .select({
          missionId: schema.agentEvents.missionId,
          last: sql<Date>`max(${schema.agentEvents.ts})`,
        })
        .from(schema.agentEvents)
        .where(inArray(schema.agentEvents.missionId, watched))
        .groupBy(schema.agentEvents.missionId);
      for (const r of seen) {
        if (r.missionId && r.last) lastSeen.set(r.missionId, new Date(r.last).getTime());
      }
      // A live stage runner writes missions.heartbeat_at every 20s (migration
      // 0004). Training is long and quiet, so event silence alone would call a
      // healthy run stalled; the heartbeat is the stronger signal and counts as
      // "last seen" whenever it is newer.
      const beats = await db
        .select({ id: schema.missions.id, heartbeatAt: schema.missions.heartbeatAt })
        .from(schema.missions)
        .where(inArray(schema.missions.id, watched));
      for (const b of beats) {
        if (!b.heartbeatAt) continue;
        const t = new Date(b.heartbeatAt).getTime();
        if (t > (lastSeen.get(b.id) ?? 0)) lastSeen.set(b.id, t);
      }
    }
    const quietFor = (id: string) => {
      const t = lastSeen.get(id);
      return t === undefined ? Infinity : (Date.now() - t) / 60_000;
    };

    const missions: MissionListRow[] = rows.map((m) => ({
      id: m.id,
      goal_text: m.goalText,
      goal_lang: m.goalLang,
      status:
        WORKING.has(m.status) && quietFor(m.id) > STALE_MIN
          ? "stalled"
          : m.status,
      stalled_minutes:
        WORKING.has(m.status) && quietFor(m.id) > STALE_MIN
          ? Math.round(quietFor(m.id))
          : undefined,
      generation: m.generation,
      is_demo: m.isDemo,
      crop: cropOf(m.taskSpec),
      created_at: m.createdAt.toISOString(),
      updated_at: m.updatedAt.toISOString(),
    }));
    return Response.json({ missions });
  } catch (err) {
    return Response.json(
      { missions: [], error: (err as Error).message },
      { status: 503 },
    );
  }
}

export async function POST(req: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "body must be JSON" }, { status: 400 });
  }

  const goalText = String(body.goal_text ?? "").trim();
  const lang = String(body.goal_lang ?? body.lang ?? "en").slice(0, 8) || "en";
  const missionId = body.mission_id ? String(body.mission_id) : null;
  if (!goalText) return Response.json({ error: "goal_text is required" }, { status: 400 });

  try {
    // ── operator reply on an existing mission → one agent_events row ──
    if (missionId) {
      const [m] = await db
        .select({ id: schema.missions.id })
        .from(schema.missions)
        .where(eq(schema.missions.id, missionId))
        .limit(1);
      if (!m) return Response.json({ error: "mission not found" }, { status: 404 });

      const eventId = newId("event");
      await db.insert(schema.agentEvents).values({
        id: eventId,
        missionId,
        agent: "foreman",
        kind: "note",
        title: goalText.slice(0, 500),
        payload: { from: "operator", lang },
      });
      return Response.json({ id: missionId, event_id: eventId }, { status: 201 });
    }

    // ── new draft mission ──
    const id = newId("mission");
    await db.insert(schema.missions).values({
      id,
      goalText,
      goalLang: lang,
      status: "draft",
    });
    return Response.json({ id, status: "draft" }, { status: 201 });
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 503 });
  }
}
