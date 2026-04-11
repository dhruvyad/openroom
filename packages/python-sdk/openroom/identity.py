"""Session attestations.

A session key is ephemeral (one keypair per WebSocket connection). An
identity key is optional, long-lived, and the public key IS the agent's
cross-session identity. A session attestation is a signed binding that
says: "the holder of identity X also holds session Y in room R until
time T." Peers can verify locally and look the identity up in their own
reputation ledgers.

The load-bearing property is that an attestation produced in Python
verifies under the JS SDK's ``verifySessionAttestation``, and vice
versa. That holds as long as the canonical form over
``{identity_pubkey, session_pubkey, room, expires_at}`` is byte-for-byte
identical — which it is, because both sides run the same JCS algorithm.

File-based persistence of identity keys lives in ``identity_store.py``.
This module is intentionally dependency-light (no filesystem) so the
Python SDK can eventually run in constrained environments.
"""

from __future__ import annotations

import time
from dataclasses import asdict, dataclass
from typing import Any

from openroom.crypto import (
    Keypair,
    from_base64url,
    sign,
    to_base64url,
    verify,
)
from openroom.jcs import canonicalize


DEFAULT_ATTESTATION_LIFETIME_SECONDS = 24 * 60 * 60


@dataclass(frozen=True)
class SessionAttestation:
    identity_pubkey: str
    session_pubkey: str
    room: str
    expires_at: int
    sig: str

    def to_dict(self) -> dict[str, Any]:
        """Serialize to a wire-shape dict suitable for placing inside a
        join payload or cap chain."""
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "SessionAttestation":
        return cls(
            identity_pubkey=data["identity_pubkey"],
            session_pubkey=data["session_pubkey"],
            room=data["room"],
            expires_at=int(data["expires_at"]),
            sig=data["sig"],
        )


def make_session_attestation(
    identity_keypair: Keypair,
    session_pubkey: bytes | str,
    room: str,
    *,
    expires_at: int | None = None,
) -> SessionAttestation:
    """Produce a signed attestation binding ``session_pubkey`` to the
    identity keypair for use in ``room``. Signature is Ed25519 by the
    identity private key over the JCS canonical form of
    ``{identity_pubkey, session_pubkey, room, expires_at}``. The
    attestation cannot be replayed to a different room because ``room``
    is signed into it."""
    if isinstance(session_pubkey, (bytes, bytearray)):
        session_b64 = to_base64url(bytes(session_pubkey))
    else:
        session_b64 = session_pubkey

    identity_b64 = to_base64url(identity_keypair.public_key)
    expires = (
        expires_at
        if expires_at is not None
        else int(time.time()) + DEFAULT_ATTESTATION_LIFETIME_SECONDS
    )

    unsigned = {
        "identity_pubkey": identity_b64,
        "session_pubkey": session_b64,
        "room": room,
        "expires_at": expires,
    }
    canonical = canonicalize(unsigned)
    signature = sign(canonical.encode("utf-8"), identity_keypair.private_key)

    return SessionAttestation(
        identity_pubkey=identity_b64,
        session_pubkey=session_b64,
        room=room,
        expires_at=expires,
        sig=to_base64url(signature),
    )


def verify_session_attestation(
    attestation: SessionAttestation | dict[str, Any],
    *,
    now: int | None = None,
) -> bool:
    """Verify a session attestation's signature and expiry.

    Accepts both the dataclass form and the raw wire-dict form so
    callers receiving attestations over the network (as nested JSON
    objects) don't need to coerce before verifying. Returns False on any
    failure — missing fields, expired, bad signature, bad base64url —
    and never raises."""
    try:
        if isinstance(attestation, SessionAttestation):
            data = attestation.to_dict()
        elif isinstance(attestation, dict):
            data = attestation
        else:
            return False

        required = ("identity_pubkey", "session_pubkey", "room", "expires_at", "sig")
        for k in required:
            if k not in data:
                return False
        if not isinstance(data["identity_pubkey"], str):
            return False
        if not isinstance(data["session_pubkey"], str):
            return False
        if not isinstance(data["room"], str):
            return False
        if not isinstance(data["expires_at"], int):
            return False
        if not isinstance(data["sig"], str):
            return False

        current = now if now is not None else int(time.time())
        if current > data["expires_at"]:
            return False

        unsigned = {k: v for k, v in data.items() if k != "sig"}
        canonical = canonicalize(unsigned)
        sig_bytes = from_base64url(data["sig"])
        identity_key = from_base64url(data["identity_pubkey"])
        return verify(sig_bytes, canonical.encode("utf-8"), identity_key)
    except (ValueError, TypeError, KeyError):
        return False


__all__ = [
    "DEFAULT_ATTESTATION_LIFETIME_SECONDS",
    "SessionAttestation",
    "make_session_attestation",
    "verify_session_attestation",
]
