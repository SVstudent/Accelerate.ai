/**
 * What Tiger is actually doing — the verification surface.
 *
 * GET /api/telemetry/engine
 *
 * Reads timescaledb_information.jobs, .job_stats, .continuous_aggregates,
 * .chunks and hypertable_compression_stats() straight off the service. It is
 * the honest answer to "is that continuous aggregate real, or did you just
 * create it?": every background job is reported with its run counts, and a
 * policy that exists but has never fired comes back with has_ever_run: false
 * rather than being presented as working.
 *
 * Nothing here is cached or hard-coded; if the extension is missing the field
 * is absent rather than invented.
 */
import { NextResponse } from "next/server";
import { tiger } from "@/db/tiger";
import { engineStatus } from "@/lib/tiger-analytics";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  if (!tiger) {
    return NextResponse.json({ error: "TIGER_DATABASE_URL is not set" }, { status: 503 });
  }
  const started = Date.now();
  try {
    const status = await engineStatus();
    return NextResponse.json({
      ...status,
      summary: {
        jobs_total: status.jobs.length,
        jobs_never_run: status.jobs.filter((j) => !j.has_ever_run).length,
        continuous_aggregates: status.continuous_aggregates.length,
        hypertables: status.hypertables.length,
      },
      generated_in_ms: Date.now() - started,
    });
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message.slice(0, 300) }, { status: 500 });
  }
}
