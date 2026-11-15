/**
 * Dev-only integration check for the Bright Data path (CLAUDE.md §2).
 * Proves, through the real app code: SERP → pick a scrapeable URL → Unlocker
 * markdown → `sources` cache hit on the second call (so reruns cost nothing).
 * Disabled in production.
 */
import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import {
  searchEngine, searchImages, scrapeAsMarkdown, isGotoRedirect,
  brightDataStatus, ingestCounters, spendSoFar,
} from "@/mastra/tools/brightdata";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MISSION = "msn_bdtest";

export async function GET() {
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const status = brightDataStatus();
  if (!status.ready) return NextResponse.json({ status, error: "not configured" }, { status: 503 });

  const out: Record<string, unknown> = { status };
  try {
    await db.insert(schema.missions).values({
      id: MISSION, goalText: "bright data integration check", status: "researching",
    }).onConflictDoNothing();

    // 1. search
    const q = "redroot pigweed seedling identification strawberry field UC IPM";
    const s1 = await searchEngine({ query: q, missionId: MISSION, limit: 10 });
    out.search = {
      results: s1.results.length, cached: s1.cached,
      scrapeable: s1.results.filter((r) => !isGotoRedirect(r.url)).length,
      top: s1.results.slice(0, 4).map((r) => ({ title: r.title.slice(0, 60), url: r.url.slice(0, 90) })),
    };

    // 2. cache must hit on the identical query (no second charge)
    const s2 = await searchEngine({ query: q, missionId: MISSION, limit: 10 });
    out.search_second_call_cached = s2.cached;

    // 3. scrape the first scrapeable result
    const target = s1.results.find((r) => !isGotoRedirect(r.url));
    if (target) {
      const page = await scrapeAsMarkdown({ url: target.url, missionId: MISSION, query: q });
      const md = page.contentMd ?? "";
      out.scrape = {
        url: target.url, cached: page.cached, bytes: md.length, domain: page.domain,
        mentions: {
          spacing: /spacing|apart|inches|cm/i.test(md),
          seedling: /seedling|cotyledon/i.test(md),
          density: /per square|density|plants per/i.test(md),
        },
        excerpt: md.replace(/\s+/g, " ").slice(0, 200),
      };
      const again = await scrapeAsMarkdown({ url: target.url, missionId: MISSION });
      out.scrape_second_call_cached = again.cached;
    }

    // 4. image SERP
    const imgs = await searchImages({ query: "redroot pigweed seedling photo", missionId: MISSION, limit: 40 });
    out.images = {
      count: imgs.images.length, cached: imgs.cached,
      sample: imgs.images.slice(0, 3).map((i) => i.url.slice(0, 90)),
    };

    out.counters = await ingestCounters(MISSION);
    out.requests_spent_this_process = spendSoFar(MISSION);
    return NextResponse.json(out);
  } catch (err) {
    out.error = (err as Error).message;
    return NextResponse.json(out, { status: 500 });
  }
}
