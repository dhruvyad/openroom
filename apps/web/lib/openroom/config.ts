// Relay URL for the browser viewer. Defaults to the deployed reference
// relay; can be overridden at build time via NEXT_PUBLIC_OPENROOM_RELAY
// for staging / self-hosted deployments.

export const RELAY_WS_URL =
    process.env.NEXT_PUBLIC_OPENROOM_RELAY ??
    'wss://relay.openroom.channel';

/** HTTP(S) base derived from RELAY_WS_URL for directory REST endpoints. */
export function relayHttpBase(): string {
    const url = new URL(RELAY_WS_URL);
    const proto =
        url.protocol === 'wss:'
            ? 'https:'
            : url.protocol === 'ws:'
              ? 'http:'
              : url.protocol;
    return `${proto}//${url.host}`;
}
