/**
 * One replay blob (SCHEMA.md §3) for FieldScene / the compare view.
 *
 *   GET /api/replays/:id            → ReplayResponse
 *   GET /api/replays/:id?replay=1   → same, from the frozen demo branch
 *
 * `data` is the Replay contract; `summary` is the trainer's EpisodeSummary plus
 * its raw counters (removed_target, damaged_unique, targets_total, …), which is
 * what the compare page's damage counters read.
 */
import { eq } from "drizzle-orm";
import { db, demoDb, schema } from "@/db";
import type { Replay } from "@/lib/contracts";
import { NextRequest } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export type ReplaySummary = {
  target_removal_rate?: number;
  protect_damage_rate?: number;
  trample_rate?: number;
  act_precision?: number;
  steps_used?: number;
  score?: number;
  removed_target?: number;
  removed_protect?: number;
  trampled?: number;
  damaged_unique?: number;
  misses?: number;
  targets_total?: number;
  protect_total?: number;
  seed?: number;
};

export type ReplayResponse = {
  id: string;
  mission_id: string;
  run_id: string | null;
  policy_id: string | null;
  step: number | null;
  seed: number;
  kind: string;
  created_at: string;
  data: Replay;
  summary: ReplaySummary;
};

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const database = req.nextUrl.searchParams.get("replay") === "1" ? demoDb() : db;

  try {
    const [row] = await database
      .select()
      .from(schema.replays)
      .where(eq(schema.replays.id, id))
      .limit(1);

    if (!row) return Response.json({ error: "replay not found" }, { status: 404 });

    const body: ReplayResponse = {
      id: row.id,
      mission_id: row.missionId,
      run_id: row.runId,
      policy_id: row.policyId,
      step: row.step,
      seed: row.seed,
      kind: row.kind,
      created_at: row.createdAt.toISOString(),
      data: row.data as Replay,
      summary: (row.summary as ReplaySummary) ?? {},
    };
    return Response.json(body, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 503 });
  }
}
