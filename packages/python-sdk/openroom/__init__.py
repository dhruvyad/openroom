"""openroom — Python SDK for the openroom coordination protocol.

Re-exports the public surface so callers can `from openroom import Client,
make_envelope, generate_keypair` instead of reaching into submodules.
"""

from openroom.client import Client
from openroom.crypto import (
    blake3_cid,
    from_base64url,
    generate_keypair,
    sign,
    to_base64url,
    verify,
    Keypair,
)
from openroom.envelope import make_envelope, verify_envelope
from openroom.jcs import canonicalize
from openroom.types import (
    AgentSummary,
    DirectMessageEvent,
    DirectPayload,
    Envelope,
    JoinPayload,
    MessageEvent,
    SendPayload,
    ServerEvent,
    TopicSummary,
)

__version__ = "0.0.1"

__all__ = [
    "Client",
    "Envelope",
    "Keypair",
    "JoinPayload",
    "SendPayload",
    "DirectPayload",
    "AgentSummary",
    "TopicSummary",
    "MessageEvent",
    "DirectMessageEvent",
    "ServerEvent",
    "make_envelope",
    "verify_envelope",
    "canonicalize",
    "generate_keypair",
    "sign",
    "verify",
    "to_base64url",
    "from_base64url",
    "blake3_cid",
]
