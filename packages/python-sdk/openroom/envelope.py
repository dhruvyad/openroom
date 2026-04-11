"""Envelope construction and verification.

An envelope is the basic wire unit — a signed, canonicalized dict with
a type tag, a random id, a timestamp, the sender's public key, and an
arbitrary payload. Every envelope on the wire goes through
``make_envelope`` and ``verify_envelope``. The relay refuses anything
with a bad signature before looking at the payload.
"""

from __future__ import annotations

import time
import uuid
from typing import Any

from openroom.crypto import (
    from_base64url,
    sign,
    to_base64url,
    verify,
)
from openroom.jcs import canonicalize


def sign_envelope(unsigned: dict[str, Any], private_key: bytes) -> dict[str, Any]:
    """Attach an Ed25519 signature to an already-built envelope dict.

    The canonical bytes exclude ``sig``. Returns a new dict with ``sig``
    added; does not mutate the input.
    """
    canonical = canonicalize(unsigned)
    signature = sign(canonical.encode("utf-8"), private_key)
    return {**unsigned, "sig": to_base64url(signature)}


def verify_envelope(envelope: dict[str, Any]) -> bool:
    """Verify an envelope's signature. Returns False on any failure —
    missing fields, bad base64url, wrong signature, malformed payload —
    never raises. Matches the JS SDK contract.
    """
    try:
        sig_b64 = envelope.get("sig")
        from_b64 = envelope.get("from")
        if not isinstance(sig_b64, str) or not isinstance(from_b64, str):
            return False
        # Canonical form excludes sig — everything else is signed.
        unsigned = {k: v for k, v in envelope.items() if k != "sig"}
        canonical = canonicalize(unsigned)
        sig_bytes = from_base64url(sig_b64)
        public_key = from_base64url(from_b64)
        return verify(sig_bytes, canonical.encode("utf-8"), public_key)
    except (ValueError, TypeError):
        return False


def make_envelope(
    type: str,
    payload: Any,
    private_key: bytes,
    public_key: bytes,
) -> dict[str, Any]:
    """Build a fresh signed envelope. ``id`` is a random UUID4 (string
    form, hyphens included), ``ts`` is the current unix timestamp in
    seconds, and ``from`` is the sender's base64url-encoded public key.

    Matches the JS SDK's ``makeEnvelope`` exactly: same field order, same
    UUID format, same ts units. Envelopes built in one SDK verify under
    the other.
    """
    unsigned = {
        "type": type,
        "id": str(uuid.uuid4()),
        "ts": int(time.time()),
        "from": to_base64url(public_key),
        "payload": payload,
    }
    return sign_envelope(unsigned, private_key)
