"""JSON Canonicalization Scheme (RFC 8785), minimal implementation.

Must produce byte-for-byte identical output to packages/sdk/src/jcs.ts
for any value that the openroom protocol puts on the wire: plain dicts,
lists, strings, bools, None, and integer numbers. The cross-language
smoke test proves this by having one SDK build an envelope and the
other SDK verify its signature — both sides canonicalize the unsigned
payload the same way or the verify fails.

Notes on the Python ↔ JS alignment:

- Python distinguishes int from float; JS has only Number. A literal
  ``1.0`` in Python canonicalizes as ``"1.0"`` but the same value in JS
  canonicalizes as ``"1"``. openroom's wire format doesn't use floats
  anywhere (timestamps are integers, everything else is string/bool),
  so this edge case is documented but not papered over.
- Strings are encoded with ``ensure_ascii=False`` to match JS
  JSON.stringify, which does not escape non-ASCII printable code points.
- Dict keys must be str; non-string keys raise TypeError.
- Undefined-style holes (``undefined`` array entries, missing optional
  properties) don't have a Python analogue. Callers simply omit the
  key, which produces the same canonical form as JS with undefined.
"""

from __future__ import annotations

import json
import math
from typing import Any


def canonicalize(value: Any) -> str:
    """Return the RFC 8785 canonical JSON string for ``value``."""
    if value is None:
        return "null"
    if isinstance(value, bool):
        # Must be checked before int — bool is a subclass of int in Python.
        return "true" if value else "false"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        if math.isnan(value) or math.isinf(value):
            raise ValueError("canonicalize: non-finite number")
        return json.dumps(value)
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False)
    if isinstance(value, list) or isinstance(value, tuple):
        inner = ",".join(canonicalize(v) for v in value)
        return f"[{inner}]"
    if isinstance(value, dict):
        for k in value.keys():
            if not isinstance(k, str):
                raise TypeError(
                    "canonicalize: dict keys must be str, "
                    f"got {type(k).__name__}"
                )
        # Sort by key using code-point ordering. For ASCII keys this
        # matches JS's UTF-16-code-unit sort, which is openroom's
        # effective domain.
        parts = []
        for k in sorted(value.keys()):
            v = value[k]
            # Match JS: skip explicitly-undefined keys. Python doesn't
            # have undefined, but callers sometimes sentinel-mark an
            # optional key as Ellipsis to mean "omit" — honor that.
            if v is ...:
                continue
            parts.append(
                json.dumps(k, ensure_ascii=False) + ":" + canonicalize(v)
            )
        return "{" + ",".join(parts) + "}"
    raise TypeError(
        f"canonicalize: unsupported type {type(value).__name__}"
    )
