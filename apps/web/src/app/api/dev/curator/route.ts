/** Dev-only: the web-data → perception link, for real. */
import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { runCurator } from "@/mastra/agents/curator";
import { teardownFarm } from "@/mastra/tools/daytona";
import type { TaskSpec } from "@/lib/contracts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 1800;

const MISSION = "msn_curatortest";

const SPEC: TaskSpec = {
  template: "selective_removal",
  crop: "strawberry",
  target: {
    key: "target",
    names: ["redroot pigweed", "common purslane"],
    scientific: ["Amaranthus retroflexus", "Portulaca oleracea"],
    stage_hint: "seedling to 4-leaf",
  },
  protect: { key: "protect", names: ["strawberry plant"], scientific: ["Fragaria x ananassa"] },
  priorities: { avoid_damage: 0.95, coverage: 0.7, speed: 0.3 },
  region_hint: "California Central Coast",
  lang: "en",
  budget: { generations: 2, variants: 4, steps_per_run: 200000 },
};

export async function GET(_req: NextRequest) {
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  try {
    await db.insert(schema.missions).values({
      id: MISSION, goalText: "curator integration check", taskSpec: SPEC, status: "curating",
    }).onConflictDoUpdate({ target: schema.missions.id, set: { taskSpec: SPEC, status: "curating" } });
    await db.delete(schema.datasetItems).where(eq(schema.datasetItems.missionId, MISSION));
    await db.delete(schema.perceptionModels).where(eq(schema.perceptionModels.missionId, MISSION));

    const t0 = Date.now();
    const out = await runCurator({ missionId: MISSION, taskSpec: SPEC });
    const byClass: Record<string, number> = {};
    const bySplit: Record<string, number> = {};
    for (const it of out.items) {
      byClass[it.classKey ?? "?"] = (byClass[it.classKey ?? "?"] ?? 0) + 1;
      bySplit[it.split ?? "?"] = (bySplit[it.split ?? "?"] ?? 0) + 1;
    }
    return NextResponse.json({
      ms: Date.now() - t0,
      items: out.items.length,
      by_class: byClass,
      by_split: bySplit,
      verified_true: out.items.filter((i) => i.verified === true).length,
      verified_false: out.items.filter((i) => i.verified === false).length,
      unverified: out.items.filter((i) => i.verified === null || i.verified === undefined).length,
      perception: out.perceptionModel ? {
        id: out.perceptionModel.id,
        arch: out.perceptionModel.arch,
        metrics: out.perceptionModel.metrics,
      } : null,
    });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message?.slice(0, 500) }, { status: 500 });
  } finally {
    // a stopped sandbox still holds its 3 GiB against the account quota
    await teardownFarm(MISSION).catch(() => {});
  }
}
