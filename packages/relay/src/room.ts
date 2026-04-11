import {
    blake3Cid,
    fromBase64Url,
    toBase64Url,
    verifyCapChain,
    verifyEnvelope,
    verifySessionAttestation,
    type AgentSummary,
    type Cap,
    type CreateTopicPayload,
    type DirectPayload,
    type Envelope,
    type JoinPayload,
    type ListTopicsPayload,
    type ResourceGetPayload,
    type ResourceListPayload,
    type ResourcePutPayload,
    type ResourceSubscribePayload,
    type ResourceSummary,
    type ResourceUnsubscribePayload,
    type SendPayload,
    type ServerEvent,
    type SessionAttestation,
    type SubscribePayload,
    type TopicSummary,
    type UnsubscribePayload,
} from 'openroom-sdk';

/**
 * Minimum WebSocket interface the relay core needs. Both Node's `ws`
 * package and the Cloudflare Workers runtime WebSocket (via `WebSocketPair`)
 * satisfy this shape, so the same core runs in both environments without
 * conditional imports.
 */
export interface RelayWebSocket {
    send(data: string): void;
    close(code?: number, reason?: string): void;
    readonly readyState: number;
}

interface Agent {
    ws: RelayWebSocket;
    roomName: string;
    sessionPubkey: string;
    displayName?: string;
    description?: string;
    joined: boolean;
    challengeNonce: string;
    /** long-lived identity pubkey if the agent presented a valid attestation */
    identityPubkey?: string;
    /** the raw attestation, forwarded to peers as-is so they can verify locally */
    identityAttestation?: SessionAttestation;
    /** token bucket for per-connection rate limiting */
    rateTokens: number;
    rateLastRefillMs: number;
    /** names of topics this agent currently subscribes to. Tracked here so
     *  it can be serialized into ws attachment for hibernation survival. */
    subscribedTopics: Set<string>;
}

/**
 * Hooks the DO (or Node server) provides so RelayCore can fire-and-forget
 * notifications about state mutations that need to reach durable storage.
 * See HIBERNATION.md for the architecture.
 */
export interface RelayCoreHooks {
    topicCreated?(record: {
        name: string;
        subscribeCap: string | null;
        postCap: string | null;
    }): void;
    topicDeleted?(name: string): void;
    resourcePut?(record: {
        name: string;
        cid: string;
        kind: string;
        mime: string;
        size: number;
        content: Uint8Array;
        createdBy: string;
        createdAt: number;
        validationHook: string | null;
    }): void;
    resourceDeleted?(name: string): void;
    /** Called when any per-agent state changes that needs to survive hibernation
     *  (join, subscribe, unsubscribe, rate token decrement). The DO flushes
     *  the attachment after the current handler returns. */
    agentMutated?(ws: RelayWebSocket): void;
}

/**
 * Serialized agent state for ws.serializeAttachment(). MUST fit under the
 * Cloudflare 2 KB attachment cap. Any new field added here needs a
 * schema-version bump and a migration path.
 */
export interface AgentAttachment {
    v: number;
    sessionPubkey: string;
    displayName?: string;
    description?: string;
    identityPubkey?: string;
    identityAttestation?: SessionAttestation;
    rateTokens: number;
    rateLastRefillMs: number;
    subscribedTopics: string[];
}

export const AGENT_ATTACHMENT_VERSION = 1;
/** Soft cap used by the DO to warn before we hit the hard 2 KiB cap. */
export const AGENT_ATTACHMENT_SOFT_LIMIT = 1536;
/** Hard cap enforced by Cloudflare — writes > 2 KB throw. */
export const AGENT_ATTACHMENT_HARD_LIMIT = 2048;

interface Topic {
    name: string;
    subscribeCap: string | null;
    postCap: string | null;
    members: Set<string>; // session pubkeys
}

interface Resource {
    name: string;
    cid: string;
    kind: string;
    mime: string;
    size: number;
    content: Uint8Array;
    createdBy: string;
    createdAt: number;
    /** cap root required for future writes at this name; null = open */
    validationHook: string | null;
    /** session pubkeys subscribed to change notifications for this resource */
    subscribers: Set<string>;
}

interface Room {
    name: string;
    agents: Map<string, Agent>;
    topics: Map<string, Topic>;
    resources: Map<string, Resource>;
}

const TIMESTAMP_DRIFT_SECONDS = 300;
const REPLAY_WINDOW_SECONDS = 600;
const REPLAY_PRUNE_THRESHOLD = 4096;
const MAIN_TOPIC = 'main';
const WS_OPEN = 1;
/** Max inline resource content size in bytes (1 MiB). Matches PROTOCOL.md. */
const MAX_RESOURCE_CONTENT_BYTES = 1024 * 1024;
/** Max length of a resource name slot (bytes). */
const MAX_RESOURCE_NAME_BYTES = 256;

// Memory bounds per room. Rough ceilings that prevent a single room from
// consuming unbounded relay memory under abuse. Generous for real usage.
const MAX_AGENTS_PER_ROOM = 500;
const MAX_TOPICS_PER_ROOM = 100;
const MAX_RESOURCES_PER_ROOM = 500;
const MAX_TOTAL_RESOURCE_BYTES_PER_ROOM = 32 * 1024 * 1024;

// Per-connection rate limit (token bucket). Well-behaved clients stay
// well under these; abusers hit them quickly and get error responses
// until they back off.
const RATE_LIMIT_BURST = 100;
const RATE_LIMIT_SUSTAINED_PER_SEC = 20;

/** Max topics a single agent can subscribe to. Bounds attachment size
 *  (30 topic names * ~40 bytes = 1.2 KB) so rehydration always fits. */
const MAX_SUBSCRIPTIONS_PER_AGENT = 30;
/** Max description length so the attachment stays under 2 KB. */
const MAX_DESCRIPTION_BYTES = 256;
// Maximum cap chain length (leaf + proof ancestors). Caps one level past a
// reasonable hierarchy and bounds per-action Ed25519 verification work so
// malicious clients can't amplify DoS via enormous proof chains.
const MAX_CAP_CHAIN_DEPTH = 10;
// Maximum session attestation lifetime this relay will honor, measured
// from now to expires_at. Combined with the lack of a v1 revoke verb, a
// year-3000 attestation would effectively make a compromised identity key
// trusted forever. 30 days is a practical ceiling that gives normal users
// plenty of headroom while bounding the blast radius of a leak.
const MAX_ATTESTATION_LIFETIME_SECONDS = 30 * 24 * 60 * 60;

function summarizeResource(r: {
    name: string;
    cid: string;
    kind: string;
    mime: string;
    size: number;
    createdBy: string;
    createdAt: number;
    validationHook: string | null;
}): ResourceSummary {
    return {
        name: r.name,
        cid: r.cid,
        kind: r.kind,
        mime: r.mime,
        size: r.size,
        created_by: r.createdBy,
        created_at: r.createdAt,
        validation_hook: r.validationHook,
    };
}

function isCapShaped(value: unknown): value is Cap {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    // Reject non-plain objects (Date, Map, class instances, etc.) — checkCap
    // forwards to verifyCapChain which assumes a plain Cap record shape.
    if (Object.getPrototypeOf(value) !== Object.prototype) return false;
    const c = value as Record<string, unknown>;
    return (
        typeof c.iss === 'string' &&
        typeof c.aud === 'string' &&
        typeof c.sig === 'string' &&
        typeof c.nbf === 'number' &&
        typeof c.exp === 'number' &&
        typeof c.nonce === 'string' &&
        !!c.cap &&
        typeof c.cap === 'object'
    );
}

export class RelayCore {
    private rooms = new Map<string, Room>();
    // Global replay protection keyed by `${from}:${id}`. Applies to every
    // signed envelope, not just `send` — the spec calls for dedup on all
    // envelopes, and without it `subscribe` / `create_topic` replays would
    // be trivially accepted within the ±5 min timestamp window.
    private recentEnvelopes = new Map<string, number>();
    // Per-connection state keyed by WebSocket reference. Lets the platform
    // glue (Node ws.on handlers or CF DO webSocket event listeners) look up
    // the Agent from the ws object without smuggling it through closures.
    private connections = new Map<RelayWebSocket, Agent>();
    private hooks: RelayCoreHooks;

    constructor(hooks: RelayCoreHooks = {}) {
        this.hooks = hooks;
    }

    /** Is this ws currently registered with the core? Used by the DO to
     *  decide whether it needs to rehydrate from ws.deserializeAttachment()
     *  before dispatching a message (true on wake from hibernation). */
    knows(ws: RelayWebSocket): boolean {
        return this.connections.has(ws);
    }

    /** Is the given room currently loaded in memory? False after the room
     *  was emptied via handleLeave and not yet re-loaded from storage. */
    hasRoom(roomName: string): boolean {
        return this.rooms.has(roomName);
    }

    getAgent(ws: RelayWebSocket): Agent | undefined {
        return this.connections.get(ws);
    }

    /** Read-only access to a named resource in a loaded room. Used by the
     *  DO for internal cross-DO lookups (e.g. directory-config). */
    readResource(
        roomName: string,
        resourceName: string
    ): { content: Uint8Array; kind: string; mime: string } | null {
        const room = this.rooms.get(roomName);
        if (!room) return null;
        const resource = room.resources.get(resourceName);
        if (!resource) return null;
        return {
            content: resource.content,
            kind: resource.kind,
            mime: resource.mime,
        };
    }

    /**
     * Bulk-load room state after a hibernation wake. Called from the DO's
     * async initialize() path. Replaces any existing in-memory state for
     * this room (the only place that would have existing state is the
     * freshly-constructed empty Maps). Also makes sure a default `main`
     * topic exists even if storage is empty.
     */
    loadSnapshot(
        roomName: string,
        snapshot: {
            topics: Array<{
                name: string;
                subscribeCap: string | null;
                postCap: string | null;
            }>;
            resources: Array<{
                name: string;
                cid: string;
                kind: string;
                mime: string;
                size: number;
                content: Uint8Array;
                createdBy: string;
                createdAt: number;
                validationHook: string | null;
            }>;
        }
    ): void {
        const room: Room = {
            name: roomName,
            agents: new Map(),
            topics: new Map(),
            resources: new Map(),
        };
        for (const t of snapshot.topics) {
            room.topics.set(t.name, {
                name: t.name,
                subscribeCap: t.subscribeCap,
                postCap: t.postCap,
                members: new Set(),
            });
        }
        // Always guarantee the default topic exists.
        if (!room.topics.has(MAIN_TOPIC)) {
            room.topics.set(MAIN_TOPIC, {
                name: MAIN_TOPIC,
                subscribeCap: null,
                postCap: null,
                members: new Set(),
            });
        }
        for (const r of snapshot.resources) {
            room.resources.set(r.name, {
                name: r.name,
                cid: r.cid,
                kind: r.kind,
                mime: r.mime,
                size: r.size,
                content: r.content,
                createdBy: r.createdBy,
                createdAt: r.createdAt,
                validationHook: r.validationHook,
                subscribers: new Set(),
            });
        }
        this.rooms.set(roomName, room);
    }

    /**
     * Rehydrate an agent that was previously joined but lost from in-memory
     * state due to DO hibernation. Reconstitutes the agent from its serialized
     * attachment, registers it in `connections`, and re-populates topic
     * `members` sets for any topics the agent was subscribed to. Topics that
     * no longer exist in the loaded room state are dropped silently and the
     * caller should re-serialize the attachment to reflect the cleanup.
     *
     * Returns the set of topic names that were dropped, if any — non-empty
     * means the attachment is now stale and should be re-persisted.
     */
    rehydrateAgent(
        ws: RelayWebSocket,
        attachment: AgentAttachment,
        roomName: string
    ): { droppedTopics: string[] } {
        const room = this.ensureRoom(roomName);
        if (attachment.v !== AGENT_ATTACHMENT_VERSION) {
            ws.close(1011, 'unknown agent schema version');
            return { droppedTopics: [] };
        }

        const agent: Agent = {
            ws,
            roomName,
            sessionPubkey: attachment.sessionPubkey,
            displayName: attachment.displayName,
            description: attachment.description,
            joined: true,
            challengeNonce: '', // already used; not needed after join
            identityPubkey: attachment.identityPubkey,
            identityAttestation: attachment.identityAttestation,
            rateTokens: attachment.rateTokens,
            rateLastRefillMs: attachment.rateLastRefillMs,
            subscribedTopics: new Set(),
        };

        this.connections.set(ws, agent);
        room.agents.set(agent.sessionPubkey, agent);

        const droppedTopics: string[] = [];
        for (const topicName of attachment.subscribedTopics) {
            const topic = room.topics.get(topicName);
            if (!topic) {
                droppedTopics.push(topicName);
                continue;
            }
            topic.members.add(agent.sessionPubkey);
            agent.subscribedTopics.add(topicName);
        }

        return { droppedTopics };
    }

    /** Serialize an agent to the shape persisted via ws.serializeAttachment. */
    serializeAgent(agent: Agent): AgentAttachment {
        return {
            v: AGENT_ATTACHMENT_VERSION,
            sessionPubkey: agent.sessionPubkey,
            displayName: agent.displayName,
            description: agent.description,
            identityPubkey: agent.identityPubkey,
            identityAttestation: agent.identityAttestation,
            rateTokens: agent.rateTokens,
            rateLastRefillMs: agent.rateLastRefillMs,
            subscribedTopics: Array.from(agent.subscribedTopics),
        };
    }

    /**
     * Register a new incoming WebSocket for the given room. Sends the
     * `challenge` event. The caller is responsible for wiring the ws's
     * message / close / error events to `deliverMessage` and `detach`.
     */
    attach(
        ws: RelayWebSocket,
        roomName: string,
        challengeNonce: string
    ) {
        const agent: Agent = {
            ws,
            roomName,
            sessionPubkey: '',
            joined: false,
            challengeNonce,
            rateTokens: RATE_LIMIT_BURST,
            rateLastRefillMs: Date.now(),
            subscribedTopics: new Set(),
        };
        this.connections.set(ws, agent);
        this.sendEvent(ws, { type: 'challenge', nonce: challengeNonce });
    }

    /** Process an inbound text frame from an attached connection. */
    deliverMessage(ws: RelayWebSocket, raw: string) {
        const agent = this.connections.get(ws);
        if (!agent) return;
        this.handleMessage(agent, agent.roomName, raw);
    }

    /**
     * Release a connection. Call this from ws close or error events. If the
     * agent had successfully joined, this broadcasts `agents_changed` to
     * the rest of the room via the leave handler.
     */
    detach(ws: RelayWebSocket) {
        const agent = this.connections.get(ws);
        if (!agent) return;
        this.connections.delete(ws);
        if (agent.joined) {
            this.handleLeave(agent, agent.roomName);
        }
    }

    private handleMessage(agent: Agent, roomName: string, raw: string) {
        // Rate limit BEFORE anything else — including JSON parse and
        // signature verification. A flood of junk envelopes should not
        // force the relay to burn CPU on parsing.
        if (!this.consumeRateLimit(agent, Date.now())) {
            this.sendError(agent.ws, 'rate limit exceeded');
            return;
        }

        let envelope: Envelope;
        try {
            envelope = JSON.parse(raw) as Envelope;
        } catch {
            this.sendError(agent.ws, 'invalid json');
            return;
        }

        if (
            typeof envelope?.type !== 'string' ||
            typeof envelope?.id !== 'string' ||
            typeof envelope?.from !== 'string' ||
            typeof envelope?.sig !== 'string' ||
            typeof envelope?.ts !== 'number' ||
            envelope?.payload === undefined
        ) {
            this.sendError(agent.ws, 'malformed envelope');
            return;
        }

        const now = Math.floor(Date.now() / 1000);
        if (Math.abs(envelope.ts - now) > TIMESTAMP_DRIFT_SECONDS) {
            this.sendError(agent.ws, 'timestamp drift');
            return;
        }

        if (!verifyEnvelope(envelope)) {
            this.sendError(agent.ws, 'invalid signature');
            return;
        }

        if (agent.joined && envelope.from !== agent.sessionPubkey) {
            this.sendError(agent.ws, 'envelope from does not match session');
            return;
        }

        // Replay protection applies to every signed envelope, silently.
        const replayKey = `${envelope.from}:${envelope.id}`;
        const seen = this.recentEnvelopes.get(replayKey);
        if (seen !== undefined && now - seen < REPLAY_WINDOW_SECONDS) {
            return;
        }
        this.recentEnvelopes.set(replayKey, now);
        this.pruneReplayWindow(now);

        switch (envelope.type) {
            case 'join':
                this.handleJoin(
                    agent,
                    roomName,
                    envelope as Envelope<JoinPayload>
                );
                return;
            case 'send':
                this.handleSend(
                    agent,
                    roomName,
                    envelope as Envelope<SendPayload>
                );
                return;
            case 'direct':
                this.handleDirect(
                    agent,
                    roomName,
                    envelope as Envelope<DirectPayload>
                );
                return;
            case 'leave':
                this.handleLeave(agent, roomName);
                return;
            case 'create_topic':
                this.handleCreateTopic(
                    agent,
                    roomName,
                    envelope as Envelope<CreateTopicPayload>
                );
                return;
            case 'subscribe':
                this.handleSubscribe(
                    agent,
                    roomName,
                    envelope as Envelope<SubscribePayload>
                );
                return;
            case 'unsubscribe':
                this.handleUnsubscribe(
                    agent,
                    roomName,
                    envelope as Envelope<UnsubscribePayload>
                );
                return;
            case 'list_topics':
                this.handleListTopics(
                    agent,
                    roomName,
                    envelope as Envelope<ListTopicsPayload>
                );
                return;
            case 'resource_put':
                this.handleResourcePut(
                    agent,
                    roomName,
                    envelope as Envelope<ResourcePutPayload>
                );
                return;
            case 'resource_get':
                this.handleResourceGet(
                    agent,
                    roomName,
                    envelope as Envelope<ResourceGetPayload>
                );
                return;
            case 'resource_list':
                this.handleResourceList(
                    agent,
                    roomName,
                    envelope as Envelope<ResourceListPayload>
                );
                return;
            case 'resource_subscribe':
                this.handleResourceSubscribe(
                    agent,
                    roomName,
                    envelope as Envelope<ResourceSubscribePayload>
                );
                return;
            case 'resource_unsubscribe':
                this.handleResourceUnsubscribe(
                    agent,
                    roomName,
                    envelope as Envelope<ResourceUnsubscribePayload>
                );
                return;
            default:
                this.sendError(
                    agent.ws,
                    `unknown envelope type: ${envelope.type}`
                );
        }
    }

    private handleJoin(
        agent: Agent,
        roomName: string,
        envelope: Envelope<JoinPayload>
    ) {
        if (agent.joined) {
            this.sendError(agent.ws, 'already joined');
            return;
        }
        if (envelope.payload?.nonce !== agent.challengeNonce) {
            this.sendError(agent.ws, 'nonce mismatch');
            return;
        }

        // Optional session attestation linking this session key to a long-
        // lived identity key. The relay verifies the signature, that the
        // attestation actually names this session, and that it is scoped to
        // THIS room (not replayed from another). Trust and reputation are
        // still type-level, not relay-level.
        const att = envelope.payload.session_attestation;
        if (att !== undefined) {
            if (att.session_pubkey !== envelope.from) {
                this.sendError(
                    agent.ws,
                    'session attestation does not bind envelope session'
                );
                return;
            }
            if (att.room !== roomName) {
                this.sendError(
                    agent.ws,
                    'session attestation is scoped to a different room'
                );
                return;
            }
            if (
                att.expires_at >
                Math.floor(Date.now() / 1000) +
                    MAX_ATTESTATION_LIFETIME_SECONDS
            ) {
                this.sendError(
                    agent.ws,
                    `session attestation lifetime exceeds relay maximum (${MAX_ATTESTATION_LIFETIME_SECONDS}s)`
                );
                return;
            }
            if (!verifySessionAttestation(att)) {
                this.sendError(
                    agent.ws,
                    'invalid session attestation signature or expiry'
                );
                return;
            }
            agent.identityPubkey = att.identity_pubkey;
            agent.identityAttestation = att;
        }

        const room = this.ensureRoom(roomName);
        // Agent count cap. Existing session-key takeover doesn't count
        // as a new agent (we evict the old one), so check before the
        // takeover branch.
        if (
            !room.agents.has(envelope.from) &&
            room.agents.size >= MAX_AGENTS_PER_ROOM
        ) {
            this.sendError(agent.ws, 'room agent limit reached');
            return;
        }

        agent.sessionPubkey = envelope.from;
        agent.displayName = envelope.payload.display_name;
        // Cap description to bound per-ws attachment size so it survives
        // hibernation via ws.serializeAttachment (2 KB hard limit).
        if (
            typeof envelope.payload.description === 'string' &&
            envelope.payload.description.length > MAX_DESCRIPTION_BYTES
        ) {
            agent.description = envelope.payload.description.slice(
                0,
                MAX_DESCRIPTION_BYTES
            );
        } else {
            agent.description = envelope.payload.description;
        }
        agent.joined = true;

        const existing = room.agents.get(agent.sessionPubkey);
        if (existing && existing !== agent) {
            existing.ws.close();
            for (const topic of room.topics.values()) {
                topic.members.delete(agent.sessionPubkey);
            }
            room.agents.delete(agent.sessionPubkey);
        }
        room.agents.set(agent.sessionPubkey, agent);

        // Auto-subscribe to the default topic.
        const main = room.topics.get(MAIN_TOPIC)!;
        main.members.add(agent.sessionPubkey);
        agent.subscribedTopics.add(MAIN_TOPIC);

        // Per-agent attachment is now dirty with the freshly-joined state.
        this.hooks.agentMutated?.(agent.ws);

        const agents = this.snapshotAgents(room);
        const topics = this.snapshotTopics(room);
        const resources = this.snapshotResources(room);

        this.sendEvent(agent.ws, {
            type: 'joined',
            room: roomName,
            you: agent.sessionPubkey,
            agents,
            topics,
            resources,
            server_time: Math.floor(Date.now() / 1000),
        });

        this.broadcastToRoom(
            room,
            { type: 'agents_changed', agents },
            agent.sessionPubkey
        );
    }

    private handleSend(
        agent: Agent,
        roomName: string,
        envelope: Envelope<SendPayload>
    ) {
        const sendFail = (error: string) => {
            this.sendResult(agent.ws, {
                type: 'send_result',
                id: envelope.id,
                success: false,
                error,
            });
        };

        if (!agent.joined) {
            sendFail('not joined');
            return;
        }
        const room = this.rooms.get(roomName);
        if (!room) {
            sendFail('unknown room');
            return;
        }

        const topicName = envelope.payload.topic;
        const topic = room.topics.get(topicName);
        if (!topic) {
            sendFail(`unknown topic: ${topicName}`);
            return;
        }

        if (topic.postCap !== null) {
            const check = this.checkCap(
                envelope.payload.cap_proof,
                agent,
                topic.postCap,
                roomName,
                topicName,
                'post'
            );
            if (!check.ok) {
                sendFail(
                    `post denied: ${check.reason ?? 'no valid cap'}`
                );
                return;
            }
        } else if (envelope.payload.cap_proof !== undefined) {
            // Open topic — a cap_proof here would be forwarded to peers as
            // opaque payload data. Reject so callers surface the inconsistency.
            sendFail('open topic does not accept cap_proof');
            return;
        }

        const event: ServerEvent = {
            type: 'message',
            room: roomName,
            envelope,
        };
        this.broadcastToTopic(room, topic, event);

        // Ack the send so the caller can correlate success to a specific
        // envelope id instead of inferring from the absence of an error.
        this.sendResult(agent.ws, {
            type: 'send_result',
            id: envelope.id,
            success: true,
        });
    }

    /**
     * Handle a direct envelope. Semantics: DMs are room-wide broadcasts with
     * a target tag, not private routing. Every agent in the room — including
     * viewers and other participants — receives the direct_message event.
     * The `target` field is a UI hint identifying the intended recipient,
     * not a routing constraint. This is deliberate: openroom's mission is
     * observable multi-agent coordination, and a private side-channel would
     * be the opposite of that. Adversarial agents can't use DMs as a hidden
     * back-channel because there is no hidden channel.
     *
     * Target existence is still verified: the relay rejects a DM whose
     * target isn't currently present in the room. This keeps the `target`
     * field meaningful (you can't DM nobody) and lets senders handle
     * missing-recipient errors cleanly.
     */
    private handleDirect(
        agent: Agent,
        roomName: string,
        envelope: Envelope<DirectPayload>
    ) {
        const fail = (error: string) => {
            this.sendResult(agent.ws, {
                type: 'direct_result',
                id: envelope.id,
                success: false,
                error,
            });
        };

        if (!agent.joined) return fail('not joined');
        const room = this.rooms.get(roomName);
        if (!room) return fail('unknown room');

        const target = envelope.payload?.target;
        if (typeof target !== 'string' || target.length === 0) {
            return fail('invalid target');
        }
        if (typeof envelope.payload?.body !== 'string') {
            return fail('body must be a string');
        }

        // Resolve the target against the room's agent set. Matches either
        // by session pubkey (the direct case) or by attested identity
        // pubkey (so you can DM a persistent identity whose current
        // session you don't know). Same two-audience fallback we use for
        // cap checks.
        let targetFound = false;
        for (const other of room.agents.values()) {
            if (!other.joined) continue;
            if (other.sessionPubkey === target) {
                targetFound = true;
                break;
            }
            if (
                other.identityPubkey !== undefined &&
                other.identityPubkey === target
            ) {
                targetFound = true;
                break;
            }
        }
        if (!targetFound) return fail('target not in room');

        const event: ServerEvent = {
            type: 'direct_message',
            room: roomName,
            envelope,
        };
        // Room-wide broadcast: every joined agent receives the DM event.
        // Exclude the sender since they already see their own action via
        // the direct_result ack.
        this.broadcastToRoom(room, event, agent.sessionPubkey);

        this.sendResult(agent.ws, {
            type: 'direct_result',
            id: envelope.id,
            success: true,
        });
    }

    private handleCreateTopic(
        agent: Agent,
        roomName: string,
        envelope: Envelope<CreateTopicPayload>
    ) {
        if (!agent.joined) {
            this.sendResult(agent.ws, {
                type: 'create_topic_result',
                id: envelope.id,
                success: false,
                error: 'not joined',
            });
            return;
        }
        const room = this.rooms.get(roomName);
        if (!room) return;

        const name = envelope.payload?.name;
        if (
            typeof name !== 'string' ||
            name.length === 0 ||
            name.length > 128
        ) {
            this.sendResult(agent.ws, {
                type: 'create_topic_result',
                id: envelope.id,
                success: false,
                error: 'invalid topic name',
            });
            return;
        }

        // Cap fields, if present, are the base64url pubkey of the topic's
        // root authority. They must be strings (or null); we do not further
        // validate pubkey shape here — invalid keys simply fail chain
        // verification later when someone tries to present a proof.
        const subscribeCap = envelope.payload.subscribe_cap ?? null;
        const postCap = envelope.payload.post_cap ?? null;
        if (
            (subscribeCap !== null && typeof subscribeCap !== 'string') ||
            (postCap !== null && typeof postCap !== 'string')
        ) {
            this.sendResult(agent.ws, {
                type: 'create_topic_result',
                id: envelope.id,
                success: false,
                error: 'cap fields must be pubkey strings or null',
            });
            return;
        }

        let topic = room.topics.get(name);
        let created = false;
        if (!topic) {
            if (room.topics.size >= MAX_TOPICS_PER_ROOM) {
                this.sendResult(agent.ws, {
                    type: 'create_topic_result',
                    id: envelope.id,
                    success: false,
                    error: 'room topic limit reached',
                });
                return;
            }
            topic = {
                name,
                subscribeCap,
                postCap,
                members: new Set(),
            };
            room.topics.set(name, topic);
            created = true;
            this.hooks.topicCreated?.({
                name,
                subscribeCap,
                postCap,
            });
        } else if (
            topic.subscribeCap !== subscribeCap ||
            topic.postCap !== postCap
        ) {
            // Idempotent only on exact match. Reject mismatched re-creates so
            // the caller doesn't silently think they reconfigured the topic.
            this.sendResult(agent.ws, {
                type: 'create_topic_result',
                id: envelope.id,
                success: false,
                error: 'topic exists with different cap fields',
            });
            return;
        }

        const summary: TopicSummary = {
            name: topic.name,
            subscribe_cap: topic.subscribeCap,
            post_cap: topic.postCap,
        };

        this.sendResult(agent.ws, {
            type: 'create_topic_result',
            id: envelope.id,
            success: true,
            topic: summary,
        });

        if (created) {
            // Exclude the creator from the broadcast: they already received
            // create_topic_result. Delivering topic_changed on top would mean
            // a single request yields two events, which makes RPC correlation
            // fragile for clients that don't eagerly dispatch.
            this.broadcastToRoom(
                room,
                {
                    type: 'topic_changed',
                    topic: name,
                    change: 'created',
                    summary,
                },
                agent.sessionPubkey
            );
        }
    }

    private handleSubscribe(
        agent: Agent,
        roomName: string,
        envelope: Envelope<SubscribePayload>
    ) {
        const topicName = envelope.payload?.topic;
        if (!agent.joined) {
            this.sendResult(agent.ws, {
                type: 'subscribe_result',
                id: envelope.id,
                success: false,
                topic: topicName ?? '',
                error: 'not joined',
            });
            return;
        }
        const room = this.rooms.get(roomName);
        if (!room) return;

        if (typeof topicName !== 'string') {
            this.sendResult(agent.ws, {
                type: 'subscribe_result',
                id: envelope.id,
                success: false,
                topic: '',
                error: 'invalid topic',
            });
            return;
        }

        const topic = room.topics.get(topicName);
        if (!topic) {
            this.sendResult(agent.ws, {
                type: 'subscribe_result',
                id: envelope.id,
                success: false,
                topic: topicName,
                error: 'unknown topic',
            });
            return;
        }

        if (topic.subscribeCap !== null) {
            const check = this.checkCap(
                envelope.payload.proof,
                agent,
                topic.subscribeCap,
                roomName,
                topicName,
                'subscribe'
            );
            if (!check.ok) {
                this.sendResult(agent.ws, {
                    type: 'subscribe_result',
                    id: envelope.id,
                    success: false,
                    topic: topicName,
                    error: `subscribe denied: ${check.reason ?? 'no valid cap'}`,
                });
                return;
            }
        } else if (envelope.payload.proof !== undefined) {
            // Open topic — see the same guard on handleSend.
            this.sendResult(agent.ws, {
                type: 'subscribe_result',
                id: envelope.id,
                success: false,
                topic: topicName,
                error: 'open topic does not accept proof',
            });
            return;
        }

        // Per-agent subscription cap — bounds attachment size so
        // serialization never exceeds the 2 KB Cloudflare limit.
        if (
            !agent.subscribedTopics.has(topicName) &&
            agent.subscribedTopics.size >= MAX_SUBSCRIPTIONS_PER_AGENT
        ) {
            this.sendResult(agent.ws, {
                type: 'subscribe_result',
                id: envelope.id,
                success: false,
                topic: topicName,
                error: `agent subscription limit reached (${MAX_SUBSCRIPTIONS_PER_AGENT})`,
            });
            return;
        }

        topic.members.add(agent.sessionPubkey);
        agent.subscribedTopics.add(topicName);
        this.hooks.agentMutated?.(agent.ws);
        this.sendResult(agent.ws, {
            type: 'subscribe_result',
            id: envelope.id,
            success: true,
            topic: topicName,
        });
    }

    private handleUnsubscribe(
        agent: Agent,
        roomName: string,
        envelope: Envelope<UnsubscribePayload>
    ) {
        const topicName = envelope.payload?.topic;
        if (!agent.joined) {
            this.sendResult(agent.ws, {
                type: 'unsubscribe_result',
                id: envelope.id,
                success: false,
                topic: topicName ?? '',
                error: 'not joined',
            });
            return;
        }
        const room = this.rooms.get(roomName);
        if (!room) return;

        if (typeof topicName !== 'string') {
            this.sendResult(agent.ws, {
                type: 'unsubscribe_result',
                id: envelope.id,
                success: false,
                topic: '',
                error: 'invalid topic',
            });
            return;
        }

        const topic = room.topics.get(topicName);
        if (!topic) {
            this.sendResult(agent.ws, {
                type: 'unsubscribe_result',
                id: envelope.id,
                success: false,
                topic: topicName,
                error: 'unknown topic',
            });
            return;
        }
        topic.members.delete(agent.sessionPubkey);
        agent.subscribedTopics.delete(topicName);
        this.hooks.agentMutated?.(agent.ws);
        this.sendResult(agent.ws, {
            type: 'unsubscribe_result',
            id: envelope.id,
            success: true,
            topic: topicName,
        });
    }

    private handleListTopics(
        agent: Agent,
        roomName: string,
        envelope: Envelope<ListTopicsPayload>
    ) {
        if (!agent.joined) {
            // Every other RPC requires a join; list_topics does too.
            // Otherwise a passive connector could enumerate topics on any
            // pre-existing room without proving possession of the room name.
            this.sendError(agent.ws, 'not joined');
            return;
        }
        const room = this.rooms.get(roomName);
        const topics = room ? this.snapshotTopics(room) : [];
        this.sendResult(agent.ws, {
            type: 'list_topics_result',
            id: envelope.id,
            topics,
        });
    }

    private handleLeave(agent: Agent, roomName: string) {
        try {
            const room = this.rooms.get(roomName);
            if (!room) return;
            if (room.agents.get(agent.sessionPubkey) !== agent) return;

            for (const topic of room.topics.values()) {
                topic.members.delete(agent.sessionPubkey);
            }
            room.agents.delete(agent.sessionPubkey);

            if (room.agents.size === 0) {
                this.rooms.delete(roomName);
                return;
            }
            this.broadcastToRoom(room, {
                type: 'agents_changed',
                agents: this.snapshotAgents(room),
            });
        } finally {
            // Honor the leave by dropping the socket. Safe if already closed;
            // .close() is a no-op on a closed or closing ws.
            agent.ws.close();
        }
    }

    private ensureRoom(roomName: string): Room {
        let room = this.rooms.get(roomName);
        if (!room) {
            room = {
                name: roomName,
                agents: new Map(),
                topics: new Map(),
                resources: new Map(),
            };
            room.topics.set(MAIN_TOPIC, {
                name: MAIN_TOPIC,
                subscribeCap: null,
                postCap: null,
                members: new Set(),
            });
            this.rooms.set(roomName, room);
            // Persist the default topic so it survives hibernation even
            // if nothing else has been created yet.
            this.hooks.topicCreated?.({
                name: MAIN_TOPIC,
                subscribeCap: null,
                postCap: null,
            });
        }
        return room;
    }

    private broadcastToRoom(
        room: Room,
        event: ServerEvent,
        excludePubkey?: string
    ) {
        const payload = JSON.stringify(event);
        for (const [pubkey, agent] of room.agents) {
            if (pubkey === excludePubkey) continue;
            if (agent.ws.readyState === WS_OPEN) {
                agent.ws.send(payload);
            }
        }
    }

    private broadcastToTopic(
        room: Room,
        topic: Topic,
        event: ServerEvent,
        excludePubkey?: string
    ) {
        const payload = JSON.stringify(event);
        for (const memberPubkey of topic.members) {
            if (memberPubkey === excludePubkey) continue;
            const member = room.agents.get(memberPubkey);
            if (member?.ws.readyState === WS_OPEN) {
                member.ws.send(payload);
            }
        }
    }

    private sendEvent(ws: RelayWebSocket, event: ServerEvent) {
        if (ws.readyState === WS_OPEN) {
            ws.send(JSON.stringify(event));
        }
    }

    private sendResult(ws: RelayWebSocket, result: ServerEvent) {
        this.sendEvent(ws, result);
    }

    private sendError(ws: RelayWebSocket, reason: string) {
        this.sendEvent(ws, { type: 'error', reason });
    }

    /** Token-bucket rate limiter. Refills lazily on each call. Returns
     *  false if the agent has exhausted their bucket. */
    private consumeRateLimit(agent: Agent, nowMs: number): boolean {
        const elapsedSec = (nowMs - agent.rateLastRefillMs) / 1000;
        if (elapsedSec > 0) {
            agent.rateTokens = Math.min(
                RATE_LIMIT_BURST,
                agent.rateTokens + elapsedSec * RATE_LIMIT_SUSTAINED_PER_SEC
            );
            agent.rateLastRefillMs = nowMs;
        }
        if (agent.rateTokens < 1) return false;
        agent.rateTokens -= 1;
        return true;
    }

    private checkCap(
        proof: Cap | undefined,
        agent: Agent,
        expectedRoot: string,
        roomName: string,
        topicName: string,
        action: 'subscribe' | 'post'
    ): { ok: boolean; reason?: string } {
        if (!isCapShaped(proof)) {
            return { ok: false, reason: 'missing or malformed cap proof' };
        }
        // Chain depth cap: leaf counts as one, ancestors are leaf.proof.
        const chainLen = 1 + (proof.proof?.length ?? 0);
        if (chainLen > MAX_CAP_CHAIN_DEPTH) {
            return {
                ok: false,
                reason: `cap chain too deep (${chainLen} > ${MAX_CAP_CHAIN_DEPTH})`,
            };
        }
        const resource = `room:${roomName}/topic:${topicName}`;
        const now = Math.floor(Date.now() / 1000);

        // The leaf may be audienced at either the agent's session key or,
        // if they proved possession of a long-lived identity key via a
        // session attestation, the identity key. This is what makes caps
        // survive across reconnections.
        //
        // The identity candidate is only considered if the agent's
        // attestation is still within its expiry window at the moment of
        // use. Without this re-check, a 5-second-TTL attestation would
        // remain "valid" for the whole connection lifetime, silently
        // breaking the spec's trust-window semantics.
        const candidates: string[] = [agent.sessionPubkey];
        if (
            agent.identityPubkey !== undefined &&
            agent.identityAttestation !== undefined &&
            now <= agent.identityAttestation.expires_at
        ) {
            candidates.push(agent.identityPubkey);
        }
        let lastReason: string | undefined;
        for (const audience of candidates) {
            const result = verifyCapChain(proof, {
                expectedAudience: audience,
                expectedRoot,
                requiredResource: resource,
                requiredAction: action,
                now,
            });
            if (result.ok) return result;
            lastReason = result.reason;
        }
        return {
            ok: false,
            reason: lastReason ?? 'no valid cap for session or identity',
        };
    }

    private snapshotAgents(room: Room): AgentSummary[] {
        return Array.from(room.agents.values())
            .filter((a) => a.joined)
            .map((a) => ({
                pubkey: a.sessionPubkey,
                display_name: a.displayName,
                description: a.description,
                identity_attestation: a.identityAttestation,
            }));
    }

    private snapshotTopics(room: Room): TopicSummary[] {
        return Array.from(room.topics.values()).map((t) => ({
            name: t.name,
            subscribe_cap: t.subscribeCap,
            post_cap: t.postCap,
        }));
    }

    private snapshotResources(room: Room): ResourceSummary[] {
        return Array.from(room.resources.values()).map((r) =>
            summarizeResource(r)
        );
    }

    private handleResourcePut(
        agent: Agent,
        roomName: string,
        envelope: Envelope<ResourcePutPayload>
    ) {
        const fail = (error: string) => {
            this.sendResult(agent.ws, {
                type: 'resource_put_result',
                id: envelope.id,
                success: false,
                error,
            });
        };

        if (!agent.joined) return fail('not joined');
        const room = this.rooms.get(roomName);
        if (!room) return fail('unknown room');

        const payload = envelope.payload;
        if (
            typeof payload?.name !== 'string' ||
            payload.name.length === 0 ||
            payload.name.length > MAX_RESOURCE_NAME_BYTES
        ) {
            return fail('invalid resource name');
        }
        if (typeof payload.kind !== 'string' || payload.kind.length === 0) {
            return fail('invalid resource kind');
        }
        if (typeof payload.content !== 'string') {
            return fail('content must be base64url-encoded string');
        }

        let content: Uint8Array;
        try {
            content = fromBase64Url(payload.content);
        } catch (err) {
            return fail(
                `invalid content encoding: ${(err as Error).message}`
            );
        }
        if (content.length > MAX_RESOURCE_CONTENT_BYTES) {
            return fail(
                `content exceeds ${MAX_RESOURCE_CONTENT_BYTES} bytes`
            );
        }

        const existing = room.resources.get(payload.name);
        // Per-room resource count cap (only counts new inserts, not
        // rewrites of an existing name).
        if (
            existing === undefined &&
            room.resources.size >= MAX_RESOURCES_PER_ROOM
        ) {
            return fail('room resource count limit reached');
        }
        // Per-room total byte cap: sum of existing resource sizes plus
        // the delta from this write.
        let totalBytes = 0;
        for (const r of room.resources.values()) totalBytes += r.size;
        const delta = content.length - (existing?.size ?? 0);
        if (totalBytes + delta > MAX_TOTAL_RESOURCE_BYTES_PER_ROOM) {
            return fail('room resource byte limit reached');
        }
        // If a prior resource declared a validation_hook, all future writes
        // at the same name must satisfy it. Without this, any agent could
        // overwrite a gated resource (e.g. rewrite room-spec) at will.
        if (existing?.validationHook !== null && existing !== undefined) {
            const check = this.checkResourceCap(
                payload.cap_proof,
                agent,
                existing.validationHook!,
                roomName,
                payload.name
            );
            if (!check.ok) {
                return fail(
                    `write denied: ${check.reason ?? 'no valid cap'}`
                );
            }
        } else if (existing === undefined && payload.cap_proof !== undefined) {
            // First put at this name with a cap_proof is unusual — the
            // hook doesn't exist yet. Allow it but only if the cap proof
            // is valid against the declared validation_hook. Otherwise
            // the write is just an unnecessary cap proof on an open create.
            // For simplicity we accept first creates without enforcing the
            // cap at create time. The hook takes effect on subsequent writes.
        }

        const cid = blake3Cid(content);
        const now = Math.floor(Date.now() / 1000);
        const validationHook =
            existing?.validationHook ?? payload.validation_hook ?? null;
        if (
            validationHook !== null &&
            typeof validationHook !== 'string'
        ) {
            return fail('validation_hook must be a pubkey string or null');
        }

        const resource: Resource = {
            name: payload.name,
            cid,
            kind: payload.kind,
            mime: payload.mime ?? 'application/octet-stream',
            size: content.length,
            content,
            createdBy: agent.sessionPubkey,
            createdAt: now,
            validationHook,
            subscribers: existing?.subscribers ?? new Set(),
        };
        room.resources.set(payload.name, resource);
        this.hooks.resourcePut?.({
            name: resource.name,
            cid: resource.cid,
            kind: resource.kind,
            mime: resource.mime,
            size: resource.size,
            content: resource.content,
            createdBy: resource.createdBy,
            createdAt: resource.createdAt,
            validationHook: resource.validationHook,
        });

        const summary = summarizeResource(resource);
        this.sendResult(agent.ws, {
            type: 'resource_put_result',
            id: envelope.id,
            success: true,
            summary,
        });

        // Broadcast a room-wide changed event so agents can refresh their
        // cached view. Exclude the writer: they got the put_result.
        this.broadcastToRoom(
            room,
            {
                type: 'resource_changed',
                name: payload.name,
                change: 'put',
                summary,
            },
            agent.sessionPubkey
        );
    }

    private handleResourceGet(
        agent: Agent,
        roomName: string,
        envelope: Envelope<ResourceGetPayload>
    ) {
        const fail = (error: string) => {
            this.sendResult(agent.ws, {
                type: 'resource_get_result',
                id: envelope.id,
                success: false,
                error,
            });
        };

        if (!agent.joined) return fail('not joined');
        const room = this.rooms.get(roomName);
        if (!room) return fail('unknown room');

        const { name, cid } = envelope.payload ?? {};
        let resource: Resource | undefined;
        if (typeof name === 'string') {
            resource = room.resources.get(name);
        } else if (typeof cid === 'string') {
            for (const r of room.resources.values()) {
                if (r.cid === cid) {
                    resource = r;
                    break;
                }
            }
        } else {
            return fail('resource_get requires name or cid');
        }
        if (!resource) return fail('resource not found');

        // Re-encode content as base64url. Small cost, small payload.
        const content = toBase64Url(resource.content);
        this.sendResult(agent.ws, {
            type: 'resource_get_result',
            id: envelope.id,
            success: true,
            content,
            summary: summarizeResource(resource),
        });
    }

    private handleResourceList(
        agent: Agent,
        roomName: string,
        envelope: Envelope<ResourceListPayload>
    ) {
        if (!agent.joined) {
            this.sendError(agent.ws, 'not joined');
            return;
        }
        const room = this.rooms.get(roomName);
        const kind = envelope.payload?.kind;
        const resources = room
            ? Array.from(room.resources.values())
                  .filter(
                      (r) => typeof kind !== 'string' || r.kind === kind
                  )
                  .map(summarizeResource)
            : [];
        this.sendResult(agent.ws, {
            type: 'resource_list_result',
            id: envelope.id,
            resources,
        });
    }

    private handleResourceSubscribe(
        agent: Agent,
        roomName: string,
        envelope: Envelope<ResourceSubscribePayload>
    ) {
        const name = envelope.payload?.name;
        const fail = (error: string) => {
            this.sendResult(agent.ws, {
                type: 'resource_subscribe_result',
                id: envelope.id,
                success: false,
                name: name ?? '',
                error,
            });
        };
        if (!agent.joined) return fail('not joined');
        const room = this.rooms.get(roomName);
        if (!room) return fail('unknown room');
        if (typeof name !== 'string' || name.length === 0) {
            return fail('invalid resource name');
        }
        const resource = room.resources.get(name);
        if (!resource) return fail('unknown resource');

        resource.subscribers.add(agent.sessionPubkey);
        this.sendResult(agent.ws, {
            type: 'resource_subscribe_result',
            id: envelope.id,
            success: true,
            name,
        });
    }

    private handleResourceUnsubscribe(
        agent: Agent,
        roomName: string,
        envelope: Envelope<ResourceUnsubscribePayload>
    ) {
        const name = envelope.payload?.name;
        const fail = (error: string) => {
            this.sendResult(agent.ws, {
                type: 'resource_unsubscribe_result',
                id: envelope.id,
                success: false,
                name: name ?? '',
                error,
            });
        };
        if (!agent.joined) return fail('not joined');
        const room = this.rooms.get(roomName);
        if (!room) return fail('unknown room');
        if (typeof name !== 'string') return fail('invalid resource name');
        const resource = room.resources.get(name);
        if (resource) resource.subscribers.delete(agent.sessionPubkey);
        this.sendResult(agent.ws, {
            type: 'resource_unsubscribe_result',
            id: envelope.id,
            success: true,
            name,
        });
    }

    private checkResourceCap(
        proof: Cap | undefined,
        agent: Agent,
        expectedRoot: string,
        roomName: string,
        resourceName: string
    ): { ok: boolean; reason?: string } {
        if (!isCapShaped(proof)) {
            return { ok: false, reason: 'missing or malformed cap proof' };
        }
        const chainLen = 1 + (proof.proof?.length ?? 0);
        if (chainLen > MAX_CAP_CHAIN_DEPTH) {
            return {
                ok: false,
                reason: `cap chain too deep (${chainLen} > ${MAX_CAP_CHAIN_DEPTH})`,
            };
        }
        const resource = `room:${roomName}/resource:${resourceName}`;
        const now = Math.floor(Date.now() / 1000);
        const candidates: string[] = [agent.sessionPubkey];
        if (
            agent.identityPubkey !== undefined &&
            agent.identityAttestation !== undefined &&
            now <= agent.identityAttestation.expires_at
        ) {
            candidates.push(agent.identityPubkey);
        }
        let lastReason: string | undefined;
        for (const audience of candidates) {
            const result = verifyCapChain(proof, {
                expectedAudience: audience,
                expectedRoot,
                requiredResource: resource,
                requiredAction: 'write',
                now,
            });
            if (result.ok) return result;
            lastReason = result.reason;
        }
        return {
            ok: false,
            reason: lastReason ?? 'no valid cap for session or identity',
        };
    }

    private pruneReplayWindow(now: number) {
        if (this.recentEnvelopes.size < REPLAY_PRUNE_THRESHOLD) return;
        for (const [key, seen] of this.recentEnvelopes) {
            if (now - seen > REPLAY_WINDOW_SECONDS) {
                this.recentEnvelopes.delete(key);
            }
        }
    }

    roomCount(): number {
        return this.rooms.size;
    }
}
