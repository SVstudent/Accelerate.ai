/**
 * Curator — the dataset agent (CLAUDE.md §4, SCHEMA.md §2.3).
 *
 * Builds the perception dataset for one mission entirely from Bright Data:
 * image SERP per class → Unlocker download → perceptual dedupe → Gemini label
 * QA → train/val/pool split → CLIP + linear probe in a Daytona sandbox.
 *
 * Non-negotiables this file is built around:
 *  · a Daytona sandbox cannot reach Bright Data or the public internet, so
 *    EVERY byte is downloaded here, in the app, and handed to the sandbox as an
 *    upload. Nothing is ever fetched from inside the sandbox;
 *  · all Bright Data traffic goes through tools/brightdata.ts so the `sources`
 *    cache and the per-mission REQUEST_BUDGET apply (it bills per request);
 *  · the label QA image is a downscaled data: URL built from bytes we already
 *    hold — VISION_MAX_PX caps it — so Gemini never re-fetches a hotlink that
 *    would 403 and we do not pay for full-resolution tokens;
 *  · 'protect' is NOT the negative class. Background queries (bare soil, mulch)
 *    are stored under their own class key and only land in split 'rejected'
 *    when the verifier rejects them.
 */
import { createHash } from "node:crypto";
import sharp from "sharp";
import { z } from "zod";
import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { db, schema } from "@/db";
import { newId } from "@/lib/ids";
import {
  BudgetExceeded,
  REQUEST_BUDGET,
  fetchImageBytes,
  searchImages,
  spendSoFar,
} from "../tools/brightdata";
import { verifyLabels, type LabelCheck } from "../tools/vision";
import { structured } from "../tools/llm";
import { runCurate } from "../tools/daytona";
import {
  PerceptionMetrics,
  SandboxJob,
  type TaskSpec,
} from "@/lib/contracts";

/* ── tuning (constants, not env: the env surface is fixed in CLAUDE.md §12) ── */
const SERP_CONCURRENCY = 6;
const SERP_IMAGES_PER_QUERY = 40;   // asked of the image SERP
const TAKE_PER_QUERY = 12;          // candidates kept per query
const DOWNLOAD_CONCURRENCY = 8;
/**
 * Downloads per plant class. 46 gave only ~12 held-out images, too few to
 * trust an accuracy figure (both zero-shot and probe read 100%). 160 per class
 * puts ~60 in val+pool while staying inside the Bright Data request budget.
 */
const MAX_PER_CLASS = Number(process.env.CURATOR_MAX_PER_CLASS ?? 160);
const MAX_BACKGROUND = 10;          // bare soil / mulch distractors
const BUDGET_RESERVE = 4;
const THUMB_PX = 128;
const SANDBOX_PX = 512;             // curate.py thumbnails to 448 anyway
const MIN_SIDE_PX = 80;
const MIN_FOR_SANDBOX = 20;         // curate.py aborts below this

/**
 * Split shares. A 13-image val set gave probe_acc 1.000 with a 95% Wilson
 * interval of [0.77, 1.00] — a number nobody should act on. Holding out a
 * quarter of each class for val (and a quarter for the pool the policy draws
 * from) halves that interval as soon as the query plan yields enough images,
 * and the remaining half of the data is still plenty for a 512-dim linear
 * probe. MIN_VAL_PER_CLASS tops val up toward ~25 images overall whenever the
 * class is big enough to spare them without starving training.
 */
const VAL_SHARE = 0.25;
const POOL_SHARE = 0.25;
const MIN_VAL_PER_CLASS = 13;       // ≈25 val images across the two classes
const MAX_VAL_SHARE = 0.35;         // never hold out more than this for val

const visionConcurrency = () => {
  const n = Number(process.env.VISION_CONCURRENCY ?? 24);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 24;
};
const visionMaxPx = () => {
  const n = Number(process.env.VISION_MAX_PX ?? 320);
  return Number.isFinite(n) && n >= 64 ? Math.floor(n) : 320;
};

/* ── types ────────────────────────────────────────────────────────────── */

export type ClassKey = "target" | "protect";
/** 'background' is a distractor bucket, never a training class. */
export type ItemClassKey = ClassKey | "background";
export type Split = "train" | "val" | "pool" | "rejected";

export type CuratorEvent = {
  id: string;
  missionId: string;
  agent: "curator";
  kind:
    | "plan" | "decision" | "search" | "download" | "verify"
    | "split" | "perceive" | "report" | "error";
  title: string;
  payload: Record<string, unknown>;
  refTable: string | null;
  refId: string | null;
};

/**
 * Observer for each step. The row is ALREADY inserted into `agent_events` when
 * this fires (the SSE route tails that table), so a handler should only relay —
 * never insert again.
 */
export type CuratorOnEvent = (e: CuratorEvent) => void | Promise<void>;

export type CuratorItem = {
  id: string;
  imageUrl: string;
  imgHash: string;
  classKey: ItemClassKey;
  classLabel: string;
  labelSource: string;
  verified: boolean | null;
  verifierNote: string | null;
  split: Split | null;
  query: string;
  /** migration 0003: look-alike mining + provenance of the bytes */
  hardNegative: boolean;
  lookalikeOf: ClassKey | null;
  lookalikeName: string | null;
  pageUrl: string | null;
  serpSourceId: string | null;
  zone: string;
  bytesSha256: string;
  bytesLen: number;
  contentType: string;
  fetchedAt: Date;
};

export type CuratorPerceptionModel = {
  id: string;
  arch: string;
  classes: Record<string, string>;
  metrics: PerceptionMetrics;
  poolArtifactId: string | null;
};

export type CuratorResult = {
  items: CuratorItem[];
  perceptionModel: CuratorPerceptionModel | null;
};

/**
 * A deliberately mined look-alike.
 *  · `name`            — the entity the planner named ("strawberry runner").
 *  · `confusableWith`  — the class it is mistaken FOR.
 *  · classKey          — the class it ACTUALLY belongs to, which is how it is
 *                        labelled. A runner looks like something to remove but
 *                        is part of the crop, so it trains as 'protect'.
 */
type Lookalike = { name: string; confusableWith: ClassKey; why: string };

type QuerySpec = {
  query: string;
  classKey: ItemClassKey;
  classLabel: string;
  /** what the verifier is asked about — the look-alike's own name, if any */
  qaLabel?: string;
  lookalike?: Lookalike;
};
type Candidate = QuerySpec & { url: string; pageUrl?: string; serpSourceId?: string };
type Prepared = Candidate & {
  id: string;
  imgHash: string;
  thumb: Buffer;
  qaDataUrl: string;
  sandboxBytes: Buffer;
  /** provenance of the downloaded bytes (migration 0003) */
  zone: string;
  bytesSha256: string;
  bytesLen: number;
  contentType: string;
  fetchedAt: Date;
};

/* ── helpers ──────────────────────────────────────────────────────────── */

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Math.max(1, Math.min(limit, items.length));
  await Promise.all(
    Array.from({ length: workers }, async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        out[i] = await fn(items[i], i);
      }
    }),
  );
  return out;
}

const squash = (s: string) => s.replace(/\s+/g, " ").trim();

function uniqBy<T>(xs: T[], key: (x: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const x of xs) {
    const k = key(x);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(x);
  }
  return out;
}

function labelOf(c: { names?: string[]; scientific?: string[] } | undefined, fallback: string): string {
  const name = squash(c?.names?.[0] ?? "") || fallback;
  const sci = squash(c?.scientific?.[0] ?? "");
  return sci && sci.toLowerCase() !== name.toLowerCase() ? `${name} (${sci})` : name;
}

/** Short phrase for the CLIP zero-shot prompt in trainer/curate.py. */
function clipName(c: { names?: string[] } | undefined, fallback: string): string {
  return (squash(c?.names?.[0] ?? "") || fallback).toLowerCase();
}

/* ── 1. image query plan ──────────────────────────────────────────────── */

/**
 * Growth stages a rover actually drives past, youngest first. A weed is only
 * worth hitting while it is small, but the open web is full of mature
 * specimens, so the stages have to be asked for by name or the dataset ends up
 * modelling flowering plants we will never see.
 */
const STAGES = ["cotyledon", "seedling", "rosette", "mature"];
/** Synonyms + scientific names used per class (scientific names pull extension / herbarium photos the common name misses). */
const MAX_SYNONYMS = 3;
/**
 * Queries per plant class. Each query is one image-SERP request, and every
 * image it yields is one Unlocker request, so the plan has to be costed:
 * 2 × 13 + 3 background = 29 SERP requests, and the downloads that follow are
 * capped by MAX_PER_CLASS (160) and by budgetLeft() — well inside the 600
 * requests shared with the Scout, which has already finished by the time the
 * Curator runs.
 */
const QUERIES_PER_CLASS = 13;

/** Words that carry no retrieval signal — dropped when testing two queries for near-identity. */
const QUERY_STOPWORDS = new Set([
  "a", "an", "and", "at", "image", "images", "in", "of", "on", "photo",
  "photos", "photograph", "picture", "plant", "the", "view", "with",
]);

/**
 * Near-identity key: lowercased, punctuation-free, stopword-free, deduplicated,
 * sorted tokens. "amaranth seedling photo in field soil" and "seedling amaranth
 * field soil photo" collapse to one key, so re-ordered or re-worded duplicates
 * cost no requests.
 */
function queryKey(q: string): string {
  const toks = q
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((w) => w && !QUERY_STOPWORDS.has(w));
  return Array.from(new Set(toks)).sort().join(" ");
}

/**
 * Queries for one plant class: synonyms × growth stages × viewpoints, plus
 * field context. Ordered most-valuable-first because the caller slices to
 * QUERIES_PER_CLASS.
 */
function classQueries(opts: {
  names: string[];
  stageHint: string;
  context: string[];
}): string[] {
  const { names, stageHint, context } = opts;
  const top = names.slice(0, MAX_SYNONYMS);
  const n0 = top[0];
  if (!n0) return [];
  const stages = uniqBy(
    [stageHint, ...STAGES].map(squash).filter(Boolean),
    (s) => s.toLowerCase(),
  );

  const q: string[] = [];
  // synonyms and scientific names: one plain close-up each
  for (const n of top) q.push(`${n} plant close up photo`);
  // growth stages on the primary name — the axis the dataset was missing
  for (const st of stages.slice(0, 4)) q.push(`${n0} ${st} photo in field soil`);
  // the strongest synonym also gets the two earliest stages
  if (top[1]) for (const st of stages.slice(0, 2)) q.push(`${top[1]} ${st} photo in soil`);
  // viewpoints: overhead is what a rover camera sees, macro is what the probe
  // separates on, in-row is the cluttered case
  q.push(`${n0} top down overhead photo on soil`);
  q.push(`${n0} leaf detail macro photo`);
  q.push(`${n0} growing between crop rows field photo`);
  // field context (crop, region, identification material)
  q.push(...context);
  return q;
}

export function planImageQueries(spec: TaskSpec): QuerySpec[] {
  const crop = squash(spec.crop ?? "");
  const region = squash(spec.region_hint ?? "");
  const target = spec.target ?? { names: [], scientific: [] };
  const protect = spec.protect ?? { names: [], scientific: [] };
  const targetLabel = labelOf(target, "weed");
  const protectLabel = labelOf(protect, crop || "crop");

  const tNames = uniqBy(
    [...(target.names ?? []), ...(target.scientific ?? [])].map(squash).filter(Boolean),
    (s) => s.toLowerCase(),
  );
  const pNames = uniqBy(
    [...(protect.names ?? []), ...(protect.scientific ?? [])].map(squash).filter(Boolean),
    (s) => s.toLowerCase(),
  );
  const tStage = squash(target.stage_hint ?? "seedling");
  const pStage = squash(protect.stage_hint ?? "seedling");

  // target: the weed we remove — synonyms × stages × viewpoints, in a field,
  // never a botanical diagram
  const targetQueries = classQueries({
    names: tNames,
    stageHint: tStage,
    context: [
      crop ? `${tNames[0]} weed in ${crop} field photo` : `${tNames[0]} weed in crop field photo`,
      `${tNames[0]} weed identification photo${region ? ` ${region}` : ""}`,
      `${tNames[0]} weed infestation in field photo`,
    ],
  }).map((query) => ({ query, classKey: "target" as ItemClassKey, classLabel: targetLabel }));

  // protect: the crop we must not touch
  const protectQueries = classQueries({
    names: pNames,
    stageHint: pStage,
    context: [
      crop && pNames[0]?.toLowerCase() !== crop.toLowerCase()
        ? `${crop} crop row photo field`
        : `${pNames[0]} crop row photo field`,
      `${pNames[0]} seedlings in row photo${region ? ` ${region}` : ""}`,
      `${pNames[0]} young crop plants in field photo`,
    ],
  }).map((query) => ({ query, classKey: "protect" as ItemClassKey, classLabel: protectLabel }));

  const plant: QuerySpec[] = [
    ...uniqBy(targetQueries, (q) => queryKey(q.query)).slice(0, QUERIES_PER_CLASS),
    ...uniqBy(protectQueries, (q) => queryKey(q.query)).slice(0, QUERIES_PER_CLASS),
  ];

  // negatives: background only, so the probe is never trained on bare soil.
  // Kept outside the per-class slices so a long synonym list cannot squeeze
  // them out.
  const bg = "bare soil, mulch or crop residue with no plants";
  const background: QuerySpec[] = [
    { query: "bare soil field close up top view photo", classKey: "background", classLabel: bg },
    { query: "straw mulch on soil close up photo", classKey: "background", classLabel: bg },
    { query: "dry crop residue stubble on soil photo", classKey: "background", classLabel: bg },
  ];

  // final pass: drop anything that survived as a near-duplicate across classes
  // (e.g. a crop that is also listed as a target synonym) and empty strings
  return uniqBy(
    [...plant, ...background]
      .map((q) => ({ ...q, query: squash(q.query) }))
      .filter((q) => q.query && !/\bundefined\b/.test(q.query)),
    (q) => queryKey(q.query),
  );
}

/* ── 1b. hard negatives: the look-alikes that actually break the robot ── */

/**
 * A probe trained on clean examples of each class learns the easy boundary.
 * What breaks a machine in the field is the LOOK-ALIKE: the thing that reads as
 * the other class at a glance. Those images are not in the obvious searches —
 * nobody publishes "the weed that looks like a strawberry plant" under the crop
 * name — so they have to be asked for by name, which means first working out
 * what the look-alikes ARE.
 *
 * That derivation is the LLM's job, from the task spec only. No list is
 * hardcoded, and the prompt names no domain: the same code path mines
 * daughter plants for a strawberry weeder and waste rock for an ore sorter.
 */
const Lookalikes = z.object({
  lookalikes: z.array(z.object({
    name: z.string().describe("the specific thing that gets confused, as it would be searched for"),
    confusable_with: z.enum(["target", "protect"])
      .describe("which of the two classes a human or camera mistakes it for"),
    true_class: z.enum(["target", "protect"])
      .describe("which class it ACTUALLY belongs to: 'target' if the system should act on it, 'protect' if it must be left alone"),
    image_query: z.string()
      .describe("an image-search query that returns real photographs of it in the working environment"),
    why: z.string().describe("one clause: what makes it visually confusable"),
  })).describe("up to 8, most dangerous confusion first"),
});

const LOOKALIKE_INSTRUCTIONS = `You plan image searches that will be used to train a visual classifier for an autonomous machine.

The machine must decide, from a single camera frame, whether something is a TARGET (it should act on it) or PROTECTED (it must not touch it). Trained only on clear examples of each, it fails on look-alikes: things that read as the wrong class at a glance. Your job is to name those look-alikes so photographs of them can be collected.

Rules, in order of importance:
1. Name only things that genuinely occur in this working environment. Do not invent.
2. For each one, state which class it is MISTAKEN FOR and which class it ACTUALLY belongs to. These must be different — a thing confusable with its own class is not a look-alike.
3. Include both directions when they exist: things that look like the target but must be left alone, and things that look like what must be protected but are in fact targets.
4. The query must be a plain image search that returns real photographs in the working environment, not diagrams, products or stock illustrations. Include the environment in the query.
5. Prefer the specific name a practitioner would search for over a general category.`;

/** Cap on look-alike queries per mission (each is one image-SERP request). */
const HARD_NEGATIVE_QUERIES = Number(process.env.CURATOR_HARD_NEGATIVE_QUERIES ?? 6);
/** Cap on look-alike images downloaded per mission (each is one Unlocker request). */
const MAX_HARD_NEGATIVES = Number(process.env.CURATOR_MAX_HARD_NEGATIVES ?? 64);

/**
 * Derive look-alike image queries from the task spec. Returns [] on any
 * failure — the dataset is then exactly what it was before, never a guess.
 */
export async function planHardNegativeQueries(spec: TaskSpec): Promise<QuerySpec[]> {
  const targetLabel = labelOf(spec.target, "target");
  const protectLabel = labelOf(spec.protect, squash(spec.crop ?? "") || "protected");
  const described = [
    `Working environment: ${squash(spec.crop ?? "") || "unspecified"}.`,
    `TARGET — the machine should act on: ${targetLabel}` +
      (spec.target?.names?.length ? ` (also called: ${spec.target.names.join(", ")})` : "") + ".",
    `PROTECTED — the machine must not touch: ${protectLabel}` +
      (spec.protect?.names?.length ? ` (also called: ${spec.protect.names.join(", ")})` : "") + ".",
    spec.region_hint ? `Location: ${squash(spec.region_hint)}.` : "",
    `Task type: ${spec.template}.`,
  ].filter(Boolean).join("\n");

  let got: z.infer<typeof Lookalikes>;
  try {
    got = await structured({
      schema: Lookalikes,
      name: "submit_lookalikes",
      description: "Submit the look-alikes to collect photographs of.",
      instructions: LOOKALIKE_INSTRUCTIONS,
      prompt: described,
    });
  } catch (err) {
    console.warn("[curator] look-alike planning failed:", (err as Error).message);
    return [];
  }

  const labelFor = (k: ClassKey) => (k === "target" ? targetLabel : protectLabel);
  const out: QuerySpec[] = [];
  for (const l of got.lookalikes ?? []) {
    const name = squash(l.name ?? "");
    const query = squash(l.image_query ?? "");
    const trueClass = l.true_class as ClassKey;
    const confusable = l.confusable_with as ClassKey;
    // a thing "confusable with" its own class is a contradiction, not a hard
    // negative — drop it rather than poison the training set
    if (!name || !query || query.length < 6) continue;
    if (trueClass !== "target" && trueClass !== "protect") continue;
    if (confusable !== "target" && confusable !== "protect") continue;
    if (trueClass === confusable) continue;
    out.push({
      query,
      classKey: trueClass,
      classLabel: labelFor(trueClass),
      // the verifier is asked about the look-alike itself, against the class it
      // is confused with: "is this a strawberry runner, or a weed?" Asking
      // "is this <the class label>?" would get every one of them rejected.
      qaLabel: name,
      lookalike: { name, confusableWith: confusable, why: squash(l.why ?? "") },
    });
  }
  return uniqBy(out, (q) => queryKey(q.query)).slice(0, HARD_NEGATIVE_QUERIES);
}

/* ── 1c. train / val / pool split ─────────────────────────────────────── */

/** Exact per-class counts for one class of n images: val ≥ 25%, pool ≥ 25%, rest train. */
export function splitCounts(n: number): { train: number; val: number; pool: number } {
  if (n <= 0) return { train: 0, val: 0, pool: 0 };
  if (n < 3) return { train: n, val: 0, pool: 0 };   // too few to hold anything out
  const ceilShare = (s: number) => Math.ceil(n * s);
  // 25% of the class, topped up toward MIN_VAL_PER_CLASS but never past MAX_VAL_SHARE
  let val = Math.max(ceilShare(VAL_SHARE), Math.min(MIN_VAL_PER_CLASS, Math.floor(n * MAX_VAL_SHARE)));
  let pool = ceilShare(POOL_SHARE);
  // the probe still has to be fit: never hold out so much that train drops
  // below ~40% of the class (this only ever bites on tiny classes)
  const maxHeldOut = Math.max(2, n - Math.max(1, Math.round(n * 0.4)));
  while (val + pool > maxHeldOut) {
    if (pool > 1 && pool >= val) pool--;
    else if (val > 1) val--;
    else break;
  }
  // the pool feeds the simulator and needs both classes present, so it keeps
  // at least one image; training keeps at least one too
  pool = Math.max(1, Math.min(pool, n - val - 1));
  val = Math.max(1, Math.min(val, n - pool - 1));
  return { train: n - val - pool, val, pool };
}

/**
 * Deterministic split labels for a class of n images, in the caller's order.
 * Largest-remainder assignment: each position goes to whichever split is
 * furthest behind its quota, so val and pool are spread evenly through the
 * (hash-ordered, i.e. query-agnostic) list instead of being a contiguous tail
 * that could come from one or two queries.
 */
export function assignSplits(n: number): Split[] {
  const counts = splitCounts(n);
  const quota: Array<[Split, number]> = [
    ["train", counts.train], ["val", counts.val], ["pool", counts.pool],
  ];
  const given: Record<string, number> = { train: 0, val: 0, pool: 0 };
  const out: Split[] = [];
  for (let i = 0; i < n; i++) {
    let best: Split = "train";
    let bestDeficit = -Infinity;
    for (const [s, q] of quota) {
      if (q <= 0 || given[s] >= q) continue;
      const deficit = (q / n) * (i + 1) - given[s];
      if (deficit > bestDeficit) { bestDeficit = deficit; best = s; }
    }
    given[best]++;
    out.push(best);
  }
  return out;
}

/* ── 2. byte work (sharp) ─────────────────────────────────────────────── */

/**
 * Perceptual-ish hash: 16×16 grayscale, sha256 of the raw pixels. Two copies of
 * the same photo at different sizes/encodings collapse to one row (there is a
 * unique index on (mission_id, img_hash)).
 */
async function perceptualHash(bytes: Buffer): Promise<string> {
  const raw = await sharp(bytes)
    .resize(16, 16, { fit: "fill" })
    .grayscale()
    .raw()
    .toBuffer();
  return createHash("sha256").update(raw).digest("hex");
}

async function prepare(
  c: Candidate,
  bytes: Buffer,
  prov: { zone: string; sha256: string; contentType: string; fetchedAt: Date },
): Promise<Prepared | null> {
  const meta = await sharp(bytes).metadata();
  const w = meta.width ?? 0;
  const h = meta.height ?? 0;
  if (w < MIN_SIDE_PX || h < MIN_SIDE_PX) return null;

  const [imgHash, thumb, qa, sandboxBytes] = await Promise.all([
    perceptualHash(bytes),
    sharp(bytes).resize(THUMB_PX, THUMB_PX, { fit: "cover" }).webp({ quality: 80 }).toBuffer(),
    sharp(bytes)
      .resize({ width: visionMaxPx(), height: visionMaxPx(), fit: "inside", withoutEnlargement: true })
      .webp({ quality: 70 })
      .toBuffer(),
    sharp(bytes)
      .resize({ width: SANDBOX_PX, height: SANDBOX_PX, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 85 })
      .toBuffer(),
  ]);

  return {
    ...c,
    id: newId("dataset_item"),
    imgHash,
    thumb,
    // the verifier gets bytes we already hold: no hotlink, no full-res tokens
    qaDataUrl: `data:image/webp;base64,${qa.toString("base64")}`,
    sandboxBytes,
    // provenance of the ORIGINAL bytes — the thumbnail, the QA copy and the
    // sandbox copy are all derived from exactly these
    zone: prov.zone,
    bytesSha256: prov.sha256,
    bytesLen: bytes.length,
    contentType: prov.contentType,
    fetchedAt: prov.fetchedAt,
  };
}

/* ── 3. the agent ─────────────────────────────────────────────────────── */

export async function runCurator(opts: {
  missionId: string;
  taskSpec: TaskSpec;
  onEvent?: CuratorOnEvent;
}): Promise<CuratorResult> {
  const { missionId, taskSpec, onEvent } = opts;

  const emit = async (e: {
    kind: CuratorEvent["kind"];
    title: string;
    payload?: Record<string, unknown>;
    refTable?: string | null;
    refId?: string | null;
  }): Promise<void> => {
    const row: CuratorEvent = {
      id: newId("event"),
      missionId,
      agent: "curator",
      kind: e.kind,
      title: e.title,
      payload: e.payload ?? {},
      refTable: e.refTable ?? null,
      refId: e.refId ?? null,
    };
    try {
      await db.insert(schema.agentEvents).values(row);
    } catch (err) {
      console.warn("[curator] agent_events insert failed:", (err as Error).message);
    }
    try {
      await onEvent?.(row);
    } catch (err) {
      console.warn("[curator] onEvent threw:", (err as Error).message);
    }
  };

  const budgetLeft = () => REQUEST_BUDGET - spendSoFar(missionId) - BUDGET_RESERVE;
  let budgetHit = false;

  const targetLabel = labelOf(taskSpec.target, "weed");
  const protectLabel = labelOf(taskSpec.protect, squash(taskSpec.crop ?? "") || "crop");
  const classes: Record<string, string> = {
    target: clipName(taskSpec.target, "weed"),
    protect: clipName(taskSpec.protect, squash(taskSpec.crop ?? "") || "crop"),
  };

  /* ── plan ── */
  const baseQueries = planImageQueries(taskSpec);
  await emit({
    kind: "plan",
    title: `Planned ${baseQueries.length} image searches (${targetLabel} vs ${protectLabel})`,
    payload: {
      via: "serp_images",
      queries: baseQueries.map((q) => ({ query: q.query, class_key: q.classKey })),
    },
  });

  /* ── plan the look-alikes (hard negatives) ── */
  const hardQueries = await planHardNegativeQueries(taskSpec);
  if (hardQueries.length) {
    await emit({
      kind: "plan",
      title: `Mining ${hardQueries.length} look-alikes that break the easy boundary: ` +
        hardQueries.map((q) => q.lookalike?.name).filter(Boolean).join(", "),
      payload: {
        via: "serp_images",
        hard_negatives: hardQueries.map((q) => ({
          name: q.lookalike?.name,
          query: q.query,
          labelled_as: q.classKey,
          confusable_with: q.lookalike?.confusableWith,
          why: q.lookalike?.why,
        })),
        cap_images: MAX_HARD_NEGATIVES,
      },
    });
  } else {
    await emit({
      kind: "decision",
      title: "No look-alikes could be derived for this task — dataset is the plain searches only",
      payload: { via: "serp_images", hard_negatives: 0 },
    });
  }
  // a look-alike query that duplicates a plain one is not a hard negative —
  // the plain one wins, so the flag never gets attached to ordinary images
  const queries = uniqBy([...baseQueries, ...hardQueries], (q) => queryKey(q.query));

  /* ── image SERP ── */
  const found: Candidate[] = [];
  await mapLimit(queries, SERP_CONCURRENCY, async (q) => {
    if (budgetHit || budgetLeft() <= 0) { budgetHit = true; return; }
    try {
      const { images, cached, sourceId } = await searchImages({
        query: q.query, missionId, limit: SERP_IMAGES_PER_QUERY,
      });
      const take = images.slice(0, TAKE_PER_QUERY);
      for (const im of take) {
        found.push({ ...q, url: im.url, pageUrl: im.pageUrl, serpSourceId: sourceId });
      }
      await emit({
        kind: "search",
        title: `Image search "${q.query}"${q.lookalike ? " [look-alike]" : ""} — ` +
          `${images.length} hits`,
        payload: {
          via: "serp_images", query: q.query, class_key: q.classKey,
          hits: images.length, taken: take.length, cached,
          hard_negative: Boolean(q.lookalike),
          lookalike_name: q.lookalike?.name ?? null,
        },
        refTable: "sources",
        refId: sourceId,
      });
    } catch (err) {
      if (err instanceof BudgetExceeded) budgetHit = true;
      await emit({
        kind: "error",
        title: `Image search failed: ${q.query}`,
        payload: { via: "serp_images", query: q.query, error: (err as Error).message },
      });
    }
  });

  /* ── choose what to download (per-class caps, interleaved by query) ── */
  const caps: Record<ItemClassKey, number> = {
    target: MAX_PER_CLASS, protect: MAX_PER_CLASS, background: MAX_BACKGROUND,
  };
  const byUrl = uniqBy(found, (c) => c.url);
  const picked: Candidate[] = [];
  const perClass: Record<string, number> = { target: 0, protect: 0, background: 0 };
  /**
   * Look-alikes are counted and capped separately. If they shared the per-class
   * cap they would displace ordinary examples, and the comparison against the
   * old dataset would stop being a comparison — the plain part has to stay
   * exactly what it was.
   */
  let hardCount = 0;
  // round-robin over the queries so no single query dominates a class
  const buckets = new Map<string, Candidate[]>();
  for (const c of byUrl) {
    const list = buckets.get(c.query) ?? [];
    list.push(c);
    buckets.set(c.query, list);
  }
  for (let depth = 0; depth < TAKE_PER_QUERY; depth++) {
    for (const list of buckets.values()) {
      const c = list[depth];
      if (!c) continue;
      if (c.lookalike) {
        if (hardCount >= MAX_HARD_NEGATIVES) continue;
        hardCount++;
      } else {
        if (perClass[c.classKey] >= caps[c.classKey]) continue;
        perClass[c.classKey]++;
      }
      picked.push(c);
    }
  }
  const downloadBudget = Math.max(0, budgetLeft());
  const toDownload = picked.slice(0, downloadBudget);

  await emit({
    kind: "decision",
    title: `Downloading ${toDownload.length} images (${perClass.target} target / ` +
      `${perClass.protect} protect / ${perClass.background} background` +
      (hardCount ? ` / ${hardCount} look-alike` : "") + ")",
    payload: {
      via: "serp_images",
      candidates: byUrl.length,
      planned: toDownload.length,
      per_class: perClass,
      hard_negatives: hardCount,
      budget_left: downloadBudget,
    },
  });

  /* ── download through Unlocker, dedupe, derive thumb + QA bytes ── */
  const existing = await db
    .select({ imgHash: schema.datasetItems.imgHash })
    .from(schema.datasetItems)
    .where(eq(schema.datasetItems.missionId, missionId));
  const seenHashes = new Set<string>(existing.map((r) => r.imgHash));

  const prepared: Prepared[] = [];
  let rawCount = 0;
  let failed = 0;
  let dupes = 0;

  await mapLimit(toDownload, DOWNLOAD_CONCURRENCY, async (c) => {
    if (budgetHit) return;
    try {
      const got = await fetchImageBytes({ url: c.url, missionId });
      if (!got) { failed++; return; }
      rawCount++;
      const p = await prepare(c, got.bytes, {
        zone: got.zone, sha256: got.sha256,
        contentType: got.contentType, fetchedAt: got.fetchedAt,
      });
      if (!p) { failed++; return; }
      if (seenHashes.has(p.imgHash)) { dupes++; return; }
      seenHashes.add(p.imgHash);
      prepared.push(p);
    } catch (err) {
      if (err instanceof BudgetExceeded) { budgetHit = true; return; }
      failed++;
    }
  });

  await emit({
    kind: "download",
    title: `Fetched ${rawCount} images, kept ${prepared.length} unique (${dupes} duplicates, ${failed} unusable)`,
    payload: {
      via: "unlocker",
      fetched: rawCount, kept: prepared.length, duplicates: dupes, failed,
      budget_used: spendSoFar(missionId), budget: REQUEST_BUDGET,
    },
  });

  if (!prepared.length) {
    await emit({
      kind: "error",
      title: "No usable images were downloaded",
      payload: { via: "unlocker", budget_exhausted: budgetHit },
    });
    return { items: [], perceptionModel: null };
  }

  /* ── label QA (Gemini) ── */
  const otherOf = (k: ItemClassKey): string =>
    k === "target" ? protectLabel
      : k === "protect" ? targetLabel
        : `${targetLabel} or ${protectLabel}`;

  const checks: LabelCheck[] = prepared.map((p) => ({
    imageUrl: p.qaDataUrl,
    // a look-alike is verified as ITSELF against the class it gets mistaken
    // for ("is this a strawberry runner, or a weed?"). Asking "is this a weed?"
    // of a runner photo would reject every hard negative we just paid for.
    classLabel: p.qaLabel ?? p.classLabel,
    otherLabel: p.lookalike
      ? (p.lookalike.confusableWith === "target" ? targetLabel : protectLabel)
      : otherOf(p.classKey),
    lookalike: Boolean(p.lookalike),
  }));
  const verdicts = await verifyLabels(checks, visionConcurrency());

  const accepted: Prepared[] = [];
  const rejected: Prepared[] = [];
  const unchecked: Prepared[] = [];
  const verdictOf = new Map<string, { verified: boolean | null; note: string | null }>();
  prepared.forEach((p, i) => {
    const v = verdicts[i];
    verdictOf.set(p.id, { verified: v ? v.verified : null, note: v ? v.note : null });
    if (!v) unchecked.push(p);
    else if (v.verified) accepted.push(p);
    else rejected.push(p);
  });

  await emit({
    kind: "verify",
    title: verdicts.some(Boolean)
      ? `Label QA: ${accepted.length} verified, ${rejected.length} rejected` +
        (unchecked.length ? `, ${unchecked.length} unchecked` : "")
      : `Label QA skipped (vision QA not configured) — ${unchecked.length} images stored unverified`,
    payload: {
      verified: accepted.length, rejected: rejected.length, unchecked: unchecked.length,
      max_px: visionMaxPx(), concurrency: visionConcurrency(),
    },
  });

  /* ── split 50/25/25 per class (see VAL_SHARE) ── */
  // deterministic ordering: the hash is stable across reruns, unlike SERP order
  const trainable = [...accepted, ...unchecked]
    .filter((p) => p.classKey !== "background")
    .sort((a, b) => (a.classKey === b.classKey ? a.imgHash.localeCompare(b.imgHash) : a.classKey < b.classKey ? -1 : 1));

  const splitOf = new Map<string, Split>();
  /**
   * Plain images and look-alikes are split SEPARATELY, per class. Two reasons,
   * both load-bearing:
   *  · the plain splits stay byte-identical to what they would have been
   *    without any hard-negative mining, so the ablation in trainer/curate.py
   *    compares two probes on the same held-out images and not on two
   *    differently-shuffled datasets;
   *  · each held-out set then provably contains look-alikes (a single pooled
   *    split can put all of them in train by chance when there are few).
   */
  for (const key of ["target", "protect"] as ClassKey[]) {
    for (const hard of [false, true]) {
      const group = trainable.filter((p) => p.classKey === key && Boolean(p.lookalike) === hard);
      const labels = assignSplits(group.length);
      group.forEach((p, i) => splitOf.set(p.id, labels[i] ?? "train"));
    }
  }
  for (const p of rejected) splitOf.set(p.id, "rejected");
  // background distractors: kept out of the probe entirely; rejected only when
  // the verifier says they are not background at all.
  for (const p of [...accepted, ...unchecked].filter((x) => x.classKey === "background")) {
    splitOf.set(p.id, "pool");
  }

  const items: CuratorItem[] = prepared.map((p) => {
    const v = verdictOf.get(p.id) ?? { verified: null, note: null };
    const isRejected = v.verified === false;
    return {
      id: p.id,
      imageUrl: p.url,
      imgHash: p.imgHash,
      classKey: p.classKey,
      classLabel: p.classLabel,
      labelSource: p.lookalike
        ? "serp_images:hard_negative"
        : p.classKey === "background" ? "serp_images:background" : "serp_images",
      verified: v.verified,
      verifierNote: v.note,
      split: splitOf.get(p.id) ?? (isRejected ? "rejected" : null),
      query: p.query,
      hardNegative: Boolean(p.lookalike),
      lookalikeOf: p.lookalike?.confusableWith ?? null,
      lookalikeName: p.lookalike?.name ?? null,
      pageUrl: p.pageUrl ?? null,
      serpSourceId: p.serpSourceId ?? null,
      zone: p.zone,
      bytesSha256: p.bytesSha256,
      bytesLen: p.bytesLen,
      contentType: p.contentType,
      fetchedAt: p.fetchedAt,
    };
  });

  /* ── persist dataset_items ── */
  const thumbOf = new Map(prepared.map((p) => [p.id, p.thumb] as const));
  const inserted = new Set<string>();
  for (let i = 0; i < items.length; i += 50) {
    const chunk = items.slice(i, i + 50);
    try {
      const rows = await db
        .insert(schema.datasetItems)
        .values(chunk.map((it) => ({
          id: it.id,
          missionId,
          // the image-SERP row that surfaced it: the first link of the chain
          sourceId: it.serpSourceId,
          imageUrl: it.imageUrl,
          imgHash: it.imgHash,
          thumb: thumbOf.get(it.id) ?? null,
          classKey: it.classKey,
          classLabel: it.classLabel,
          labelSource: it.labelSource,
          verified: it.verified,
          verifierNote: it.verifierNote,
          split: it.split,
          query: it.query,
          pageUrl: it.pageUrl,
          zone: it.zone,
          bytesSha256: it.bytesSha256,
          bytesLen: it.bytesLen,
          contentType: it.contentType,
          fetchedAt: it.fetchedAt,
          hardNegative: it.hardNegative,
          lookalikeOf: it.lookalikeOf,
          lookalikeName: it.lookalikeName,
        })))
        .onConflictDoNothing({
          target: [schema.datasetItems.missionId, schema.datasetItems.imgHash],
        })
        .returning({ id: schema.datasetItems.id });
      for (const r of rows) inserted.add(r.id);
    } catch (err) {
      await emit({
        kind: "error",
        title: "Could not store some dataset items",
        payload: { error: (err as Error).message, chunk: chunk.length },
      });
    }
  }

  const nTrain = items.filter((i) => i.split === "train" && i.classKey !== "background").length;
  const nVal = items.filter((i) => i.split === "val" && i.classKey !== "background").length;
  const nPool = items.filter((i) => i.split === "pool" && i.classKey !== "background").length;
  const hardKept = items.filter((i) => i.hardNegative && i.split !== "rejected");
  const hardBySplit = {
    train: hardKept.filter((i) => i.split === "train").length,
    val: hardKept.filter((i) => i.split === "val").length,
    pool: hardKept.filter((i) => i.split === "pool").length,
  };
  await emit({
    kind: "split",
    title:
      `Dataset: ${nTrain} train / ${nVal} val / ${nPool} pool, ${rejected.length} rejected` +
      (nTrain + nVal + nPool > 0
        ? ` (val ${Math.round((100 * nVal) / (nTrain + nVal + nPool))}% of labelled)`
        : "") +
      (hardKept.length
        ? ` · ${hardKept.length} look-alikes (${hardBySplit.train} train / ` +
          `${hardBySplit.val} val / ${hardBySplit.pool} pool)`
        : ""),
    payload: {
      via: "serp_images",
      n_train: nTrain, n_val: nVal, n_pool: nPool, n_rejected: rejected.length,
      stored: inserted.size, classes,
      hard_negatives: hardKept.length,
      hard_negatives_by_split: hardBySplit,
      hard_negatives_rejected:
        items.filter((i) => i.hardNegative && i.split === "rejected").length,
      lookalikes: [...new Set(hardKept.map((i) => i.lookalikeName).filter(Boolean))],
      val_share: nTrain + nVal + nPool > 0
        ? Number((nVal / (nTrain + nVal + nPool)).toFixed(3))
        : 0,
      pool_share: nTrain + nVal + nPool > 0
        ? Number((nPool / (nTrain + nVal + nPool)).toFixed(3))
        : 0,
      target_val_share: VAL_SHARE,
      min_val_per_class: MIN_VAL_PER_CLASS,
    },
  });

  /* ── perception: CLIP + probe in Daytona (bytes uploaded from here) ── */
  // Gate on HOLDING THE BYTES, not on the insert's RETURNING set: with
  // onConflictDoNothing only newly inserted rows come back, so an image whose
  // db row collided was dropped from the sandbox batch even though we had its
  // bytes — that silently cut 62 usable images down to 5.
  const bytesOf = new Map(prepared.map((p) => [p.id, p.sandboxBytes] as const));
  const forSandbox = items.filter(
    (it) =>
      it.classKey !== "background" &&
      (it.split === "train" || it.split === "val" || it.split === "pool") &&
      (bytesOf.get(it.id)?.length ?? 0) > 0,
  );

  if (forSandbox.length < MIN_FOR_SANDBOX) {
    await emit({
      kind: "error",
      title: `Only ${forSandbox.length} usable images — skipping perception (needs ${MIN_FOR_SANDBOX})`,
      payload: { usable: forSandbox.length, needed: MIN_FOR_SANDBOX },
    });
    return { items, perceptionModel: null };
  }

  const jobParsed = SandboxJob.safeParse({
    job: "curate",
    mission_id: missionId,
    classes,
    dataset: forSandbox.map((it) => ({
      id: it.id,
      image_url: it.imageUrl,
      class_key: it.classKey as ClassKey,
      split: it.split as "train" | "val" | "pool",
      // curate.py runs the probe twice — with and without these — and reports
      // both numbers on the same held-out images
      hard_negative: it.hardNegative,
      lookalike_of: it.lookalikeOf,
    })),
  });
  if (!jobParsed.success) {
    await emit({
      kind: "error",
      title: "Curate job failed contract validation",
      payload: { error: jobParsed.error.message.slice(0, 400) },
    });
    return { items, perceptionModel: null };
  }

  const images = forSandbox.map((it) => ({
    id: it.id,
    bytes: bytesOf.get(it.id) ?? Buffer.alloc(0),
    ext: "jpg",
  })).filter((im) => im.bytes.length > 0);

  await emit({
    kind: "perceive",
    title: `Uploading ${images.length} images to the sandbox and fitting CLIP + probe`,
    payload: {
      images: images.length,
      bytes: images.reduce((a, b) => a + b.bytes.length, 0),
      arch: "clip-vitb32+logreg",
    },
  });

  let metricsRaw: Record<string, unknown> | null = null;
  try {
    const res = await runCurate({ missionId, job: jobParsed.data, images });
    metricsRaw = res.metrics;
    if (!metricsRaw) {
      await emit({
        kind: "error",
        title: "Perception run produced no metrics",
        payload: { log: (res.log ?? "").slice(-600) },
      });
    }
  } catch (err) {
    await emit({
      kind: "error",
      title: "Perception run failed",
      payload: { error: (err as Error).message },
    });
  }
  if (!metricsRaw) return { items, perceptionModel: null };

  const parsed = PerceptionMetrics.safeParse(metricsRaw);
  if (!parsed.success) {
    await emit({
      kind: "error",
      title: "Perception metrics failed contract validation",
      payload: { error: parsed.error.message.slice(0, 400), raw: metricsRaw },
    });
    return { items, perceptionModel: null };
  }

  const poolArtifactId =
    typeof metricsRaw.pool_artifact_id === "string" ? metricsRaw.pool_artifact_id : null;
  /**
   * Fields curate.py reports that PerceptionMetrics (owned elsewhere) does not
   * declare: safeParse strips them, so they are carried alongside the strict
   * parse into the stored jsonb and the event payload. Additive only — nothing
   * here is required for the parse to succeed.
   *  · probe_acc_ci_low/high — 95% Wilson interval, so the UI can print
   *    "100% (77–100%)" instead of a bare 100% measured on 13 images;
   *  · pool_separation — mean p_target gap the policy is handed;
   *  · pool_overlap — share of pool images in the ambiguous [0.4, 0.6] band:
   *    high means the policy is being fed mush.
   */
  const EXTRA_NUMERIC = [
    "probe_acc_ci_low", "probe_acc_ci_high", "probe_acc_n",
    "pool_separation", "pool_overlap", "probe_C",
    "probe_acc_plain_val", "n_hard_negatives",
  ] as const;
  const EXTRA_STRING = ["p_target_mapping", "probe_acc_on", "tta"] as const;
  const extras: Record<string, unknown> = {};
  for (const k of EXTRA_NUMERIC) {
    if (typeof metricsRaw[k] === "number") extras[k] = metricsRaw[k];
  }
  for (const k of EXTRA_STRING) {
    if (typeof metricsRaw[k] === "string") extras[k] = metricsRaw[k];
  }
  if (Array.isArray(metricsRaw.pool_ambiguous_band)) {
    extras.pool_ambiguous_band = metricsRaw.pool_ambiguous_band;
  }
  /**
   * The hard-negative ablation: two probes (with and without the mined
   * look-alikes) scored on the SAME held-out images. Carried through verbatim
   * so the observability API can show the before/after a judge asks for —
   * including when the delta is negative, which is reported, not hidden.
   */
  if (metricsRaw.hard_negative_ablation && typeof metricsRaw.hard_negative_ablation === "object") {
    extras.hard_negative_ablation = metricsRaw.hard_negative_ablation;
  }
  const ciLow = typeof extras.probe_acc_ci_low === "number" ? extras.probe_acc_ci_low : null;
  const ciHigh = typeof extras.probe_acc_ci_high === "number" ? extras.probe_acc_ci_high : null;
  const ciText =
    ciLow !== null && ciHigh !== null
      ? ` [95% CI ${(ciLow * 100).toFixed(0)}–${(ciHigh * 100).toFixed(0)}%, n=${
          typeof extras.probe_acc_n === "number" ? extras.probe_acc_n : parsed.data.n_val
        }]`
      : "";

  const perceptionModel: CuratorPerceptionModel = {
    id: newId("perception_model"),
    arch: "clip-vitb32+logreg",
    classes,
    metrics: parsed.data,
    poolArtifactId,
  };

  try {
    await db.insert(schema.perceptionModels).values({
      id: perceptionModel.id,
      missionId,
      arch: perceptionModel.arch,
      classes,
      metrics: { ...parsed.data, ...extras },
      poolArtifactId,
      modelArtifactId: null,
    });
  } catch (err) {
    await emit({
      kind: "error",
      title: "Could not store the perception model",
      payload: { error: (err as Error).message },
    });
    return { items, perceptionModel: null };
  }

  /* ── the look-alike ablation, reported whichever way it came out ── */
  const ab = extras.hard_negative_ablation as {
    n_hard_train?: number; n_hard_val?: number;
    before?: { lookalike_val?: { acc?: number; n?: number }; plain_val?: { acc?: number }; pool_separation?: number };
    after?: { lookalike_val?: { acc?: number; n?: number }; plain_val?: { acc?: number }; pool_separation?: number };
    delta?: { lookalike_val_acc?: number | null; plain_val_acc?: number | null; pool_separation?: number | null };
  } | undefined;
  if (ab?.before && ab?.after) {
    const pct = (v: number | undefined | null) =>
      typeof v === "number" ? `${(v * 100).toFixed(1)}%` : "—";
    const signed = (v: number | null | undefined, scale = 100, unit = " pts") =>
      typeof v === "number" ? `${v >= 0 ? "+" : ""}${(v * scale).toFixed(1)}${unit}` : "—";
    const dLook = ab.delta?.lookalike_val_acc ?? null;
    await emit({
      kind: "decision",
      title:
        `Look-alike ablation (${ab.n_hard_train ?? 0} mined into train, ` +
        `${ab.n_hard_val ?? 0} held out): accuracy on look-alikes ` +
        `${pct(ab.before.lookalike_val?.acc)} → ${pct(ab.after.lookalike_val?.acc)} ` +
        `(${signed(dLook)}), on plain images ${pct(ab.before.plain_val?.acc)} → ` +
        `${pct(ab.after.plain_val?.acc)} (${signed(ab.delta?.plain_val_acc)})` +
        (typeof dLook === "number" && dLook <= 0
          ? " — no gain on this dataset, reported as measured"
          : ""),
      payload: {
        via: "serp_images",
        hard_negative_ablation: ab,
        lookalikes: [...new Set(hardKept.map((i) => i.lookalikeName).filter(Boolean))],
      },
      refTable: "perception_models",
      refId: perceptionModel.id,
    });
  }

  await emit({
    kind: "report",
    title:
      `Perception ready: zero-shot ${(parsed.data.zero_shot_acc * 100).toFixed(1)}% → ` +
      `probe ${(parsed.data.probe_acc * 100).toFixed(1)}%${ciText} ` +
      `(${parsed.data.n_train} train / ${parsed.data.n_val} val / ${parsed.data.n_pool} pool` +
      (typeof extras.pool_overlap === "number"
        ? `, pool overlap ${((extras.pool_overlap as number) * 100).toFixed(0)}%`
        : "") +
      `)`,
    payload: {
      via: "serp_images",
      metrics: { ...parsed.data, ...extras },
      pool_artifact_id: poolArtifactId,
      hard_negatives: hardKept.length,
      budget_used: spendSoFar(missionId),
      budget: REQUEST_BUDGET,
    },
    refTable: "perception_models",
    refId: perceptionModel.id,
  });

  return { items, perceptionModel };
}

/* ── 4. resume: re-fit perception from images we already paid for ─────── */

/** The CLIP class prompts for this task, exactly as runCurator derives them. */
export function clipClasses(taskSpec: TaskSpec): Record<string, string> {
  return {
    target: clipName(taskSpec.target, "weed"),
    protect: clipName(taskSpec.protect, squash(taskSpec.crop ?? "") || "crop"),
  };
}

/**
 * Fit CLIP + probe from the dataset_items ALREADY in Postgres.
 *
 * Why this exists: a mission killed during `curate` typically has hundreds of
 * images stored (each one an image-SERP hit plus an Unlocker download that was
 * already billed) and no perception model, because the model is fitted at the
 * very end of the stage from bytes held in memory. Re-running runCurator would
 * re-issue every one of those requests. The 128 px thumbnails are durable, so
 * the probe can be re-fitted from them instead: zero Bright Data requests, one
 * sandbox.
 *
 * HONESTY: 128 px thumbnails are a lossy input compared with the 512 px bytes
 * the first pass uploads, so the resulting accuracy is not identical to an
 * uninterrupted run. The perception_models row and the agent event both record
 * `refit_from: "stored_thumbnails_128px"`, so no number from this path can be
 * mistaken for a fresh fit.
 */
export async function refitPerceptionFromStored(opts: {
  missionId: string;
  taskSpec: TaskSpec;
  onEvent?: CuratorOnEvent;
}): Promise<CuratorPerceptionModel | null> {
  const { missionId, taskSpec } = opts;
  const emit = async (e: { kind: CuratorEvent["kind"]; title: string; payload?: Record<string, unknown>; refTable?: string | null; refId?: string | null }) => {
    const row: CuratorEvent = {
      id: newId("event"), missionId, agent: "curator", kind: e.kind, title: e.title,
      payload: e.payload ?? {}, refTable: e.refTable ?? null, refId: e.refId ?? null,
    };
    try { await db.insert(schema.agentEvents).values(row); }
    catch (err) { console.warn("[curator] agent_events insert failed:", (err as Error).message); }
    try { await opts.onEvent?.(row); } catch { /* the trace is for humans */ }
  };

  const rows = await db
    .select({
      id: schema.datasetItems.id,
      classKey: schema.datasetItems.classKey,
      split: schema.datasetItems.split,
      imageUrl: schema.datasetItems.imageUrl,
      thumb: schema.datasetItems.thumb,
    })
    .from(schema.datasetItems)
    .where(and(
      eq(schema.datasetItems.missionId, missionId),
      isNotNull(schema.datasetItems.thumb),
      inArray(schema.datasetItems.split, ["train", "val", "pool"]),
    ));

  const usable = rows.filter(
    (r) => r.classKey !== "background" && (r.thumb?.length ?? 0) > 0,
  );
  if (usable.length < MIN_FOR_SANDBOX) {
    await emit({
      kind: "error",
      title: `Only ${usable.length} stored images — cannot re-fit perception (needs ${MIN_FOR_SANDBOX})`,
      payload: { stored: rows.length, usable: usable.length, needed: MIN_FOR_SANDBOX },
    });
    return null;
  }

  const classes = clipClasses(taskSpec);
  const jobParsed = SandboxJob.safeParse({
    job: "curate",
    mission_id: missionId,
    classes,
    dataset: usable.map((r) => ({
      id: r.id,
      image_url: r.imageUrl,
      class_key: r.classKey as ClassKey,
      split: r.split as "train" | "val" | "pool",
    })),
  });
  if (!jobParsed.success) {
    await emit({
      kind: "error", title: "Re-fit curate job failed contract validation",
      payload: { error: jobParsed.error.message.slice(0, 400) },
    });
    return null;
  }

  // thumbnails are webp; curate.py reads them through PIL, and jpeg is the
  // format the fresh path already uploads, so convert rather than assume.
  const images: { id: string; bytes: Buffer; ext: string }[] = [];
  for (const r of usable) {
    try {
      images.push({ id: r.id, bytes: await sharp(r.thumb as Buffer).jpeg({ quality: 90 }).toBuffer(), ext: "jpg" });
    } catch { /* a corrupt thumbnail is skipped, never guessed at */ }
  }
  if (images.length < MIN_FOR_SANDBOX) {
    await emit({
      kind: "error",
      title: `Only ${images.length} thumbnails decoded — cannot re-fit perception`,
      payload: { usable: usable.length, decoded: images.length },
    });
    return null;
  }

  await emit({
    kind: "perceive",
    title: `Re-fitting CLIP + probe from ${images.length} images already in Postgres (0 Bright Data requests)`,
    payload: {
      images: images.length, bytes: images.reduce((a, b) => a + b.bytes.length, 0),
      arch: "clip-vitb32+logreg", refit_from: "stored_thumbnails_128px",
      thumb_px: THUMB_PX, reused: true,
    },
  });

  let metricsRaw: Record<string, unknown> | null = null;
  try {
    const res = await runCurate({ missionId, job: jobParsed.data, images });
    metricsRaw = res.metrics;
    if (!metricsRaw) {
      await emit({ kind: "error", title: "Perception re-fit produced no metrics", payload: { log: (res.log ?? "").slice(-600) } });
    }
  } catch (err) {
    await emit({ kind: "error", title: "Perception re-fit failed", payload: { error: (err as Error).message } });
  }
  if (!metricsRaw) return null;

  const parsed = PerceptionMetrics.safeParse(metricsRaw);
  if (!parsed.success) {
    await emit({
      kind: "error", title: "Perception re-fit metrics failed contract validation",
      payload: { error: parsed.error.message.slice(0, 400), raw: metricsRaw },
    });
    return null;
  }
  const poolArtifactId =
    typeof metricsRaw.pool_artifact_id === "string" ? metricsRaw.pool_artifact_id : null;

  const model: CuratorPerceptionModel = {
    id: newId("perception_model"),
    arch: "clip-vitb32+logreg",
    classes,
    metrics: parsed.data,
    poolArtifactId,
  };
  try {
    await db.insert(schema.perceptionModels).values({
      id: model.id, missionId, arch: model.arch, classes,
      metrics: { ...parsed.data, refit_from: "stored_thumbnails_128px", thumb_px: THUMB_PX },
      poolArtifactId, modelArtifactId: null,
    });
  } catch (err) {
    await emit({ kind: "error", title: "Could not store the re-fitted perception model", payload: { error: (err as Error).message } });
    return null;
  }

  await emit({
    kind: "report",
    title:
      `Perception re-fitted from stored images: zero-shot ${(parsed.data.zero_shot_acc * 100).toFixed(1)}% → ` +
      `probe ${(parsed.data.probe_acc * 100).toFixed(1)}% ` +
      `(${parsed.data.n_train} train / ${parsed.data.n_val} val / ${parsed.data.n_pool} pool)`,
    payload: {
      metrics: { ...parsed.data }, pool_artifact_id: poolArtifactId,
      refit_from: "stored_thumbnails_128px", brightdata_requests: 0,
    },
    refTable: "perception_models", refId: model.id,
  });
  return model;
}
