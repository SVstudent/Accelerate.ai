/**
 * Regional disagreement — a first-class signal, not a tie to be broken quietly.
 *
 * The Scout asks the same question through Bright Data's SERP zone from several
 * locales (`gl`/`hl`, see tools/brightdata.ts). Authorities in different
 * countries genuinely publish different numbers for the same quantity, because
 * their equipment, climate and regulations differ. The old behaviour — keep the
 * highest-confidence fact per key and drop the rest — hid that: the simulator
 * silently became "US-shaped" with no trace of the alternative.
 *
 * This module turns the same facts into a per-key comparison across regions. It
 * is deliberately domain-agnostic: it only reads `key`, `value`, `unit` and the
 * region tag, so it works the same whether the keys describe row spacing, ore
 * grade or pallet clearance.
 */

export type RegionalFactInput = {
  id?: string;
  key: string;
  /** number | [min, max] | string, as stored in facts.value */
  value: unknown;
  unit?: string | null;
  region?: string | null;
  confidence?: number | null;
  source_id?: string | null;
  source_url?: string | null;
  source_domain?: string | null;
  quote?: string | null;
};

export type RegionalValue = {
  region: string;
  /** scalar used for comparison (midpoint of a range) */
  value: number;
  /** the value as stored, so the UI can print "25–30 cm" not "27.5" */
  raw: unknown;
  unit: string | null;
  fact_id: string | null;
  source_url: string | null;
  source_domain: string | null;
  quote: string | null;
  confidence: number | null;
};

export type RegionalKey = {
  key: string;
  unit: string | null;
  regions: RegionalValue[];
  /** min and max across regions, and which region each came from */
  min: { region: string; value: number } | null;
  max: { region: string; value: number } | null;
  /** (max - min) / |mean| — 0 when every region agrees exactly */
  spread: number;
  /** true when the regions differ by more than DISAGREEMENT_SPREAD */
  disagrees: boolean;
};

/**
 * Relative spread above which regions are reported as disagreeing. 0.15 is a
 * judgement call, stated here rather than buried: two authorities quoting
 * 30 cm and 36 cm are describing the same practice, 30 cm and 90 cm are not.
 */
export const DISAGREEMENT_SPREAD = 0.15;

/** Scalar for comparison: a number as-is, a [min, max] range by its midpoint. */
export function scalarOf(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (
    Array.isArray(value) && value.length === 2 &&
    typeof value[0] === "number" && typeof value[1] === "number"
  ) {
    return (value[0] + value[1]) / 2;
  }
  return null;   // text-valued facts are not comparable numerically
}

/**
 * Group facts by key, keep the most confident fact per (key, region), and
 * measure the spread across regions. Keys answered from only one region are
 * still returned (with disagrees=false) so the UI can show coverage honestly.
 */
export function regionalConsensus(facts: RegionalFactInput[]): RegionalKey[] {
  const byKey = new Map<string, Map<string, RegionalValue>>();

  for (const f of facts) {
    const region = (f.region ?? "").trim().toLowerCase();
    if (!region) continue;                       // untargeted fetch: nothing to compare
    const scalar = scalarOf(f.value);
    if (scalar === null) continue;
    const perRegion = byKey.get(f.key) ?? new Map<string, RegionalValue>();
    const prev = perRegion.get(region);
    const conf = typeof f.confidence === "number" ? f.confidence : 0.7;
    if (prev && (prev.confidence ?? 0.7) >= conf) {
      perRegion.set(region, prev);
    } else {
      perRegion.set(region, {
        region,
        value: scalar,
        raw: f.value,
        unit: f.unit ?? null,
        fact_id: f.id ?? null,
        source_url: f.source_url ?? null,
        source_domain: f.source_domain ?? null,
        quote: f.quote ?? null,
        confidence: conf,
      });
    }
    byKey.set(f.key, perRegion);
  }

  const out: RegionalKey[] = [];
  for (const [key, perRegion] of byKey) {
    const regions = [...perRegion.values()].sort((a, b) => a.region.localeCompare(b.region));
    const values = regions.map((r) => r.value);
    const lo = Math.min(...values);
    const hi = Math.max(...values);
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const spread = Math.abs(mean) > 1e-9 ? (hi - lo) / Math.abs(mean) : 0;
    out.push({
      key,
      unit: regions.find((r) => r.unit)?.unit ?? null,
      regions,
      min: regions.length ? { region: regions[values.indexOf(lo)].region, value: lo } : null,
      max: regions.length ? { region: regions[values.indexOf(hi)].region, value: hi } : null,
      spread: Number(spread.toFixed(4)),
      disagrees: regions.length > 1 && spread > DISAGREEMENT_SPREAD,
    });
  }
  // the loudest disagreements first — that is what a reviewer wants to see
  return out.sort((a, b) =>
    Number(b.disagrees) - Number(a.disagrees) ||
    b.regions.length - a.regions.length ||
    b.spread - a.spread);
}

/** One-line summary per disagreeing key, for an agent event title. */
export function describeDisagreement(k: RegionalKey): string {
  const fmt = (v: RegionalValue) =>
    `${v.region.toUpperCase()} ${Array.isArray(v.raw) ? (v.raw as number[]).join("–") : v.value}` +
    (k.unit ? ` ${k.unit}` : "");
  const sorted = [...k.regions].sort((a, b) => a.value - b.value);
  return `${k.key}: ${sorted.map(fmt).join(" vs ")} (${Math.round(k.spread * 100)}% apart)`;
}
