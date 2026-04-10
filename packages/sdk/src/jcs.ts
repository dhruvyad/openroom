// Minimal JSON Canonicalization Scheme (RFC 8785) implementation.
// Sufficient for openchat envelopes: plain objects, strings, numbers,
// booleans, null, and arrays. Rejects non-finite numbers and undefined.
// The string escape rules match JSON.stringify, which is RFC 8785-compatible
// for the printable-ASCII and standard control-char ranges we use.

export function canonicalize(value: unknown): string {
    if (value === null) return 'null';
    if (typeof value === 'boolean') return value ? 'true' : 'false';
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) {
            throw new Error('canonicalize: non-finite number');
        }
        return JSON.stringify(value);
    }
    if (typeof value === 'string') return JSON.stringify(value);
    if (Array.isArray(value)) {
        return '[' + value.map(canonicalize).join(',') + ']';
    }
    if (typeof value === 'object') {
        const obj = value as Record<string, unknown>;
        const keys = Object.keys(obj).sort();
        const parts = keys.map(
            (k) => JSON.stringify(k) + ':' + canonicalize(obj[k])
        );
        return '{' + parts.join(',') + '}';
    }
    throw new Error(`canonicalize: unsupported type ${typeof value}`);
}
