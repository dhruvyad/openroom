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
    type RecentMessage,
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
     *  a relay restart, a network drop, or an explicit leave. With
     *  autoReconnect enabled the Client will attempt to restore the
     *  connection before surfacing the close; this callback fires
     *  only on *final* closes (explicit leave or reconnect gave up). */
    onClose?: (meta: { code?: number; reason?: string }) => void;
    /** Fired every time the keepalive ping is sent. Diagnostic only;
     *  callers typically don't need to know, but the MCP adapter
     *  uses it to prove the keepalive path is running inside
     *  subprocess-hosted servers. */
    onKeepalivePing?: () => void;
    /** Fired when an unexpected close triggers a reconnect attempt
     *  (before the attempt actually runs). */
    onReconnecting?: (meta: { attempt: number; delayMs: number }) => void;
    /** Fired after a successful auto-reconnect restored the room
     *  membership. The Client re-subscribes to topics, fires a fresh
     *  joined event snapshot onto cached state, and signals via this
     *  callback so the caller can refresh any UI. */
    onReconnected?: () => void;
    /** If true, when the WebSocket drops unexpectedly the Client will
     *  automatically open a fresh WS and rejoin the same room,
     *  reusing the same session keypair. Relay's handleJoin evicts
     *  the stale agent entry for an existing session pubkey and
     *  accepts the new one, so identity continuity is preserved.
     *  Recommended for long-running subprocesses (e.g. the MCP
     *  adapter). Default false. */
    autoReconnect?: boolean;
    /** Initial backoff for reconnect attempts in ms. Doubles each
     *  failed attempt up to reconnectMaxDelayMs. Default 1000. */
    reconnectBaseDelayMs?: number;
    /** Cap on the reconnect backoff. Default 30000. */
    reconnectMaxDelayMs?: number;
}

interface PendingRequest {
    resolve: (value: ServerEvent) => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
}

const REQUEST_TIMEOUT_MS = 5000;

/** WebSocket keepalive interval in milliseconds. Sends WS protocol
 *  PING control frames on this cadence (with a text-frame fallback
 *  for browsers). We also fire a kickoff ping right after join so
 *  there's TCP activity within a few seconds of connecting — some
 *  consumer NAT routers drop idle TCP mappings after 15-30 seconds
 *  which would manifest as abnormal closes before any traditional
 *  keepalive interval elapsed.
 *
 *  10s keeps the socket warm under any consumer-grade NAT and gives
 *  us 10 pings per 100s CF edge-idle window.
 */
const KEEPALIVE_INTERVAL_MS = 10_000;
const KEEPALIVE_KICKOFF_MS = 3_000;

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
    private ws!: WebSocketLike;
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
    private _recentMessages: RecentMessage[] = [];
    /** Topics we've explicitly subscribed to via subscribe(). Tracked
     *  separately from _topics (which is the room-wide topic list) so
     *  auto-reconnect can re-establish subscriptions on a fresh WS. */
    private _subscribedTopics = new Set<string>();
    /** Set to true when leave() is called so the close handler knows
     *  not to treat it as an unexpected drop and trigger reconnect. */
    private leaving = false;
    private reconnectAttempt = 0;
    private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    private readonly relayBaseUrl: string;
    private readonly roomUrl: string;

    constructor(private opts: ClientOptions, keypair?: ClientKeypair) {
        const kp = keypair ?? generateKeypair();
        this._privateKey = kp.privateKey;
        this._publicKey = kp.publicKey;
        this.wsCtor = opts.webSocket;

        this.relayBaseUrl = opts.relayUrl.replace(/\/+$/, '');
        this.roomUrl = `${this.relayBaseUrl}/v1/room/${encodeURIComponent(opts.room)}`;
        this.openSocket();
    }

    /** Open a fresh WebSocket and wire up handlers. Called once from
     *  the constructor and once per reconnect attempt. Clears any
     *  prior keepalive and pending state before rewiring. */
    private openSocket(): void {
        this.ws = new this.wsCtor(this.roomUrl);
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
            const code =
                ev && typeof ev === 'object' && 'code' in ev
                    ? (ev as { code?: number }).code
                    : undefined;
            const reason =
                ev && typeof ev === 'object' && 'reason' in ev
                    ? String((ev as { reason?: unknown }).reason)
                    : undefined;

            // If the caller asked for auto-reconnect and this wasn't a
            // deliberate leave, schedule a reconnect with exponential
            // backoff. We don't fire onClose in this path — onClose is
            // reserved for final terminations (leave, reconnect disabled).
            if (this.opts.autoReconnect && !this.leaving) {
                this.scheduleReconnect();
                return;
            }

            this.opts.onClose?.({ code, reason });
        });
    }

    private scheduleReconnect(): void {
        if (this.reconnectTimer !== null) return;
        const base = this.opts.reconnectBaseDelayMs ?? 1_000;
        const cap = this.opts.reconnectMaxDelayMs ?? 30_000;
        // Exponential backoff: base * 2^attempt, capped.
        const delayMs = Math.min(cap, base * Math.pow(2, this.reconnectAttempt));
        this.reconnectAttempt += 1;
        this.opts.onReconnecting?.({
            attempt: this.reconnectAttempt,
            delayMs,
        });
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            void this.runReconnect();
        }, delayMs);
        const ref = this.reconnectTimer as unknown as {
            unref?: () => void;
        };
        if (typeof ref.unref === 'function') ref.unref();
    }

    private async runReconnect(): Promise<void> {
        // Reset the join promise machinery so the rejoin handshake
        // resolves through a fresh promise chain.
        const rejoin = new Promise<void>((resolve, reject) => {
            this.joinResolve = resolve;
            this.joinReject = reject;
        });
        try {
            this.openSocket();
            await rejoin;
            // Successfully rejoined. Re-subscribe to topics we had
            // before the drop. Run them sequentially so any per-topic
            // failure only affects that topic.
            const topicsToResume = Array.from(this._subscribedTopics);
            // Clear first so the per-topic subscribe() below can
            // re-populate as each call succeeds.
            this._subscribedTopics.clear();
            for (const topic of topicsToResume) {
                try {
                    await this.subscribe(topic);
                } catch (err) {
                    this.opts.onError?.(
                        `reconnect: failed to re-subscribe to ${topic}: ${(err as Error).message}`
                    );
                }
            }
            this.reconnectAttempt = 0;
            this.opts.onReconnected?.();
        } catch (err) {
            // Rejoin failed. The close handler already fired and will
            // re-schedule via scheduleReconnect on the new ws close.
            this.opts.onError?.(
                `reconnect attempt failed: ${(err as Error).message}`
            );
        }
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
                // Verify each backfilled envelope's signature. The
                // relay has already verified them once on the way in,
                // but we re-check here because a compromised relay
                // could fabricate history to mislead the client. On
                // verify failure, drop the entry silently.
                this._recentMessages = (event.recent_messages ?? []).filter(
                    (m) => verifyEnvelope(m.envelope)
                );
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
        const hasProtocolPing = typeof wsWithPing.ping === 'function';
        const sendPing = () => {
            if (this.ws.readyState !== this.wsCtor.OPEN) return;
            try {
                // 1. Protocol-level PING control frame (Node `ws` only).
                //    Keeps the TCP connection alive through consumer
                //    NAT and CF edge, handled transparently at the
                //    socket layer regardless of event-loop health.
                if (hasProtocolPing) {
                    wsWithPing.ping!();
                }
                // 2. Text-frame "ping". Routed to the relay DO's
                //    webSocketMessage handler, where it wakes the DO
                //    and refreshes the DO's binding to this WS —
                //    CF can evict the binding from a hibernated DO
                //    if nothing ever wakes it, at which point the
                //    agent falls out of the room even though the
                //    client's TCP is still alive (the edge ponged
                //    protocol pings without telling the DO).
                //    Belt and suspenders: one keeps the pipe, the
                //    other keeps the state.
                this.ws.send('ping');
                this.opts.onKeepalivePing?.();
            } catch {
                // ws layer may be mid-close; next close event cleans up
            }
        };
        // Kickoff ping shortly after join so there's TCP activity
        // within seconds, well before any consumer NAT idle timeout.
        const kickoff = setTimeout(sendPing, KEEPALIVE_KICKOFF_MS);
        const kickoffRef = kickoff as unknown as { unref?: () => void };
        if (typeof kickoffRef.unref === 'function') kickoffRef.unref();

        this.keepaliveTimer = setInterval(sendPing, KEEPALIVE_INTERVAL_MS);
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
        // Track for auto-reconnect restore.
        this._subscribedTopics.add(topic);
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
        this._subscribedTopics.delete(topic);
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
        // Mark as a deliberate termination so the close handler
        // doesn't trigger auto-reconnect.
        this.leaving = true;
        if (this.reconnectTimer !== null) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
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

    /** History buffer delivered by the relay in the joined event.
     *  Ordered oldest-first. Callers rendering a feed should seed it
     *  with these entries on connect, then layer live onMessage /
     *  onDirectMessage events on top. */
    get recentMessages(): readonly RecentMessage[] {
        return this._recentMessages;
    }

    /** Room name this client is connected to. */
    get room(): string {
        return this.opts.room;
    }
}
