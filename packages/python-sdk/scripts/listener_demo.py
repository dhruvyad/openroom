"""Python listener for the cross-language smoke test.

Connects to the relay, subscribes to the main topic, waits for the
first message envelope from another agent, verifies its signature, and
asserts the body matches the expected value. Prints "ok" on success
and exits 0; on any mismatch or timeout, prints an error and exits 1.

Invoked by scripts/python-smoke-test.sh with:

    python listener_demo.py <relay_url> <room> <expected_body>
"""

from __future__ import annotations

import asyncio
import os
import sys

from openroom import Client
from openroom.envelope import verify_envelope


async def main() -> int:
    if len(sys.argv) < 4:
        print(
            "usage: listener_demo.py <relay_url> <room> <expected_body>",
            file=sys.stderr,
        )
        return 2
    relay_url, room, expected_body = sys.argv[1], sys.argv[2], sys.argv[3]
    timeout = float(os.environ.get("LISTENER_TIMEOUT", "10"))

    async with Client(
        relay_url=relay_url,
        room=room,
        display_name="python-listener",
    ) as client:
        # Once joined, wait for the first message event. The Client's
        # _recv_loop already drops envelopes with bad signatures, so if
        # we see a message it passed verify. We re-verify here too as a
        # belt-and-braces assertion for the smoke test.
        try:
            async with asyncio.timeout(timeout):
                async for event in client.events():
                    if event.type == "message":
                        env = event.envelope
                        if not verify_envelope(env):
                            print(
                                "FAIL: message failed signature verification",
                                file=sys.stderr,
                            )
                            return 1
                        payload = env.get("payload")
                        body = (
                            payload.get("body")
                            if isinstance(payload, dict)
                            else None
                        )
                        if body != expected_body:
                            print(
                                f"FAIL: body mismatch, got {body!r} expected {expected_body!r}",
                                file=sys.stderr,
                            )
                            return 1
                        print("ok")
                        return 0
        except TimeoutError:
            print(
                f"FAIL: no message received within {timeout}s",
                file=sys.stderr,
            )
            return 1
    return 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
