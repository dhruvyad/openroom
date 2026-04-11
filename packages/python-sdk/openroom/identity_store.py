"""File-backed persistence for long-lived identity keys.

Mirrors packages/sdk/src/identity-node.ts exactly — on-disk JSON format
is identical, so an identity file created by the JS CLI is loadable by
a Python agent and vice versa. The file at ``~/.openroom/identity/
default.key`` is the canonical cross-SDK identity location.

On-disk schema::

    {
        "kind": "ed25519",
        "private_key": "<base64url 32 bytes>",
        "public_key": "<base64url 32 bytes>"
    }

Save operations are atomic (tmp file + rename) and enforce 0600 perms
on the final inode even if umask stripped the bit at creation. Load
operations validate both key lengths (32 bytes each) and key integrity
— the stored public key must equal the derived public key from the
stored private key. This catches truncation, base64url corruption, and
bit-flips at load time instead of deep inside a later ``sign()`` call.
"""

from __future__ import annotations

import json
import os
import secrets
from pathlib import Path

from openroom.crypto import (
    Keypair,
    from_base64url,
    generate_keypair,
    public_key_from_private,
    to_base64url,
)

ED25519_KEY_LENGTH = 32


def default_identity_path() -> Path:
    """Canonical on-disk location for the identity keypair. Matches the
    JS CLI's ``~/.openroom/identity/default.key``."""
    return Path.home() / ".openroom" / "identity" / "default.key"


def load_identity(path: Path | str | None = None) -> Keypair | None:
    """Load an identity keypair from disk. Returns None if no file
    exists at ``path`` (or the default path).

    Raises ValueError on corruption: bad JSON, wrong kind tag, wrong
    key length, or mismatched public/private keys.
    """
    p = Path(path) if path is not None else default_identity_path()
    try:
        raw = p.read_text(encoding="utf-8")
    except FileNotFoundError:
        return None

    try:
        stored = json.loads(raw)
    except json.JSONDecodeError as e:
        raise ValueError(f"identity file at {p} is not valid JSON: {e}") from e

    if stored.get("kind") != "ed25519":
        raise ValueError(
            f"identity file at {p} has unsupported kind: {stored.get('kind')!r}"
        )
    if not isinstance(stored.get("private_key"), str) or not isinstance(
        stored.get("public_key"), str
    ):
        raise ValueError(f"identity file at {p} missing key fields")

    private_key = from_base64url(stored["private_key"])
    public_key = from_base64url(stored["public_key"])

    if len(private_key) != ED25519_KEY_LENGTH:
        raise ValueError(
            f"identity file at {p} private_key is {len(private_key)} bytes,"
            f" expected {ED25519_KEY_LENGTH}"
        )
    if len(public_key) != ED25519_KEY_LENGTH:
        raise ValueError(
            f"identity file at {p} public_key is {len(public_key)} bytes,"
            f" expected {ED25519_KEY_LENGTH}"
        )

    derived = public_key_from_private(private_key)
    if not _ct_equal(derived, public_key):
        raise ValueError(
            f"identity file at {p} has mismatched private/public keys"
            " (corruption?)"
        )

    return Keypair(private_key=private_key, public_key=public_key)


def save_identity(keypair: Keypair, path: Path | str | None = None) -> None:
    """Save an identity keypair to disk atomically (write to tmp +
    rename) with 0600 perms. The rename is atomic on POSIX, so crashing
    mid-write leaves the previous file intact. Mode is enforced on the
    tmp file before rename so overwriting an existing file with looser
    permissions (e.g. an older 0644 file from a backup) lands the
    final inode at 0600.
    """
    p = Path(path) if path is not None else default_identity_path()
    p.parent.mkdir(parents=True, exist_ok=True, mode=0o700)

    stored = {
        "kind": "ed25519",
        "private_key": to_base64url(keypair.private_key),
        "public_key": to_base64url(keypair.public_key),
    }
    data = json.dumps(stored, indent=2).encode("utf-8")

    tmp = p.with_suffix(f".tmp.{os.getpid()}.{secrets.token_hex(4)}")
    with open(tmp, "wb") as fh:
        fh.write(data)
    os.chmod(tmp, 0o600)
    os.replace(tmp, p)


def load_or_create_identity(
    path: Path | str | None = None,
) -> Keypair:
    """Load the identity keypair if it exists, otherwise generate one
    and save it atomically.

    Uses ``O_CREAT | O_EXCL`` so two concurrent callers on the same path
    don't both win the "create new key" race — whichever caller loses
    re-reads the winner's file instead of overwriting it, so the
    in-memory and on-disk keypairs agree.
    """
    p = Path(path) if path is not None else default_identity_path()

    existing = load_identity(p)
    if existing is not None:
        return existing

    fresh = generate_keypair()
    p.parent.mkdir(parents=True, exist_ok=True, mode=0o700)

    stored = {
        "kind": "ed25519",
        "private_key": to_base64url(fresh.private_key),
        "public_key": to_base64url(fresh.public_key),
    }
    data = json.dumps(stored, indent=2).encode("utf-8")

    try:
        fd = os.open(
            str(p),
            os.O_WRONLY | os.O_CREAT | os.O_EXCL,
            0o600,
        )
    except FileExistsError:
        # Another caller beat us to it — re-read their file so the two
        # of us agree on the key.
        winning = load_identity(p)
        if winning is None:
            raise
        return winning

    try:
        with os.fdopen(fd, "wb") as fh:
            fh.write(data)
        os.chmod(p, 0o600)
    except BaseException:
        try:
            os.unlink(p)
        except OSError:
            pass
        raise

    return fresh


def _ct_equal(a: bytes, b: bytes) -> bool:
    if len(a) != len(b):
        return False
    diff = 0
    for x, y in zip(a, b):
        diff |= x ^ y
    return diff == 0


__all__ = [
    "default_identity_path",
    "load_identity",
    "load_or_create_identity",
    "save_identity",
]
