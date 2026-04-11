"""Cryptographic primitives for openroom: Ed25519 keys, sign/verify, BLAKE3
content-addressed IDs, and base64url that matches the JS SDK exactly.

Why our own base64url: Python's base64.urlsafe_b64encode pads with '=' and
urlsafe_b64decode requires padding. The wire protocol uses unpadded
base64url. We strip on encode and re-pad on decode, and we raise on
invalid characters (rather than silently dropping them) to match the JS
SDK's behavior — the JS SDK has a comment about a real bug where Node's
Buffer.from silently truncated on garbage input.
"""

from __future__ import annotations

import base64
import os
import secrets
from dataclasses import dataclass

from blake3 import blake3 as _blake3
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import (
    Ed25519PrivateKey,
    Ed25519PublicKey,
)


@dataclass(frozen=True)
class Keypair:
    """Ed25519 keypair. Both fields are raw 32-byte values (no SPKI/PKCS8
    framing) — matches the JS SDK's { privateKey, publicKey } shape so
    serialized identity files are portable across SDKs."""

    private_key: bytes
    public_key: bytes


def generate_keypair() -> Keypair:
    """Generate a fresh Ed25519 keypair."""
    private = Ed25519PrivateKey.generate()
    private_bytes = private.private_bytes_raw()
    public_bytes = private.public_key().public_bytes_raw()
    return Keypair(private_key=private_bytes, public_key=public_bytes)


def public_key_from_private(private_key: bytes) -> bytes:
    """Derive the public key from a 32-byte Ed25519 private key."""
    pk = Ed25519PrivateKey.from_private_bytes(private_key)
    return pk.public_key().public_bytes_raw()


def sign(message: bytes, private_key: bytes) -> bytes:
    """Sign a message with a 32-byte Ed25519 private key. Returns a
    64-byte signature."""
    pk = Ed25519PrivateKey.from_private_bytes(private_key)
    return pk.sign(message)


def verify(signature: bytes, message: bytes, public_key: bytes) -> bool:
    """Verify an Ed25519 signature. Returns False on any failure — bad
    signature, wrong key, malformed input — never raises. Matches the JS
    SDK contract."""
    try:
        pub = Ed25519PublicKey.from_public_bytes(public_key)
        pub.verify(signature, message)
        return True
    except (InvalidSignature, ValueError, TypeError):
        return False


def blake3_hash(data: bytes) -> bytes:
    """BLAKE3 of `data`, 32 bytes."""
    return _blake3(data).digest()


def blake3_cid(data: bytes) -> str:
    """Content-addressed identifier for a resource: ``blake3:<hex>`` over
    the raw bytes. Stable across agents, deterministic from content."""
    return f"blake3:{_blake3(data).hexdigest()}"


def to_base64url(data: bytes) -> str:
    """Encode bytes to unpadded base64url (RFC 4648 §5)."""
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def from_base64url(s: str) -> bytes:
    """Decode an unpadded base64url string to bytes.

    Raises ValueError on invalid characters, invalid length, or malformed
    trailing padding. The JS SDK raises on these too (unlike Node's
    Buffer.from, which silently truncates). The cross-language
    compatibility contract depends on the two SDKs rejecting the same set
    of inputs.
    """
    if not isinstance(s, str):
        raise ValueError("from_base64url: expected str")

    # Strip any explicit padding the caller included, then re-pad to a
    # multiple of 4 for urlsafe_b64decode. Length % 4 == 1 is always
    # invalid (no base64 string ends on a single trailing char).
    trimmed = s.rstrip("=")
    mod = len(trimmed) % 4
    if mod == 1:
        raise ValueError("from_base64url: invalid input length")

    # Validate alphabet before calling the stdlib — stdlib is stricter
    # than Node's Buffer but we want consistent error messages.
    valid = set(
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
    )
    for i, ch in enumerate(trimmed):
        if ch not in valid:
            raise ValueError(
                f"from_base64url: invalid character at position {i}"
                f" (0x{ord(ch):x})"
            )

    padded = trimmed + "=" * ((4 - mod) % 4)
    return base64.urlsafe_b64decode(padded.encode("ascii"))


def to_hex(data: bytes) -> str:
    """Lowercase hex encoding — matches the JS SDK's toHex()."""
    return data.hex()


def random_nonce(n: int = 32) -> str:
    """Cryptographically-random base64url nonce of n bytes (default 32).
    Used for envelope.id and join-challenge nonces."""
    return to_base64url(secrets.token_bytes(n))


# Re-export secrets used by callers that want to ensure the same RNG
# source everywhere.
__all__ = [
    "Keypair",
    "blake3_cid",
    "blake3_hash",
    "from_base64url",
    "generate_keypair",
    "public_key_from_private",
    "random_nonce",
    "sign",
    "to_base64url",
    "to_hex",
    "verify",
]
