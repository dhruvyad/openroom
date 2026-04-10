import { canonicalize } from './jcs.js';
import { sign, verify, toBase64Url, fromBase64Url } from './crypto.js';
import type { Envelope } from './types.js';

const encoder = new TextEncoder();

export function signEnvelope<T>(
    envelope: Omit<Envelope<T>, 'sig'>,
    privateKey: Uint8Array
): Envelope<T> {
    const canonical = canonicalize(envelope);
    const bytes = encoder.encode(canonical);
    const signature = sign(bytes, privateKey);
    return { ...envelope, sig: toBase64Url(signature) };
}

export function verifyEnvelope(envelope: Envelope): boolean {
    const { sig, ...rest } = envelope;
    const canonical = canonicalize(rest);
    const bytes = encoder.encode(canonical);
    const signatureBytes = fromBase64Url(sig);
    const publicKey = fromBase64Url(envelope.from);
    return verify(signatureBytes, bytes, publicKey);
}

export function makeEnvelope<T>(
    type: string,
    payload: T,
    privateKey: Uint8Array,
    publicKey: Uint8Array
): Envelope<T> {
    const unsigned = {
        type,
        id: crypto.randomUUID(),
        ts: Math.floor(Date.now() / 1000),
        from: toBase64Url(publicKey),
        payload,
    };
    return signEnvelope(unsigned, privateKey);
}
