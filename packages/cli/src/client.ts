import WebSocket from 'ws';
import {
    generateKeypair,
    makeEnvelope,
    toBase64Url,
    verifyEnvelope,
    type CreateTopicPayload,
    type CreateTopicResult,
    type JoinPayload,
    type LeavePayload,
    type ListTopicsPayload,
    type ListTopicsResult,
    type MessageEvent,
    type SendPayload,
    type ServerEvent,
    type SubscribePayload,
    type SubscribeResult,
    type TopicChangedEvent,
    type TopicSummary,
    type UnsubscribePayload,
    type UnsubscribeResult,
} from '@dhruvy/openchat-sdk';

export interface ClientOptions {
    relayUrl: string;
    room: string;
    displayName?: string;
    description?: string;
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

export class Client {
    private ws: WebSocket;
    private privateKey: Uint8Array;
    private publicKey: Uint8Array;
    private joined = false;
    private joinResolve?: () => void;
    private joinReject?: (err: Error) => void;
    private pending = new Map<string, PendingRequest>();

    constructor(private opts: ClientOptions) {
        const kp = generateKeypair();
        this.privateKey = kp.privateKey;
        this.publicKey = kp.publicKey;

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
            this.privateKey,
            this.publicKey
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
            features: ['openchat/1'],
        };
        const envelope = makeEnvelope(
            'join',
            payload,
            this.privateKey,
            this.publicKey
        );
        this.ws.send(JSON.stringify(envelope));
    }

    send(body: string, topic = 'main') {
        const payload: SendPayload = { topic, body };
        const envelope = makeEnvelope(
            'send',
            payload,
            this.privateKey,
            this.publicKey
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

    async subscribe(topic: string): Promise<void> {
        const payload: SubscribePayload = { topic };
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
                this.privateKey,
                this.publicKey
            );
            this.ws.send(JSON.stringify(envelope));
        }
        this.ws.close();
    }

    get sessionPubkey(): string {
        return toBase64Url(this.publicKey);
    }
}
