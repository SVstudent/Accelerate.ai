"""Neon writer — agent state only (SCHEMA.md §1).

Every write is wrapped: a DB hiccup must never kill a training run (§12).
"""
from __future__ import annotations

import hashlib
import json
import os
import threading
import uuid

try:
    import psycopg
except Exception:  # the sandbox installs it; local spikes may not have it
    psycopg = None

from neon_http import NeonHttp
from jsonsafe import dumps as jdumps


def _nid(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:12]}"


class NeonWriter:
    """Writes agent state to Neon over whichever transport is reachable.

    transport = "tcp"  → psycopg (local / anywhere with port 5432 open)
                "http" → Neon SQL-over-HTTP on :443 (Daytona sandboxes)
                "auto" → try TCP once, fall back to HTTP (the default)
    """

    def __init__(self, dsn: str | None = None, transport: str | None = None):
        self.dsn = dsn or os.environ.get("DATABASE_URL")
        self._lock = threading.Lock()
        self._conn = None
        self._http: NeonHttp | None = None
        self.transport = (transport or os.environ.get("FURROW_DB_TRANSPORT") or "auto").lower()
        if self.dsn and self.transport in ("http", "auto"):
            self._http = NeonHttp(self.dsn)
        if self.transport == "auto":
            self.transport = self._pick()

    def _pick(self) -> str:
        if not self.dsn:
            return "none"
        if psycopg is not None:
            try:
                c = psycopg.connect(self.dsn, autocommit=True, connect_timeout=6)
                c.close()
                return "tcp"
            except Exception:
                pass
        if self._http is not None and self._http.ping():
            print("[neon] Postgres port unreachable; using SQL-over-HTTP", flush=True)
            return "http"
        return "none"

    # ── plumbing ─────────────────────────────────────────────────────────
    def _c(self):
        if psycopg is None or not self.dsn:
            return None
        if self._conn is None or self._conn.closed:
            self._conn = psycopg.connect(self.dsn, autocommit=True, connect_timeout=10)
        return self._conn

    def _exec(self, sql: str, params: tuple = ()):  # never raises
        """Returns the first row as a tuple, or None."""
        try:
            with self._lock:
                if self.transport == "http" and self._http is not None:
                    rows = self._http.query(sql, params)
                    if not rows:
                        return None
                    r = rows[0]
                    return tuple(r.values()) if isinstance(r, dict) else tuple(r)
                c = self._c()
                if c is None:
                    return None
                with c.cursor() as cur:
                    cur.execute(sql, params)
                    try:
                        return cur.fetchone()
                    except Exception:
                        return None
        except Exception as exc:
            print(f"[neon] write failed (ignored): {type(exc).__name__}: {exc}", flush=True)
            self._conn = None
            return None

    # ── runs ─────────────────────────────────────────────────────────────
    def run_status(self, run_id: str, status: str, progress: float | None = None,
                   error: str | None = None, sandbox_id: str | None = None):
        sets = ["status = %s"]
        params: list = [status]
        if progress is not None:
            sets.append("progress = %s"); params.append(float(progress))
        if error is not None:
            sets.append("error = %s"); params.append(error[:2000])
        if sandbox_id is not None:
            sets.append("sandbox_id = %s"); params.append(sandbox_id)
        if status == "training":
            sets.append("started_at = coalesce(started_at, now())")
        if status in ("done", "failed", "killed"):
            sets.append("ended_at = now()")
        params.append(run_id)
        self._exec(f"update runs set {', '.join(sets)} where id = %s", tuple(params))

    # ── artifacts ────────────────────────────────────────────────────────
    def put_artifact(self, kind: str, mime: str, blob: bytes) -> str | None:
        aid = _nid("art")
        sha = hashlib.sha256(blob).hexdigest()
        if self.transport == "http":
            # over HTTP the blob travels as hex and Postgres decodes it
            row = self._exec(
                "insert into artifacts (id, kind, mime, bytes, sha256, size) "
                "values (%s,%s,%s,decode(%s,'hex'),%s,%s) returning id",
                (aid, kind, mime, blob, sha, len(blob)),
            )
        else:
            row = self._exec(
                "insert into artifacts (id, kind, mime, bytes, sha256, size) "
                "values (%s,%s,%s,%s,%s,%s) returning id",
                (aid, kind, mime, blob, sha, len(blob)),
            )
        return row[0] if row else None

    def get_artifact(self, artifact_id: str) -> bytes | None:
        if self.transport == "http":
            row = self._exec("select encode(bytes,'hex') as hex from artifacts where id = %s",
                             (artifact_id,))
            if not row or row[0] is None:
                return None
            import binascii
            return binascii.unhexlify(str(row[0]))
        row = self._exec("select bytes from artifacts where id = %s", (artifact_id,))
        if not row:
            return None
        b = row[0]
        return bytes(b) if b is not None else None

    # ── policies ─────────────────────────────────────────────────────────
    def put_policy(self, name: str, kind: str, artifact_id: str,
                   mission_id: str | None = None, parent_id: str | None = None,
                   obs_version: int = 1) -> str | None:
        pid = _nid("pol")
        row = self._exec(
            "insert into policies (id, name, kind, mission_id, parent_id, obs_version, artifact_id) "
            "values (%s,%s,%s,%s,%s,%s,%s) returning id",
            (pid, name, kind, mission_id, parent_id, obs_version, artifact_id),
        )
        return row[0] if row else None

    def set_run_result_policy(self, run_id: str, policy_id: str):
        self._exec("update runs set result_policy_id = %s where id = %s", (policy_id, run_id))

    # ── replays ──────────────────────────────────────────────────────────
    def put_replay(self, mission_id: str, replay: dict, summary: dict, kind: str,
                   run_id: str | None = None, policy_id: str | None = None,
                   step: int | None = None) -> str | None:
        rid = _nid("rpl")
        row = self._exec(
            "insert into replays (id, run_id, policy_id, mission_id, step, seed, kind, data, summary) "
            "values (%s,%s,%s,%s,%s,%s,%s,%s,%s) returning id",
            (rid, run_id, policy_id, mission_id, step, int(replay.get("seed", 0)), kind,
             jdumps(replay), jdumps(summary)),
        )
        return row[0] if row else None

    # ── evaluations ──────────────────────────────────────────────────────
    def put_evaluation(self, mission_id: str, policy_id: str, env_config_id: str,
                       seeds: list[int], metrics: dict, is_baseline: bool,
                       perception_model_id: str | None = None) -> str | None:
        eid = _nid("evl")
        row = self._exec(
            "insert into evaluations (id, mission_id, policy_id, env_config_id, "
            "perception_model_id, seeds, metrics, is_baseline) "
            "values (%s,%s,%s,%s,%s,%s,%s,%s) returning id",
            (eid, mission_id, policy_id, env_config_id, perception_model_id,
             list(seeds), jdumps(metrics), is_baseline),
        )
        return row[0] if row else None

    # ── agent trace (sandboxes narrate their own progress) ───────────────
    def event(self, mission_id: str, agent: str, kind: str, title: str, payload: dict | None = None):
        self._exec(
            "insert into agent_events (id, mission_id, agent, kind, title, payload) "
            "values (%s,%s,%s,%s,%s,%s)",
            (_nid("evt"), mission_id, agent, kind, title[:300], jdumps(payload or {})),
        )

    # ── telemetry relay (db/migrations/0002) ─────────────────────────────
    def inbox(self, kind: str, mission_id: str, run_id: str, payload: dict):
        """Append one telemetry row for the app to drain into Tiger."""
        self._exec(
            "insert into telemetry_inbox (kind, mission_id, run_id, payload) "
            "values (%s,%s,%s,%s)",
            (kind, mission_id, run_id, jdumps(payload)),
        )

    def inbox_many(self, rows: list[tuple[str, str, str, dict]]):
        """Batch append. One statement, so one round trip over HTTP."""
        if not rows:
            return
        vals = ",".join(["(%s,%s,%s,%s)"] * len(rows))
        params: list = []
        for kind, mission_id, run_id, payload in rows:
            params += [kind, mission_id, run_id, jdumps(payload)]
        self._exec(
            f"insert into telemetry_inbox (kind, mission_id, run_id, payload) values {vals}",
            tuple(params),
        )

    def close(self):
        try:
            if self._conn and not self._conn.closed:
                self._conn.close()
        except Exception:
            pass
