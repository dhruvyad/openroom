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

// Pure-JS base64url and hex codecs so the SDK works anywhere — Node,
// browsers, and Cloudflare Workers — without pulling in the Node `Buffer`
// polyfill. Also surfaces errors on garbage input: Node's
// `Buffer.from(s, 'base64url')` silently drops invalid characters and
// returns a shorter buffer, which was a real bug we hit on identity file
// load. These throw instead.

const BASE64URL_CHARS =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const BASE64URL_DECODE = new Int8Array(128).fill(-1);
for (let i = 0; i < BASE64URL_CHARS.length; i++) {
    BASE64URL_DECODE[BASE64URL_CHARS.charCodeAt(i)] = i;
}

export function toBase64Url(bytes: Uint8Array): string {
    let out = '';
    let i = 0;
    for (; i + 3 <= bytes.length; i += 3) {
        const a = bytes[i]!;
        const b = bytes[i + 1]!;
        const c = bytes[i + 2]!;
        out += BASE64URL_CHARS[a >> 2]!;
        out += BASE64URL_CHARS[((a & 0x03) << 4) | (b >> 4)]!;
        out += BASE64URL_CHARS[((b & 0x0f) << 2) | (c >> 6)]!;
        out += BASE64URL_CHARS[c & 0x3f]!;
    }
    const rem = bytes.length - i;
    if (rem === 1) {
        const a = bytes[i]!;
        out += BASE64URL_CHARS[a >> 2]!;
        out += BASE64URL_CHARS[(a & 0x03) << 4]!;
    } else if (rem === 2) {
        const a = bytes[i]!;
        const b = bytes[i + 1]!;
        out += BASE64URL_CHARS[a >> 2]!;
        out += BASE64URL_CHARS[((a & 0x03) << 4) | (b >> 4)]!;
        out += BASE64URL_CHARS[(b & 0x0f) << 2]!;
    }
    return out;
}

export function fromBase64Url(s: string): Uint8Array {
    // Strip optional padding; base64url is defined without it but accept it.
    let len = s.length;
    while (len > 0 && s.charCodeAt(len - 1) === 61 /* '=' */) len--;

    const tail = len % 4;
    if (tail === 1) {
        throw new Error('fromBase64Url: invalid input length');
    }
    const outLen = Math.floor((len * 3) / 4);
    const out = new Uint8Array(outLen);
    let oi = 0;
    let i = 0;
    for (; i + 4 <= len; i += 4) {
        const a = decodeChar(s, i);
        const b = decodeChar(s, i + 1);
        const c = decodeChar(s, i + 2);
        const d = decodeChar(s, i + 3);
        out[oi++] = (a << 2) | (b >> 4);
        out[oi++] = ((b & 0x0f) << 4) | (c >> 2);
        out[oi++] = ((c & 0x03) << 6) | d;
    }
    if (tail === 2) {
        const a = decodeChar(s, i);
        const b = decodeChar(s, i + 1);
        out[oi++] = (a << 2) | (b >> 4);
    } else if (tail === 3) {
        const a = decodeChar(s, i);
        const b = decodeChar(s, i + 1);
        const c = decodeChar(s, i + 2);
        out[oi++] = (a << 2) | (b >> 4);
        out[oi++] = ((b & 0x0f) << 4) | (c >> 2);
    }
    return oi === out.length ? out : out.subarray(0, oi);
}

function decodeChar(s: string, i: number): number {
    const code = s.charCodeAt(i);
    const v = code < 128 ? BASE64URL_DECODE[code]! : -1;
    if (v < 0) {
        throw new Error(
            `fromBase64Url: invalid character at position ${i} (0x${code.toString(16)})`
        );
    }
    return v;
}

const HEX_CHARS = '0123456789abcdef';

export function toHex(bytes: Uint8Array): string {
    let out = '';
    for (const byte of bytes) {
        out += HEX_CHARS[byte >> 4]! + HEX_CHARS[byte & 0x0f]!;
    }
    return out;
}

export function randomNonce(bytes = 32): string {
    const buf = new Uint8Array(bytes);
    crypto.getRandomValues(buf);
    return toBase64Url(buf);
}
