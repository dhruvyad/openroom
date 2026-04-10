import WebSocket from 'ws';
import {
    generateKeypair,
    makeEnvelope,
    makeSessionAttestation,
    toBase64Url,
    verifyEnvelope,
    type Cap,
    type CreateTopicPayload,
    type CreateTopicResult,
    type JoinPayload,
    type Keypair,
    type LeavePayload,
    type ListTopicsPayload,
    type ListTopicsResult,
    type MessageEvent,
    type SendPayload,
    type ServerEvent,
    type SessionAttestation,
    type SubscribePayload,
    type SubscribeResult,
    type TopicChangedEvent,
    type TopicSummary,
    type UnsubscribePayload,
    type UnsubscribeResult,
} from 'openroom-sdk';

export interface ClientOptions {
    relayUrl: string;
    room: string;
    displayName?: string;
    description?: string;
    /** Optional long-lived identity keypair. When supplied, the client
     * creates a session attestation and sends it in the join payload so
     * peers can recognize this session as the same identity across
     * reconnects. */
    identityKeypair?: Keypair;
    onMessage?: (event: MessageEvent) => void;
    onAgentsChanged?: (
        event: Extract<ServerEvent, { type: 'agents_changed' }>
    ) => void;
    onTopicChanged?: (event: TopicChangedEvent) => void;
    onError?: (reason: string) => void;
}

interface PendingRequest {
    resolve: (value: ServerEvent) => void;
    reject: (err: Error) => void;
    timer: NodeJS.Timeout;
}

const REQUEST_TIMEOUT_MS = 5000;

export interface ClientKeypair {
    privateKey: Uint8Array;
    publicKey: Uint8Array;
}

export class Client {
    private ws: WebSocket;
    private _privateKey: Uint8Array;
    private _publicKey: Uint8Array;
    private joined = false;
    private joinResolve?: () => void;
    private joinReject?: (err: Error) => void;
    private pending = new Map<string, PendingRequest>();

    constructor(private opts: ClientOptions, keypair?: ClientKeypair) {
        const kp = keypair ?? generateKeypair();
        this._privateKey = kp.privateKey;
        this._publicKey = kp.publicKey;

        const baseUrl = opts.relayUrl.replace(/\/+$/, '');
        const url = `${baseUrl}/v1/room/${encodeURIComponent(opts.room)}`;
        this.ws = new WebSocket(url);
        this.ws.on('message', (data) => this.handleServerEvent(data.toString()));
        this.ws.on('error', (err) => {
            this.joinReject?.(err);
            this.opts.onError?.(err.message);
        });
        this.ws.on('close', () => {
            for (const pending of this.pending.values()) {
                clearTimeout(pending.timer);
                pending.reject(new Error('connection closed'));
            }
            this.pending.clear();
            if (!this.joined) {
                this.joinReject?.(
                    new Error('connection closed before join completed')
                );
            }
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
            event.type === 'subscribe_result' ||
            event.type === 'unsubscribe_result' ||
            event.type === 'list_topics_result'
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
            case 'agents_changed':
                this.opts.onAgentsChanged?.(event);
                return;
            case 'topic_changed':
                this.opts.onTopicChanged?.(event);
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

    send(body: string, topic = 'main', options?: { cap?: Cap }) {
        const payload: SendPayload = { topic, body };
        if (options?.cap) payload.cap_proof = options.cap;
        const envelope = makeEnvelope(
            'send',
            payload,
            this._privateKey,
            this._publicKey
        );
        this.ws.send(JSON.stringify(envelope));
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

    leave() {
        if (this.ws.readyState === WebSocket.OPEN) {
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
}
