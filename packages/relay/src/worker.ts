// Cloudflare Worker + Durable Object entry point for the openroom relay.
//
// The Worker's fetch handler routes `/v1/room/<name>` WebSocket upgrade
// requests to a Durable Object instance named after the room. The DO uses
// the WebSocket Hibernation API so idle rooms release memory between
// messages and rehydrate state from Durable Object storage on wake.
//
// See packages/relay/HIBERNATION.md for the full state taxonomy, failure
// modes, and observability plan. If you are touching this file and need
// to understand WHERE state lives, read that doc first.

import { randomNonce } from 'openroom-sdk';
import {
    AGENT_ATTACHMENT_SOFT_LIMIT,
    AGENT_ATTACHMENT_HARD_LIMIT,
    RelayCore,
    type AgentAttachment,
    type RelayCoreHooks,
} from './room.js';
import { RoomStore, type Logger } from './room-store.js';

export { DirectoryDurableObject } from './directory.js';

export interface Env {
    ROOM_DO: DurableObjectNamespace;
    DIRECTORY_DO: DurableObjectNamespace;
}

const ROOM_PATH_RE = /^\/v1\/room\/(.+)$/;
const DIRECTORY_SINGLETON = 'singleton';

/** Log a structured event to the Worker observability pane. */
function logEvent(
    level: 'debug' | 'info' | 'warn' | 'error',
    event: string,
    fields: Record<string, unknown>
): void {
    const entry = JSON.stringify({ level, event, ...fields });
    if (level === 'error') console.error(entry);
    else if (level === 'warn') console.warn(entry);
    else console.log(entry);
}

export default {
    async fetch(request: Request, env: Env): Promise<Response> {
        const url = new URL(request.url);

        if (url.pathname === '/' || url.pathname === '/health') {
            return new Response(
                JSON.stringify({
                    service: 'openroom-relay',
                    protocol: 'openroom/1',
                    status: 'ok',
                }),
                {
                    status: 200,
                    headers: { 'content-type': 'application/json' },
                }
            );
        }

        // Directory endpoints — singleton DO, HTTP rather than WS.
        if (
            url.pathname === '/v1/directory' ||
            url.pathname === '/v1/public-rooms'
        ) {
            const id = env.DIRECTORY_DO.idFromName(DIRECTORY_SINGLETON);
            const stub = env.DIRECTORY_DO.get(id);
            return stub.fetch(request);
        }

        const match = url.pathname.match(ROOM_PATH_RE);
        if (!match) {
            return new Response('not found', { status: 404 });
        }
        if (request.headers.get('Upgrade') !== 'websocket') {
            return new Response('expected websocket upgrade', {
                status: 426,
            });
        }

        const roomName = decodeURIComponent(match[1]!);
        const id = env.ROOM_DO.idFromName(roomName);
        const stub = env.ROOM_DO.get(id);
        return stub.fetch(request);
    },
};

/**
 * Per-room Durable Object. One instance per room via `idFromName(roomName)`.
 * Uses the WebSocket Hibernation API so the runtime can reclaim memory from
 * idle rooms. On wake, state is rehydrated from DurableObjectStorage for
 * room-level data and from `ws.deserializeAttachment()` for per-connection
 * agent state. See HIBERNATION.md.
 */
export class RoomDurableObject {
    private state: DurableObjectState;
    private store: RoomStore;
    private core: RelayCore;
    private logger: Logger;
    private dirtyAgents = new Set<WebSocket>();
    private pendingWrites: Promise<void>[] = [];
    private initialized: Promise<void>;
    private roomName: string | null = null;

    constructor(state: DurableObjectState, _env: Env) {
        this.state = state;
        this.logger = {
            warn: (event, fields) => logEvent('warn', event, fields),
            error: (event, fields) => logEvent('error', event, fields),
        };
        this.store = new RoomStore(this.state.storage, this.logger);
        this.core = new RelayCore(this.makeHooks());
        this.initialized = this.initialize();
    }

    /**
     * Load room state from DurableObjectStorage. Called once from the
     * constructor; subsequent handlers await `this.initialized`. If the DO
     * is rematerializing from hibernation, this runs on the fresh instance
     * before any handler sees a message.
     */
    private async initialize(): Promise<void> {
        const snapshot = await this.store.loadSnapshot();
        // Recover the room name. It's embedded in the first storage key if
        // we have any, otherwise we'll pick it up from the first fetch.
        // For hibernation wakes we need the room name to call loadSnapshot
        // on RelayCore; use a sentinel and patch it on first fetch/message.
        // In practice, the DO's id is stable per room so any of its stored
        // data belongs to that single room — we only use the name for
        // building resource URIs in cap enforcement.
        //
        // Since loadSnapshot on RelayCore takes a room name, defer the
        // actual core.loadSnapshot() call to the first handler that knows
        // the name (fetch knows it from the URL; webSocketMessage can
        // recover it from an attached agent).
        void snapshot;
        this.pendingSnapshot = snapshot;
    }

    private pendingSnapshot: Awaited<
        ReturnType<RoomStore['loadSnapshot']>
    > | null = null;

    /**
     * Ensure RelayCore has the room loaded. Called from every fetch /
     * webSocketMessage entry point. Idempotent in the hot path (short-
     * circuits when the room is already in memory) but handles the
     * cold-reload case correctly: if the room was previously cleared by
     * handleLeave (last agent disconnected) or we're waking from
     * hibernation with a stale roomName reference, we re-read the
     * snapshot from storage before dispatching. Storage is the durable
     * source of truth; in-memory state is a cache.
     */
    private async loadCoreIfNeeded(roomName: string): Promise<void> {
        this.roomName = roomName;
        if (this.core.hasRoom(roomName)) return;
        const snapshot =
            this.pendingSnapshot ?? (await this.store.loadSnapshot());
        this.core.loadSnapshot(roomName, snapshot);
        this.pendingSnapshot = null;
    }

    async fetch(request: Request): Promise<Response> {
        await this.initialized;

        const url = new URL(request.url);

        // Internal cross-DO endpoint: the directory DO fetches the room's
        // directory-config resource to determine authority policy. This is
        // an HTTP GET, not a WebSocket upgrade.
        if (url.pathname === '/__internal/directory-config') {
            const roomName = url.searchParams.get('room');
            if (!roomName) {
                return new Response('missing room param', { status: 400 });
            }
            await this.loadCoreIfNeeded(roomName);
            const resource = this.core.readResource(
                roomName,
                'directory-config'
            );
            if (!resource) {
                return new Response(
                    JSON.stringify({ present: false }),
                    {
                        status: 200,
                        headers: { 'content-type': 'application/json' },
                    }
                );
            }
            // Return the content bytes as base64url-encoded JSON so the
            // directory DO can parse without binary framing surprises.
            return new Response(
                JSON.stringify({
                    present: true,
                    content: btoa(
                        String.fromCharCode(...resource.content)
                    ),
                }),
                {
                    status: 200,
                    headers: { 'content-type': 'application/json' },
                }
            );
        }

        const match = url.pathname.match(ROOM_PATH_RE);
        if (!match) return new Response('not found', { status: 404 });
        if (request.headers.get('Upgrade') !== 'websocket') {
            return new Response('expected websocket upgrade', {
                status: 426,
            });
        }

        const roomName = decodeURIComponent(match[1]!);
        await this.loadCoreIfNeeded(roomName);

        const pair = new WebSocketPair();
        const client = pair[0];
        const server = pair[1];

        // Hibernation API: the runtime owns the ws lifecycle and calls
        // our webSocketMessage / webSocketClose / webSocketError methods
        // even after the DO has been evicted from memory.
        this.state.acceptWebSocket(server);

        this.core.attach(server, roomName, randomNonce());

        // Initial attachment so the agent can be rehydrated on wake
        // even though they haven't joined yet — the challenge nonce in
        // the Agent state is needed for the join handshake.
        this.persistAgentAttachment(server);

        await this.flushDirty();

        return new Response(null, {
            status: 101,
            webSocket: client,
        });
    }

    async webSocketMessage(
        ws: WebSocket,
        message: string | ArrayBuffer
    ): Promise<void> {
        await this.initialized;

        // Rehydrate from attachment if this is the first message after
        // a hibernation wake (the core's in-memory connections map is
        // empty, but the ws itself survived).
        if (!this.core.knows(ws)) {
            const restored = await this.rehydrateFromAttachment(ws);
            if (!restored) {
                ws.close(1011, 'session state missing');
                return;
            }
        }

        const text =
            typeof message === 'string'
                ? message
                : new TextDecoder().decode(message);
        this.core.deliverMessage(ws, text);
        await this.flushDirty();
    }

    async webSocketClose(
        ws: WebSocket,
        _code: number,
        _reason: string,
        _wasClean: boolean
    ): Promise<void> {
        await this.initialized;
        if (!this.core.knows(ws)) {
            await this.rehydrateFromAttachment(ws);
        }
        if (this.core.knows(ws)) {
            this.core.detach(ws);
        }
        await this.flushDirty();
    }

    async webSocketError(ws: WebSocket, _error: unknown): Promise<void> {
        await this.initialized;
        if (!this.core.knows(ws)) {
            await this.rehydrateFromAttachment(ws);
        }
        if (this.core.knows(ws)) {
            this.core.detach(ws);
        }
        await this.flushDirty();
    }

    /**
     * Rehydrate an agent from its per-ws attachment. Returns true if the
     * agent was successfully reconstructed; false if the attachment is
     * missing or unrecognized (caller should close the ws).
     */
    private async rehydrateFromAttachment(ws: WebSocket): Promise<boolean> {
        const raw = ws.deserializeAttachment();
        if (!raw || typeof raw !== 'object') {
            logEvent('warn', 'openroom.rehydration_no_attachment', {
                room: this.roomName,
            });
            return false;
        }

        const attachment = raw as AgentAttachment;

        // Recover the room name from the attachment's identity attestation
        // if we haven't learned it yet. Attestations are room-scoped via
        // the `room` field we added in Q3. If this ws has no attestation,
        // fall back to a placeholder and hope fetch will set it first.
        const roomName =
            attachment.identityAttestation?.room ??
            this.roomName ??
            '__unknown__';
        await this.loadCoreIfNeeded(roomName);

        const { droppedTopics } = this.core.rehydrateAgent(
            ws,
            attachment,
            roomName
        );
        if (droppedTopics.length > 0) {
            for (const topic of droppedTopics) {
                logEvent('warn', 'openroom.rehydration_topic_mismatch', {
                    room: roomName,
                    session_pubkey: attachment.sessionPubkey,
                    topic,
                });
            }
            // Attachment is now stale — re-serialize without the dropped
            // topics so the next wake doesn't repeat the warnings.
            this.persistAgentAttachment(ws);
        }
        return true;
    }

    /**
     * Serialize the current agent state for this ws into the ws attachment.
     * Logs a warning if we're approaching the 2 KB hard limit.
     */
    private persistAgentAttachment(ws: WebSocket): void {
        const agent = this.core.getAgent(ws);
        if (!agent) return;
        const attachment = this.core.serializeAgent(agent);
        const serialized = JSON.stringify(attachment);
        const bytes = new TextEncoder().encode(serialized).length;
        if (bytes > AGENT_ATTACHMENT_HARD_LIMIT) {
            logEvent('error', 'openroom.attachment_overflow', {
                room: this.roomName,
                session_pubkey: agent.sessionPubkey,
                bytes,
            });
            // Don't persist — the write would throw. Close the ws so the
            // client reconnects and starts fresh.
            ws.close(1011, 'agent attachment exceeds cloudflare limit');
            return;
        }
        if (bytes > AGENT_ATTACHMENT_SOFT_LIMIT) {
            logEvent('warn', 'openroom.attachment_near_limit', {
                room: this.roomName,
                session_pubkey: agent.sessionPubkey,
                bytes,
            });
        }
        ws.serializeAttachment(attachment);
    }

    private makeHooks(): RelayCoreHooks {
        return {
            topicCreated: (record) => {
                this.pendingWrites.push(
                    this.store
                        .putTopic({
                            name: record.name,
                            subscribeCap: record.subscribeCap,
                            postCap: record.postCap,
                        })
                        .catch((err) => {
                            logEvent('error', 'openroom.storage_write_failed', {
                                op: 'topic.put',
                                room: this.roomName,
                                err: String(err),
                            });
                        })
                );
            },
            topicDeleted: (name) => {
                this.pendingWrites.push(
                    this.store.deleteTopic(name).catch((err) => {
                        logEvent('error', 'openroom.storage_write_failed', {
                            op: 'topic.delete',
                            room: this.roomName,
                            err: String(err),
                        });
                    })
                );
            },
            resourcePut: (record) => {
                this.pendingWrites.push(
                    this.store
                        .putResource({
                            name: record.name,
                            cid: record.cid,
                            kind: record.kind,
                            mime: record.mime,
                            size: record.size,
                            content: record.content,
                            createdBy: record.createdBy,
                            createdAt: record.createdAt,
                            validationHook: record.validationHook,
                        })
                        .catch((err) => {
                            logEvent('error', 'openroom.storage_write_failed', {
                                op: 'resource.put',
                                room: this.roomName,
                                err: String(err),
                            });
                        })
                );
            },
            resourceDeleted: (name) => {
                this.pendingWrites.push(
                    this.store.deleteResource(name).catch((err) => {
                        logEvent('error', 'openroom.storage_write_failed', {
                            op: 'resource.delete',
                            room: this.roomName,
                            err: String(err),
                        });
                    })
                );
            },
            agentMutated: (ws) => {
                this.dirtyAgents.add(ws as WebSocket);
            },
        };
    }

    /**
     * Flush all pending storage writes and persist dirty agent attachments.
     * Called at the end of every handler so durable state is consistent
     * with in-memory state before we return control to the runtime.
     */
    private async flushDirty(): Promise<void> {
        for (const ws of this.dirtyAgents) {
            this.persistAgentAttachment(ws);
        }
        this.dirtyAgents.clear();

        if (this.pendingWrites.length > 0) {
            const pending = this.pendingWrites;
            this.pendingWrites = [];
            await Promise.all(pending);
        }
    }
}
