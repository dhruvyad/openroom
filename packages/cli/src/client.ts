// Node-wired openroom client. Thin subclass of the isomorphic Client in
// openroom-sdk that injects the `ws` package's WebSocket so existing CLI
// scripts can keep using `new Client(...)` without knowing about the
// WebSocket injection. The browser (apps/web) imports Client directly
// from openroom-sdk and passes `globalThis.WebSocket`.

import WebSocket from 'ws';
import {
    Client as BaseClient,
    type ClientKeypair,
    type ClientOptions as BaseClientOptions,
    type WebSocketConstructorLike,
} from 'openroom-sdk';

export type ClientOptions = Omit<BaseClientOptions, 'webSocket'>;
export type { ClientKeypair };

// The `ws` package exports a WebSocket class that implements the standard
// browser WebSocket interface (including addEventListener, OPEN, readyState,
// send, close). The types don't perfectly align with the DOM types but the
// runtime shape is identical, so we cast at the boundary.
const NodeWebSocket = WebSocket as unknown as WebSocketConstructorLike;

export class Client extends BaseClient {
    constructor(opts: ClientOptions, keypair?: ClientKeypair) {
        super({ ...opts, webSocket: NodeWebSocket }, keypair);
    }
}
