"""UCAN-style capabilities.

A Cap is a signed delegation from an ``iss`` (issuer) to an ``aud``
(audience) granting a specific action on a specific resource, bounded by
a validity window. Caps chain: the root is self-issued by a resource's
declared authority, and each subsequent cap is narrower-or-equal to its
parent.

A leaf cap carries the full chain of ancestors inline in ``proof``,
which lets verifiers walk leaf → root without any external storage.
Each ancestor in the proof is independently signed and independently
verifiable; the ancestor's own ``proof`` field is stripped when
embedded in a child's chain, because signatures are computed over the
cap with ``proof`` excluded.

Mirrors packages/sdk/src/cap.ts — a cap signed on one SDK verifies on
the other. The load-bearing invariant is the canonicalization rule:
sign over the cap without ``sig`` AND without ``proof``, in both
languages.
"""

from __future__ import annotations

import secrets
import time
from dataclasses import asdict, dataclass, field
from typing import Any

from openroom.crypto import (
    from_base64url,
    sign,
    to_base64url,
    verify,
)
from openroom.jcs import canonicalize


DEFAULT_LIFETIME_SECONDS = 24 * 60 * 60


@dataclass(frozen=True)
class CapScope:
    """What a cap authorizes.

    ``resource`` is a URI-like string, typically ``room:<name>/topic:<name>``
    or ``room:<name>/*`` for a prefix-wildcard. ``action`` is the verb
    (``post``, ``subscribe``, ``write``, or ``*`` for any). ``constraints``
    is reserved for action-specific refinements and must be equal across
    a chain for v1.
    """

    resource: str
    action: str
    constraints: dict[str, Any] | None = None

    def to_dict(self) -> dict[str, Any]:
        d: dict[str, Any] = {"resource": self.resource, "action": self.action}
        if self.constraints is not None:
            d["constraints"] = self.constraints
        return d

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "CapScope":
        return cls(
            resource=data["resource"],
            action=data["action"],
            constraints=data.get("constraints"),
        )


@dataclass(frozen=True)
class Cap:
    """A single capability in a chain.

    ``proof`` is the chain of ancestors, ROOT-FIRST. Only the leaf carries
    a full chain; intermediates stored inside another cap's ``proof``
    have their own ``proof`` stripped.
    """

    iss: str
    aud: str
    cap: CapScope
    nbf: int
    exp: int
    nonce: str
    sig: str
    proof: list["Cap"] | None = None

    def to_dict(self) -> dict[str, Any]:
        d: dict[str, Any] = {
            "iss": self.iss,
            "aud": self.aud,
            "cap": self.cap.to_dict(),
            "nbf": self.nbf,
            "exp": self.exp,
            "nonce": self.nonce,
            "sig": self.sig,
        }
        if self.proof is not None:
            d["proof"] = [p.to_dict() for p in self.proof]
        return d

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "Cap":
        proof_raw = data.get("proof")
        proof = (
            [cls.from_dict(p) for p in proof_raw]
            if proof_raw is not None
            else None
        )
        return cls(
            iss=data["iss"],
            aud=data["aud"],
            cap=CapScope.from_dict(data["cap"]),
            nbf=int(data["nbf"]),
            exp=int(data["exp"]),
            nonce=data["nonce"],
            sig=data["sig"],
            proof=proof,
        )


def _unsigned_dict(c: Cap) -> dict[str, Any]:
    """Return the cap's canonical dict form WITHOUT sig and WITHOUT proof.

    The JS SDK canonicalizes over exactly this set of fields; both
    sigs and proof chains must be excluded so that intermediate caps
    embedded in another cap's proof still verify standalone.
    """
    return {
        "iss": c.iss,
        "aud": c.aud,
        "cap": c.cap.to_dict(),
        "nbf": c.nbf,
        "exp": c.exp,
        "nonce": c.nonce,
    }


def sign_cap(
    iss: str,
    aud: str,
    scope: CapScope,
    nbf: int,
    exp: int,
    nonce: str,
    issuer_private_key: bytes,
    *,
    proof: list[Cap] | None = None,
) -> Cap:
    """Sign a cap with ``issuer_private_key`` (which must correspond to
    the pubkey ``iss``). Returns a fully populated Cap including the
    proof chain the caller supplied (root-first, stripped).
    """
    unsigned_dict = {
        "iss": iss,
        "aud": aud,
        "cap": scope.to_dict(),
        "nbf": nbf,
        "exp": exp,
        "nonce": nonce,
    }
    canonical = canonicalize(unsigned_dict)
    signature = sign(canonical.encode("utf-8"), issuer_private_key)
    return Cap(
        iss=iss,
        aud=aud,
        cap=scope,
        nbf=nbf,
        exp=exp,
        nonce=nonce,
        sig=to_base64url(signature),
        proof=proof,
    )


def verify_cap(c: Cap) -> bool:
    """Verify a single cap's signature against its ``iss``. Does NOT
    walk the chain — use ``verify_cap_chain`` for that."""
    try:
        canonical = canonicalize(_unsigned_dict(c))
        sig_bytes = from_base64url(c.sig)
        iss_bytes = from_base64url(c.iss)
        return verify(sig_bytes, canonical.encode("utf-8"), iss_bytes)
    except (ValueError, TypeError):
        return False


def make_root_cap(
    public_key: bytes,
    private_key: bytes,
    scope: CapScope,
    *,
    nbf: int | None = None,
    exp: int | None = None,
    nonce: str | None = None,
) -> Cap:
    """Create a self-issued root cap. Used by a resource's declared
    authority to bootstrap any delegation tree."""
    now = int(time.time())
    effective_nbf = nbf if nbf is not None else now
    effective_exp = (
        exp if exp is not None else effective_nbf + DEFAULT_LIFETIME_SECONDS
    )
    effective_nonce = nonce if nonce is not None else _random_nonce(16)
    pubkey_b64 = to_base64url(public_key)
    return sign_cap(
        iss=pubkey_b64,
        aud=pubkey_b64,
        scope=scope,
        nbf=effective_nbf,
        exp=effective_exp,
        nonce=effective_nonce,
        issuer_private_key=private_key,
    )


def delegate_cap(
    parent: Cap,
    audience_pubkey: str,
    narrower_scope: CapScope,
    issuer_private_key: bytes,
    *,
    nbf: int | None = None,
    exp: int | None = None,
    nonce: str | None = None,
) -> Cap:
    """Delegate from a cap the caller already holds. The new cap's proof
    chain is built automatically from ``parent.proof`` + ``parent``
    (stripped). The caller must hold the private key matching
    ``parent.aud``.

    Times are clamped to the parent's window: the child's nbf is at
    least as late as the parent's, and the child's exp is at most as
    early as the parent's.
    """
    now = int(time.time())
    effective_nbf = max(nbf if nbf is not None else now, parent.nbf)
    effective_exp = min(
        exp if exp is not None else effective_nbf + DEFAULT_LIFETIME_SECONDS,
        parent.exp,
    )
    effective_nonce = nonce if nonce is not None else _random_nonce(16)

    parent_ancestors = parent.proof or []
    full_proof: list[Cap] = []
    for ancestor in parent_ancestors:
        full_proof.append(_strip_proof(ancestor))
    full_proof.append(_strip_proof(parent))

    return sign_cap(
        iss=parent.aud,
        aud=audience_pubkey,
        scope=narrower_scope,
        nbf=effective_nbf,
        exp=effective_exp,
        nonce=effective_nonce,
        issuer_private_key=issuer_private_key,
        proof=full_proof,
    )


@dataclass(frozen=True)
class CapVerifyResult:
    ok: bool
    reason: str | None = None


def verify_cap_chain(
    leaf: Cap,
    *,
    expected_audience: str,
    expected_root: str,
    required_resource: str,
    required_action: str,
    now: int | None = None,
) -> CapVerifyResult:
    """Walk a cap chain from leaf to root, checking each link for:

    - valid signature
    - validity at current time (nbf ≤ now ≤ exp)
    - delegation continuity (child.iss == parent.aud)
    - narrowing (child scope covered by parent scope; child validity
      ⊆ parent validity)

    And finally that the root is self-issued by ``expected_root``.
    """
    current = now if now is not None else int(time.time())

    if leaf.aud != expected_audience:
        return CapVerifyResult(False, "leaf audience does not match sender")
    if not cap_covers(leaf.cap, required_resource, required_action):
        return CapVerifyResult(False, "leaf scope does not cover requested action")
    if not _is_valid_at(leaf, current):
        return CapVerifyResult(False, "leaf not valid at current time")
    if not verify_cap(leaf):
        return CapVerifyResult(False, "leaf signature invalid")

    chain = leaf.proof or []
    child: Cap = leaf

    for i in range(len(chain) - 1, -1, -1):
        parent = chain[i]
        if not verify_cap(parent):
            return CapVerifyResult(False, f"cap at chain[{i}] has invalid signature")
        if not _is_valid_at(parent, current):
            return CapVerifyResult(False, f"cap at chain[{i}] not valid at current time")
        if child.iss != parent.aud:
            return CapVerifyResult(
                False,
                f"delegation break at chain[{i}]: child.iss does not match parent.aud",
            )
        if not cap_covers(parent.cap, child.cap.resource, child.cap.action):
            return CapVerifyResult(False, f"cap at chain[{i}] scope does not cover child")
        if parent.nbf > child.nbf:
            return CapVerifyResult(False, f"cap at chain[{i}] nbf is later than child's")
        if parent.exp < child.exp:
            return CapVerifyResult(False, f"cap at chain[{i}] exp is earlier than child's")
        child = parent

    # `child` is now the root of the chain.
    if child.iss != expected_root:
        return CapVerifyResult(False, "root cap iss does not match expected authority")
    if child.iss != child.aud:
        return CapVerifyResult(False, "root cap is not self-issued")

    return CapVerifyResult(True)


def cap_covers(scope: CapScope, resource: str, action: str) -> bool:
    """Does ``scope`` authorize ``(resource, action)``?"""
    if not _resource_covers(scope.resource, resource):
        return False
    if scope.action != action and scope.action != "*":
        return False
    return True


def _resource_covers(authorized: str, requested: str) -> bool:
    if authorized == requested:
        return True
    if authorized.endswith("/*"):
        prefix = authorized[:-1]  # keep trailing slash
        return requested.startswith(prefix)
    return False


def _is_valid_at(c: Cap, now: int) -> bool:
    return c.nbf <= now <= c.exp


def _strip_proof(c: Cap) -> Cap:
    """Return a copy of ``c`` with its proof chain cleared. Used when
    embedding an ancestor inside a descendant's proof chain."""
    return Cap(
        iss=c.iss,
        aud=c.aud,
        cap=c.cap,
        nbf=c.nbf,
        exp=c.exp,
        nonce=c.nonce,
        sig=c.sig,
        proof=None,
    )


def _random_nonce(n_bytes: int = 16) -> str:
    return to_base64url(secrets.token_bytes(n_bytes))


__all__ = [
    "Cap",
    "CapScope",
    "CapVerifyResult",
    "cap_covers",
    "delegate_cap",
    "make_root_cap",
    "sign_cap",
    "verify_cap",
    "verify_cap_chain",
]
