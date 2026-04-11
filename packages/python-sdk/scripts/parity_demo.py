"""Python side of the cross-language parity helper.

Modes (first argv):
  make-attestation    — emit a fresh session attestation as JSON
  verify-attestation  — read an attestation from stdin, print ok/fail
  make-cap            — emit a root → delegate cap chain + metadata
  verify-cap          — read a cap chain from stdin, verify, print ok/fail

The wire format of each wrapper JSON matches the JS-side parity helper
in packages/cli/scripts/py-compat-parity.ts, so either direction of the
pipe (JS-make → Python-verify, Python-make → JS-verify) works.
"""

from __future__ import annotations

import json
import sys

from openroom import (
    Cap,
    CapScope,
    delegate_cap,
    generate_keypair,
    make_root_cap,
    make_session_attestation,
    to_base64url,
    verify_cap_chain,
    verify_session_attestation,
)
from openroom.identity import SessionAttestation


def make_attestation(argv: list[str]) -> None:
    room = argv[0] if argv else "parity-test-room"
    identity = generate_keypair()
    session = generate_keypair()
    attestation = make_session_attestation(
        identity, session.public_key, room
    )
    print(
        json.dumps(
            {
                "room": room,
                "identity_pubkey": to_base64url(identity.public_key),
                "session_pubkey": to_base64url(session.public_key),
                "attestation": attestation.to_dict(),
            }
        )
    )


def verify_attestation(_argv: list[str]) -> int:
    raw = sys.stdin.read()
    try:
        wrapper = json.loads(raw)
    except json.JSONDecodeError as e:
        print(f"invalid json: {e}", file=sys.stderr)
        return 1
    att = SessionAttestation.from_dict(wrapper["attestation"])
    if verify_session_attestation(att):
        print("ok")
        return 0
    print("attestation verification failed", file=sys.stderr)
    return 1


def make_cap(_argv: list[str]) -> None:
    master = generate_keypair()
    trusted = generate_keypair()
    resource = "room:parity/topic:decisions"
    action = "post"
    root = make_root_cap(
        master.public_key,
        master.private_key,
        CapScope(resource="room:parity/*", action="*"),
    )
    leaf = delegate_cap(
        root,
        audience_pubkey=to_base64url(trusted.public_key),
        narrower_scope=CapScope(resource=resource, action=action),
        issuer_private_key=master.private_key,
    )
    print(
        json.dumps(
            {
                "expected_audience": to_base64url(trusted.public_key),
                "expected_root": to_base64url(master.public_key),
                "required_resource": resource,
                "required_action": action,
                "cap": leaf.to_dict(),
            }
        )
    )


def verify_cap(_argv: list[str]) -> int:
    raw = sys.stdin.read()
    try:
        wrapper = json.loads(raw)
    except json.JSONDecodeError as e:
        print(f"invalid json: {e}", file=sys.stderr)
        return 1
    cap = Cap.from_dict(wrapper["cap"])
    result = verify_cap_chain(
        cap,
        expected_audience=wrapper["expected_audience"],
        expected_root=wrapper["expected_root"],
        required_resource=wrapper["required_resource"],
        required_action=wrapper["required_action"],
    )
    if result.ok:
        print("ok")
        return 0
    print(f"cap verification failed: {result.reason}", file=sys.stderr)
    return 1


def main() -> int:
    if len(sys.argv) < 2:
        print("usage: parity_demo.py <mode> [args...]", file=sys.stderr)
        return 2
    mode = sys.argv[1]
    rest = sys.argv[2:]
    if mode == "make-attestation":
        make_attestation(rest)
        return 0
    if mode == "verify-attestation":
        return verify_attestation(rest)
    if mode == "make-cap":
        make_cap(rest)
        return 0
    if mode == "verify-cap":
        return verify_cap(rest)
    print(f"unknown mode: {mode}", file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main())
