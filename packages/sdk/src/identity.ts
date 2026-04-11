// Session attestations. Browser-safe — no Node imports.
//
// A session key is ephemeral (one keypair per WebSocket connection). An
// identity key is optional, long-lived, and the public key IS the agent's
// cross-session identity. A session attestation is a signed binding that
// says: "the holder of identity X also holds session Y in room R until
// time T." Peers can verify locally and look the identity up in their own
// reputation ledgers.
//
// The Node-only persistence helpers (load/save identity files) live in
// `./identity-node.ts` so this module can be bundled into a browser.

import { canonicalize } from './jcs.js';
import {
    fromBase64Url,
    sign,
    toBase64Url,
    verify,
    type Keypair,
} from './crypto.js';

const encoder = new TextEncoder();

/** Default TTL for a fresh session attestation when the caller does not
 * supply `expiresAt`. */
const DEFAULT_ATTESTATION_LIFETIME_SECONDS = 24 * 60 * 60;

export interface SessionAttestation {
    identity_pubkey: string;
    session_pubkey: string;
    /** Room name this attestation is scoped to. Prevents replay of an
     * attestation captured from one room into another. */
    room: string;
    expires_at: number;
    sig: string;
}

/**
 * Produce a signed attestation binding `sessionPubkey` to the identity
 * keypair for use in a specific room. The canonical form excludes `sig`;
 * signature is Ed25519 by the identity private key. The attestation cannot
 * be replayed to a different room because `room` is signed into it.
 */
export function makeSessionAttestation(
    identityKeypair: Keypair,
    sessionPubkey: Uint8Array | string,
    room: string,
    options?: { expiresAt?: number }
): SessionAttestation {
    const session_pubkey =
        typeof sessionPubkey === 'string'
            ? sessionPubkey
            : toBase64Url(sessionPubkey);
    const identity_pubkey = toBase64Url(identityKeypair.publicKey);
    const expires_at =
        options?.expiresAt ??
        Math.floor(Date.now() / 1000) + DEFAULT_ATTESTATION_LIFETIME_SECONDS;

    const unsigned = { identity_pubkey, session_pubkey, room, expires_at };
    const canonical = canonicalize(unsigned);
    const signature = sign(
        encoder.encode(canonical),
        identityKeypair.privateKey
    );
    return { ...unsigned, sig: toBase64Url(signature) };
}

/** Verify a session attestation's signature and expiry. Returns true if the
 * attestation is currently valid. */
export function verifySessionAttestation(
    attestation: SessionAttestation,
    options?: { now?: number }
): boolean {
    if (
        !attestation ||
        typeof attestation.identity_pubkey !== 'string' ||
        typeof attestation.session_pubkey !== 'string' ||
        typeof attestation.room !== 'string' ||
        typeof attestation.expires_at !== 'number' ||
        typeof attestation.sig !== 'string'
    ) {
        return false;
    }
    const now = options?.now ?? Math.floor(Date.now() / 1000);
    if (now > attestation.expires_at) return false;
    try {
        const { sig, ...rest } = attestation;
        const canonical = canonicalize(rest);
        const signatureBytes = fromBase64Url(sig);
        const identityKeyBytes = fromBase64Url(attestation.identity_pubkey);
        return verify(
            signatureBytes,
            encoder.encode(canonical),
            identityKeyBytes
        );
    } catch {
        return false;
    }
}
