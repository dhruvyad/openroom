"""Unit tests for session attestations + identity-file persistence.

Cross-language parity (a Python attestation verifies under the JS SDK
and vice versa) is asserted by the identity section of the python
cross-language smoke test, not here.
"""

from __future__ import annotations

import json
import os
import stat
from pathlib import Path

import pytest

from openroom import (
    SessionAttestation,
    generate_keypair,
    load_identity,
    load_or_create_identity,
    make_session_attestation,
    save_identity,
    to_base64url,
    verify_session_attestation,
)


# ---- session attestation ----


def test_attestation_roundtrip_verifies() -> None:
    identity = generate_keypair()
    session = generate_keypair()
    att = make_session_attestation(identity, session.public_key, "my-room")
    assert verify_session_attestation(att) is True


def test_attestation_fields_are_populated() -> None:
    identity = generate_keypair()
    session = generate_keypair()
    att = make_session_attestation(identity, session.public_key, "my-room")
    assert att.identity_pubkey == to_base64url(identity.public_key)
    assert att.session_pubkey == to_base64url(session.public_key)
    assert att.room == "my-room"
    assert att.expires_at > 0
    assert isinstance(att.sig, str) and len(att.sig) > 0


def test_attestation_rejects_different_room_in_verify() -> None:
    identity = generate_keypair()
    session = generate_keypair()
    att = make_session_attestation(identity, session.public_key, "room-a")
    # Tamper the room — signature should no longer match.
    tampered = SessionAttestation(
        identity_pubkey=att.identity_pubkey,
        session_pubkey=att.session_pubkey,
        room="room-b",
        expires_at=att.expires_at,
        sig=att.sig,
    )
    assert verify_session_attestation(tampered) is False


def test_attestation_rejects_expired() -> None:
    identity = generate_keypair()
    session = generate_keypair()
    att = make_session_attestation(
        identity, session.public_key, "r", expires_at=1_000
    )
    # Clock has moved way past 1_000 by now — must reject.
    assert verify_session_attestation(att, now=2_000) is False


def test_attestation_verify_accepts_dict_form() -> None:
    identity = generate_keypair()
    session = generate_keypair()
    att = make_session_attestation(identity, session.public_key, "r")
    assert verify_session_attestation(att.to_dict()) is True


def test_attestation_verify_rejects_missing_fields() -> None:
    assert verify_session_attestation({}) is False
    assert verify_session_attestation({"identity_pubkey": "x"}) is False


# ---- file persistence ----


def test_save_and_load_identity(tmp_path: Path) -> None:
    p = tmp_path / "identity.key"
    kp = generate_keypair()
    save_identity(kp, p)
    loaded = load_identity(p)
    assert loaded is not None
    assert loaded.private_key == kp.private_key
    assert loaded.public_key == kp.public_key


def test_save_identity_enforces_0600(tmp_path: Path) -> None:
    p = tmp_path / "identity.key"
    kp = generate_keypair()
    save_identity(kp, p)
    mode = stat.S_IMODE(os.stat(p).st_mode)
    assert mode == 0o600


def test_load_identity_returns_none_when_missing(tmp_path: Path) -> None:
    p = tmp_path / "nope.key"
    assert load_identity(p) is None


def test_load_identity_rejects_bad_kind(tmp_path: Path) -> None:
    p = tmp_path / "bad.key"
    p.write_text(json.dumps({"kind": "rsa", "private_key": "x", "public_key": "y"}))
    with pytest.raises(ValueError, match="unsupported kind"):
        load_identity(p)


def test_load_identity_rejects_mismatched_keys(tmp_path: Path) -> None:
    p = tmp_path / "mismatch.key"
    # Two distinct keypairs — pair one's private with the other's public.
    kp1 = generate_keypair()
    kp2 = generate_keypair()
    p.write_text(
        json.dumps(
            {
                "kind": "ed25519",
                "private_key": to_base64url(kp1.private_key),
                "public_key": to_base64url(kp2.public_key),
            }
        )
    )
    with pytest.raises(ValueError, match="mismatched"):
        load_identity(p)


def test_load_or_create_creates_once(tmp_path: Path) -> None:
    p = tmp_path / "lazy.key"
    first = load_or_create_identity(p)
    second = load_or_create_identity(p)
    # Second call must return the exact same keypair — it's a load,
    # not a fresh create.
    assert first.private_key == second.private_key
    assert first.public_key == second.public_key


def test_js_format_compatibility(tmp_path: Path) -> None:
    """The JS CLI writes identity files in the same schema we read. We
    lock the format to prevent accidental drift — if this test fails,
    the JS and Python SDKs would stop sharing identity keys."""
    p = tmp_path / "identity.key"
    kp = generate_keypair()
    save_identity(kp, p)
    stored = json.loads(p.read_text())
    assert stored["kind"] == "ed25519"
    assert "private_key" in stored
    assert "public_key" in stored
    # base64url is padless
    assert "=" not in stored["private_key"]
    assert "=" not in stored["public_key"]
