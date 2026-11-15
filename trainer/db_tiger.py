"""Tiger Data writer — telemetry only (SCHEMA.md §1.1).

Batched on a background thread. Training never waits on a telemetry write, and
a failed flush is dropped rather than retried forever: the demo must keep moving.
"""
from __future__ import annotations

import json
import os
import queue
import threading
import time

try:
    import psycopg
except Exception:
    psycopg = None

from jsonsafe import dumps as jdumps

FLUSH_EVERY_S = 1.0
MAX_BATCH = 2000


class TigerWriter:
    """Telemetry sink.

    Direct mode: psycopg straight into Tiger's hypertables (the app, or anywhere
    Tiger's Postgres port is open).
    Relay mode: Tiger's port is unreachable (Daytona sandboxes egress on :443
    only), so rows are appended to Neon's telemetry_inbox over HTTPS and the
    app drains them into Tiger. Measured constraint, see db/migrations/0002.
    """

    def __init__(self, dsn: str | None = None, relay=None):
        self.dsn = dsn or os.environ.get("TIGER_DATABASE_URL")
        self.relay = relay
        self.mode = "direct"
        self.q: "queue.Queue[tuple[str, tuple]]" = queue.Queue(maxsize=50_000)
        self._stop = threading.Event()
        self._conn = None
        self.dropped = 0
        self.written = 0
        # Prefer writing straight into the hypertables; relay only if we must.
        direct_ok = False
        if self.dsn and psycopg is not None:
            try:
                c = psycopg.connect(self.dsn, connect_timeout=6); c.close()
                direct_ok = True
            except Exception:
                pass
        if direct_ok:
            self.mode = "direct"
        elif self.relay is not None:
            print("[tiger] port unreachable; relaying telemetry via Neon", flush=True)
            self.mode = "relay"
        else:
            self.mode = "none"
        self._t = threading.Thread(target=self._loop, daemon=True, name="tiger-writer")
        if self.mode in ("direct", "relay"):
            self._t.start()

    # ── public, non-blocking ─────────────────────────────────────────────
    def episode(self, mission_id, run_id, env, phase, policy, seed, global_step, s: dict):
        self._put("episode_stats", (
            mission_id, run_id, int(env), phase, policy, int(seed), int(global_step),
            float(s.get("score", 0.0)), float(s.get("target_removal_rate", 0.0)),
            float(s.get("protect_damage_rate", 0.0)), float(s.get("trample_rate", 0.0)),
            float(s.get("act_precision", 0.0)), int(s.get("steps_used", 0)),
        ))

    def metrics(self, run_id, step, m: dict):
        self._put("run_metrics", (
            run_id, int(step),
            m.get("ep_return_mean"), m.get("target_removal_rate"), m.get("protect_damage_rate"),
            m.get("trample_rate"), m.get("act_precision"), m.get("fps"),
            m.get("policy_loss"), m.get("value_loss"), m.get("entropy"), m.get("approx_kl"),
            jdumps(m.get("components", {})),
        ))

    def live_frame(self, mission_id, run_id, seq, phase, global_step, frame: dict):
        self._put("live_frames", (
            mission_id, run_id, int(seq), phase, int(global_step), jdumps(frame),
        ))

    def _put(self, table: str, row: tuple):
        if self.mode == "none":
            return
        try:
            self.q.put_nowait((table, row))
        except queue.Full:
            self.dropped += 1

    # ── background flush ─────────────────────────────────────────────────
    def _c(self):
        if self._conn is None or self._conn.closed:
            self._conn = psycopg.connect(self.dsn, autocommit=True, connect_timeout=10)
        return self._conn

    _SQL = {
        "episode_stats": (
            "insert into episode_stats (ts, mission_id, run_id, env, phase, policy, seed, "
            'global_step, score, removal, damage, trample, "precision", steps) '
            "values (now(),%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)"
        ),
        "run_metrics": (
            "insert into run_metrics (ts, run_id, step, ep_return_mean, target_removal_rate, "
            "protect_damage_rate, trample_rate, act_precision, fps, policy_loss, value_loss, "
            "entropy, approx_kl, components) "
            "values (now(),%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)"
        ),
        "live_frames": (
            "insert into live_frames (ts, mission_id, run_id, seq, phase, global_step, data) "
            "values (now(),%s,%s,%s,%s,%s,%s)"
        ),
    }

    def _loop(self):
        pending: dict[str, list[tuple]] = {k: [] for k in self._SQL}
        last = time.monotonic()
        while not self._stop.is_set() or not self.q.empty():
            timeout = max(0.05, FLUSH_EVERY_S - (time.monotonic() - last))
            try:
                table, row = self.q.get(timeout=timeout)
                pending[table].append(row)
            except queue.Empty:
                pass
            due = (time.monotonic() - last) >= FLUSH_EVERY_S
            big = any(len(v) >= MAX_BATCH for v in pending.values())
            if due or big:
                self._flush(pending)
                last = time.monotonic()
        self._flush(pending)

    _RELAY_FIELDS = {
        "episode_stats": ["mission_id", "run_id", "env", "phase", "policy", "seed",
                          "global_step", "score", "removal", "damage", "trample",
                          "precision", "steps"],
        "run_metrics": ["run_id", "step", "ep_return_mean", "target_removal_rate",
                        "protect_damage_rate", "trample_rate", "act_precision", "fps",
                        "policy_loss", "value_loss", "entropy", "approx_kl", "components"],
        "live_frames": ["mission_id", "run_id", "seq", "phase", "global_step", "data"],
    }
    _RELAY_KIND = {"episode_stats": "episode", "run_metrics": "metric", "live_frames": "live_frame"}

    def _flush_relay(self, pending: dict[str, list[tuple]]):
        batch: list[tuple] = []
        for table, rows in pending.items():
            if not rows:
                continue
            fields = self._RELAY_FIELDS[table]
            kind = self._RELAY_KIND[table]
            for row in rows:
                d = dict(zip(fields, row))
                for j in ("components", "data"):
                    if isinstance(d.get(j), str):
                        try:
                            d[j] = json.loads(d[j])
                        except Exception:
                            pass
                mission = d.get("mission_id") or ""
                run = d.get("run_id") or ""
                batch.append((kind, mission, run, d))
            rows.clear()
        if not batch:
            return
        try:
            self.relay.inbox_many(batch)
            self.written += len(batch)
        except Exception as exc:
            self.dropped += len(batch)
            print(f"[tiger] relay dropped {len(batch)} rows: {type(exc).__name__}: {exc}", flush=True)

    def _flush(self, pending: dict[str, list[tuple]]):
        if self.mode == "relay":
            if self.relay is None:
                for v in pending.values():
                    self.dropped += len(v); v.clear()
                return
            return self._flush_relay(pending)
        for table, rows in pending.items():
            if not rows:
                continue
            try:
                with self._c().cursor() as cur:
                    cur.executemany(self._SQL[table], rows)
                self.written += len(rows)
            except Exception as exc:
                self.dropped += len(rows)
                print(f"[tiger] dropped {len(rows)} {table} rows: {type(exc).__name__}: {exc}", flush=True)
                self._conn = None
            finally:
                rows.clear()

    def close(self, timeout: float = 5.0):
        self._stop.set()
        if self._t.is_alive():
            self._t.join(timeout=timeout)
        try:
            if self._conn and not self._conn.closed:
                self._conn.close()
        except Exception:
            pass
        print(f"[tiger] written={self.written} dropped={self.dropped}", flush=True)
