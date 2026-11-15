/**
 * "Fork this mission" — the Neon branching showcase.
 *
 *   GET    /api/missions/<id>/fork                  → this mission's forks
 *   POST   /api/missions/<id>/fork                  → branch + re-run
 *   DELETE /api/missions/<id>/fork?fork_id=…        → delete the branch
 *
 * A grower's real question is "what if I told it to be more cautious?". The
 * honest answer is to run the pipeline again with a different reward emphasis
 * (or a different training budget) and show both outcomes. Doing that without
 * Neon means either re-scraping the web and re-curating the dataset, or
 * scribbling a second set of rows into the same tables.
 *
 * Instead: create a real Neon branch of the database AT THIS MISSION'S STATE
 * through the Neon API. The branch starts with every source, fact, curated
 * image, perception model, policy checkpoint and artifact already present —
 * copy-on-write, no data copied, nothing re-scraped. Then the stages from the
 * chosen fork point are re-run INSIDE the branch (db/index.ts binds the whole
 * pipeline, including the training sandboxes' own Neon writes, to the branch
 * for that async context). `main` is never touched, and the two timelines can
 * be read side by side by connecting to both (see ./compare).
 *
 * POST body:
 *   { from_stage?: "design"|"baseline"|"generation"|"test"|"report",
 *     overrides?: { priorities?: {avoid_damage,coverage,speed},
 *                   budget?: {generations,variants,steps_per_run} },
 *     label?: string, wait?: boolean }
 */
import { NextRequest, NextResponse } from "next/server";
import { and, desc, eq } from "drizzle-orm";
import { closeBranchDb, db, schema, withBranchDb } from "@/db";
import { newId } from "@/lib/ids";
import type { Stage } from "@/lib/resume";
import {
  applyOverrides, resetFromStage, runMissionStages, type SpecOverrides,
} from "@/mastra/workflows/stages";
import {
  createForkBranch, deleteBranch, getBranch, neonConfigured,
} from "@/lib/neon";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 3600;

/** Stages it makes sense to fork from (re-running research would re-scrape). */
const FORKABLE: Stage[] = ["curate", "design", "baseline", "generation", "test", "report"];

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const forks = await db.select().from(schema.missionForks)
    .where(eq(schema.missionForks.missionId, id))
    .orderBy(desc(schema.missionForks.createdAt));

  const rows = [];
  for (const f of forks) {
    const branch = neonConfigured() && !f.deletedAt ? await getBranch(f.neonBranchId) : null;
    rows.push({
      id: f.id,
      neon_branch_id: f.neonBranchId,
      neon_branch_name: f.neonBranchName,
      parent_branch_id: f.parentBranchId,
      from_stage: f.fromStage,
      overrides: f.overrides,
      label: f.label,
      status: f.status,
      detail: f.detail,
      created_at: f.createdAt,
      deleted_at: f.deletedAt,
      branch_exists: Boolean(branch),
      branch_size_bytes: branch?.logical_size ?? null,
      branch_state: branch?.current_state ?? null,
    });
  }
  return NextResponse.json({ mission_id: id, forks: rows, neon_configured: neonConfigured() });
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const body = (await req.json().catch(() => ({}))) as {
    from_stage?: string; overrides?: SpecOverrides; label?: string; wait?: boolean;
  };

  if (!neonConfigured()) {
    return NextResponse.json({
      error: "NEON_API_KEY is not set — forking creates a real Neon branch through the Neon API",
    }, { status: 503 });
  }

  const [mission] = await db.select().from(schema.missions)
    .where(eq(schema.missions.id, id)).limit(1);
  if (!mission) return NextResponse.json({ error: "mission not found" }, { status: 404 });
  if (!mission.taskSpec) {
    return NextResponse.json({ error: "mission has no TaskSpec to re-run" }, { status: 409 });
  }

  const fromStage = (body.from_stage as Stage | undefined) ?? "design";
  if (!FORKABLE.includes(fromStage)) {
    return NextResponse.json({
      error: `from_stage must be one of ${FORKABLE.join(", ")}`,
      note: "research is deliberately not forkable: re-scraping is exactly what a fork avoids",
    }, { status: 400 });
  }

  const forkId = newId("mission_fork");
  const label = (body.label ?? "").slice(0, 120) || null;
  const parentBranchId = process.env.NEON_BRANCH_ID || undefined;

  // ── 1. the Neon branch: the mission's whole state, copy-on-write ──
  let branch, connectionUri: string;
  try {
    const made = await createForkBranch({
      name: `${id.replace(/^msn_/, "")}-${fromStage}-${forkId.slice(-6)}`.toLowerCase(),
      parentId: parentBranchId,
    });
    branch = made.branch;
    connectionUri = made.connectionUri;
  } catch (err) {
    return NextResponse.json({ error: `could not create the Neon branch: ${(err as Error).message}` }, { status: 502 });
  }

  // ── 2. the fork row, on the PARENT branch (normally main) ──
  await db.insert(schema.missionForks).values({
    id: forkId,
    missionId: id,
    neonBranchId: branch.id,
    neonBranchName: branch.name,
    parentBranchId: parentBranchId ?? branch.parent_id ?? null,
    fromStage,
    overrides: (body.overrides ?? {}) as Record<string, unknown>,
    label,
    status: "running",
  });

  // Every mission row should say which branch it lives on. The parent's row is
  // on the branch we are connected to (normally main); the fork's row, written
  // below inside the branch, points at the branch.
  if (parentBranchId && !mission.neonBranchId) {
    await db.update(schema.missions).set({
      neonBranchId: parentBranchId,
      neonBranchName: process.env.NEON_BRANCH ?? null,
      updatedAt: new Date(),
    }).where(eq(schema.missions.id, id)).catch(() => {});
  }

  const setForkStatus = async (status: string, detail?: string) => {
    await db.update(schema.missionForks)
      .set({ status, detail: detail?.slice(0, 500) ?? null, updatedAt: new Date() })
      .where(eq(schema.missionForks.id, forkId))
      .catch(() => {});
  };

  // ── 3. re-run the stages INSIDE the branch ──
  const run = withBranchDb(connectionUri, async () => {
    // the row inside the branch knows which timeline it is
    await db.update(schema.missions).set({
      neonBranchId: branch.id,
      neonBranchName: branch.name,
      forkId,
      updatedAt: new Date(),
    }).where(eq(schema.missions.id, id));

    if (body.overrides) await applyOverrides(id, body.overrides);
    // only ever inside a branch: resetFromStage refuses to run on main
    const cleared = await resetFromStage(id, fromStage);
    const out = await runMissionStages(id, {
      from: fromStage,
      force: true,
      kind: "fork",
      reason: `fork ${forkId} on ${branch.name}`,
    });
    return { ...out, cleared };
  })
    .then(async (out) => {
      await setForkStatus(out.status === "failed" ? "failed" : "done", out.error ?? out.status);
      return out;
    })
    .catch(async (err) => {
      await setForkStatus("failed", (err as Error).message);
      throw err;
    })
    .finally(async () => { await closeBranchDb(connectionUri); });

  const summary = {
    mission_id: id,
    fork_id: forkId,
    neon_branch_id: branch.id,
    neon_branch_name: branch.name,
    parent_branch_id: parentBranchId ?? branch.parent_id ?? null,
    from_stage: fromStage,
    overrides: body.overrides ?? {},
    reused_without_copying:
      "every source, fact, curated image, perception model and artifact came with the branch",
    compare: `/api/missions/${id}/compare?fork_id=${forkId}`,
    delete: `/api/missions/${id}/fork?fork_id=${forkId}`,
  };

  if (body.wait) {
    try {
      const out = await run;
      return NextResponse.json({ ...summary, run: out });
    } catch (err) {
      return NextResponse.json({ ...summary, error: (err as Error).message }, { status: 500 });
    }
  }
  run.catch(() => { /* recorded on the fork row */ });
  return NextResponse.json({ ...summary, started: true });
}

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const forkId = req.nextUrl.searchParams.get("fork_id");
  const branchId = req.nextUrl.searchParams.get("branch_id");
  if (!forkId && !branchId) {
    return NextResponse.json({ error: "fork_id or branch_id is required" }, { status: 400 });
  }
  const [fork] = await db.select().from(schema.missionForks)
    .where(and(
      eq(schema.missionForks.missionId, id),
      forkId ? eq(schema.missionForks.id, forkId) : eq(schema.missionForks.neonBranchId, branchId!),
    )).limit(1);
  if (!fork) return NextResponse.json({ error: "fork not found for this mission" }, { status: 404 });

  if (!neonConfigured()) {
    return NextResponse.json({ error: "NEON_API_KEY is not set — cannot delete the branch" }, { status: 503 });
  }
  const out = await deleteBranch(fork.neonBranchId);
  if (!out.deleted) {
    return NextResponse.json({ fork_id: fork.id, deleted: false, reason: out.reason }, { status: 409 });
  }
  await db.update(schema.missionForks)
    .set({ status: "deleted", deletedAt: new Date(), updatedAt: new Date() })
    .where(eq(schema.missionForks.id, fork.id));
  return NextResponse.json({
    fork_id: fork.id, neon_branch_id: fork.neonBranchId,
    neon_branch_name: fork.neonBranchName, deleted: true,
  });
}
