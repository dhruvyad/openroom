"""Async WebSocket client for the openroom relay.

Mirrors packages/sdk/src/client.ts at the protocol level. The API is
deliberately smaller than the JS Client — this is the minimum needed for
an agent to join a room, send/receive messages, subscribe to topics,
create topics, and put/get resources. Identity attestations and
capability chains will land in a follow-up.

Usage:

    import asyncio
    from openroom import Client, generate_keypair

    async def main():
        async with Client(
            relay_url="wss://relay.openroom.channel",
            room="my-room",
            display_name="python-agent",
        ) as client:
            await client.send("hello")
            async for event in client.events():
                if event.type == "message":
                    print(event.envelope["payload"])

    asyncio.run(main())
"""

from __future__ import annotations

import asyncio
import json
from contextlib import AbstractAsyncContextManager
from typing import Any, AsyncIterator, Awaitable, Callable
from urllib.parse import quote

import websockets
from websockets.asyncio.client import ClientConnection

from openroom.cap import Cap
from openroom.crypto import Keypair, generate_keypair, to_base64url
from openroom.envelope import make_envelope, verify_envelope
from openroom.identity import make_session_attestation
from openroom.types import (
    AgentSummary,
    RecentMessage,
    ResourceSummary,
    RpcResult,
    ServerEvent,
    TopicSummary,
    parse_event,
)


DEFAULT_TIMEOUT = 5.0
DEFAULT_TOPIC = "main"

# Text-frame keepalive interval. Every tick we send raw text "ping"
# which the relay handles in its webSocketMessage handler, waking the
# Durable Object and refreshing its binding to this socket. The
# websockets library also sends protocol PING control frames at its
# own ping_interval (default 20s) which keeps the TCP/NAT layer warm;
# the two work together the same way the JS SDK does.
#
# 10s interval with a 3s kickoff after join keeps us well under any
# consumer NAT idle timeout and any CF edge cleanup window.
KEEPALIVE_INTERVAL_SECONDS = 10.0
KEEPALIVE_KICKOFF_SECONDS = 3.0
# Built-in protocol ping cadence. websockets sends a PING control
# frame every ping_interval seconds and expects a PONG within
# ping_timeout or the connection is considered dead.
PROTOCOL_PING_INTERVAL_SECONDS = 20.0
PROTOCOL_PING_TIMEOUT_SECONDS = 20.0
# Exponential backoff for auto-reconnect.
RECONNECT_BASE_DELAY_SECONDS = 1.0
RECONNECT_MAX_DELAY_SECONDS = 30.0


class ClientError(Exception):
    """Raised when the relay returns an error result for an RPC."""


class Client(AbstractAsyncContextManager):
    """Async openroom client.

    Construct with ``relay_url``, ``room``, and an optional ``keypair``
    (generated fresh if not supplied). Use as an async context manager to
    auto-connect on enter and clean-leave on exit, or call ``connect()``
    and ``leave()`` manually.
    """

    def __init__(
        self,
        *,
        relay_url: str,
        room: str,
        keypair: Keypair | None = None,
        identity_keypair: Keypair | None = None,
        display_name: str | None = None,
        description: str | None = None,
        viewer: bool = False,
        timeout: float = DEFAULT_TIMEOUT,
        auto_reconnect: bool = False,
    ) -> None:
        self._relay_url = relay_url.rstrip("/")
        self._room = room
        self._keypair = keypair or generate_keypair()
        # Optional long-lived identity. When supplied, the client
        # automatically attaches a session attestation to the join
        # payload so peers recognize this session as the same identity
        # across reconnects. Survives the life of the Client instance.
        self._identity_keypair = identity_keypair
        self._display_name = display_name
        self._description = description
        self._viewer = viewer
        self._timeout = timeout
        self._auto_reconnect = auto_reconnect

        self._ws: ClientConnection | None = None
        self._recv_task: asyncio.Task[None] | None = None
        self._keepalive_task: asyncio.Task[None] | None = None
        self._reconnect_task: asyncio.Task[None] | None = None
        self._event_queue: asyncio.Queue[ServerEvent | None] = asyncio.Queue()
        self._pending: dict[str, asyncio.Future[RpcResult]] = {}
        self._joined = asyncio.Event()
        self._join_error: str | None = None
        # True once leave() has been called so the recv loop's
        # termination handler knows not to reconnect.
        self._leaving = False
        # Topics this client has explicitly subscribed to via
        # subscribe(). Tracked separately from self._topics (which is
        # the room-wide list) so auto-reconnect can re-establish them
        # after a fresh join.
        self._subscribed_topics: set[str] = set()
        self._reconnect_attempt = 0

        self._agents: list[AgentSummary] = []
        self._topics: list[TopicSummary] = []
        self._resources: list[ResourceSummary] = []
        self._recent_messages: list[RecentMessage] = []
        self._you: str = ""

    # ---- lifecycle ----

    @property
    def session_pubkey(self) -> str:
        """Base64url-encoded session public key. Matches the ``from`` field
        the relay sees on every envelope from this client."""
        return to_base64url(self._keypair.public_key)

    @property
    def identity_pubkey(self) -> str | None:
        """Base64url-encoded long-lived identity pubkey, or None if no
        identity keypair was supplied. Peers use this to recognize the
        same agent across reconnects."""
        if self._identity_keypair is None:
            return None
        return to_base64url(self._identity_keypair.public_key)

    @property
    def room(self) -> str:
        return self._room

    @property
    def agents(self) -> list[AgentSummary]:
        """Latest agent list from the most recent ``agents_changed`` event."""
        return list(self._agents)

    @property
    def topics(self) -> list[TopicSummary]:
        return list(self._topics)

    @property
    def resources(self) -> list[ResourceSummary]:
        return list(self._resources)

    @property
    def recent_messages(self) -> list[RecentMessage]:
        """History buffer delivered by the relay in the joined event,
        oldest first. Callers rendering a feed should seed it from
        this on connect and layer live events on top.
        """
        return list(self._recent_messages)

    async def __aenter__(self) -> Client:
        await self.connect()
        return self

    async def __aexit__(self, exc_type, exc, tb) -> None:
        await self.leave()

    async def connect(self) -> None:
        """Open the WebSocket, respond to the challenge, and wait for the
        ``joined`` event (or raise on join failure)."""
        await self._open_socket()

    async def _open_socket(self) -> None:
        url = f"{self._relay_url}/v1/room/{quote(self._room, safe='')}"
        self._joined.clear()
        self._join_error = None
        # ping_interval/ping_timeout give us protocol-level PING
        # control frames handled by the websockets library — these
        # are the analog of the JS SDK's ws.ping(). They keep TCP
        # and CF edge state warm without needing anything from our
        # own code. We still send text "ping" in _keepalive_loop so
        # the relay DO wakes up and refreshes its socket binding.
        self._ws = await websockets.connect(
            url,
            ping_interval=PROTOCOL_PING_INTERVAL_SECONDS,
            ping_timeout=PROTOCOL_PING_TIMEOUT_SECONDS,
        )
        self._recv_task = asyncio.create_task(self._recv_loop())
        try:
            await asyncio.wait_for(self._joined.wait(), timeout=self._timeout)
        except TimeoutError:
            await self._close(final=True)
            raise ClientError("join timeout")
        if self._join_error is not None:
            err = self._join_error
            await self._close(final=True)
            raise ClientError(f"join failed: {err}")

    async def leave(self) -> None:
        """Send a ``leave`` envelope and close the connection."""
        self._leaving = True
        if self._reconnect_task is not None and not self._reconnect_task.done():
            self._reconnect_task.cancel()
            try:
                await self._reconnect_task
            except (asyncio.CancelledError, Exception):
                pass
            self._reconnect_task = None
        if self._ws is not None:
            try:
                envelope = make_envelope(
                    "leave",
                    {},
                    self._keypair.private_key,
                    self._keypair.public_key,
                )
                await self._ws.send(json.dumps(envelope))
            except Exception:
                pass  # already closing
        await self._close(final=True)

    async def _close(self, *, final: bool) -> None:
        """Tear down the current WebSocket and associated tasks.

        When ``final`` is True (explicit leave or reconnect-disabled
        terminal close), also terminates the event queue so any
        outstanding events() iterator sees termination.
        """
        self._stop_keepalive()
        if self._ws is not None:
            try:
                await self._ws.close()
            except Exception:
                pass
            self._ws = None
        if self._recv_task is not None and not self._recv_task.done():
            self._recv_task.cancel()
            try:
                await self._recv_task
            except (asyncio.CancelledError, Exception):
                pass
            self._recv_task = None
        if final:
            await self._event_queue.put(None)

    def _start_keepalive(self) -> None:
        """Start the text-frame keepalive loop. Each tick sends raw
        "ping" which the relay handles in its webSocketMessage
        handler, waking the Durable Object and refreshing its
        binding to this socket. Runs in parallel to the websockets
        library's built-in protocol ping (configured at connect)."""
        if self._keepalive_task is not None:
            return
        self._keepalive_task = asyncio.create_task(self._keepalive_loop())

    def _stop_keepalive(self) -> None:
        if self._keepalive_task is None:
            return
        self._keepalive_task.cancel()
        self._keepalive_task = None

    async def _keepalive_loop(self) -> None:
        try:
            # Kickoff ping a few seconds after join so there's TCP
            # activity within the consumer-NAT idle window, matching
            # the JS SDK's kickoff behavior.
            await asyncio.sleep(KEEPALIVE_KICKOFF_SECONDS)
            while True:
                ws = self._ws
                if ws is None:
                    return
                try:
                    await ws.send("ping")
                except Exception:
                    return
                await asyncio.sleep(KEEPALIVE_INTERVAL_SECONDS)
        except asyncio.CancelledError:
            return

    async def _schedule_reconnect(self) -> None:
        """Kick off a reconnect attempt after exponential backoff.
        Called from the recv loop when the WebSocket closes
        unexpectedly and auto_reconnect is enabled."""
        if self._leaving or not self._auto_reconnect:
            return
        if self._reconnect_task is not None and not self._reconnect_task.done():
            return
        self._reconnect_task = asyncio.create_task(self._run_reconnect())

    async def _run_reconnect(self) -> None:
        try:
            delay = min(
                RECONNECT_MAX_DELAY_SECONDS,
                RECONNECT_BASE_DELAY_SECONDS * (2**self._reconnect_attempt),
            )
            self._reconnect_attempt += 1
            await asyncio.sleep(delay)
            # Tear down whatever half-alive state is left without
            # pushing a final None to the event queue — callers of
            # events() should see live messages from the fresh ws.
            await self._close(final=False)
            await self._open_socket()
            # Resume previously-subscribed topics.
            topics_to_resume = list(self._subscribed_topics)
            self._subscribed_topics.clear()
            for topic in topics_to_resume:
                try:
                    await self.subscribe(topic)
                except Exception:
                    # Per-topic failure is non-fatal; leave it out of
                    # the resumed set so the caller can retry if they
                    # care.
                    pass
            self._reconnect_attempt = 0
        except asyncio.CancelledError:
            raise
        except Exception:
            # Reconnect attempt failed. The new ws is either not
            # open or closed again already. If auto_reconnect is
            # still on and we're not leaving, schedule another
            # attempt with the next backoff step.
            if self._auto_reconnect and not self._leaving:
                self._reconnect_task = None
                await self._schedule_reconnect()

    # ---- event stream ----

    async def events(self) -> AsyncIterator[ServerEvent]:
        """Yield server events as they arrive. Terminates when the
        connection closes or the client leaves."""
        while True:
            event = await self._event_queue.get()
            if event is None:
                return
            yield event

    # ---- RPCs ----

    async def send(
        self,
        body: str,
        topic: str = DEFAULT_TOPIC,
        *,
        reply_to: str | None = None,
        cap: Cap | None = None,
    ) -> None:
        """Send a message to a topic. Raises ClientError on relay rejection.

        For a gated topic (``post_cap`` set), pass a ``cap`` whose leaf
        audience is this session or the attested identity and whose root
        matches the topic's ``post_cap``.
        """
        payload: dict[str, Any] = {"topic": topic, "body": body}
        if reply_to is not None:
            payload["reply_to"] = reply_to
        if cap is not None:
            payload["cap_proof"] = cap.to_dict()
        result = await self._request("send", payload)
        self._raise_if_failed(result, "send")

    async def send_direct(
        self,
        target: str,
        body: str,
        *,
        reply_to: str | None = None,
    ) -> None:
        """Send a direct message to a specific agent. Note: DMs are
        room-wide broadcasts, not private routes — every agent and viewer
        in the room receives the event. ``target`` is a UI hint for the
        intended recipient."""
        payload: dict[str, Any] = {"target": target, "body": body}
        if reply_to is not None:
            payload["reply_to"] = reply_to
        result = await self._request("direct", payload)
        self._raise_if_failed(result, "direct")

    async def create_topic(
        self,
        name: str,
        *,
        subscribe_cap: str | None = None,
        post_cap: str | None = None,
    ) -> TopicSummary:
        payload: dict[str, Any] = {
            "name": name,
            "subscribe_cap": subscribe_cap,
            "post_cap": post_cap,
        }
        result = await self._request("create_topic", payload)
        self._raise_if_failed(result, "create_topic")
        topic_raw = result.raw.get("topic")
        if not isinstance(topic_raw, dict):
            raise ClientError("create_topic returned no topic summary")
        return TopicSummary.from_dict(topic_raw)

    async def subscribe(self, topic: str, *, cap: Cap | None = None) -> None:
        """Subscribe to a topic. For a gated topic (``subscribe_cap``
        set), pass a ``cap`` authorizing subscribe on the topic."""
        payload: dict[str, Any] = {"topic": topic}
        if cap is not None:
            payload["proof"] = cap.to_dict()
        result = await self._request("subscribe", payload)
        self._raise_if_failed(result, "subscribe")
        self._subscribed_topics.add(topic)

    async def unsubscribe(self, topic: str) -> None:
        result = await self._request("unsubscribe", {"topic": topic})
        self._raise_if_failed(result, "unsubscribe")
        self._subscribed_topics.discard(topic)

    async def list_topics(self) -> list[TopicSummary]:
        result = await self._request("list_topics", {})
        raw_topics = result.raw.get("topics", [])
        return [TopicSummary.from_dict(t) for t in raw_topics]

    async def put_resource(
        self,
        name: str,
        content: bytes | str,
        *,
        kind: str = "blob",
        mime: str | None = None,
        validation_hook: str | None = None,
        cap: Cap | None = None,
    ) -> ResourceSummary:
        """Write a resource to the room. If the existing slot has a
        ``validation_hook`` set, pass a ``cap`` whose root matches it.
        """
        if isinstance(content, str):
            content_bytes = content.encode("utf-8")
        else:
            content_bytes = content
        payload: dict[str, Any] = {
            "name": name,
            "kind": kind,
            "content": to_base64url(content_bytes),
            "validation_hook": validation_hook,
        }
        if mime is not None:
            payload["mime"] = mime
        if cap is not None:
            payload["cap_proof"] = cap.to_dict()
        result = await self._request("resource_put", payload)
        self._raise_if_failed(result, "resource_put")
        summary = result.raw.get("summary")
        if not isinstance(summary, dict):
            raise ClientError("resource_put returned no summary")
        return ResourceSummary.from_dict(summary)

    async def get_resource(
        self, *, name: str | None = None, cid: str | None = None
    ) -> tuple[ResourceSummary, bytes]:
        if name is None and cid is None:
            raise ValueError("get_resource requires name or cid")
        payload: dict[str, Any] = {}
        if name is not None:
            payload["name"] = name
        if cid is not None:
            payload["cid"] = cid
        result = await self._request("resource_get", payload)
        self._raise_if_failed(result, "resource_get")
        summary = result.raw.get("summary")
        content_b64 = result.raw.get("content")
        if not isinstance(summary, dict) or not isinstance(content_b64, str):
            raise ClientError("resource_get returned no content")
        from openroom.crypto import blake3_cid, from_base64url

        content = from_base64url(content_b64)
        # Verify the server-reported CID matches the content hash — the
        # relay could lie; we re-derive locally and refuse on mismatch.
        derived = blake3_cid(content)
        if derived != summary["cid"]:
            raise ClientError(
                f"resource content hash mismatch: {derived} vs {summary['cid']}"
            )
        return ResourceSummary.from_dict(summary), content

    # ---- internal ----

    def _raise_if_failed(self, result: RpcResult, op: str) -> None:
        if not result.success:
            raise ClientError(result.error or f"{op} failed")

    async def _request(self, type: str, payload: Any) -> RpcResult:
        if self._ws is None:
            raise ClientError("not connected")
        envelope = make_envelope(
            type,
            payload,
            self._keypair.private_key,
            self._keypair.public_key,
        )
        request_id = envelope["id"]
        fut: asyncio.Future[RpcResult] = asyncio.get_running_loop().create_future()
        self._pending[request_id] = fut
        await self._ws.send(json.dumps(envelope))
        try:
            return await asyncio.wait_for(fut, timeout=self._timeout)
        except TimeoutError:
            self._pending.pop(request_id, None)
            raise ClientError(f"{type} timed out")

    async def _recv_loop(self) -> None:
        assert self._ws is not None
        try:
            async for raw in self._ws:
                if isinstance(raw, bytes):
                    raw = raw.decode("utf-8")
                try:
                    data = json.loads(raw)
                except json.JSONDecodeError:
                    continue
                await self._handle_raw(data)
        except websockets.ConnectionClosed:
            pass
        finally:
            # Flush any pending RPCs with a connection-closed error so
            # callers don't hang forever.
            for fut in list(self._pending.values()):
                if not fut.done():
                    fut.set_exception(ClientError("connection closed"))
            self._pending.clear()
            self._joined.clear()
            # Auto-reconnect if enabled and the termination wasn't
            # triggered by an explicit leave(). Otherwise emit the
            # None sentinel so events() callers see termination.
            if self._auto_reconnect and not self._leaving:
                await self._schedule_reconnect()
            else:
                await self._event_queue.put(None)

    async def _handle_raw(self, data: dict[str, Any]) -> None:
        event = parse_event(data)
        if event is None:
            return

        # Route RPC results to waiting futures.
        if isinstance(event, RpcResult):
            fut = self._pending.pop(event.id, None)
            if fut is not None and not fut.done():
                fut.set_result(event)
            return

        if event.type == "challenge":
            await self._send_join(event.nonce)
            return

        if event.type == "joined":
            self._you = event.you
            self._agents = event.agents
            self._topics = event.topics
            self._resources = event.resources
            # Verify each backfilled envelope's signature locally — the
            # relay could be compromised and fabricate history, so we
            # drop entries that don't verify against their own `from`
            # pubkey.
            self._recent_messages = [
                m for m in event.recent_messages
                if verify_envelope(m.envelope)
            ]
            self._start_keepalive()
            self._joined.set()
            await self._event_queue.put(event)
            return

        if event.type == "agents_changed":
            self._agents = event.agents

        if event.type == "message":
            if not verify_envelope(event.envelope):
                # Drop forwarded messages with bad signatures. Symmetric
                # with the JS client — a compromised peer can try to
                # inject, but the signature check catches it.
                return

        if event.type == "direct_message":
            if not verify_envelope(event.envelope):
                return

        if event.type == "error" and not self._joined.is_set():
            self._join_error = event.reason
            self._joined.set()
            return

        await self._event_queue.put(event)

    async def _send_join(self, nonce: str) -> None:
        assert self._ws is not None
        payload: dict[str, Any] = {
            "nonce": nonce,
            "features": ["openroom/1"],
        }
        if self._display_name is not None:
            payload["display_name"] = self._display_name
        if self._description is not None:
            payload["description"] = self._description
        if self._viewer:
            payload["viewer"] = True
        if self._identity_keypair is not None:
            # Bind this ephemeral session key to the long-lived
            # identity, scoped to this room. The relay stores the
            # attestation in the agent's state so peers see the
            # identity pubkey alongside the session pubkey.
            attestation = make_session_attestation(
                self._identity_keypair,
                self._keypair.public_key,
                self._room,
            )
            payload["session_attestation"] = attestation.to_dict()

        envelope = make_envelope(
            "join",
            payload,
            self._keypair.private_key,
            self._keypair.public_key,
        )
        await self._ws.send(json.dumps(envelope))


__all__ = ["Client", "ClientError"]
