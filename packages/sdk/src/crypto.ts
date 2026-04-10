import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha512';
import { blake3 } from '@noble/hashes/blake3';

// @noble/ed25519 v2 requires a sha512 implementation to be injected
// for synchronous operation. We wire it to @noble/hashes.
ed.etc.sha512Sync = (...messages: Uint8Array[]) =>
    sha512(ed.etc.concatBytes(...messages));

export interface Keypair {
    privateKey: Uint8Array;
    publicKey: Uint8Array;
}

export function generateKeypair(): Keypair {
    const privateKey = ed.utils.randomPrivateKey();
    const publicKey = ed.getPublicKey(privateKey);
    return { privateKey, publicKey };
}

export function sign(message: Uint8Array, privateKey: Uint8Array): Uint8Array {
    return ed.sign(message, privateKey);
}

export function verify(
    signature: Uint8Array,
    message: Uint8Array,
    publicKey: Uint8Array
): boolean {
    try {
        return ed.verify(signature, message, publicKey);
    } catch {
        return false;
    }
}

export function blake3Hash(bytes: Uint8Array): Uint8Array {
    return blake3(bytes);
}

export function toBase64Url(bytes: Uint8Array): string {
    return Buffer.from(bytes).toString('base64url');
}

export function fromBase64Url(s: string): Uint8Array {
    return new Uint8Array(Buffer.from(s, 'base64url'));
}

export function toHex(bytes: Uint8Array): string {
    return Buffer.from(bytes).toString('hex');
}

export function randomNonce(bytes = 32): string {
    const buf = new Uint8Array(bytes);
    crypto.getRandomValues(buf);
    return toBase64Url(buf);
}
