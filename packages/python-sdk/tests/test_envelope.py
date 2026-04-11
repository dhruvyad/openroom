"""Unit tests for envelope construction and verification."""

from __future__ import annotations

from openroom import generate_keypair, make_envelope, verify_envelope
from openroom.crypto import to_base64url


def test_envelope_has_expected_fields() -> None:
    kp = generate_keypair()
    env = make_envelope("send", {"topic": "main", "body": "hi"}, kp.private_key, kp.public_key)
    assert env["type"] == "send"
    assert isinstance(env["id"], str) and len(env["id"]) > 0
    assert isinstance(env["ts"], int)
    assert env["from"] == to_base64url(kp.public_key)
    assert env["payload"] == {"topic": "main", "body": "hi"}
    assert isinstance(env["sig"], str) and len(env["sig"]) > 0


def test_envelope_roundtrip_verifies() -> None:
    kp = generate_keypair()
    env = make_envelope("ping", {"n": 1}, kp.private_key, kp.public_key)
    assert verify_envelope(env) is True


def test_verify_rejects_tampered_payload() -> None:
    kp = generate_keypair()
    env = make_envelope("ping", {"n": 1}, kp.private_key, kp.public_key)
    env["payload"] = {"n": 2}
    assert verify_envelope(env) is False


def test_verify_rejects_tampered_from() -> None:
    kp = generate_keypair()
    other = generate_keypair()
    env = make_envelope("ping", {}, kp.private_key, kp.public_key)
    env["from"] = to_base64url(other.public_key)
    assert verify_envelope(env) is False


def test_verify_rejects_missing_sig() -> None:
    kp = generate_keypair()
    env = make_envelope("ping", {}, kp.private_key, kp.public_key)
    del env["sig"]
    assert verify_envelope(env) is False


def test_verify_rejects_bad_base64() -> None:
    kp = generate_keypair()
    env = make_envelope("ping", {}, kp.private_key, kp.public_key)
    env["sig"] = "!!!not base64!!!"
    assert verify_envelope(env) is False


def test_envelope_ids_are_unique() -> None:
    kp = generate_keypair()
    e1 = make_envelope("ping", {}, kp.private_key, kp.public_key)
    e2 = make_envelope("ping", {}, kp.private_key, kp.public_key)
    assert e1["id"] != e2["id"]
