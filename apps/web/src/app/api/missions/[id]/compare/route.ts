/**
 * Side-by-side: this mission on `main` vs the same mission on a fork branch.
 *
 *   GET /api/missions/<id>/compare?fork_id=fork_…
 *
 * The reading and diffing live in lib/compare.ts so the same code path is
 * exercised by the verification scripts; this route is the HTTP shell.
 */
import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { compareWithFork } from "@/lib/compare";
import { neonConfigured } from "@/lib/neon";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const forkId = req.nextUrl.searchParams.get("fork_id");
  if (!forkId) return NextResponse.json({ error: "fork_id is required" }, { status: 400 });

  const [fork] = await db.select().from(schema.missionForks)
    .where(and(eq(schema.missionForks.missionId, id), eq(schema.missionForks.id, forkId))).limit(1);
  if (!fork) return NextResponse.json({ error: "fork not found for this mission" }, { status: 404 });
  if (fork.deletedAt) {
    return NextResponse.json({
      error: "that fork's branch has been deleted",
      fork_id: fork.id, neon_branch_id: fork.neonBranchId,
    }, { status: 410 });
  }
  if (!neonConfigured()) {
    return NextResponse.json({
      error: "no Neon control-plane access (set NEON_API_KEY, or log in with the neon CLI)",
    }, { status: 503 });
  }

  const out = await compareWithFork(id, fork);
  if ("error" in out) return NextResponse.json({ error: out.error }, { status: out.status });
  return NextResponse.json(out);
}
