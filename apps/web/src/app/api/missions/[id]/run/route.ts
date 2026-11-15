/**
 * Start (or resume) the mission workflow.
 *
 *   POST /api/missions/<id>/run              → start it
 *   POST /api/missions/<id>/run  {confirm:true, taskSpec?} → resume the
 *                                              suspended confirm step
 *
 * The workflow runs for minutes, so this returns as soon as it is under way;
 * progress is visible through the SSE stream and the agent trace.
 */
import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { missionWorkflow } from "@/mastra/workflows/mission";
import { mastra } from "@/mastra";
import { eventSink } from "@/mastra/tools/events";
import { teardownFarm } from "@/mastra/tools/daytona";
import { startHeartbeat } from "@/mastra/workflows/stages";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 3600;

/** runId per mission, so a confirm can resume the right suspended run. */
const runs = new Map<string, { run: Awaited<ReturnType<typeof missionWorkflow.createRun>>; started: number }>();

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const body = await req.json().catch(() => ({} as Record<string, unknown>));

  const [mission] = await db.select().from(schema.missions)
    .where(eq(schema.missions.id, id)).limit(1);
  if (!mission) return NextResponse.json({ error: "mission not found" }, { status: 404 });

  const onEvent = eventSink(id);

  // ── resume the suspended confirm step ──
  if (body.confirm) {
    const existing = runs.get(id);
    if (!existing) {
      return NextResponse.json({ error: "no suspended run for this mission" }, { status: 409 });
    }
    existing.run.resume({
      step: "confirm",
      resumeData: { confirmed: true, taskSpec: body.taskSpec },
    }).catch(async (err: unknown) => {
      await onEvent({ agent: "system", kind: "error", title: `resume failed: ${(err as Error).message}` });
    });
    return NextResponse.json({ missionId: id, resumed: true });
  }

  if (runs.has(id)) {
    return NextResponse.json({ missionId: id, already_running: true });
  }

  // attach the workflow to the Mastra instance so snapshots land in Neon
  try { mastra(); } catch { /* storage optional */ }

  const run = await missionWorkflow.createRun();
  runs.set(id, { run, started: Date.now() });

  // The workflow object dies with this process. The heartbeat is what lets
  // GET /api/missions tell "alive but quiet" (a 2-minute PPO run writes no
  // events) from "the server restarted and this run is gone", and what stops
  // POST /resume from starting a second runner for a mission that is live.
  const stopHeartbeat = startHeartbeat(id);

  run.start({
    inputData: { missionId: id, goalText: mission.goalText, lang: mission.goalLang ?? "en" },
  })
    .then(async (result: unknown) => {
      await onEvent({
        agent: "system", kind: "result",
        title: "Mission workflow finished",
        payload: { result: result as Record<string, unknown> },
      });
    })
    .catch(async (err: unknown) => {
      await onEvent({
        agent: "system", kind: "error",
        title: `Mission workflow failed: ${(err as Error).message}`.slice(0, 280),
      });
      await db.update(schema.missions)
        .set({ status: "failed", phaseDetail: (err as Error).message?.slice(0, 200), updatedAt: new Date() })
        .where(eq(schema.missions.id, id));
    })
    .finally(async () => {
      stopHeartbeat();
      runs.delete(id);
      // never leave sandboxes billing after a run ends, success or failure
      await teardownFarm(id).catch(() => {});
    });

  return NextResponse.json({ missionId: id, started: true, demo_mode: process.env.DEMO_MODE === "true" });
}

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const r = runs.get(id);
  const [m] = await db.select({ status: schema.missions.status, detail: schema.missions.phaseDetail })
    .from(schema.missions).where(eq(schema.missions.id, id)).limit(1);
  return NextResponse.json({
    missionId: id, running: Boolean(r),
    elapsed_s: r ? Math.round((Date.now() - r.started) / 1000) : null,
    status: m?.status ?? null, phase_detail: m?.detail ?? null,
  });
}
