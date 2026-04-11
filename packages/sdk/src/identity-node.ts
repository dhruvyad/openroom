// Node-only persistence helpers for long-lived identity keys.
//
// Kept in a separate module (and separate package export) from the
// browser-safe session attestation helpers so bundlers targeting the
// browser can import `openroom-sdk` without pulling in `node:fs`.

import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import * as ed from '@noble/ed25519';

import {
    fromBase64Url,
    generateKeypair,
    toBase64Url,
    type Keypair,
} from './crypto.js';

const ED25519_KEY_LENGTH = 32;

interface StoredIdentity {
    kind: 'ed25519';
    private_key: string;
    public_key: string;
}

/** Default on-disk location for the identity keypair. */
export function defaultIdentityPath(): string {
    return path.join(os.homedir(), '.openroom', 'identity', 'default.key');
}

/**
 * Load an identity keypair from disk. Returns null if no file exists.
 * Validates that both keys decode to exactly 32 bytes, and that the stored
 * public key is actually derivable from the stored private key — catches
 * truncated files, base64url corruption, and bitflips at load time instead
 * of deep inside a later `sign()` call.
 */
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
    let stored: StoredIdentity;
    try {
        stored = JSON.parse(raw);
    } catch (err) {
        throw new Error(
            `identity file at ${p} is not valid JSON: ${(err as Error).message}`
        );
    }
    if (stored.kind !== 'ed25519') {
        throw new Error(
            `identity file at ${p} has unsupported kind: ${stored.kind}`
        );
    }
    if (
        typeof stored.private_key !== 'string' ||
        typeof stored.public_key !== 'string'
    ) {
        throw new Error(`identity file at ${p} missing key fields`);
    }

    const privateKey = fromBase64Url(stored.private_key);
    const publicKey = fromBase64Url(stored.public_key);
    if (privateKey.length !== ED25519_KEY_LENGTH) {
        throw new Error(
            `identity file at ${p} private_key is ${privateKey.length} bytes, expected ${ED25519_KEY_LENGTH}`
        );
    }
    if (publicKey.length !== ED25519_KEY_LENGTH) {
        throw new Error(
            `identity file at ${p} public_key is ${publicKey.length} bytes, expected ${ED25519_KEY_LENGTH}`
        );
    }

    // Integrity check: the stored public key must match the derivation from
    // the stored private key. Catches bitflips and tampering that leave
    // lengths intact.
    const derived = ed.getPublicKey(privateKey);
    if (!bytesEqual(derived, publicKey)) {
        throw new Error(
            `identity file at ${p} has mismatched private/public keys (corruption?)`
        );
    }

    return { privateKey, publicKey };
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
    return diff === 0;
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
