/**
 * Evidence drawer feed (DESIGN.md §5).
 *
 *   GET /api/missions/:id/evidence → EvidencePayload
 *
 * Everything the drawer shows comes from Neon rows written by the agents —
 * sources (with the Bright Data `via` and the query that found them), facts
 * (with their ≤25-word quote), the EnvConfig those facts produced, the curated
 * dataset and the perception model's before/after metrics. Nothing is invented
 * here: a missing value is returned as null and the UI renders "—".
 */
import { desc, eq } from "drizzle-orm";
import { db, demoDb, schema } from "@/db";
import type { EnvConfig, PerceptionMetrics } from "@/lib/contracts";
import { NextRequest } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const EXCERPT_CHARS = 2400;
const MAX_SOURCES = 120;
const MAX_FACTS = 200;
const MAX_ITEMS = 300;

export type EvidenceSource = {
  id: string;
  url: string;
  domain: string | null;
  title: string | null;
  via: string;
  query: string | null;
  http_status: number | null;
  fetched_at: string;
  /** first EXCERPT_CHARS of content_md, or null when the page was not unlocked */
  excerpt: string | null;
  truncated: boolean;
  fact_count: number;
  image_count: number;
};

export type EvidenceFact = {
  id: string;
  source_id: string;
  key: string;
  value: unknown;
  unit: string | null;
  quote: string | null;
  confidence: number;
  domain: string | null;
  url: string | null;
};

export type EvidenceDatasetItem = {
  id: string;
  image_url: string;
  class_key: string;
  class_label: string;
  label_source: string;
  verified: boolean | null;
  verifier_note: string | null;
  split: string | null;
  source_id: string | null;
  domain: string | null;
};

export type EvidencePayload = {
  mission_id: string;
  sources: EvidenceSource[];
  facts: EvidenceFact[];
  envConfig: { id: string; config: EnvConfig } | null;
  datasetItems: EvidenceDatasetItem[];
  perceptionModel: {
    id: string;
    arch: string;
    classes: unknown;
    metrics: PerceptionMetrics | null;
  } | null;
};

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const database = req.nextUrl.searchParams.get("replay") === "1" ? demoDb() : db;

  try {
    const [srcRows, factRows, envRows, itemRows, pmRows] = await Promise.all([
      database
        .select({
          id: schema.sources.id,
          url: schema.sources.url,
          domain: schema.sources.domain,
          title: schema.sources.title,
          via: schema.sources.via,
          query: schema.sources.query,
          httpStatus: schema.sources.httpStatus,
          fetchedAt: schema.sources.fetchedAt,
          contentMd: schema.sources.contentMd,
        })
        .from(schema.sources)
        .where(eq(schema.sources.missionId, id))
        .orderBy(desc(schema.sources.fetchedAt))
        .limit(MAX_SOURCES),
      database
        .select()
        .from(schema.facts)
        .where(eq(schema.facts.missionId, id))
        .orderBy(desc(schema.facts.confidence))
        .limit(MAX_FACTS),
      database
        .select()
        .from(schema.envConfigs)
        .where(eq(schema.envConfigs.missionId, id))
        .orderBy(desc(schema.envConfigs.createdAt))
        .limit(1),
      database
        .select({
          id: schema.datasetItems.id,
          imageUrl: schema.datasetItems.imageUrl,
          classKey: schema.datasetItems.classKey,
          classLabel: schema.datasetItems.classLabel,
          labelSource: schema.datasetItems.labelSource,
          verified: schema.datasetItems.verified,
          verifierNote: schema.datasetItems.verifierNote,
          split: schema.datasetItems.split,
          sourceId: schema.datasetItems.sourceId,
        })
        .from(schema.datasetItems)
        .where(eq(schema.datasetItems.missionId, id))
        .orderBy(desc(schema.datasetItems.createdAt))
        .limit(MAX_ITEMS),
      database
        .select()
        .from(schema.perceptionModels)
        .where(eq(schema.perceptionModels.missionId, id))
        .orderBy(desc(schema.perceptionModels.createdAt))
        .limit(1),
    ]);

    const domainById = new Map<string, string | null>();
    const urlById = new Map<string, string>();
    for (const s of srcRows) {
      domainById.set(s.id, s.domain);
      urlById.set(s.id, s.url);
    }

    const factCount = new Map<string, number>();
    for (const f of factRows) {
      factCount.set(f.sourceId, (factCount.get(f.sourceId) ?? 0) + 1);
    }
    const imageCount = new Map<string, number>();
    for (const it of itemRows) {
      if (it.sourceId) imageCount.set(it.sourceId, (imageCount.get(it.sourceId) ?? 0) + 1);
    }

    const sources: EvidenceSource[] = srcRows.map((s) => ({
      id: s.id,
      url: s.url,
      domain: s.domain,
      title: s.title,
      via: s.via,
      query: s.query,
      http_status: s.httpStatus,
      fetched_at: s.fetchedAt.toISOString(),
      excerpt: s.contentMd ? s.contentMd.slice(0, EXCERPT_CHARS) : null,
      truncated: !!s.contentMd && s.contentMd.length > EXCERPT_CHARS,
      fact_count: factCount.get(s.id) ?? 0,
      image_count: imageCount.get(s.id) ?? 0,
    }));

    const facts: EvidenceFact[] = factRows.map((f) => ({
      id: f.id,
      source_id: f.sourceId,
      key: f.key,
      value: f.value,
      unit: f.unit,
      quote: f.quote,
      confidence: f.confidence,
      domain: domainById.get(f.sourceId) ?? null,
      url: urlById.get(f.sourceId) ?? null,
    }));

    const datasetItems: EvidenceDatasetItem[] = itemRows.map((it) => ({
      id: it.id,
      image_url: it.imageUrl,
      class_key: it.classKey,
      class_label: it.classLabel,
      label_source: it.labelSource,
      verified: it.verified,
      verifier_note: it.verifierNote,
      split: it.split,
      source_id: it.sourceId,
      domain: it.sourceId ? domainById.get(it.sourceId) ?? null : null,
    }));

    const env = envRows[0];
    const pm = pmRows[0];

    const payload: EvidencePayload = {
      mission_id: id,
      sources,
      facts,
      envConfig: env ? { id: env.id, config: env.config as EnvConfig } : null,
      datasetItems,
      perceptionModel: pm
        ? {
            id: pm.id,
            arch: pm.arch,
            classes: pm.classes,
            metrics: (pm.metrics as PerceptionMetrics | null) ?? null,
          }
        : null,
    };

    return Response.json(payload, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 503 });
  }
}
