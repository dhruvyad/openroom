// Minimal JSON Canonicalization Scheme (RFC 8785) implementation.
// Sufficient for openroom envelopes: plain objects, strings, numbers,
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
        // Match JSON.stringify: undefined entries become null in arrays.
        return (
            '[' +
            value
                .map((v) => canonicalize(v === undefined ? null : v))
                .join(',') +
            ']'
        );
    }
    if (typeof value === 'object') {
        // Match JSON.stringify: undefined properties are omitted entirely.
        const obj = value as Record<string, unknown>;
        const keys = Object.keys(obj)
            .filter((k) => obj[k] !== undefined)
            .sort();
        const parts = keys.map(
            (k) => JSON.stringify(k) + ':' + canonicalize(obj[k])
        );
        return '{' + parts.join(',') + '}';
    }
    throw new Error(`canonicalize: unsupported type ${typeof value}`);
}
