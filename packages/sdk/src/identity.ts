// Session attestations and long-lived identity key persistence.
//
// A session key is ephemeral (one keypair per WebSocket connection). An
// identity key is optional, long-lived, stored locally on disk, and the
// public key IS the agent's cross-session identity. A session attestation
// is a signed binding that says: "the holder of identity X also holds
// session Y until time T." Peers can verify the attestation locally and
// look up the identity pubkey in their own reputation ledgers.
//
// The fs helpers in this module use `node:fs` / `node:os` and are therefore
// Node-only. The pure signing/verification helpers work anywhere.

import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { canonicalize } from './jcs.js';
import {
    fromBase64Url,
    generateKeypair,
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
    expires_at: number;
    sig: string;
}

/**
 * Produce a signed attestation binding `sessionPubkey` to the identity
 * keypair. The canonical form excludes `sig`; signature is Ed25519 by the
 * identity private key.
 */
export function makeSessionAttestation(
    identityKeypair: Keypair,
    sessionPubkey: Uint8Array | string,
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

    const unsigned = { identity_pubkey, session_pubkey, expires_at };
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

// --- Node-only persistence helpers -----------------------------------------

interface StoredIdentity {
    kind: 'ed25519';
    private_key: string;
    public_key: string;
}

/** Default on-disk location for the identity keypair. */
export function defaultIdentityPath(): string {
    return path.join(os.homedir(), '.openroom', 'identity', 'default.key');
}

/** Load an identity keypair from disk. Returns null if no file exists. */
export async function loadIdentity(
    filePath?: string
): Promise<Keypair | null> {
    const p = filePath ?? defaultIdentityPath();
    let raw: string;
    try {
        raw = await fs.readFile(p, 'utf8');
    } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
        throw err;
    }
    const stored: StoredIdentity = JSON.parse(raw);
    if (stored.kind !== 'ed25519') {
        throw new Error(`unsupported identity key kind: ${stored.kind}`);
    }
    return {
        privateKey: fromBase64Url(stored.private_key),
        publicKey: fromBase64Url(stored.public_key),
    };
}

/**
 * Save an identity keypair to disk atomically (write to tmp + rename) with
 * restrictive permissions (0600). The rename is atomic on POSIX, so crashing
 * mid-write leaves the previous file intact. Mode is enforced on the tmp
 * file before rename so overwriting an existing file with looser permissions
 * (e.g. an older 0644 file from a backup) lands the final inode at 0600.
 */
export async function saveIdentity(
    keypair: Keypair,
    filePath?: string
): Promise<void> {
    const p = filePath ?? defaultIdentityPath();
    const dir = path.dirname(p);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });

    const stored: StoredIdentity = {
        kind: 'ed25519',
        private_key: toBase64Url(keypair.privateKey),
        public_key: toBase64Url(keypair.publicKey),
    };
    const data = JSON.stringify(stored, null, 2);
    const tmp = `${p}.tmp.${process.pid}.${Date.now()}`;
    await fs.writeFile(tmp, data, { mode: 0o600 });
    // Force 0600 even if umask stripped it at creation time.
    await fs.chmod(tmp, 0o600);
    await fs.rename(tmp, p);
}

/**
 * Load the identity keypair if it exists, otherwise generate one and save
 * it atomically. Uses exclusive-create (`wx` flag) so that two concurrent
 * callers on the same path do not both win the "create new key" race —
 * whichever caller loses EEXIST re-reads the winner's file instead of
 * overwriting it, so the in-memory and on-disk keypairs agree.
 */
export async function loadOrCreateIdentity(
    filePath?: string
): Promise<Keypair> {
    const p = filePath ?? defaultIdentityPath();
    const existing = await loadIdentity(p);
    if (existing) return existing;

    const fresh = generateKeypair();
    const dir = path.dirname(p);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });

    const stored: StoredIdentity = {
        kind: 'ed25519',
        private_key: toBase64Url(fresh.privateKey),
        public_key: toBase64Url(fresh.publicKey),
    };
    const data = JSON.stringify(stored, null, 2);

    try {
        // 'wx' = write + exclusive create (O_EXCL|O_CREAT). Fails with
        // EEXIST if the file exists, which is the TOCTOU resolution:
        // another process beat us to it, re-read their file.
        const handle = await fs.open(p, 'wx', 0o600);
        try {
            await handle.writeFile(data);
        } finally {
            await handle.close();
        }
        await fs.chmod(p, 0o600);
        return fresh;
    } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code === 'EEXIST') {
            const winning = await loadIdentity(p);
            if (winning) return winning;
        }
        throw err;
    }
}
