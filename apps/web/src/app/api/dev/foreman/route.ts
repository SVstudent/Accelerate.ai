/** Dev-only: prove structured TaskSpec generation works on Vultr. */
import { NextRequest, NextResponse } from "next/server";
import { db, schema } from "@/db";
import { parseGoal } from "@/mastra/workflows/foreman";
import { eventSink } from "@/mastra/tools/events";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const goal = req.nextUrl.searchParams.get("goal")
    ?? "Pull pigweed and purslane in my strawberry beds without touching the strawberries";
  const lang = req.nextUrl.searchParams.get("lang") ?? "en";
  const missionId = "msn_foremantest";
  try {
    await db.insert(schema.missions).values({
      id: missionId, goalText: goal, goalLang: lang, status: "draft",
    }).onConflictDoUpdate({
      target: schema.missions.id,
      set: { goalText: goal, goalLang: lang, status: "draft" },
    });
    const t0 = Date.now();
    const spec = await parseGoal({ missionId, goalText: goal, lang, onEvent: eventSink(missionId) });
    return NextResponse.json({ ms: Date.now() - t0, model: process.env.VULTR_MODEL, spec });
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message, model: process.env.VULTR_MODEL }, { status: 500 },
    );
  }
}
