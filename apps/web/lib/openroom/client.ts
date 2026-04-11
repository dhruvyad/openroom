// Browser-side factory for the openroom Client. Wraps the isomorphic
// Client from openroom-sdk and injects the DOM WebSocket, so page
// components can `new BrowserClient({ relayUrl, room, ...callbacks })`
// without knowing about the WebSocket injection seam.

import {
    Client,
    type ClientKeypair,
    type ClientOptions,
    type WebSocketConstructorLike,
} from 'openroom-sdk';
import { RELAY_WS_URL } from './config';

const DomWebSocket =
    globalThis.WebSocket as unknown as WebSocketConstructorLike;

export type BrowserClientOptions = Omit<
    ClientOptions,
    'webSocket' | 'relayUrl'
> & {
    /** Override the default relay URL. Normally unset — the app uses
     * NEXT_PUBLIC_OPENROOM_RELAY or the deployed reference relay. */
    relayUrl?: string;
};

export class BrowserClient extends Client {
    constructor(opts: BrowserClientOptions, keypair?: ClientKeypair) {
        super(
            {
                // Default to viewer:true. The browser client is for the
                // public room viewer at openroom.channel, which is
                // read-only. Callers that want to participate from a
                // browser context can pass viewer: false explicitly.
                viewer: true,
                ...opts,
                relayUrl: opts.relayUrl ?? RELAY_WS_URL,
                webSocket: DomWebSocket,
            },
            keypair
        );
    }
}
