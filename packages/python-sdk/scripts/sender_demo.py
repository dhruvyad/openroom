"""Python sender half of the cross-language smoke test.

Joins the room, sends a single message, and exits. The JS-side listener
(scripts/python-smoke-test.sh uses the reference CLI's `listen`) must
verify the Python envelope's signature before we call it a success.

Invoked by the smoke test script with:

    python sender_demo.py <relay_url> <room> <body>
"""

from __future__ import annotations

import asyncio
import sys

from openroom import Client


async def main() -> int:
    if len(sys.argv) < 4:
        print(
            "usage: sender_demo.py <relay_url> <room> <body>",
            file=sys.stderr,
        )
        return 2
    relay_url, room, body = sys.argv[1], sys.argv[2], sys.argv[3]

    async with Client(
        relay_url=relay_url,
        room=room,
        display_name="python-sender",
    ) as client:
        await client.send(body)
        # Tiny grace period so the send_result is processed before leave.
        await asyncio.sleep(0.2)
    print("ok")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
