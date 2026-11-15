/**
 * Mission SSE stream (SCHEMA.md §7).
 * Polls Neon (state) and Tiger Data (telemetry) every 500 ms with a cursor and
 * emits typed events. Also starts the telemetry drain, since this is the thing
 * that is always open while a mission runs.
 */
import { NextRequest } from "next/server";
import { and, asc, eq, gt, sql } from "drizzle-orm";
import { db, demoDb, schema } from "@/db";
import { curve, farmHeat, testSplit, liveFrames, tiger } from "@/db/tiger";
import { startDrain } from "@/lib/telemetry-drain";
import { phaseOf, type MissionStatus } from "@/lib/contracts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const POLL_MS = 500;
const HEAT_EVERY = 2;      // ~1 s
const HEARTBEAT_MS = 15_000;

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const replay = req.nextUrl.searchParams.get("replay") === "1";
  // The demo branch is a FROZEN snapshot holding only the pinned golden
  // mission. Any other mission — including every new one — lives on main, so
  // pointing its replay at the branch queried a database that neither has the
  // mission nor the newer columns, and the stream died on every poll.
  const isPinnedDemo = id === process.env.DEMO_MISSION_ID;
  const database = replay && isPinnedDemo ? demoDb() : db;
  if (!replay) startDrain();

  const encoder = new TextEncoder();
  let closed = false;

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        if (closed) return;
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };

      // cursors
      let lastEventTs = new Date(0);
      let lastCurve: Date | undefined;
      let lastFrameTs: Date | undefined;
      let lastStatus = "";
      const seenRuns = new Map<string, string>();
      const seenReplays = new Set<string>();
      const seenEvals = new Set<string>();
      const seenVoice = new Set<string>();
      let tick = 0;
      let lastBeat = Date.now();

      send("mission", { hello: true, missionId: id, replay });

      const poll = async () => {
        if (closed) return;
        tick++;
        try {
          // ── mission row ──
          const [m] = await database.select().from(schema.missions)
            .where(eq(schema.missions.id, id)).limit(1);
          if (m) {
            const key = `${m.status}|${m.phaseDetail ?? ""}|${m.generation}|${m.bestPolicyId ?? ""}`;
            if (key !== lastStatus) {
              lastStatus = key;
              send("mission", {
                id: m.id,
                goal_text: m.goalText,
                goal_lang: m.goalLang,
                task_spec: m.taskSpec,
                status: m.status,
                phase: phaseOf(m.status as MissionStatus, m.generation),
                phase_detail: m.phaseDetail,
                generation: m.generation,
                best_policy_id: m.bestPolicyId,
                baseline_eval_id: m.baselineEvalId,
                is_demo: m.isDemo,
              });
            }
          }

          // ── agent trace ──
          const events = await database.select().from(schema.agentEvents)
            .where(and(eq(schema.agentEvents.missionId, id), gt(schema.agentEvents.ts, lastEventTs)))
            .orderBy(asc(schema.agentEvents.ts)).limit(200);
          for (const e of events) {
            lastEventTs = e.ts > lastEventTs ? e.ts : lastEventTs;
            send("agent_event", e);
          }

          // ── runs ──
          const runs = await database.select().from(schema.runs)
            .where(eq(schema.runs.missionId, id)).orderBy(asc(schema.runs.generation));
          for (const r of runs) {
            const key = `${r.status}|${r.progress}|${r.sandboxId ?? ""}`;
            if (seenRuns.get(r.id) !== key) {
              seenRuns.set(r.id, key);
              send("run", {
                id: r.id, generation: r.generation, variant: r.variant,
                status: r.status, progress: r.progress, sandbox_id: r.sandboxId,
                reward_spec_id: r.rewardSpecId, error: r.error,
              });
            }
          }

          // ── replays (metadata only; the client fetches the blob) ──
          const reps = await database.select({
            id: schema.replays.id, runId: schema.replays.runId, step: schema.replays.step,
            kind: schema.replays.kind, summary: schema.replays.summary,
            policyId: schema.replays.policyId,
          }).from(schema.replays).where(eq(schema.replays.missionId, id)).limit(80);
          for (const r of reps) {
            if (seenReplays.has(r.id)) continue;
            seenReplays.add(r.id);
            send("replay", r);
          }

          // ── evaluations ──
          const evals = await database.select().from(schema.evaluations)
            .where(eq(schema.evaluations.missionId, id));
          for (const e of evals) {
            if (seenEvals.has(e.id)) continue;
            seenEvals.add(e.id);
            send("eval", {
              id: e.id, policy_id: e.policyId, is_baseline: e.isBaseline, metrics: e.metrics,
            });
          }

          // ── voice clips ──
          const clips = await database.select({
            id: schema.voiceClips.id, purpose: schema.voiceClips.purpose,
            transcript: schema.voiceClips.transcript, direction: schema.voiceClips.direction,
            lang: schema.voiceClips.lang,
          }).from(schema.voiceClips).where(eq(schema.voiceClips.missionId, id)).limit(40);
          for (const c of clips) {
            if (seenVoice.has(c.id)) continue;
            seenVoice.add(c.id);
            send("voice", { clip_id: c.id, purpose: c.purpose, transcript: c.transcript, lang: c.lang });
          }

          // ── Bright Data ingest counters ──
          const ing = await database.execute(sql`
            select
              (select count(*) from sources where mission_id = ${id} and via in ('serp','serp_images')) as queries,
              (select count(*) from sources where mission_id = ${id} and via in ('unlocker','scraper','browser')) as pages,
              (select count(*) from dataset_items where mission_id = ${id}) as images_raw,
              (select count(*) from dataset_items where mission_id = ${id} and verified is true) as images_kept,
              (select count(*) from facts where mission_id = ${id}) as facts`);
          const row = ((ing.rows ?? ing) as Record<string, unknown>[])[0];

          // dataset_items is the per-image record. When a run is interrupted
          // after the sandbox has fitted the probe but before those rows are
          // written back, the table is empty even though the images really
          // were fetched and used. The Curator's own log line is a surviving
          // record of this mission, so read the counts from it rather than
          // report a zero that implies no images were ever processed.
          let imgRaw = Number(row?.images_raw ?? 0);
          let imgKept = Number(row?.images_kept ?? 0);
          if (imgRaw === 0) {
            const logged = await database.execute(sql`
              select title from agent_events
              where mission_id = ${id} and agent = 'curator'
                and title like 'Fetched %images%'
              order by ts desc limit 1`);
            const t = ((logged.rows ?? logged) as { title?: string }[])[0]?.title ?? "";
            const m2 = /Fetched\s+(\d+)\s+images,\s+kept\s+(\d+)/i.exec(t);
            if (m2) { imgRaw = Number(m2[1]); imgKept = Number(m2[2]); }
          }

          if (row) {
            send("ingest", {
              queries: Number(row.queries), pages: Number(row.pages),
              images_raw: imgRaw, images_kept: imgKept,
              facts: Number(row.facts),
            });
          }

          // ── Tiger telemetry ──
          if (tiger) {
            const pts = await curve(id, lastCurve);
            for (const p of pts) {
              lastCurve = !lastCurve || p.bucket > lastCurve ? p.bucket : lastCurve;
              send("metric", {
                run_id: p.run_id, bucket: p.bucket, score: p.score,
                removal: p.removal, damage: p.damage, episodes: Number(p.episodes),
                phase: p.phase, policy: p.policy,
              });
            }

            const frames = await liveFrames(id, lastFrameTs, 24);
            for (const f of frames) {
              lastFrameTs = !lastFrameTs || f.ts > lastFrameTs ? f.ts : lastFrameTs;
              send("live", {
                run_id: f.run_id, seq: f.seq, phase: f.phase,
                global_step: f.global_step, data: f.data,
              });
            }

            if (tick % HEAT_EVERY === 0) {
              const heat = await farmHeat(id);
              if (heat.length) send("heat", heat);
              const split = await testSplit(id);
              if (split.length) {
                const byPolicy: Record<string, unknown> = {};
                for (const s of split) byPolicy[s.policy] = s;
                if (byPolicy.base || byPolicy.cand) send("split", byPolicy);
              }
            }
          }

          if (Date.now() - lastBeat > HEARTBEAT_MS) {
            lastBeat = Date.now();
            controller.enqueue(encoder.encode(": keepalive\n\n"));
          }
        } catch (err) {
          send("agent_event", {
            id: `evt_stream_${Date.now()}`, mission_id: id, agent: "system", kind: "error",
            title: `stream poll failed: ${(err as Error).message}`.slice(0, 200),
            payload: {}, ts: new Date().toISOString(),
          });
        }
      };

      await poll();
      const interval = setInterval(poll, POLL_MS);
      req.signal.addEventListener("abort", () => {
        closed = true;
        clearInterval(interval);
        try { controller.close(); } catch {}
      });
    },
    cancel() { closed = true; },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
