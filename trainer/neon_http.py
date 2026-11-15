"""Neon SQL-over-HTTP transport (port 443).

Daytona sandboxes can only egress on :443, so psycopg's TCP connection to
Neon's Postgres port is unreachable there. Neon's HTTP SQL endpoint speaks the
same SQL over 443 and is verified working from inside a sandbox.

Placeholders: we keep writing psycopg-style %s in the callers and rewrite to
$1..$n here, so one SQL string works over either transport.
"""
from __future__ import annotations

import binascii
import json
import re
import urllib.error
import urllib.request
from urllib.parse import urlparse


def to_numbered(sql: str) -> str:
    """%s -> $1, $2, ... (ignores %% escapes)."""
    out = []
    n = 0
    i = 0
    while i < len(sql):
        if sql[i:i + 2] == "%%":
            out.append("%"); i += 2; continue
        if sql[i:i + 2] == "%s":
            n += 1; out.append(f"${n}"); i += 2; continue
        out.append(sql[i]); i += 1
    return "".join(out)


class NeonHttp:
    def __init__(self, dsn: str, timeout: float = 25.0):
        self.dsn = dsn
        self.timeout = timeout
        host = urlparse(dsn.replace("postgresql://", "https://").replace("postgres://", "https://")).hostname
        self.url = f"https://{host}/sql"

    @staticmethod
    def _encode(p):
        """bytes -> hex string; the SQL wraps it in decode(..., 'hex')."""
        if isinstance(p, (bytes, bytearray, memoryview)):
            return binascii.hexlify(bytes(p)).decode("ascii")
        if isinstance(p, (list, tuple)):
            return list(p)
        return p

    def query(self, sql: str, params: tuple = ()):  # returns list[dict] or None
        body = json.dumps({
            "query": to_numbered(sql),
            "params": [self._encode(p) for p in params],
        }).encode()
        req = urllib.request.Request(
            self.url, data=body,
            headers={
                "Content-Type": "application/json",
                "Neon-Connection-String": self.dsn,
                "Neon-Raw-Text-Output": "true",
                "Neon-Array-Mode": "false",
            },
        )
        with urllib.request.urlopen(req, timeout=self.timeout) as r:
            payload = json.load(r)
        return payload.get("rows", [])

    def ping(self) -> bool:
        try:
            rows = self.query("select 1 as ok")
            return bool(rows)
        except Exception:
            return False
