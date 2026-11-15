/** Dev-only: run Scout for real and show the cited facts it extracted. */
import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { parseGoal } from "@/mastra/workflows/foreman";
import { runScout, planQueries } from "@/mastra/agents/scout";
import { eventSink } from "@/mastra/tools/events";
import type { TaskSpec } from "@/lib/contracts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 800;

const MISSION = "msn_scouttest";

export async function GET(req: NextRequest) {
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const goal = req.nextUrl.searchParams.get("goal")
    ?? "Pull pigweed and purslane in my strawberry beds without touching the strawberries";
  try {
    await db.insert(schema.missions).values({
      id: MISSION, goalText: goal, status: "researching",
    }).onConflictDoUpdate({ target: schema.missions.id, set: { goalText: goal } });
    await db.delete(schema.facts).where(eq(schema.facts.missionId, MISSION));

    const onEvent = eventSink(MISSION);
    const spec = await parseGoal({ missionId: MISSION, goalText: goal, lang: "en", onEvent });
    const plan = planQueries(spec as TaskSpec);

    const t0 = Date.now();
    const out = await runScout({ missionId: MISSION, taskSpec: spec as TaskSpec });
    return NextResponse.json({
      ms: Date.now() - t0,
      planned_queries: plan,
      sources: out.sources.length,
      domains: [...new Set(out.sources.map((s) => s.domain))].filter(Boolean),
      counters: out.counters,
      facts: out.facts.map((f) => ({
        key: f.key, value: f.value, unit: f.unit,
        quote: f.quote?.slice(0, 90), confidence: f.confidence,
      })),
    });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
