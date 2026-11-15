/**
 * Resume an interrupted mission.
 *
 *   GET  /api/missions/<id>/resume  → what survived, and where a resume starts
 *   POST /api/missions/<id>/resume  → continue from that stage
 *
 * The Mastra workflow lives in this server process, so a rebuild, a crash or a
 * deploy kills every in-flight mission and leaves its row claiming `training`.
 * This route does not try to revive the dead workflow object: it reconstructs
 * progress from Postgres (see lib/resume.ts), then re-enters the pipeline at
 * the first stage whose durable product is missing, reusing everything already
 * paid for — scraped sources and facts, curated images, the fitted perception
 * model, written reward specs, completed training runs and recorded
 * evaluations.
 *
 * Body (all optional):
 *   { from?: Stage, force?: boolean, wait?: boolean,
 *     overrides?: { priorities?: {...}, budget?: {...} } }
 */
import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { STAGES, missionProgress, type Stage } from "@/lib/resume";
import {
  activeStageRun, runMissionStages, type SpecOverrides,
} from "@/mastra/workflows/stages";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 3600;

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const progress = await missionProgress(id);
  if (!progress) return NextResponse.json({ error: "mission not found" }, { status: 404 });
  const run = activeStageRun(id);
  return NextResponse.json({
    ...progress,
    running_in_this_process: run
      ? { stage: run.stage, elapsed_s: Math.round((Date.now() - run.startedAt) / 1000) }
      : null,
    resumable: progress.resume_from !== null,
  });
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const body = (await req.json().catch(() => ({}))) as {
    from?: string; force?: boolean; wait?: boolean; reason?: string;
    overrides?: SpecOverrides;
  };

  const [mission] = await db.select({ id: schema.missions.id, status: schema.missions.status })
    .from(schema.missions).where(eq(schema.missions.id, id)).limit(1);
  if (!mission) return NextResponse.json({ error: "mission not found" }, { status: 404 });

  if (body.from && !STAGES.includes(body.from as Stage)) {
    return NextResponse.json(
      { error: `from must be one of ${STAGES.join(", ")}` }, { status: 400 },
    );
  }

  const progress = await missionProgress(id);
  if (!progress) return NextResponse.json({ error: "mission not found" }, { status: 404 });

  const inProcess = activeStageRun(id);
  if (inProcess && !body.force) {
    return NextResponse.json({
      error: "this mission is already running in this process",
      stage: inProcess.stage,
      elapsed_s: Math.round((Date.now() - inProcess.startedAt) / 1000),
    }, { status: 409 });
  }
  if (progress.live && !body.force) {
    return NextResponse.json({
      error: "a live stage runner is holding this mission (heartbeat within the last minute)",
      quiet_minutes: progress.quiet_minutes,
    }, { status: 409 });
  }
  const from = (body.from as Stage | undefined) ?? progress.resume_from ?? null;
  if (!from) {
    return NextResponse.json({
      mission_id: id, resumed: false,
      reason: "every stage is already complete — nothing to resume",
      progress,
    });
  }
  // A mission still waiting for its TaskSpec to be confirmed is not an
  // interrupted run; confirming it is the operator's decision, not ours.
  if (mission.status === "awaiting_confirm" && !body.force && from !== "draft") {
    return NextResponse.json({
      error: "mission is awaiting confirmation — confirm it via POST /run {confirm:true}, " +
        "or pass force to resume anyway",
      progress,
    }, { status: 409 });
  }

  const started = Date.now();
  const promise = runMissionStages(id, {
    from,
    force: body.force,
    overrides: body.overrides,
    reason: body.reason ?? "interrupted run picked back up",
  });

  // wait:true is for scripts and verification; the UI fires and watches the SSE
  // stream, exactly as it does for a fresh run.
  if (body.wait) {
    const out = await promise;
    return NextResponse.json({ ...out, resumed: true, elapsed_s: Math.round((Date.now() - started) / 1000) });
  }
  promise.catch(() => { /* the runner already recorded the failure */ });
  return NextResponse.json({
    mission_id: id, resumed: true, resuming_from: from,
    skipping: STAGES.slice(0, STAGES.indexOf(from)),
    reusing: progress.reuse,
    was: { status: progress.status, quiet_minutes: progress.quiet_minutes, stalled: progress.stalled },
  });
}
