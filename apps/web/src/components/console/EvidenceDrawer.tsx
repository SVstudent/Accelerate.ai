"use client";
/**
 * Evidence drawer (DESIGN.md §5) — the "show your work" surface.
 *
 * 520px right slide-over, three tabs:
 *   Sources   — grouped by domain, each with its Bright Data via tag, the query
 *               that found it, fact/image counts, and the markdown excerpt.
 *   Facts     — every EnvConfig parameter beside the fact that set it: value,
 *               ≤25-word quote, domain. Assumed parameters get a dashed outline.
 *   Dataset   — Target / Protect / Rejected thumbnails plus the perception
 *               before→after header and its confusion matrix.
 *
 * All of it comes from /api/missions/:id/evidence. Missing numbers render "—".
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { C } from "@/lib/colors";
import type { EnvConfig, Sourced } from "@/lib/contracts";
import type {
  EvidenceDatasetItem, EvidenceFact, EvidencePayload, EvidenceSource,
} from "@/app/api/missions/[id]/evidence/route";

export type EvidenceTab = "sources" | "facts" | "dataset";

const TABS: { key: EvidenceTab; label: string }[] = [
  { key: "sources", label: "Sources" },
  { key: "facts", label: "Facts → Environment" },
  { key: "dataset", label: "Dataset → Perception" },
];

const VIA_LABEL: Record<string, string> = {
  serp: "SERP", serp_images: "SERP images", unlocker: "Unlocker",
  scraper: "Scraper API", browser: "Browser API",
};

const EM_DASH = "—";

function pct(v: number | null | undefined): string {
  if (v === null || v === undefined || Number.isNaN(v)) return EM_DASH;
  return `${Math.round(v * 100)}%`;
}

function num(v: unknown, unit?: string | null): string {
  if (typeof v === "number") return unit ? `${v} ${unit}` : String(v);
  if (Array.isArray(v) && v.length === 2 && typeof v[0] === "number") {
    return unit ? `${v[0]}–${v[1]} ${unit}` : `${v[0]}–${v[1]}`;
  }
  if (typeof v === "string" && v.length) return v;
  return EM_DASH;
}

/** ≤ 25 words, as the contract promises; anything longer is clipped here too. */
function clip25(q: string | null | undefined): string | null {
  if (!q) return null;
  const words = q.trim().split(/\s+/);
  return words.length <= 25 ? q.trim() : words.slice(0, 25).join(" ") + "…";
}

function ViaTag({ via }: { via: string }) {
  return (
    <span
      className="chip num whitespace-nowrap"
      style={{ color: C.signal400, borderColor: `${C.signal400}66` }}
      title="fetched through Bright Data"
    >
      via Bright Data · {VIA_LABEL[via] ?? via}
    </span>
  );
}

/* ── Sources ──────────────────────────────────────────────────────────── */

function SourceRow({ s }: { s: EvidenceSource }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border-b" style={{ borderColor: C.soil800 }}>
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full text-left px-3 py-2 hover:bg-soil-800/60 transition-colors"
      >
        <div className="flex items-start gap-2">
          <span className="shrink-0 mt-0.5" style={{ color: C.chaff600 }}>
            {open ? "▾" : "▸"}
          </span>
          <div className="min-w-0 flex-1">
            <div className="truncate" style={{ color: C.chaff200 }}>
              {s.title || s.url}
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px]">
              <ViaTag via={s.via} />
              {s.query && (
                <span className="num truncate max-w-[260px]" style={{ color: C.chaff400 }}>
                  query: “{s.query}”
                </span>
              )}
              <span className="num" style={{ color: C.chaff600 }}>
                {s.fact_count} facts · {s.image_count} imgs
                {s.http_status ? ` · HTTP ${s.http_status}` : ""}
              </span>
            </div>
          </div>
        </div>
      </button>
      {open && (
        <div className="px-3 pb-3 pl-8">
          <a
            href={s.url}
            target="_blank"
            rel="noreferrer noopener"
            className="num text-[11px] underline break-all"
            style={{ color: C.sky400 }}
          >
            {s.url}
          </a>
          <pre
            className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap text-[11px] leading-relaxed p-2 rounded"
            style={{ background: C.soil950, color: C.chaff400, border: `1px solid ${C.soil800}` }}
          >
            {s.excerpt
              ? s.excerpt + (s.truncated ? "\n\n… excerpt truncated" : "")
              : "no markdown captured for this source"}
          </pre>
        </div>
      )}
    </div>
  );
}

function SourcesTab({ sources }: { sources: EvidenceSource[] }) {
  const groups = useMemo(() => {
    const byDomain = new Map<string, EvidenceSource[]>();
    for (const s of sources) {
      const key = s.domain ?? "unknown domain";
      const arr = byDomain.get(key) ?? [];
      arr.push(s);
      byDomain.set(key, arr);
    }
    return [...byDomain.entries()].sort((a, b) => b[1].length - a[1].length);
  }, [sources]);

  if (!sources.length) {
    return <Empty text="No sources fetched yet. The Scout writes them here as it reads." />;
  }

  return (
    <div>
      {groups.map(([domain, rows]) => (
        <section key={domain}>
          <header
            className="sticky top-0 z-10 px-3 py-1.5 flex items-center justify-between text-[11px] uppercase tracking-wider"
            style={{ background: C.soil900, borderBottom: `1px solid ${C.soil700}`, color: C.chaff400 }}
          >
            <span className="truncate">{domain}</span>
            <span className="num" style={{ color: C.chaff600 }}>
              {rows.length} page{rows.length === 1 ? "" : "s"}
            </span>
          </header>
          {rows.map((s) => <SourceRow key={s.id} s={s} />)}
        </section>
      ))}
    </div>
  );
}

/* ── Facts → Environment ──────────────────────────────────────────────── */

const ENV_PARAMS: { path: keyof EnvConfig["field"]; label: string; unit: string }[] = [
  { path: "row_spacing_m", label: "row_spacing_m", unit: "m" },
  { path: "in_row_spacing_m", label: "in_row_spacing_m", unit: "m" },
  { path: "crop_radius_m", label: "crop_radius_m", unit: "m" },
  { path: "root_zone_radius_m", label: "root_zone_radius_m", unit: "m" },
  { path: "weed_density_per_m2", label: "weed_density_per_m2", unit: "/m²" },
  { path: "weed_radius_m", label: "weed_radius_m", unit: "m" },
];

function isSourced(x: unknown): x is Sourced {
  return !!x && typeof x === "object" && "value" in (x as Record<string, unknown>);
}

function FactChip({ fact }: { fact: EvidenceFact }) {
  const quote = clip25(fact.quote);
  return (
    <div className="panel px-2.5 py-2" style={{ borderColor: C.soil700 }}>
      <div className="flex items-baseline gap-2">
        <span className="num" style={{ color: C.leaf400 }}>
          {num(fact.value, fact.unit)}
        </span>
        <span className="num text-[10px]" style={{ color: C.chaff600 }}>
          {fact.key}
        </span>
      </div>
      {quote ? (
        <div className="mt-1 text-[11px] leading-snug" style={{ color: C.chaff400 }}>
          “{quote}”
        </div>
      ) : (
        <div className="mt-1 text-[11px]" style={{ color: C.chaff600 }}>no quote captured</div>
      )}
      <div className="mt-1 flex items-center gap-2 text-[10px]">
        {fact.url ? (
          <a href={fact.url} target="_blank" rel="noreferrer noopener"
            className="num underline truncate" style={{ color: C.sky400 }}>
            {fact.domain ?? fact.url}
          </a>
        ) : (
          <span className="num" style={{ color: C.chaff600 }}>{fact.domain ?? EM_DASH}</span>
        )}
        <span className="num" style={{ color: C.chaff600 }}>
          conf {fact.confidence.toFixed(2)}
        </span>
      </div>
    </div>
  );
}

function AssumedChip({ value, unit }: { value: string; unit: string }) {
  return (
    <div
      className="px-2.5 py-2 rounded"
      style={{ border: `1px dashed ${C.chaff600}`, background: "transparent" }}
    >
      <div className="flex items-baseline gap-2">
        <span className="num" style={{ color: C.chaff400 }}>{value} {unit}</span>
        <span className="chip text-[10px]" style={{ color: C.chaff600, borderColor: C.chaff600 }}>
          assumed
        </span>
      </div>
      <div className="mt-1 text-[11px]" style={{ color: C.chaff600 }}>
        no fact supported this parameter — the Architect assumed it.
      </div>
    </div>
  );
}

function FactsTab({ facts, envConfig }: {
  facts: EvidenceFact[]; envConfig: EvidencePayload["envConfig"];
}) {
  const byId = useMemo(() => {
    const map = new Map<string, EvidenceFact>();
    for (const f of facts) map.set(f.id, f);
    return map;
  }, [facts]);

  if (!envConfig && !facts.length) {
    return <Empty text="No facts yet. The Scout's numbers and the environment they build appear here." />;
  }

  const field = envConfig?.config?.field;
  const usedFactIds = new Set<string>();

  const rows = ENV_PARAMS.map((p) => {
    const raw = field ? (field as unknown as Record<string, unknown>)[p.path] : undefined;
    const sourced = isSourced(raw) ? raw : null;
    const fact = sourced?.fact_id ? byId.get(sourced.fact_id) ?? null : null;
    if (fact) usedFactIds.add(fact.id);
    return { p, sourced, fact };
  });

  const others = facts.filter((f) => !usedFactIds.has(f.id));

  return (
    <div className="p-3">
      {!envConfig && (
        <div className="panel px-3 py-2 mb-3 text-[11px]" style={{ color: C.chaff400 }}>
          No EnvConfig written yet — showing the gathered facts only.
        </div>
      )}

      {envConfig && (
        <div className="space-y-2">
          <div className="grid grid-cols-[150px_1fr] gap-2 text-[11px] uppercase tracking-wider"
            style={{ color: C.chaff600 }}>
            <span>EnvConfig parameter</span>
            <span>Evidence</span>
          </div>
          {rows.map(({ p, sourced, fact }) => (
            <div key={p.path} className="grid grid-cols-[150px_1fr] gap-2 items-start">
              <div className="pt-2">
                <div className="num text-[12px]" style={{ color: C.chaff200 }}>{p.label}</div>
                <div className="num text-[12px]" style={{ color: C.signal400 }}>
                  {sourced ? num(sourced.value) : EM_DASH}{" "}
                  <span style={{ color: C.chaff600 }}>{p.unit}</span>
                </div>
              </div>
              {fact ? (
                <FactChip fact={fact} />
              ) : sourced ? (
                <AssumedChip value={num(sourced.value)} unit={p.unit} />
              ) : (
                <div className="px-2.5 py-2 rounded text-[11px]"
                  style={{ border: `1px dashed ${C.soil700}`, color: C.chaff600 }}>
                  {EM_DASH} not set
                </div>
              )}
            </div>
          ))}
          <div className="num text-[10px] pt-1" style={{ color: C.chaff600 }}>
            env {envConfig.id} · obs v{envConfig.config?.obs_version ?? EM_DASH} ·{" "}
            {envConfig.config?.episode_steps ?? EM_DASH} steps · dt{" "}
            {envConfig.config?.dt ?? EM_DASH}
          </div>
        </div>
      )}

      {others.length > 0 && (
        <section className="mt-5">
          <div className="text-[11px] uppercase tracking-wider mb-2" style={{ color: C.chaff600 }}>
            Other facts gathered ({others.length})
          </div>
          <div className="space-y-2">
            {others.map((f) => <FactChip key={f.id} fact={f} />)}
          </div>
        </section>
      )}
    </div>
  );
}

/* ── Dataset → Perception ─────────────────────────────────────────────── */

function Thumb({ item }: { item: EvidenceDatasetItem }) {
  const rejected = item.verified === false;
  return (
    <figure
      className="relative mb-1 break-inside-avoid group rounded overflow-hidden"
      style={{ border: `1px solid ${rejected ? C.soil800 : C.soil700}` }}
      title={rejected ? item.verifier_note ?? "rejected by the verifier" : item.class_label}
    >
      {/* plain img: dataset URLs are arbitrary remote hosts, not configured for next/image */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={item.image_url}
        alt={item.class_label}
        loading="lazy"
        className="w-full block"
        style={{ opacity: rejected ? 0.32 : 1, filter: rejected ? "grayscale(0.6)" : undefined }}
      />
      <figcaption
        className="absolute inset-x-0 bottom-0 px-1 py-0.5 text-[9px] flex items-center justify-between"
        style={{ background: "rgba(18,16,12,0.78)", color: C.chaff400 }}
      >
        <span className="truncate">{item.domain ?? item.class_label}</span>
        {item.verified === true && <span style={{ color: C.leaf400 }}>✓</span>}
        {item.verified === null && <span style={{ color: C.chaff600 }}>?</span>}
      </figcaption>
      {rejected && (
        <div
          className="absolute inset-0 hidden group-hover:flex items-center p-1.5 text-[10px] leading-snug"
          style={{ background: "rgba(18,16,12,0.92)", color: C.blight500 }}
        >
          {item.verifier_note ?? "rejected by the verifier"}
        </div>
      )}
    </figure>
  );
}

function Confusion({ matrix, classes }: { matrix?: number[][]; classes?: string[] }) {
  if (!matrix || !matrix.length) {
    return (
      <div className="num text-[11px]" style={{ color: C.chaff600 }}>
        confusion matrix {EM_DASH}
      </div>
    );
  }
  const labels = classes && classes.length === matrix.length
    ? classes
    : matrix.map((_, i) => (i === 0 ? "protect" : "target"));
  const max = Math.max(1, ...matrix.flat());
  return (
    <div className="inline-block">
      <div className="text-[10px] uppercase tracking-wider mb-1" style={{ color: C.chaff600 }}>
        confusion · rows = truth
      </div>
      <div className="grid gap-px" style={{ gridTemplateColumns: `60px repeat(${matrix.length}, 44px)` }}>
        <span />
        {labels.map((l) => (
          <span key={`h-${l}`} className="text-[10px] text-center truncate" style={{ color: C.chaff600 }}>
            {l}
          </span>
        ))}
        {matrix.map((row, i) => (
          <div key={`r-${i}`} className="contents">
            <span className="text-[10px] truncate pr-1" style={{ color: C.chaff600 }}>
              {labels[i]}
            </span>
            {row.map((cellValue, j) => (
              <span
                key={`c-${i}-${j}`}
                className="num text-[11px] text-center py-1 rounded-sm"
                style={{
                  background: i === j
                    ? `rgba(107,203,119,${0.15 + 0.5 * (cellValue / max)})`
                    : `rgba(229,72,77,${0.12 + 0.5 * (cellValue / max)})`,
                  color: C.chaff200,
                }}
              >
                {cellValue}
              </span>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

function DatasetTab({ items, perceptionModel }: {
  items: EvidenceDatasetItem[]; perceptionModel: EvidencePayload["perceptionModel"];
}) {
  const metrics = perceptionModel?.metrics ?? null;
  const classes = useMemo(() => {
    const c = perceptionModel?.classes;
    if (Array.isArray(c)) return c.map(String);
    if (c && typeof c === "object") return Object.values(c as Record<string, unknown>).map(String);
    return undefined;
  }, [perceptionModel]);

  const cols = useMemo(() => {
    const target: EvidenceDatasetItem[] = [];
    const protect: EvidenceDatasetItem[] = [];
    const rejected: EvidenceDatasetItem[] = [];
    for (const it of items) {
      if (it.verified === false) rejected.push(it);
      else if (it.class_key === "target") target.push(it);
      else protect.push(it);
    }
    return { target, protect, rejected };
  }, [items]);

  return (
    <div className="p-3">
      <div className="panel p-3">
        <div className="text-[11px] uppercase tracking-wider" style={{ color: C.chaff600 }}>
          Perception · zero-shot → web-trained
        </div>
        <div className="mt-1 flex items-baseline gap-3">
          <span className="hero-num text-[28px]" style={{ color: C.sky400, opacity: 0.75 }}>
            {pct(metrics?.zero_shot_acc)}
          </span>
          <span style={{ color: C.chaff600 }}>→</span>
          <span className="hero-num text-[34px]" style={{ color: C.leaf400 }}>
            {pct(metrics?.probe_acc)}
          </span>
          <span className="num text-[11px]" style={{ color: C.chaff400 }}>
            {metrics ? `${metrics.n_train} train · ${metrics.n_val} val · ${metrics.n_pool} pool · ${metrics.n_rejected} rejected`
              : "counts —"}
          </span>
        </div>
        <div className="mt-3">
          <Confusion matrix={metrics?.confusion} classes={classes} />
        </div>
        {perceptionModel && (
          <div className="num text-[10px] mt-2" style={{ color: C.chaff600 }}>
            {perceptionModel.arch} · {perceptionModel.id}
            {metrics?.probe_auc !== undefined ? ` · AUC ${metrics.probe_auc.toFixed(3)}` : ""}
          </div>
        )}
      </div>

      {!items.length ? (
        <div className="mt-3"><Empty text="No images curated yet. The Curator's keeps and rejects land here." /></div>
      ) : (
        <div className="mt-3 grid grid-cols-3 gap-2">
          {([
            ["Target", cols.target, C.bloom400],
            ["Protect", cols.protect, C.leaf400],
            ["Rejected", cols.rejected, C.blight500],
          ] as const).map(([title, list, color]) => (
            <div key={title} className="min-w-0">
              <div className="flex items-baseline justify-between mb-1">
                <span className="text-[11px] uppercase tracking-wider" style={{ color }}>{title}</span>
                <span className="num text-[11px]" style={{ color: C.chaff600 }}>{list.length}</span>
              </div>
              <div className="min-w-0">
                {list.map((it) => <Thumb key={it.id} item={it} />)}
                {!list.length && (
                  <div className="text-[11px] py-2" style={{ color: C.chaff600 }}>{EM_DASH}</div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ── shell ────────────────────────────────────────────────────────────── */

function Empty({ text }: { text: string }) {
  return (
    <div className="p-4 text-xs" style={{ color: C.chaff600 }}>{text}</div>
  );
}

export function EvidenceDrawer({
  missionId, open, onClose, tab, onTabChange, replayMode = false,
}: {
  missionId: string;
  open: boolean;
  onClose: () => void;
  tab?: EvidenceTab;
  onTabChange?: (t: EvidenceTab) => void;
  replayMode?: boolean;
}) {
  const [innerTab, setInnerTab] = useState<EvidenceTab>("sources");
  const active = tab ?? innerTab;
  const setTab = useCallback((t: EvidenceTab) => {
    setInnerTab(t);
    onTabChange?.(t);
  }, [onTabChange]);

  // `attempt` is the fetch generation; a result carries the attempt it answered,
  // so `loading` is derived instead of being set from inside the effect.
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{
    attempt: number; data: EvidencePayload | null; error: string | null;
  }>({ attempt: -1, data: null, error: null });

  const data = result.data;
  const error = result.error;
  const loading = open && result.attempt !== attempt;
  const reload = useCallback(() => setAttempt((a) => a + 1), []);

  useEffect(() => {
    if (!open) return;
    let gone = false;
    (async () => {
      try {
        const res = await fetch(
          `/api/missions/${missionId}/evidence${replayMode ? "?replay=1" : ""}`,
          { cache: "no-store" },
        );
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error ?? `HTTP ${res.status}`);
        }
        const payload = (await res.json()) as EvidencePayload;
        if (!gone) setResult({ attempt, data: payload, error: null });
      } catch (err) {
        if (!gone) setResult({ attempt, data: null, error: (err as Error).message });
      }
    })();
    return () => { gone = true; };
  }, [open, attempt, missionId, replayMode]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const counts = {
    sources: data?.sources.length ?? 0,
    facts: data?.facts.length ?? 0,
    dataset: data?.datasetItems.length ?? 0,
  };

  return (
    <div className="fixed inset-0 z-40 flex justify-end" role="dialog" aria-label="Evidence">
      <button
        aria-label="close evidence"
        onClick={onClose}
        className="flex-1 cursor-default"
        style={{ background: "rgba(18,16,12,0.55)" }}
      />
      <aside
        className="w-[520px] max-w-full h-full flex flex-col"
        style={{ background: C.soil900, borderLeft: `1px solid ${C.soil700}` }}
      >
        <header className="h-12 shrink-0 flex items-center gap-2 px-3 border-b"
          style={{ borderColor: C.soil700 }}>
          <span className="tracking-wide" style={{ color: C.chaff200 }}>Evidence</span>
          <span className="num text-[11px]" style={{ color: C.chaff600 }}>{missionId}</span>
          <button onClick={reload} className="chip ml-auto hover:border-chaff-400"
            style={{ color: C.chaff400 }}>
            {loading ? "loading…" : "refresh"}
          </button>
          <button onClick={onClose} className="chip hover:border-chaff-400"
            style={{ color: C.chaff400 }}>
            close ✕
          </button>
        </header>

        <nav className="h-9 shrink-0 flex items-center gap-1 px-2 border-b text-xs"
          style={{ borderColor: C.soil700 }}>
          {TABS.map((t) => {
            const on = t.key === active;
            return (
              <button
                key={t.key}
                onClick={() => setTab(t.key)}
                className="px-2 py-1 rounded-full transition-colors"
                style={{
                  color: on ? C.signal400 : C.chaff400,
                  background: on ? "rgba(242,179,61,0.12)" : "transparent",
                  border: `1px solid ${on ? C.signal400 : "transparent"}`,
                }}
              >
                {t.label}
                <span className="num ml-1.5" style={{ color: C.chaff600 }}>
                  {counts[t.key]}
                </span>
              </button>
            );
          })}
        </nav>

        <div className="flex-1 min-h-0 overflow-y-auto">
          {error && (
            <div className="m-3 panel px-3 py-2 text-xs" style={{ color: C.blight500 }}>
              evidence unavailable · {error}
            </div>
          )}
          {!data && !error && <Empty text={loading ? "reading the mission's evidence…" : "nothing loaded"} />}
          {data && active === "sources" && <SourcesTab sources={data.sources} />}
          {data && active === "facts" && <FactsTab facts={data.facts} envConfig={data.envConfig} />}
          {data && active === "dataset" && (
            <DatasetTab items={data.datasetItems} perceptionModel={data.perceptionModel} />
          )}
        </div>
      </aside>
    </div>
  );
}
