"""Wire protocol types for openroom/1.

Source of truth is PROTOCOL.md at the repo root, mirrored from
packages/sdk/src/types.ts.

Design notes on the Python shape:

- **Envelopes and outgoing payloads are plain ``dict``s.** Trying to
  use dataclasses for payloads forces either (a) inclusion of None-valued
  optional fields in the canonical JSON (breaks signatures because the
  JS side omits them) or (b) a filter-None-on-serialize helper that
  silently drops legitimate null values. Dicts let callers express
  "don't include this key" by simply not including it.
- **Incoming events are typed dataclasses** parsed by ``parse_event``,
  because they have fixed shapes and callers benefit from
  ``match event:`` dispatch and attribute access.
- **TypedDicts document the payload shapes** for editor help and static
  checkers, without enforcing them at runtime.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal, NotRequired, TypedDict


# ---- Envelope ----

class Envelope(TypedDict):
    type: str
    id: str
    ts: int
    from_: str  # see note below
    sig: str
    payload: Any


# Python reserves ``from`` as a keyword, so TypedDict can't declare it
# as an attribute directly. In practice callers read envelopes as
# ``envelope["from"]`` (regular dict access works fine), and we only
# build outgoing envelopes via ``make_envelope`` which sets the key
# through dict literal syntax. The ``from_`` alias above is purely
# cosmetic for Python code that wants attribute-like access — ignore
# it if you prefer the literal string.


# ---- Common value types ----

@dataclass(frozen=True)
class AgentSummary:
    pubkey: str
    display_name: str | None = None
    description: str | None = None
    identity_attestation: dict[str, Any] | None = None
    viewer: bool = False

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> AgentSummary:
        return cls(
            pubkey=data["pubkey"],
            display_name=data.get("display_name"),
            description=data.get("description"),
            identity_attestation=data.get("identity_attestation"),
            viewer=bool(data.get("viewer", False)),
        )


@dataclass(frozen=True)
class TopicSummary:
    name: str
    subscribe_cap: str | None
    post_cap: str | None

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> TopicSummary:
        return cls(
            name=data["name"],
            subscribe_cap=data.get("subscribe_cap"),
            post_cap=data.get("post_cap"),
        )


@dataclass(frozen=True)
class ResourceSummary:
    cid: str
    name: str
    kind: str
    mime: str
    size: int
    created_by: str
    created_at: int
    validation_hook: str | None

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> ResourceSummary:
        return cls(
            cid=data["cid"],
            name=data["name"],
            kind=data["kind"],
            mime=data.get("mime", ""),
            size=data["size"],
            created_by=data["created_by"],
            created_at=data["created_at"],
            validation_hook=data.get("validation_hook"),
        )


@dataclass(frozen=True)
class AnnouncementSummary:
    room: str
    description: str
    announcer_session: str
    announced_at: int
    expires_at: int
    announcer_identity: str | None = None

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> AnnouncementSummary:
        return cls(
            room=data["room"],
            description=data["description"],
            announcer_session=data["announcer_session"],
            announcer_identity=data.get("announcer_identity"),
            announced_at=data["announced_at"],
            expires_at=data["expires_at"],
        )


# ---- Outgoing payloads (TypedDict for editor help only) ----

class JoinPayload(TypedDict):
    nonce: str
    display_name: NotRequired[str]
    description: NotRequired[str]
    features: NotRequired[list[str]]
    session_attestation: NotRequired[dict[str, Any]]
    viewer: NotRequired[bool]


class SendPayload(TypedDict):
    topic: str
    body: str
    reply_to: NotRequired[str]
    cap_proof: NotRequired[dict[str, Any]]


class DirectPayload(TypedDict):
    target: str
    body: str
    reply_to: NotRequired[str]


class CreateTopicPayload(TypedDict):
    name: str
    subscribe_cap: NotRequired[str | None]
    post_cap: NotRequired[str | None]


class SubscribePayload(TypedDict):
    topic: str
    proof: NotRequired[dict[str, Any]]


class ResourcePutPayload(TypedDict):
    name: str
    kind: str
    mime: NotRequired[str]
    content: str  # base64url
    validation_hook: NotRequired[str | None]
    cap_proof: NotRequired[dict[str, Any]]


# ---- Incoming events ----

@dataclass(frozen=True)
class ChallengeEvent:
    type: Literal["challenge"]
    nonce: str


@dataclass(frozen=True)
class JoinedEvent:
    type: Literal["joined"]
    room: str
    you: str
    agents: list[AgentSummary]
    topics: list[TopicSummary]
    resources: list[ResourceSummary]
    server_time: int


@dataclass(frozen=True)
class AgentsChangedEvent:
    type: Literal["agents_changed"]
    agents: list[AgentSummary]


@dataclass(frozen=True)
class MessageEvent:
    type: Literal["message"]
    room: str
    envelope: dict[str, Any]


@dataclass(frozen=True)
class DirectMessageEvent:
    type: Literal["direct_message"]
    room: str
    envelope: dict[str, Any]


@dataclass(frozen=True)
class TopicChangedEvent:
    type: Literal["topic_changed"]
    topic: str
    change: Literal["created", "deleted"]
    summary: TopicSummary | None = None


@dataclass(frozen=True)
class ResourceChangedEvent:
    type: Literal["resource_changed"]
    name: str
    change: Literal["put", "deleted"]
    summary: ResourceSummary | None = None


@dataclass(frozen=True)
class ErrorEvent:
    type: Literal["error"]
    reason: str
    request_id: str | None = None


@dataclass(frozen=True)
class RpcResult:
    """Generic envelope for `_result` events (send_result, create_topic_result,
    subscribe_result, direct_result, resource_put_result, announce_result, …).
    Carried as a dict so callers can read whatever fields the specific result
    type includes without needing a dozen dataclasses.
    """

    type: str
    id: str
    raw: dict[str, Any]

    @property
    def success(self) -> bool:
        return bool(self.raw.get("success", False))

    @property
    def error(self) -> str | None:
        err = self.raw.get("error")
        return err if isinstance(err, str) else None


ServerEvent = (
    ChallengeEvent
    | JoinedEvent
    | AgentsChangedEvent
    | MessageEvent
    | DirectMessageEvent
    | TopicChangedEvent
    | ResourceChangedEvent
    | ErrorEvent
    | RpcResult
)


_RPC_RESULT_TYPES = {
    "create_topic_result",
    "send_result",
    "direct_result",
    "subscribe_result",
    "unsubscribe_result",
    "list_topics_result",
    "resource_put_result",
    "resource_get_result",
    "resource_list_result",
    "resource_subscribe_result",
    "resource_unsubscribe_result",
    "announce_result",
    "unannounce_result",
    "list_public_rooms_result",
}


def parse_event(raw: dict[str, Any]) -> ServerEvent | None:
    """Parse a server→client JSON object into a typed event. Returns None
    for unknown event types so callers can discard them without crashing
    on forward-incompatible relay versions.
    """
    t = raw.get("type")
    if not isinstance(t, str):
        return None

    if t == "challenge":
        return ChallengeEvent(type="challenge", nonce=raw["nonce"])
    if t == "joined":
        return JoinedEvent(
            type="joined",
            room=raw["room"],
            you=raw["you"],
            agents=[AgentSummary.from_dict(a) for a in raw.get("agents", [])],
            topics=[TopicSummary.from_dict(tp) for tp in raw.get("topics", [])],
            resources=[
                ResourceSummary.from_dict(r) for r in raw.get("resources", [])
            ],
            server_time=raw.get("server_time", 0),
        )
    if t == "agents_changed":
        return AgentsChangedEvent(
            type="agents_changed",
            agents=[AgentSummary.from_dict(a) for a in raw.get("agents", [])],
        )
    if t == "message":
        return MessageEvent(
            type="message", room=raw["room"], envelope=raw["envelope"]
        )
    if t == "direct_message":
        return DirectMessageEvent(
            type="direct_message", room=raw["room"], envelope=raw["envelope"]
        )
    if t == "topic_changed":
        summary = raw.get("summary")
        return TopicChangedEvent(
            type="topic_changed",
            topic=raw["topic"],
            change=raw["change"],
            summary=TopicSummary.from_dict(summary) if summary else None,
        )
    if t == "resource_changed":
        summary = raw.get("summary")
        return ResourceChangedEvent(
            type="resource_changed",
            name=raw["name"],
            change=raw["change"],
            summary=ResourceSummary.from_dict(summary) if summary else None,
        )
    if t == "error":
        return ErrorEvent(
            type="error",
            reason=raw.get("reason", ""),
            request_id=raw.get("request_id"),
        )
    if t in _RPC_RESULT_TYPES:
        return RpcResult(type=t, id=raw.get("id", ""), raw=raw)

    return None


__all__ = [
    "AgentSummary",
    "AgentsChangedEvent",
    "AnnouncementSummary",
    "ChallengeEvent",
    "CreateTopicPayload",
    "DirectMessageEvent",
    "DirectPayload",
    "Envelope",
    "ErrorEvent",
    "JoinPayload",
    "JoinedEvent",
    "MessageEvent",
    "ResourceChangedEvent",
    "ResourcePutPayload",
    "ResourceSummary",
    "RpcResult",
    "SendPayload",
    "ServerEvent",
    "SubscribePayload",
    "TopicChangedEvent",
    "TopicSummary",
    "parse_event",
]
