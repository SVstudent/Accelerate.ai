"""JSON encoding that tolerates numpy scalars.

SB3's logger hands back np.float32 values and our summaries carry numpy ints.
json.dumps refuses them, which silently dropped 63 telemetry rows in the first
sandbox run. Everything that serialises telemetry goes through here.
"""
from __future__ import annotations

import json
import math


def coerce(o):
    # numpy scalars expose .item(); this avoids importing numpy here
    item = getattr(o, "item", None)
    if callable(item):
        try:
            v = o.item()
            if isinstance(v, float) and not math.isfinite(v):
                return None
            return v
        except Exception:
            pass
    tolist = getattr(o, "tolist", None)
    if callable(tolist):
        try:
            return o.tolist()
        except Exception:
            pass
    if isinstance(o, (set, frozenset)):
        return list(o)
    if isinstance(o, bytes):
        return o.decode("utf-8", "replace")
    return str(o)


def dumps(obj) -> str:
    return json.dumps(obj, default=coerce, allow_nan=False)
