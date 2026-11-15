/**
 * Pre-create the sandbox fleet (CLAUDE.md §5.4) so booting never counts against
 * a demo. POST { missionId, count? }. DELETE tears the fleet down — call it when
 * you are done, because idle sandboxes still bill.
 */
import { NextRequest, NextResponse } from "next/server";
import { warmFarm, teardownFarm, teardownEverything, poolSize, preset } from "@/mastra/tools/daytona";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const missionId = String(body.missionId ?? "");
  if (!missionId) return NextResponse.json({ error: "missionId required" }, { status: 400 });
  if (!process.env.DAYTONA_API_KEY) {
    return NextResponse.json({ error: "DAYTONA_API_KEY not set" }, { status: 503 });
  }
  try {
    const ids = await warmFarm(missionId, body.count ? Number(body.count) : undefined);
    return NextResponse.json({ missionId, sandboxes: ids, preset: preset() });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  const missionId = req.nextUrl.searchParams.get("missionId") ?? "";
  return NextResponse.json({ missionId, size: poolSize(missionId), preset: preset() });
}

export async function DELETE(req: NextRequest) {
  const missionId = req.nextUrl.searchParams.get("missionId");
  const all = req.nextUrl.searchParams.get("all") === "1";
  if (all) return NextResponse.json({ deleted: await teardownEverything() });
  if (!missionId) return NextResponse.json({ error: "missionId required" }, { status: 400 });
  await teardownFarm(missionId);
  return NextResponse.json({ missionId, torn_down: true });
}
