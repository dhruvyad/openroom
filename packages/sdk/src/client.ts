// Isomorphic openroom client. Works in any runtime that has a
// browser-compatible WebSocket constructor: browsers (globalThis.WebSocket),
// Node via the `ws` package, Deno, Bun, Cloudflare Workers. The constructor
// must be supplied via `opts.webSocket` — we don't assume `globalThis.WebSocket`
// exists because Node didn't ship it as stable until recent versions and
// we want to keep the SDK runtime-agnostic.
//
// The CLI package re-exports a Node-wired `Client` (bound to `ws`) so
// existing CLI callers don't need to know about the injection.

import {
    generateKeypair,
    makeEnvelope,
    makeSessionAttestation,
    toBase64Url,
    verifyEnvelope,
    type AgentSummary,
    type Cap,
    type CreateTopicPayload,
    type CreateTopicResult,
    type JoinPayload,
    type Keypair,
    type LeavePayload,
    type ListTopicsPayload,
    type ListTopicsResult,
    type DirectMessageEvent,
    type DirectPayload,
    type DirectResult,
    type MessageEvent,
    type ResourceChangedEvent,
    type ResourceGetPayload,
    type ResourceGetResult,
    type ResourceListPayload,
    type ResourceListResult,
    type ResourcePutPayload,
    type ResourcePutResult,
    type ResourceSubscribePayload,
    type ResourceSubscribeResult,
    type ResourceSummary,
    type ResourceUnsubscribePayload,
    type ResourceUnsubscribeResult,
    type SendPayload,
    type SendResult,
    type ServerEvent,
    type SubscribePayload,
    type SubscribeResult,
    type TopicChangedEvent,
    type TopicSummary,
    type UnsubscribePayload,
    type UnsubscribeResult,
} from './index.js';
import { blake3Cid, fromBase64Url } from './crypto.js';

/**
 * Minimal WebSocket surface we rely on. Both `globalThis.WebSocket` in
 * browsers and the `ws` package in Node implement this exactly, so we don't
 * need adapters.
 */
export interface WebSocketLike {
    readonly readyState: number;
    send(data: string): void;
    close(code?: number, reason?: string): void;
    addEventListener(type: 'open', listener: () => void): void;
    addEventListener(
        type: 'close',
        listener: (ev?: { code?: number; reason?: string }) => void
    ): void;
    addEventListener(
        type: 'error',
        listener: (ev?: unknown) => void
    ): void;
    addEventListener(
        type: 'message',
        listener: (ev: { data: unknown }) => void
    ): void;
}

export interface WebSocketConstructorLike {
    new (url: string): WebSocketLike;
    readonly OPEN: number;
}

export interface ClientOptions {
    relayUrl: string;
    room: string;
    /** WebSocket constructor. Pass `globalThis.WebSocket` in browsers or
     * `import WebSocket from 'ws'` in Node. Required — the SDK does not
     * fall back to a global to stay runtime-agnostic. */
    webSocket: WebSocketConstructorLike;
    displayName?: string;
    description?: string;
    /** Optional long-lived identity keypair. When supplied, the client
     * creates a session attestation and sends it in the join payload so
     * peers can recognize this session as the same identity across
     * reconnects. */
    identityKeypair?: Keypair;
    /** Join as a read-only viewer. The relay tags the agent in its
     * AgentSummary and rejects write operations. Defaults to false. */
    viewer?: boolean;
    onMessage?: (event: MessageEvent) => void;
    onDirectMessage?: (event: DirectMessageEvent) => void;
    onAgentsChanged?: (
        event: Extract<ServerEvent, { type: 'agents_changed' }>
    ) => void;
    onTopicChanged?: (event: TopicChangedEvent) => void;
    onResourceChanged?: (event: ResourceChangedEvent) => void;
    onError?: (reason: string) => void;
    /** Fired when the underlying WebSocket closes for any reason —
     *  a relay restart, a network drop, or an explicit leave. The
     *  client does not auto-reconnect. Callers that want the
     *  connection back should construct a new Client. */
    onClose?: (meta: { code?: number; reason?: string }) => void;
    /** Fired every time the keepalive ping is sent. Diagnostic only;
     *  callers typically don't need to know, but the MCP adapter
     *  uses it to prove the keepalive path is running inside
     *  subprocess-hosted servers. */
    onKeepalivePing?: () => void;
}

interface PendingRequest {
    resolve: (value: ServerEvent) => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
}

const REQUEST_TIMEOUT_MS = 5000;

/** WebSocket keepalive interval in milliseconds. Clients send raw
 *  "ping" text on this cadence; the relay DO handles it in
 *  webSocketMessage (waking the DO) and replies "pong". We
 *  deliberately do NOT use Cloudflare's edge auto-response because
 *  that keeps the client-to-edge TCP alive without waking the DO,
 *  and CF garbage-collects hibernated DO-to-socket bindings after
 *  idle. Waking the DO on each ping refreshes that binding.
 *
 *  20s keeps us well under any conceivable idle window (CF's
 *  documented timeout is ~100s but observed drops happen around
 *  90s), and gives us 4-5 pings before any realistic timeout.
 */
const KEEPALIVE_INTERVAL_MS = 20_000;

export interface ClientKeypair {
    privateKey: Uint8Array;
    publicKey: Uint8Array;
}

/** Coerce a browser / ws / ArrayBuffer message payload to a string. */
function messageDataToString(data: unknown): string {
    if (typeof data === 'string') return data;
    if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
    // Node `ws` with the default binaryType yields Buffer (Uint8Array)
    if (data instanceof Uint8Array) return new TextDecoder().decode(data);
    // Last-ditch fallback for Blob etc. — not expected on the text JSON path
    return String(data);
}

export class Client {
    private ws: WebSocketLike;
    private wsCtor: WebSocketConstructorLike;
    private _privateKey: Uint8Array;
    private _publicKey: Uint8Array;
    private joined = false;
    private joinResolve?: () => void;
    private joinReject?: (err: Error) => void;
    private pending = new Map<string, PendingRequest>();
    private keepaliveTimer: ReturnType<typeof setInterval> | null = null;
    // Cached snapshot of room state, updated by joined / agents_changed /
    // topic_changed / resource_changed events. The adapter (and any tool
    // that wants a read without hitting the relay) reads from these.
    private _agents: AgentSummary[] = [];
    private _topics: TopicSummary[] = [];
    private _resources: ResourceSummary[] = [];

    constructor(private opts: ClientOptions, keypair?: ClientKeypair) {
        const kp = keypair ?? generateKeypair();
        this._privateKey = kp.privateKey;
        this._publicKey = kp.publicKey;
        this.wsCtor = opts.webSocket;

        const baseUrl = opts.relayUrl.replace(/\/+$/, '');
        const url = `${baseUrl}/v1/room/${encodeURIComponent(opts.room)}`;
        this.ws = new this.wsCtor(url);
        this.ws.addEventListener('message', (event) => {
            this.handleServerEvent(messageDataToString(event.data));
        });
        this.ws.addEventListener('error', (ev) => {
            const msg =
                ev && typeof ev === 'object' && 'message' in ev
                    ? String((ev as { message: unknown }).message)
                    : 'websocket error';
            this.joinReject?.(new Error(msg));
            this.opts.onError?.(msg);
        });
        this.ws.addEventListener('close', (ev) => {
            this.stopKeepalive();
            for (const pending of this.pending.values()) {
                clearTimeout(pending.timer);
                pending.reject(new Error('connection closed'));
            }
            this.pending.clear();
            const wasJoined = this.joined;
            this.joined = false;
            if (!wasJoined) {
                this.joinReject?.(
                    new Error('connection closed before join completed')
                );
            }
            const code = ev && typeof ev === 'object' && 'code' in ev
                ? (ev as { code?: number }).code
                : undefined;
            const reason =
                ev && typeof ev === 'object' && 'reason' in ev
                    ? String((ev as { reason?: unknown }).reason)
                    : undefined;
            this.opts.onClose?.({ code, reason });
        });
    }

    connect(): Promise<void> {
        if (this.joined) return Promise.resolve();
        return new Promise((resolve, reject) => {
            this.joinResolve = resolve;
            this.joinReject = reject;
        });
    }

    private handleServerEvent(raw: string) {
        let event: ServerEvent;
        try {
            event = JSON.parse(raw) as ServerEvent;
        } catch {
            return;
        }

        // Correlate RPC results to pending requests.
        if (
            event.type === 'create_topic_result' ||
            event.type === 'send_result' ||
            event.type === 'direct_result' ||
            event.type === 'subscribe_result' ||
            event.type === 'unsubscribe_result' ||
            event.type === 'list_topics_result' ||
            event.type === 'resource_put_result' ||
            event.type === 'resource_get_result' ||
            event.type === 'resource_list_result' ||
            event.type === 'resource_subscribe_result' ||
            event.type === 'resource_unsubscribe_result'
        ) {
            this.resolvePending(event.id, event);
            return;
        }

        switch (event.type) {
            case 'challenge':
                this.sendJoin(event.nonce);
                return;
            case 'joined':
                this.joined = true;
                this._agents = event.agents;
                this._topics = event.topics;
                this._resources = event.resources ?? [];
                this.startKeepalive();
                this.joinResolve?.();
                return;
            case 'message':
                if (!verifyEnvelope(event.envelope)) {
                    this.opts.onError?.(
                        'dropped message with invalid forwarded signature'
                    );
                    return;
                }
                this.opts.onMessage?.(event);
                return;
            case 'direct_message':
                if (!verifyEnvelope(event.envelope)) {
                    this.opts.onError?.(
                        'dropped direct_message with invalid forwarded signature'
                    );
                    return;
                }
                this.opts.onDirectMessage?.(event);
                return;
            case 'agents_changed':
                this._agents = event.agents;
                this.opts.onAgentsChanged?.(event);
                return;
            case 'topic_changed':
                if (event.change === 'created' && event.summary) {
                    if (!this._topics.some((t) => t.name === event.topic)) {
                        this._topics = [...this._topics, event.summary];
                    }
                } else if (event.change === 'deleted') {
                    this._topics = this._topics.filter(
                        (t) => t.name !== event.topic
                    );
                }
                this.opts.onTopicChanged?.(event);
                return;
            case 'resource_changed':
                if (event.change === 'put' && event.summary) {
                    const idx = this._resources.findIndex(
                        (r) => r.name === event.name
                    );
                    if (idx === -1) {
                        this._resources = [...this._resources, event.summary];
                    } else {
                        this._resources = this._resources.map((r, i) =>
                            i === idx ? event.summary! : r
                        );
                    }
                } else if (event.change === 'deleted') {
                    this._resources = this._resources.filter(
                        (r) => r.name !== event.name
                    );
                }
                this.opts.onResourceChanged?.(event);
                return;
            case 'error':
                this.opts.onError?.(event.reason);
                if (!this.joined) {
                    this.joinReject?.(new Error(event.reason));
                }
                return;
        }
    }

    private resolvePending(id: string, event: ServerEvent) {
        const pending = this.pending.get(id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(id);
        pending.resolve(event);
    }

    /** Start a WebSocket keepalive: send the raw text "ping" on a
     *  30s interval. The relay's CF edge auto-responds "pong" without
     *  waking the Durable Object, which keeps CF's ~100s idle timeout
     *  from dropping quiet connections (e.g. an MCP server waiting for
     *  Claude to do something). The "pong" reply comes back on the
     *  message channel; handleServerEvent's JSON.parse silently drops
     *  it since "pong" isn't a valid ServerEvent. */
    private startKeepalive(): void {
        if (this.keepaliveTimer !== null) return;
        // Prefer the protocol-level WebSocket PING control frame over
        // sending a text frame with body "ping". Control frames are
        // handled at the TCP/edge layer transparently to the Node
        // event loop, which keeps the connection alive even when the
        // host process (e.g. Claude Code) starves our subprocess of
        // scheduler time. Text-frame pings go through application
        // logic and are more susceptible to being delayed or lost.
        //
        // The `ws` package's WebSocket exposes .ping() as a protocol
        // control frame sender; browsers don't have an equivalent on
        // the standard WebSocket interface, so we fall back to text.
        // This mirrors what wahooks-channel does and is the reason
        // their subprocess stays alive for days inside Claude Code.
        const wsWithPing = this.ws as unknown as { ping?: () => void };
        const useProtocolPing = typeof wsWithPing.ping === 'function';
        this.keepaliveTimer = setInterval(() => {
            if (this.ws.readyState !== this.wsCtor.OPEN) return;
            try {
                if (useProtocolPing) {
                    wsWithPing.ping!();
                } else {
                    this.ws.send('ping');
                }
                this.opts.onKeepalivePing?.();
            } catch {
                // ws layer may be mid-close; next close event cleans up
            }
        }, KEEPALIVE_INTERVAL_MS);
        // Don't keep the Node event loop alive on the interval alone.
        // The `ws` package's timers are already unref'd by default, but
        // `setInterval` in Node returns a Timeout object that has an
        // `unref` method. Browsers don't have this API; guard accordingly.
        const timer = this.keepaliveTimer as unknown as {
            unref?: () => void;
        };
        if (typeof timer.unref === 'function') timer.unref();
    }

    private stopKeepalive(): void {
        if (this.keepaliveTimer === null) return;
        clearInterval(this.keepaliveTimer);
        this.keepaliveTimer = null;
    }

    private async request<T extends ServerEvent>(
        type: string,
        payload: unknown
    ): Promise<T> {
        const envelope = makeEnvelope(
            type,
            payload,
            this._privateKey,
            this._publicKey
        );
        const promise = new Promise<ServerEvent>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(envelope.id);
                reject(new Error(`request ${type} timed out`));
            }, REQUEST_TIMEOUT_MS);
            this.pending.set(envelope.id, { resolve, reject, timer });
        });
        this.ws.send(JSON.stringify(envelope));
        return (await promise) as T;
    }

    private sendJoin(nonce: string) {
        const payload: JoinPayload = {
            nonce,
            display_name: this.opts.displayName,
            description: this.opts.description,
            features: ['openroom/1'],
        };
        if (this.opts.viewer) payload.viewer = true;
        if (this.opts.identityKeypair) {
            payload.session_attestation = makeSessionAttestation(
                this.opts.identityKeypair,
                this._publicKey,
                this.opts.room
            );
        }
        const envelope = makeEnvelope(
            'join',
            payload,
            this._privateKey,
            this._publicKey
        );
        this.ws.send(JSON.stringify(envelope));
    }

    async send(
        body: string,
        topic = 'main',
        options?: { cap?: Cap }
    ): Promise<void> {
        const payload: SendPayload = { topic, body };
        if (options?.cap) payload.cap_proof = options.cap;
        const result = await this.request<SendResult>('send', payload);
        if (!result.success) {
            throw new Error(result.error ?? 'send failed');
        }
    }

    /**
     * Send a direct message to a specific agent in the room. Semantically
     * NOT private — every agent and viewer in the room receives the DM
     * event. The target is a UI hint for the intended recipient, not a
     * routing constraint. openroom's philosophy is "observable by default."
     *
     * The target may be a session pubkey or an identity pubkey; the relay
     * resolves either.
     */
    async sendDirect(
        target: string,
        body: string,
        options?: { reply_to?: string }
    ): Promise<void> {
        const payload: DirectPayload = { target, body };
        if (options?.reply_to) payload.reply_to = options.reply_to;
        const result = await this.request<DirectResult>('direct', payload);
        if (!result.success) {
            throw new Error(result.error ?? 'sendDirect failed');
        }
    }

    async createTopic(
        name: string,
        options?: { subscribeCap?: string | null; postCap?: string | null }
    ): Promise<TopicSummary> {
        const payload: CreateTopicPayload = {
            name,
            subscribe_cap: options?.subscribeCap ?? null,
            post_cap: options?.postCap ?? null,
        };
        const result = await this.request<CreateTopicResult>(
            'create_topic',
            payload
        );
        if (!result.success || !result.topic) {
            throw new Error(result.error ?? 'create_topic failed');
        }
        return result.topic;
    }

    async subscribe(topic: string, options?: { cap?: Cap }): Promise<void> {
        const payload: SubscribePayload = { topic };
        if (options?.cap) payload.proof = options.cap;
        const result = await this.request<SubscribeResult>(
            'subscribe',
            payload
        );
        if (!result.success) {
            throw new Error(result.error ?? 'subscribe failed');
        }
    }

    async unsubscribe(topic: string): Promise<void> {
        const payload: UnsubscribePayload = { topic };
        const result = await this.request<UnsubscribeResult>(
            'unsubscribe',
            payload
        );
        if (!result.success) {
            throw new Error(result.error ?? 'unsubscribe failed');
        }
    }

    async listTopics(): Promise<TopicSummary[]> {
        const payload: ListTopicsPayload = {};
        const result = await this.request<ListTopicsResult>(
            'list_topics',
            payload
        );
        return result.topics;
    }

    async putResource(
        name: string,
        content: Uint8Array | string,
        options?: {
            kind?: string;
            mime?: string;
            validationHook?: string | null;
            cap?: Cap;
        }
    ): Promise<ResourceSummary> {
        const bytes =
            typeof content === 'string'
                ? new TextEncoder().encode(content)
                : content;
        const payload: ResourcePutPayload = {
            name,
            kind: options?.kind ?? 'blob',
            mime: options?.mime,
            content: toBase64Url(bytes),
            validation_hook: options?.validationHook ?? null,
        };
        if (options?.cap) payload.cap_proof = options.cap;
        const result = await this.request<ResourcePutResult>(
            'resource_put',
            payload
        );
        if (!result.success || !result.summary) {
            throw new Error(result.error ?? 'resource_put failed');
        }
        return result.summary;
    }

    async getResource(
        nameOrCid: { name: string } | { cid: string }
    ): Promise<{ summary: ResourceSummary; content: Uint8Array }> {
        const payload: ResourceGetPayload = {};
        if ('name' in nameOrCid) payload.name = nameOrCid.name;
        else payload.cid = nameOrCid.cid;
        const result = await this.request<ResourceGetResult>(
            'resource_get',
            payload
        );
        if (!result.success || !result.summary || !result.content) {
            throw new Error(result.error ?? 'resource_get failed');
        }
        // Verify CID matches the received content — the relay's CID was
        // computed from the stored bytes, but a compromised relay could
        // lie. Re-deriving locally catches that.
        const bytes = fromBase64Url(result.content);
        const derived = blake3Cid(bytes);
        if (derived !== result.summary.cid) {
            throw new Error(
                `resource content hash mismatch: ${derived} vs ${result.summary.cid}`
            );
        }
        return { summary: result.summary, content: bytes };
    }

    async listResources(kind?: string): Promise<ResourceSummary[]> {
        const payload: ResourceListPayload = {};
        if (kind) payload.kind = kind;
        const result = await this.request<ResourceListResult>(
            'resource_list',
            payload
        );
        return result.resources;
    }

    async subscribeResource(name: string): Promise<void> {
        const payload: ResourceSubscribePayload = { name };
        const result = await this.request<ResourceSubscribeResult>(
            'resource_subscribe',
            payload
        );
        if (!result.success) {
            throw new Error(result.error ?? 'resource_subscribe failed');
        }
    }

    async unsubscribeResource(name: string): Promise<void> {
        const payload: ResourceUnsubscribePayload = { name };
        const result = await this.request<ResourceUnsubscribeResult>(
            'resource_unsubscribe',
            payload
        );
        if (!result.success) {
            throw new Error(result.error ?? 'resource_unsubscribe failed');
        }
    }

    leave() {
        if (this.ws.readyState === this.wsCtor.OPEN) {
            const envelope = makeEnvelope<LeavePayload>(
                'leave',
                {},
                this._privateKey,
                this._publicKey
            );
            this.ws.send(JSON.stringify(envelope));
        }
        this.ws.close();
    }

    get sessionPubkey(): string {
        return toBase64Url(this._publicKey);
    }

    /** Raw session public key bytes (ephemeral). */
    get publicKey(): Uint8Array {
        return this._publicKey;
    }

    /** Raw session private key bytes (ephemeral). Handle with care. */
    get privateKey(): Uint8Array {
        return this._privateKey;
    }

    /** The long-lived identity pubkey if one was supplied, else undefined. */
    get identityPubkey(): string | undefined {
        return this.opts.identityKeypair
            ? toBase64Url(this.opts.identityKeypair.publicKey)
            : undefined;
    }

    /** Cached agent list from the last joined or agents_changed event. */
    get agents(): readonly AgentSummary[] {
        return this._agents;
    }

    /** Cached topic list from the last joined event plus topic_changed updates. */
    get cachedTopics(): readonly TopicSummary[] {
        return this._topics;
    }

    /** Cached resource summaries, updated by joined + resource_changed events. */
    get cachedResources(): readonly ResourceSummary[] {
        return this._resources;
    }

    /** Room name this client is connected to. */
    get room(): string {
        return this.opts.room;
    }
}
