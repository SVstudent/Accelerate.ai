/**
 * Bright Data — the only source of training data (CLAUDE.md §2, primary track).
 *
 * Cost discipline (deliberate, see §8 step 3):
 *  · every response is cached in `sources` keyed by sha256(url), so demo reruns
 *    cost nothing and never block;
 *  · a per-mission request budget caps the spend of a runaway agent;
 *  · 20 s timeout per request, and the caller never blocks the UI on us.
 *
 * Two things this module is deliberately strict about, because the whole
 * platform's credibility rests on them (migration 0003):
 *
 *  · REGION. The SERP zone accepts Google's own locale targeting (gl =
 *    country, hl = UI language). Guidance for the same question genuinely
 *    differs between a US and a UK authority, so the region is part of the
 *    request, part of the cache key, and is stored on the row — never dropped.
 *    Callers can then show disagreement instead of silently picking one answer.
 *
 *  · PROVENANCE. Every retrieval records the zone that served it, the fetch
 *    time, the SHA-256 of the bytes Bright Data actually returned (hashed
 *    BEFORE any compaction or truncation) and, when the page states one, its
 *    published/modified date. Nothing in the UI has to be trusted: it can be
 *    re-fetched and re-hashed.
 */
import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import { newId } from "@/lib/ids";

const API = "https://api.brightdata.com/request";
const TIMEOUT_MS = 20_000;

/** Hard ceiling per mission. Bright Data bills per request. */
export const REQUEST_BUDGET = Number(process.env.BRIGHTDATA_MAX_REQUESTS_PER_MISSION ?? 150);
const spend = new Map<string, number>();

export class BrightDataNotConfigured extends Error {}
export class BudgetExceeded extends Error {}

export function brightDataStatus() {
  return {
    token: Boolean(process.env.BRIGHTDATA_API_TOKEN),
    unlockerZone: process.env.BRIGHTDATA_UNLOCKER_ZONE || null,
    serpZone: process.env.BRIGHTDATA_SERP_ZONE || null,
    ready: Boolean(
      process.env.BRIGHTDATA_API_TOKEN &&
      (process.env.BRIGHTDATA_UNLOCKER_ZONE || process.env.BRIGHTDATA_SERP_ZONE),
    ),
  };
}

export const urlHash = (url: string) => createHash("sha256").update(url).digest("hex");
const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

/* ── region targeting (migration 0003) ───────────────────────────────── */

/** One SERP locale: Google's own `gl` (country) and `hl` (UI language). */
export type SerpRegion = { gl: string; hl: string; label?: string };

/** `us:en,gb:en,…` — the fallback panel when nobody asks for specific ones. */
const DEFAULT_REGIONS = "us:en,gb:en,au:en,in:en";

/**
 * Parse a region panel. Accepts "us", "us:en" or "US:EN"; anything that is not
 * a 2-letter country code is dropped rather than sent to the API as garbage.
 */
export function parseRegions(spec?: string | null): SerpRegion[] {
  const text = (spec ?? "").trim() || process.env.BRIGHTDATA_SERP_REGIONS || DEFAULT_REGIONS;
  const out: SerpRegion[] = [];
  const seen = new Set<string>();
  for (const part of text.split(/[,\s]+/)) {
    const [glRaw, hlRaw] = part.split(":");
    const gl = (glRaw ?? "").trim().toLowerCase();
    if (!/^[a-z]{2}$/.test(gl) || seen.has(gl)) continue;
    const hl = /^[a-z]{2}$/.test((hlRaw ?? "").trim().toLowerCase())
      ? (hlRaw as string).trim().toLowerCase()
      : "en";
    seen.add(gl);
    out.push({ gl, hl });
  }
  return out;
}

/** The region a request was issued from, as it is stored and reported. */
export const regionTag = (r?: SerpRegion | null) => (r ? r.gl : null);

function domainOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return ""; }
}

function budget(missionId: string) {
  const used = spend.get(missionId) ?? 0;
  if (used >= REQUEST_BUDGET) {
    throw new BudgetExceeded(
      `Bright Data request budget (${REQUEST_BUDGET}) reached for ${missionId}`,
    );
  }
  spend.set(missionId, used + 1);
}

export function spendSoFar(missionId: string) {
  return spend.get(missionId) ?? 0;
}

/* ── cache ────────────────────────────────────────────────────────────── */

type CachedSource = {
  id: string; url: string; title: string | null; domain: string | null;
  via: string; contentMd: string | null; httpStatus: number | null; cached: boolean;
  /** provenance + region (migration 0003) — null on rows written before it */
  region?: string | null; regionLang?: string | null; zone?: string | null;
  contentSha256?: string | null; contentBytes?: number | null;
  pagePublishedAt?: Date | null; pagePublishedRaw?: string | null;
  fetchedAt?: Date | null;
};

/** The provenance chain for one retrieval, as the API hands it to the UI. */
export type Provenance = {
  url: string;
  zone: string | null;
  region: string | null;
  fetched_at: string | null;
  sha256: string | null;
  bytes: number | null;
  http_status: number | null;
  page_published_at: string | null;
  page_published_raw: string | null;
};

export function provenanceOf(src: {
  url: string; zone?: string | null; region?: string | null;
  fetchedAt?: Date | string | null; contentSha256?: string | null;
  contentBytes?: number | null; httpStatus?: number | null;
  pagePublishedAt?: Date | string | null; pagePublishedRaw?: string | null;
}): Provenance {
  const iso = (d: Date | string | null | undefined) =>
    d ? (typeof d === "string" ? d : d.toISOString()) : null;
  return {
    url: src.url,
    zone: src.zone ?? null,
    region: src.region ?? null,
    fetched_at: iso(src.fetchedAt),
    sha256: src.contentSha256 ?? null,
    bytes: src.contentBytes ?? null,
    http_status: src.httpStatus ?? null,
    page_published_at: iso(src.pagePublishedAt),
    page_published_raw: src.pagePublishedRaw ?? null,
  };
}

/**
 * The page's own date, when it states one. Best-effort and often null: we ask
 * Unlocker for markdown, which strips the `<meta>` tags and JSON-LD where the
 * machine-readable date usually lives, so what survives is the human-visible
 * line extension services print ("Revised: June 2021", "Last updated …").
 * A null here is reported as null — never as "today".
 */
export function detectPublished(text: string | null | undefined): {
  at: Date | null; raw: string | null;
} {
  if (!text) return { at: null, raw: null };
  const head = text.slice(0, 20_000);
  const patterns: RegExp[] = [
    // machine-readable, if any survived
    /"date(?:Published|Modified)"\s*:\s*"([^"]{6,40})"/i,
    /(?:article:(?:published|modified)_time|datePublished|dateModified)["'\s:=]+([0-9]{4}-[0-9]{2}-[0-9]{2}[^"'<\s]*)/i,
    // human-visible lines. Case-insensitive: real pages write "Updated May 30,
    // 2024" with a capital U, and without /i none of these ever fired
    // (measured: 0 dates found on 6 extension-service pages).
    /(?:published|last\s+updated|last\s+modified|updated|revised|reviewed)\s*(?:on)?\s*[:\-—]?\s*([A-Z][a-z]{2,9}\.?\s+\d{1,2},?\s+\d{4})/i,
    /(?:published|last\s+updated|last\s+modified|updated|revised|reviewed)\s*(?:on)?\s*[:\-—]?\s*(\d{1,2}\s+[A-Z][a-z]{2,9}\.?\s+\d{4})/i,
    /(?:published|last\s+updated|last\s+modified|updated|revised|reviewed)\s*(?:on)?\s*[:\-—]?\s*(\d{1,2}\/\d{1,2}\/\d{2,4})/i,
    /(?:published|last\s+updated|last\s+modified|updated|revised|reviewed)\s*(?:on)?\s*[:\-—]?\s*([A-Z][a-z]{2,9}\s+\d{4})/i,
    /(?:published|last\s+updated|last\s+modified|updated|revised|reviewed)\s*(?:on)?\s*[:\-—]?\s*(\d{4}-\d{2}-\d{2})/i,
  ];
  for (const re of patterns) {
    const m = re.exec(head);
    if (!m) continue;
    const raw = m[1].trim();
    const t = Date.parse(raw);
    // a date in the future, or before the web existed, is a parse artefact
    if (Number.isFinite(t)) {
      const d = new Date(t);
      const year = d.getUTCFullYear();
      if (year >= 1993 && d.getTime() <= Date.now() + 86_400_000) {
        return { at: d, raw };
      }
    }
    return { at: null, raw };
  }
  return { at: null, raw: null };
}

async function fromCache(url: string, missionId: string | null): Promise<CachedSource | null> {
  const h = urlHash(url);
  const rows = await db.select().from(schema.sources)
    .where(eq(schema.sources.urlHash, h)).limit(8);
  if (!rows.length) return null;

  const own = rows.find((r) => r.missionId === missionId);
  if (own) return { ...own, cached: true } as CachedSource;

  // A hit belonging to another mission still saves the request, but a fact may
  // only cite a source this mission owns — otherwise the Evidence drawer shows
  // facts whose source is missing. Copy the cached content into this mission
  // (free: no Bright Data call) and cite the copy.
  const other = rows[0];
  if (!missionId) return { ...other, cached: true } as CachedSource;
  // the copy carries the ORIGINAL provenance (zone, region, fetch time, byte
  // hash, page date): those describe the retrieval, and re-stamping them with
  // "now" would turn a cache hit into a fabricated fetch.
  const copy = {
    id: newId("source"),
    missionId,
    url: other.url,
    urlHash: other.urlHash,
    title: other.title,
    domain: other.domain,
    via: other.via,
    query: other.query,
    contentMd: other.contentMd,
    httpStatus: other.httpStatus,
    region: other.region,
    regionLang: other.regionLang,
    zone: other.zone,
    contentSha256: other.contentSha256,
    contentBytes: other.contentBytes,
    pagePublishedAt: other.pagePublishedAt,
    pagePublishedRaw: other.pagePublishedRaw,
    fetchedAt: other.fetchedAt,
  };
  await db.insert(schema.sources).values(copy)
    .onConflictDoUpdate({
      target: [schema.sources.urlHash, schema.sources.missionId],
      set: { contentMd: copy.contentMd },
    });
  return { ...copy, cached: true } as CachedSource;
}

/**
 * SERP responses are big (an image SERP with 100 results runs well past the
 * 200 KB `content_md` cap), and truncating JSON makes the cached copy
 * unparseable — which silently turned every cache hit into "0 hits". So we
 * cache a compacted form carrying only the fields parseSerp/parseImages read.
 */
function compactSerp(text: string, via: string): string {
  if (via !== "serp" && via !== "serp_images") return text;
  try {
    const j = JSON.parse(text);
    const out: Record<string, unknown> = {};
    if (Array.isArray(j.organic)) {
      out.organic = j.organic.slice(0, 30).map((o: Record<string, unknown>) => ({
        title: o.title, link: o.link ?? o.url, description: o.description ?? o.snippet,
      }));
    }
    const imgs = j.images ?? j.image_results;
    if (Array.isArray(imgs)) {
      out.images = imgs.slice(0, 120).map((o: Record<string, unknown>) => ({
        original_image: o.original_image ?? o.image_url ?? o.original ?? o.src,
        title: o.title, source: o.source, link: o.link,
      }));
    }
    if (!out.organic && !out.images) return text;
    return JSON.stringify(out);
  } catch {
    return text;   // not JSON (raw HTML) — leave it to the length cap
  }
}

async function saveSource(args: {
  missionId: string | null; url: string; title?: string | null; via: string;
  query?: string | null; contentMd?: string | null; httpStatus?: number | null;
  region?: SerpRegion | null; zone?: string | null;
  /** sha256 + length of the bytes Bright Data returned, BEFORE compaction. */
  contentSha256?: string | null; contentBytes?: number | null;
}): Promise<CachedSource> {
  const id = newId("source");
  // the page's own date is read from the untruncated body
  const published = args.via === "unlocker"
    ? detectPublished(args.contentMd)
    : { at: null, raw: null };
  const fetchedAt = new Date();
  const row = {
    id,
    missionId: args.missionId,
    url: args.url,
    urlHash: urlHash(args.url),
    title: args.title ?? null,
    domain: domainOf(args.url),
    via: args.via,
    query: args.query ?? null,
    // compact SERP JSON first, then apply the schema's 200 KB cap
    contentMd: args.contentMd
      ? compactSerp(args.contentMd, args.via).slice(0, 200_000)
      : null,
    httpStatus: args.httpStatus ?? null,
    region: args.region?.gl ?? null,
    regionLang: args.region?.hl ?? null,
    zone: args.zone ?? null,
    contentSha256: args.contentSha256 ?? null,
    contentBytes: args.contentBytes ?? null,
    pagePublishedAt: published.at,
    pagePublishedRaw: published.raw,
    fetchedAt,
  };
  await db.insert(schema.sources).values(row)
    .onConflictDoUpdate({
      target: [schema.sources.urlHash, schema.sources.missionId],
      set: {
        contentMd: row.contentMd, httpStatus: row.httpStatus, fetchedAt,
        zone: row.zone, region: row.region, regionLang: row.regionLang,
        contentSha256: row.contentSha256, contentBytes: row.contentBytes,
        pagePublishedAt: row.pagePublishedAt, pagePublishedRaw: row.pagePublishedRaw,
      },
    });
  return { ...row, cached: false } as CachedSource;
}

/* ── transport ────────────────────────────────────────────────────────── */

/**
 * One Bright Data request. The body bytes are hashed here, before anything
 * truncates or compacts them, so `sha256` identifies exactly what the API
 * returned and a judge can re-fetch and compare.
 */
async function request(body: Record<string, unknown>): Promise<{
  status: number; text: string; sha256: string; bytes: number;
}> {
  const token = process.env.BRIGHTDATA_API_TOKEN;
  if (!token) throw new BrightDataNotConfigured("BRIGHTDATA_API_TOKEN is not set");
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(API, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: ctl.signal,
    });
    const buf = Buffer.from(await res.arrayBuffer());
    return {
      status: res.status,
      text: buf.toString("utf8"),
      sha256: sha256(buf),
      bytes: buf.length,
    };
  } finally {
    clearTimeout(t);
  }
}

/* ── public tools ─────────────────────────────────────────────────────── */

export type SerpResult = { title: string; url: string; snippet?: string };

/**
 * Web search through the SERP zone. Returns organic results.
 *
 * `region` appends Google's own `gl`/`hl` targeting. It is part of the URL, so
 * it is also part of the cache key: two regions are two cached rows, and
 * re-asking the same region costs nothing.
 */
export async function searchEngine(opts: {
  query: string; missionId: string | null; engine?: "google" | "bing"; limit?: number;
  region?: SerpRegion | null;
}): Promise<{
  results: SerpResult[]; cached: boolean; source: CachedSource; region: string | null;
}> {
  const zone = process.env.BRIGHTDATA_SERP_ZONE || process.env.BRIGHTDATA_UNLOCKER_ZONE;
  if (!zone) throw new BrightDataNotConfigured("no SERP or Unlocker zone configured");
  const engine = opts.engine ?? "google";
  const q = encodeURIComponent(opts.query);
  const loc = opts.region ? `&gl=${opts.region.gl}&hl=${opts.region.hl}` : "";
  const url = engine === "bing"
    ? `https://www.bing.com/search?q=${q}&format=json${opts.region ? `&cc=${opts.region.gl}` : ""}`
    : `https://www.google.com/search?q=${q}&brd_json=1&num=${opts.limit ?? 10}${loc}`;

  const cached = await fromCache(url, opts.missionId);
  if (cached?.contentMd) {
    return {
      results: parseSerp(cached.contentMd), cached: true, source: cached,
      region: cached.region ?? regionTag(opts.region),
    };
  }
  budget(opts.missionId ?? "shared");
  const { status, text, sha256: sha, bytes } = await request({ zone, url, format: "raw" });
  const source = await saveSource({
    missionId: opts.missionId, url, via: "serp", query: opts.query,
    contentMd: text, httpStatus: status, title: `SERP: ${opts.query}`,
    region: opts.region ?? null, zone, contentSha256: sha, contentBytes: bytes,
  });
  return {
    results: parseSerp(text), cached: false, source, region: regionTag(opts.region),
  };
}

/** Google wraps some results in /goto?url=<opaque>; those cannot be scraped. */
export const isGotoRedirect = (u: string) =>
  u.includes("google.com/goto?") || u.includes("google.com/url?");

/**
 * Real serp_api1 + brd_json=1 shape (verified 2026-11-14):
 *   { general, input, navigation, organic:[{title, link, description, ...}],
 *     videos, pagination, related, people_also_ask }
 * Direct links come first; goto-wrapped ones are kept but marked so callers can
 * prefer scrapeable URLs.
 */
function parseSerp(text: string): SerpResult[] {
  try {
    const j = JSON.parse(text);
    const organic = j.organic ?? j.organic_results ?? [];
    const out: SerpResult[] = organic.map((o: Record<string, unknown>) => ({
      title: String(o.title ?? ""),
      url: String(o.link ?? o.url ?? ""),
      snippet: o.description ? String(o.description)
        : o.snippet ? String(o.snippet) : undefined,
    })).filter((r: SerpResult) => r.url.startsWith("http"));
    // scrapeable results first, redirects last
    return out.sort((a, b) => Number(isGotoRedirect(a.url)) - Number(isGotoRedirect(b.url)));
  } catch {
    return [];
  }
}

/** Image SERP (Google Images). The Curator's source of labelled photos. */
export async function searchImages(opts: {
  query: string; missionId: string | null; limit?: number; region?: SerpRegion | null;
}): Promise<{
  images: { url: string; title?: string; pageUrl?: string }[];
  cached: boolean; sourceId: string; serpUrl: string; region: string | null;
}> {
  const zone = process.env.BRIGHTDATA_SERP_ZONE || process.env.BRIGHTDATA_UNLOCKER_ZONE;
  if (!zone) throw new BrightDataNotConfigured("no SERP or Unlocker zone configured");
  const q = encodeURIComponent(opts.query);
  const loc = opts.region ? `&gl=${opts.region.gl}&hl=${opts.region.hl}` : "";
  const url =
    `https://www.google.com/search?q=${q}&tbm=isch&brd_json=1&num=${opts.limit ?? 40}${loc}`;

  const cached = await fromCache(url, opts.missionId);
  const text = cached?.contentMd ?? null;
  if (text && cached) {
    return {
      images: parseImages(text), cached: true, sourceId: cached.id, serpUrl: url,
      region: cached.region ?? regionTag(opts.region),
    };
  }

  budget(opts.missionId ?? "shared");
  const res = await request({ zone, url, format: "raw" });
  const source = await saveSource({
    missionId: opts.missionId, url, via: "serp_images", query: opts.query,
    contentMd: res.text, httpStatus: res.status, title: `Images: ${opts.query}`,
    region: opts.region ?? null, zone, contentSha256: res.sha256, contentBytes: res.bytes,
  });
  return {
    images: parseImages(res.text), cached: false, sourceId: source.id, serpUrl: url,
    region: regionTag(opts.region),
  };
}

/**
 * Real image-SERP shape (verified 2026-11-14): `images: [{ link, original_image,
 * title, source }]` — `link` is a goto redirect, `original_image` is the direct
 * image URL we actually want.
 */
function parseImages(text: string): { url: string; title?: string; pageUrl?: string }[] {
  try {
    const j = JSON.parse(text);
    const arr = j.images ?? j.image_results ?? [];
    const seen = new Set<string>();
    const out: { url: string; title?: string; pageUrl?: string }[] = [];
    for (const o of arr as Record<string, unknown>[]) {
      const url = String(o.original_image ?? o.image_url ?? o.original ?? o.src ?? "");
      if (!url.startsWith("http") || seen.has(url)) continue;
      seen.add(url);
      out.push({
        url,
        title: o.title ? String(o.title) : undefined,
        pageUrl: (() => {
          const src = o.source ? String(o.source) : "";
          if (/^https?:\/\//.test(src)) return src;
          const link = o.link ? String(o.link) : "";
          // a goto redirect is opaque: it identifies nothing a judge can open
          return /^https?:\/\//.test(link) && !isGotoRedirect(link) ? link : undefined;
        })(),
      });
    }
    return out;
  } catch {
    return [];
  }
}

/** Fetch a page as markdown through Web Unlocker. */
export async function scrapeAsMarkdown(opts: {
  url: string; missionId: string | null; query?: string; region?: SerpRegion | null;
}): Promise<CachedSource> {
  const zone = process.env.BRIGHTDATA_UNLOCKER_ZONE;
  if (!zone) throw new BrightDataNotConfigured("BRIGHTDATA_UNLOCKER_ZONE is not set");
  const cached = await fromCache(opts.url, opts.missionId);
  if (cached?.contentMd) {
    // A cache hit still belongs to a region in THIS mission. The row may have
    // been written before region targeting existed, or by a mission that asked
    // untargeted; region records which locale's results surfaced the page, so
    // it is stamped on the row we are about to cite. Without this, a demo rerun
    // serves every page from cache and every fact comes back region-null —
    // measured on mission msn_6K0A4ufY3dsf.
    if (opts.region && !cached.region) {
      try {
        await db.update(schema.sources)
          .set({ region: opts.region.gl, regionLang: opts.region.hl })
          .where(eq(schema.sources.id, cached.id));
        return { ...cached, region: opts.region.gl, regionLang: opts.region.hl };
      } catch { /* the citation still works untagged */ }
    }
    return cached;
  }

  budget(opts.missionId ?? "shared");
  const { status, text, sha256: sha, bytes } = await request({
    zone, url: opts.url, format: "raw", data_format: "markdown",
  });
  return saveSource({
    missionId: opts.missionId, url: opts.url, via: "unlocker",
    query: opts.query ?? null, contentMd: text, httpStatus: status,
    // the page inherits the region of the SERP that found it, when the caller
    // knows it — a UK result read through the Unlocker is still UK guidance
    region: opts.region ?? null, zone, contentSha256: sha, contentBytes: bytes,
  });
}

/**
 * Download an image through Web Unlocker.
 * Direct fetches are blocked by many galleries (Wikimedia 403s us), and Daytona
 * sandboxes cannot reach Bright Data at all, so this runs in the app and the
 * bytes are handed to the sandbox.
 */
export async function fetchImageBytes(opts: {
  url: string; missionId: string | null;
}): Promise<{
  bytes: Buffer; contentType: string;
  /** provenance of these exact bytes (migration 0003) */
  zone: string; sha256: string; fetchedAt: Date; httpStatus: number;
} | null> {
  const zone = process.env.BRIGHTDATA_UNLOCKER_ZONE;
  const token = process.env.BRIGHTDATA_API_TOKEN;
  if (!zone || !token) throw new BrightDataNotConfigured("Unlocker zone or token missing");
  budget(opts.missionId ?? "shared");
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(API, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ zone, url: opts.url, format: "raw" }),
      signal: ctl.signal,
    });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    const ct = res.headers.get("content-type") ?? "image/jpeg";
    if (!ct.startsWith("image/") && buf.length < 512) return null;
    // hashed here, on the bytes as delivered — the thumbnail and the sandbox
    // copy are both derived from these, so this hash is what anyone re-checking
    // our training data would compute.
    return {
      bytes: buf, contentType: ct, zone, sha256: sha256(buf),
      fetchedAt: new Date(), httpStatus: res.status,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

/** Counters behind the "Web data ingested" readout (§2). */
export async function ingestCounters(missionId: string) {
  const r = await db.execute(sql`
    select
      (select count(*) from sources where mission_id = ${missionId} and via in ('serp','serp_images')) queries,
      (select count(*) from sources where mission_id = ${missionId} and via in ('unlocker','scraper','browser')) pages,
      (select count(*) from dataset_items where mission_id = ${missionId}) images_raw,
      (select count(*) from dataset_items where mission_id = ${missionId} and verified is true) images_kept,
      (select count(*) from facts where mission_id = ${missionId}) facts,
      (select count(distinct region) from sources where mission_id = ${missionId} and region is not null) regions,
      (select count(*) from dataset_items where mission_id = ${missionId} and hard_negative is true) hard_negatives`);
  const row = ((r.rows ?? r) as Record<string, unknown>[])[0] ?? {};
  return {
    queries: Number(row.queries ?? 0), pages: Number(row.pages ?? 0),
    images_raw: Number(row.images_raw ?? 0), images_kept: Number(row.images_kept ?? 0),
    facts: Number(row.facts ?? 0),
    regions: Number(row.regions ?? 0),
    hard_negatives: Number(row.hard_negatives ?? 0),
  };
}
