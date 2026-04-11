"""openroom — Python SDK for the openroom coordination protocol.

Re-exports the public surface so callers can `from openroom import Client,
make_envelope, generate_keypair` instead of reaching into submodules.
"""

from openroom.cap import (
    Cap,
    CapScope,
    CapVerifyResult,
    cap_covers,
    delegate_cap,
    make_root_cap,
    sign_cap,
    verify_cap,
    verify_cap_chain,
)
from openroom.client import Client, ClientError
from openroom.crypto import (
    Keypair,
    blake3_cid,
    from_base64url,
    generate_keypair,
    sign,
    to_base64url,
    verify,
)
from openroom.envelope import make_envelope, verify_envelope
from openroom.identity import (
    SessionAttestation,
    make_session_attestation,
    verify_session_attestation,
)
from openroom.identity_store import (
    default_identity_path,
    load_identity,
    load_or_create_identity,
    save_identity,
)
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

__version__ = "0.0.2"

__all__ = [
    "AgentSummary",
    "Cap",
    "CapScope",
    "CapVerifyResult",
    "Client",
    "ClientError",
    "DirectMessageEvent",
    "DirectPayload",
    "Envelope",
    "JoinPayload",
    "Keypair",
    "MessageEvent",
    "SendPayload",
    "ServerEvent",
    "SessionAttestation",
    "TopicSummary",
    "blake3_cid",
    "canonicalize",
    "cap_covers",
    "default_identity_path",
    "delegate_cap",
    "from_base64url",
    "generate_keypair",
    "load_identity",
    "load_or_create_identity",
    "make_envelope",
    "make_root_cap",
    "make_session_attestation",
    "save_identity",
    "sign",
    "sign_cap",
    "to_base64url",
    "verify",
    "verify_cap",
    "verify_cap_chain",
    "verify_envelope",
    "verify_session_attestation",
]
