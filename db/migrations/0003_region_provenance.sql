-- Furrow · 0003 — multi-region SERP + a verifiable Bright Data provenance chain
--
-- Two additions, both additive (every column is nullable or defaulted, so an
-- already-running mission keeps working against this schema):
--
-- 1. REGION. Bright Data's SERP zone accepts Google's own locale targeting
--    (gl = country, hl = UI language). The same question answered from a US
--    extension service and a UK one does not always give the same number, and
--    silently keeping whichever came back first is a lie by omission. So the
--    region a result was retrieved from is stored on the source and copied onto
--    every fact extracted from it, and the API reports per-key disagreement as
--    a signal instead of collapsing it.
--
-- 2. PROVENANCE. A judge should be able to click any training image or any
--    number in the reward and see exactly where the bytes came from: the URL,
--    the Bright Data zone that retrieved them, when, the SHA-256 of what came
--    back, and the page's own published/modified date when the page states one.
--    sources.fetched_at and dataset_items.created_at already existed; the rest
--    did not, and dataset_items did not even keep the SERP query or the page an
--    image was found on.

-- ── 1. region ─────────────────────────────────────────────────────────────
alter table sources add column if not exists region text;        -- 'us' | 'gb' | …  (Google gl)
alter table sources add column if not exists region_lang text;   -- 'en' | 'de' | …  (Google hl)
alter table facts   add column if not exists region text;         -- copied from the source

create index if not exists sources_mission_region_idx on sources (mission_id, region);
-- the regional-disagreement query: every fact for one key, grouped by region
create index if not exists facts_mission_key_region_idx on facts (mission_id, key, region);

-- ── 2. provenance chain ───────────────────────────────────────────────────
-- which Bright Data zone retrieved it (serp / unlocker zone name, never a key)
alter table sources add column if not exists zone text;
-- sha256 of the bytes Bright Data returned, before any truncation or compaction
alter table sources add column if not exists content_sha256 text;
alter table sources add column if not exists content_bytes int;
-- the page's own date, when it states one, plus the raw string we parsed it from
alter table sources add column if not exists page_published_at timestamptz;
alter table sources add column if not exists page_published_raw text;

alter table dataset_items add column if not exists query text;          -- the image SERP query
alter table dataset_items add column if not exists page_url text;       -- page the image was found on
alter table dataset_items add column if not exists zone text;           -- Unlocker zone that fetched the bytes
alter table dataset_items add column if not exists bytes_sha256 text;   -- sha256 of the ORIGINAL bytes
alter table dataset_items add column if not exists bytes_len int;
alter table dataset_items add column if not exists content_type text;
alter table dataset_items add column if not exists fetched_at timestamptz;

-- ── 3. hard negatives ─────────────────────────────────────────────────────
-- A look-alike mined on purpose: visually confusable with the other class, but
-- labelled with the class it actually belongs to. `lookalike_of` records which
-- class it is confusable WITH, `lookalike_name` the entity the planner named.
alter table dataset_items add column if not exists hard_negative boolean not null default false;
alter table dataset_items add column if not exists lookalike_of text;
alter table dataset_items add column if not exists lookalike_name text;

create index if not exists dataset_items_mission_hardneg_idx
  on dataset_items (mission_id, hard_negative);
