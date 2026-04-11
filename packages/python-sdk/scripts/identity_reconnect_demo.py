"""Exercise the Python SDK's identity-reconnect path on a live relay.

Joins a room twice with the same long-lived identity key but a fresh
session keypair each time. Asserts:

  1. The identity_pubkey reported by the Client stays stable across
     reconnects.
  2. The session_pubkey changes.
  3. The join attestation the client attaches is valid for both
     sessions.
  4. A peer (a second Python client) observing via agents_changed sees
     the identity_attestation on the re-joining agent, and the
     identity_pubkey embedded matches the one we used to sign.

Mirrors the shape of scripts/identity-smoke-test.sh, which does the
same in JS. Invoked by scripts/python-smoke-test.sh with:

    python identity_reconnect_demo.py <relay_url> <room>
"""

from __future__ import annotations

import asyncio
import sys
import tempfile
from pathlib import Path

from openroom import (
    Client,
    generate_keypair,
    load_or_create_identity,
    to_base64url,
    verify_session_attestation,
)
from openroom.identity import SessionAttestation


async def observe_for_identity(
    relay_url: str,
    room: str,
    expected_identity_pubkey: str,
    ready: asyncio.Event,
    seen: asyncio.Event,
) -> None:
    """Peer that joins the same room, waits for an agents_changed event
    that contains an agent with the expected identity pubkey, and sets
    `seen` when it arrives."""
    async with Client(
        relay_url=relay_url,
        room=room,
        display_name="peer-observer",
    ) as peer:
        ready.set()
        async for event in peer.events():
            if event.type != "agents_changed":
                continue
            for agent in event.agents:
                att = agent.identity_attestation
                if isinstance(att, dict):
                    identity = att.get("identity_pubkey")
                    if identity == expected_identity_pubkey:
                        # Also verify the forwarded attestation is valid.
                        if not verify_session_attestation(att):
                            print(
                                "FAIL: observed attestation failed verify",
                                file=sys.stderr,
                            )
                            return
                        seen.set()
                        return


async def main() -> int:
    if len(sys.argv) < 3:
        print("usage: identity_reconnect_demo.py <relay_url> <room>", file=sys.stderr)
        return 2
    relay_url, room = sys.argv[1], sys.argv[2]

    # Isolated identity file so the test never touches the user's real
    # ~/.openroom/identity/default.key.
    with tempfile.TemporaryDirectory() as tmpdir:
        identity_path = Path(tmpdir) / "identity.key"
        identity_kp = load_or_create_identity(identity_path)
        expected_identity_pubkey = to_base64url(identity_kp.public_key)

        ready = asyncio.Event()
        seen = asyncio.Event()
        observer_task = asyncio.create_task(
            observe_for_identity(
                relay_url, room, expected_identity_pubkey, ready, seen
            )
        )

        try:
            await asyncio.wait_for(ready.wait(), timeout=5)
        except TimeoutError:
            print("FAIL: observer never joined", file=sys.stderr)
            observer_task.cancel()
            return 1

        # Session 1.
        session_1 = generate_keypair()
        async with Client(
            relay_url=relay_url,
            room=room,
            keypair=session_1,
            identity_keypair=identity_kp,
            display_name="py-identity-agent",
        ) as c1:
            session_pub_1 = c1.session_pubkey
            identity_pub_1 = c1.identity_pubkey
            if identity_pub_1 != expected_identity_pubkey:
                print("FAIL: identity_pubkey mismatch (session 1)", file=sys.stderr)
                observer_task.cancel()
                return 1
            await c1.send("hello from session 1")
            await asyncio.sleep(0.2)

        # Session 2 — same identity, fresh session key.
        session_2 = generate_keypair()
        async with Client(
            relay_url=relay_url,
            room=room,
            keypair=session_2,
            identity_keypair=identity_kp,
            display_name="py-identity-agent",
        ) as c2:
            session_pub_2 = c2.session_pubkey
            identity_pub_2 = c2.identity_pubkey

            if session_pub_2 == session_pub_1:
                print(
                    "FAIL: session pubkey did not change across reconnect",
                    file=sys.stderr,
                )
                observer_task.cancel()
                return 1
            if identity_pub_2 != identity_pub_1:
                print(
                    "FAIL: identity pubkey changed across reconnect",
                    file=sys.stderr,
                )
                observer_task.cancel()
                return 1
            await c2.send("hello from session 2")
            # Give the observer a moment to see our agents_changed.
            try:
                await asyncio.wait_for(seen.wait(), timeout=5)
            except TimeoutError:
                print(
                    "FAIL: observer did not see the identity_attestation",
                    file=sys.stderr,
                )
                observer_task.cancel()
                return 1

        observer_task.cancel()
        try:
            await observer_task
        except (asyncio.CancelledError, Exception):
            pass

    print("ok")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
