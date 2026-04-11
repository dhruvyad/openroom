"""Unit tests for UCAN-style capability chains."""

from __future__ import annotations

import time

from openroom import (
    CapScope,
    delegate_cap,
    generate_keypair,
    make_root_cap,
    to_base64url,
    verify_cap,
    verify_cap_chain,
)


def test_root_cap_is_self_issued_and_valid() -> None:
    kp = generate_keypair()
    cap = make_root_cap(
        kp.public_key,
        kp.private_key,
        CapScope(resource="room:my-room/*", action="*"),
    )
    assert cap.iss == cap.aud == to_base64url(kp.public_key)
    assert verify_cap(cap) is True


def test_verify_cap_rejects_tampered_scope() -> None:
    kp = generate_keypair()
    cap = make_root_cap(
        kp.public_key,
        kp.private_key,
        CapScope(resource="room:a/*", action="*"),
    )
    tampered = cap.__class__(
        iss=cap.iss,
        aud=cap.aud,
        cap=CapScope(resource="room:b/*", action="*"),
        nbf=cap.nbf,
        exp=cap.exp,
        nonce=cap.nonce,
        sig=cap.sig,
        proof=cap.proof,
    )
    assert verify_cap(tampered) is False


def test_delegate_chain_of_one() -> None:
    master = generate_keypair()
    trusted = generate_keypair()
    root = make_root_cap(
        master.public_key,
        master.private_key,
        CapScope(resource="room:r/topic:decisions", action="*"),
    )
    leaf = delegate_cap(
        root,
        audience_pubkey=to_base64url(trusted.public_key),
        narrower_scope=CapScope(
            resource="room:r/topic:decisions", action="post"
        ),
        issuer_private_key=master.private_key,
    )
    result = verify_cap_chain(
        leaf,
        expected_audience=to_base64url(trusted.public_key),
        expected_root=to_base64url(master.public_key),
        required_resource="room:r/topic:decisions",
        required_action="post",
    )
    assert result.ok is True, result.reason


def test_chain_detects_delegation_break() -> None:
    master = generate_keypair()
    trusted = generate_keypair()
    bystander = generate_keypair()
    root = make_root_cap(
        master.public_key,
        master.private_key,
        CapScope(resource="room:r/*", action="*"),
    )
    leaf = delegate_cap(
        root,
        audience_pubkey=to_base64url(trusted.public_key),
        narrower_scope=CapScope(resource="room:r/topic:t", action="post"),
        issuer_private_key=master.private_key,
    )
    # Expected audience is someone else — should reject.
    result = verify_cap_chain(
        leaf,
        expected_audience=to_base64url(bystander.public_key),
        expected_root=to_base64url(master.public_key),
        required_resource="room:r/topic:t",
        required_action="post",
    )
    assert result.ok is False
    assert result.reason is not None


def test_chain_rejects_wrong_root() -> None:
    master = generate_keypair()
    imposter = generate_keypair()
    trusted = generate_keypair()
    root = make_root_cap(
        master.public_key,
        master.private_key,
        CapScope(resource="room:r/*", action="*"),
    )
    leaf = delegate_cap(
        root,
        audience_pubkey=to_base64url(trusted.public_key),
        narrower_scope=CapScope(resource="room:r/topic:t", action="post"),
        issuer_private_key=master.private_key,
    )
    result = verify_cap_chain(
        leaf,
        expected_audience=to_base64url(trusted.public_key),
        expected_root=to_base64url(imposter.public_key),
        required_resource="room:r/topic:t",
        required_action="post",
    )
    assert result.ok is False
    assert "root cap iss" in (result.reason or "")


def test_chain_rejects_requested_action_outside_scope() -> None:
    master = generate_keypair()
    trusted = generate_keypair()
    root = make_root_cap(
        master.public_key,
        master.private_key,
        CapScope(resource="room:r/*", action="*"),
    )
    leaf = delegate_cap(
        root,
        audience_pubkey=to_base64url(trusted.public_key),
        # Post only — not subscribe.
        narrower_scope=CapScope(resource="room:r/topic:t", action="post"),
        issuer_private_key=master.private_key,
    )
    result = verify_cap_chain(
        leaf,
        expected_audience=to_base64url(trusted.public_key),
        expected_root=to_base64url(master.public_key),
        required_resource="room:r/topic:t",
        required_action="subscribe",
    )
    assert result.ok is False


def test_chain_rejects_expired_leaf() -> None:
    master = generate_keypair()
    trusted = generate_keypair()
    now = int(time.time())
    root = make_root_cap(
        master.public_key,
        master.private_key,
        CapScope(resource="room:r/*", action="*"),
    )
    # Build a leaf whose window has already ended.
    leaf = delegate_cap(
        root,
        audience_pubkey=to_base64url(trusted.public_key),
        narrower_scope=CapScope(resource="room:r/topic:t", action="post"),
        issuer_private_key=master.private_key,
        nbf=now - 100,
        exp=now - 50,
    )
    result = verify_cap_chain(
        leaf,
        expected_audience=to_base64url(trusted.public_key),
        expected_root=to_base64url(master.public_key),
        required_resource="room:r/topic:t",
        required_action="post",
        now=now,
    )
    assert result.ok is False
    assert "not valid at current time" in (result.reason or "")
