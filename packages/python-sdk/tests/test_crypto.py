"""Unit tests for crypto primitives.

Most of these are round-trip checks. Cross-language parity (Python signs,
JS verifies and vice versa) is covered by the cross-language smoke test
in scripts/python-smoke-test.sh.
"""

from __future__ import annotations

import pytest

from openroom import (
    blake3_cid,
    from_base64url,
    generate_keypair,
    sign,
    to_base64url,
    verify,
)


def test_keypair_generation_is_random() -> None:
    a = generate_keypair()
    b = generate_keypair()
    assert a.private_key != b.private_key
    assert len(a.private_key) == 32
    assert len(a.public_key) == 32


def test_sign_verify_roundtrip() -> None:
    kp = generate_keypair()
    msg = b"hello openroom"
    sig = sign(msg, kp.private_key)
    assert len(sig) == 64
    assert verify(sig, msg, kp.public_key) is True


def test_verify_rejects_tampered_message() -> None:
    kp = generate_keypair()
    sig = sign(b"hello", kp.private_key)
    assert verify(sig, b"hellO", kp.public_key) is False


def test_verify_rejects_wrong_key() -> None:
    kp1 = generate_keypair()
    kp2 = generate_keypair()
    sig = sign(b"hello", kp1.private_key)
    assert verify(sig, b"hello", kp2.public_key) is False


def test_verify_does_not_raise_on_malformed() -> None:
    # Matches JS SDK: verify returns False, never throws.
    assert verify(b"garbage", b"msg", b"not a key") is False


@pytest.mark.parametrize(
    "raw",
    [
        b"",
        b"\x00",
        b"hello",
        bytes(range(256)),
        b"\xff" * 32,
    ],
)
def test_base64url_roundtrip(raw: bytes) -> None:
    encoded = to_base64url(raw)
    assert "=" not in encoded  # no padding
    assert from_base64url(encoded) == raw


def test_base64url_rejects_invalid_chars() -> None:
    with pytest.raises(ValueError, match="invalid character"):
        from_base64url("abc$def")


def test_base64url_rejects_invalid_length() -> None:
    # Single trailing char is never valid base64
    with pytest.raises(ValueError, match="invalid input length"):
        from_base64url("a")


def test_base64url_accepts_padded_input() -> None:
    # Standard base64url is unpadded, but we accept padded for robustness
    # (matches the JS SDK which also strips trailing '=').
    assert from_base64url("aGVsbG8=") == b"hello"
    assert from_base64url("aGVsbG8") == b"hello"


def test_blake3_cid_format() -> None:
    cid = blake3_cid(b"hello")
    assert cid.startswith("blake3:")
    hex_part = cid.removeprefix("blake3:")
    assert len(hex_part) == 64
    assert int(hex_part, 16) >= 0  # valid hex


def test_blake3_cid_deterministic() -> None:
    assert blake3_cid(b"same") == blake3_cid(b"same")
    assert blake3_cid(b"same") != blake3_cid(b"diff")
