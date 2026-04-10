// Directory Durable Object: the singleton that holds public room
// announcements for openroom.channel's browse experience.
//
// See packages/relay/HIBERNATION.md for the overall state philosophy.
// This DO uses a plain request/response model (HTTP POST for writes,
// HTTP GET for the cached listing) rather than the WebSocket hibernation
// path — directory operations are low-frequency and write-seldom, and
// the listing is much cheaper to serve from the CF edge cache than from
// a WebSocket fan-out.
//
// v1 operates in "open" mode by default: any signed announce envelope
// succeeds. Authority enforcement (via cross-DO room-spec fetch) lands
// in a follow-up task so we can isolate that complexity.

import {
    verifyEnvelope,
    verifySessionAttestation,
    type AnnouncePayload,
    type AnnouncementSummary,
    type Envelope,
    type UnannouncePayload,
} from 'openroom-sdk';

export interface DirectoryEnv {
    ROOM_DO: DurableObjectNamespace;
    DIRECTORY_DO: DurableObjectNamespace;
}

const ANNOUNCEMENT_KEY_PREFIX = 'announcement:';
const SCHEMA_VERSION = 1;
const MAX_DESCRIPTION_LENGTH = 512;
const MAX_ROOM_NAME_LENGTH = 128;
const MAX_TTL_SECONDS = 14 * 24 * 60 * 60; // 14 days hard ceiling
const TIMESTAMP_DRIFT_SECONDS = 300;
const DIRECTORY_LIST_CACHE_SECONDS = 30;

interface StoredAnnouncement {
    v: number;
    room: string;
    description: string;
    announcer_session: string;
    announcer_identity?: string;
    announced_at: number;
    expires_at: number;
}

/**
 * Directory policy for a room, parsed out of its `directory-config`
 * resource. Absent / missing resource defaults to open mode.
 */
interface DirectoryPolicy {
    mode: 'open' | 'authority';
    authority?: string;
}

interface CachedPolicy {
    policy: DirectoryPolicy;
    fetchedAt: number;
}

const POLICY_CACHE_TTL_SECONDS = 60;

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

/**
 * Singleton Durable Object that serves the public room directory. Every
 * request goes through this one instance (routed via `idFromName('singleton')`),
 * which is correct for a globally-ordered listing. Scaling reads is handled
 * at the CF edge cache layer — the GET endpoint sets Cache-Control so
 * thousands of browse-page hits collapse into roughly one DO request per
 * edge location per TTL window.
 */
export class DirectoryDurableObject {
    private state: DurableObjectState;
    private env: DirectoryEnv;
    private policyCache = new Map<string, CachedPolicy>();

    constructor(state: DurableObjectState, env: DirectoryEnv) {
        this.state = state;
        this.env = env;
    }

    /**
     * Fetch the directory policy for a room by calling into its Room DO and
     * reading the `directory-config` resource. Caches the result for
     * POLICY_CACHE_TTL_SECONDS so hot announce paths don't incur a cross-DO
     * round trip on every call.
     */
    private async loadPolicy(roomName: string): Promise<DirectoryPolicy> {
        const now = Math.floor(Date.now() / 1000);
        const cached = this.policyCache.get(roomName);
        if (cached && now - cached.fetchedAt < POLICY_CACHE_TTL_SECONDS) {
            return cached.policy;
        }

        const policy: DirectoryPolicy = await this.fetchPolicyFromRoom(
            roomName
        );
        this.policyCache.set(roomName, { policy, fetchedAt: now });
        return policy;
    }

    private async fetchPolicyFromRoom(
        roomName: string
    ): Promise<DirectoryPolicy> {
        try {
            const id = this.env.ROOM_DO.idFromName(roomName);
            const stub = this.env.ROOM_DO.get(id);
            const url = new URL(
                `http://internal/__internal/directory-config`
            );
            url.searchParams.set('room', roomName);
            const response = await stub.fetch(url.toString());
            if (!response.ok) {
                logEvent('warn', 'openroom.directory_policy_fetch_failed', {
                    room: roomName,
                    status: response.status,
                });
                return { mode: 'open' };
            }
            const payload = (await response.json()) as {
                present: boolean;
                content?: string;
            };
            if (!payload.present || typeof payload.content !== 'string') {
                return { mode: 'open' };
            }

            // The resource content is base64-encoded (not base64url) JSON.
            const jsonBytes = atob(payload.content);
            const parsed = JSON.parse(jsonBytes);
            if (!parsed || typeof parsed !== 'object') {
                return { mode: 'open' };
            }
            if (parsed.mode === 'authority') {
                if (typeof parsed.authority !== 'string') {
                    logEvent(
                        'warn',
                        'openroom.directory_policy_invalid',
                        {
                            room: roomName,
                            reason: 'authority mode missing pubkey',
                        }
                    );
                    return { mode: 'open' };
                }
                return {
                    mode: 'authority',
                    authority: parsed.authority,
                };
            }
            return { mode: 'open' };
        } catch (err) {
            logEvent('error', 'openroom.directory_policy_fetch_failed', {
                room: roomName,
                err: String(err),
            });
            return { mode: 'open' };
        }
    }

    /** Test-only: invalidate the policy cache for a room. */
    invalidatePolicyCache(roomName: string): void {
        this.policyCache.delete(roomName);
    }

    async fetch(request: Request): Promise<Response> {
        const url = new URL(request.url);

        if (request.method === 'GET' && url.pathname === '/v1/public-rooms') {
            return this.listPublicRooms();
        }

        if (request.method === 'POST' && url.pathname === '/v1/directory') {
            return this.handleWrite(request);
        }

        return new Response('not found', { status: 404 });
    }

    private async listPublicRooms(): Promise<Response> {
        const entries = await this.state.storage.list({
            prefix: ANNOUNCEMENT_KEY_PREFIX,
        });
        const now = Math.floor(Date.now() / 1000);
        const rooms: AnnouncementSummary[] = [];
        const expiredKeys: string[] = [];

        for (const [key, raw] of entries) {
            if (!raw || typeof raw !== 'object') continue;
            const record = raw as StoredAnnouncement;
            if (record.v !== SCHEMA_VERSION) {
                logEvent('warn', 'openroom.directory_schema_unknown', {
                    key,
                    version: record.v,
                });
                continue;
            }
            if (record.expires_at < now) {
                expiredKeys.push(key);
                continue;
            }
            rooms.push({
                room: record.room,
                description: record.description,
                announcer_session: record.announcer_session,
                announcer_identity: record.announcer_identity,
                announced_at: record.announced_at,
                expires_at: record.expires_at,
            });
        }

        // Lazy expiry — sweep expired entries while we're here. Fire-and-
        // forget so we don't block the response.
        if (expiredKeys.length > 0) {
            Promise.all(
                expiredKeys.map((k) =>
                    this.state.storage
                        .delete(k)
                        .catch((err) =>
                            logEvent(
                                'error',
                                'openroom.directory_delete_failed',
                                { key: k, err: String(err) }
                            )
                        )
                )
            );
        }

        rooms.sort((a, b) => b.announced_at - a.announced_at);

        return new Response(JSON.stringify({ rooms }), {
            status: 200,
            headers: {
                'content-type': 'application/json',
                // Edge-cache the listing. The write path does not invalidate
                // this cache — fresh announcements become visible at the next
                // cache tick. Viewers tolerate up to 30 seconds of staleness.
                'cache-control': `public, max-age=${DIRECTORY_LIST_CACHE_SECONDS}, s-maxage=${DIRECTORY_LIST_CACHE_SECONDS}`,
            },
        });
    }

    private async handleWrite(request: Request): Promise<Response> {
        let body: unknown;
        try {
            body = await request.json();
        } catch {
            return jsonError(400, 'invalid json body');
        }

        if (!isValidEnvelope(body)) {
            return jsonError(400, 'malformed envelope');
        }
        const envelope = body as Envelope;

        const now = Math.floor(Date.now() / 1000);
        if (Math.abs(envelope.ts - now) > TIMESTAMP_DRIFT_SECONDS) {
            return jsonError(400, 'timestamp drift');
        }

        if (!verifyEnvelope(envelope)) {
            return jsonError(400, 'invalid signature');
        }

        switch (envelope.type) {
            case 'announce':
                return this.handleAnnounce(
                    envelope as Envelope<AnnouncePayload>
                );
            case 'unannounce':
                return this.handleUnannounce(
                    envelope as Envelope<UnannouncePayload>
                );
            default:
                return jsonError(
                    400,
                    `unknown envelope type: ${envelope.type}`
                );
        }
    }

    private async handleAnnounce(
        envelope: Envelope<AnnouncePayload>
    ): Promise<Response> {
        const payload = envelope.payload;

        if (
            typeof payload?.room !== 'string' ||
            payload.room.length === 0 ||
            payload.room.length > MAX_ROOM_NAME_LENGTH
        ) {
            return jsonResult({
                type: 'announce_result',
                id: envelope.id,
                success: false,
                error: 'invalid room name',
            });
        }
        if (
            typeof payload.description !== 'string' ||
            payload.description.length === 0 ||
            payload.description.length > MAX_DESCRIPTION_LENGTH
        ) {
            return jsonResult({
                type: 'announce_result',
                id: envelope.id,
                success: false,
                error: `description must be 1..${MAX_DESCRIPTION_LENGTH} bytes`,
            });
        }

        const now = Math.floor(Date.now() / 1000);
        const expiresAt = Math.min(
            typeof payload.expires_at === 'number' ? payload.expires_at : 0,
            now + MAX_TTL_SECONDS
        );
        if (expiresAt <= now) {
            return jsonResult({
                type: 'announce_result',
                id: envelope.id,
                success: false,
                error: 'expires_at must be in the future',
            });
        }

        // Optional identity attestation — when present, it binds the
        // announcing session to a long-lived identity key AND to the
        // specific room being announced. Verify both conditions before
        // recording the identity pubkey alongside the announcement.
        let announcerIdentity: string | undefined;
        if (payload.identity_attestation !== undefined) {
            const att = payload.identity_attestation;
            if (att.session_pubkey !== envelope.from) {
                return jsonResult({
                    type: 'announce_result',
                    id: envelope.id,
                    success: false,
                    error: 'attestation does not bind announcing session',
                });
            }
            if (att.room !== payload.room) {
                return jsonResult({
                    type: 'announce_result',
                    id: envelope.id,
                    success: false,
                    error: 'attestation is scoped to a different room',
                });
            }
            if (!verifySessionAttestation(att)) {
                return jsonResult({
                    type: 'announce_result',
                    id: envelope.id,
                    success: false,
                    error: 'invalid session attestation',
                });
            }
            announcerIdentity = att.identity_pubkey;
        }

        // Authority enforcement: fetch the room's directory-config
        // resource (cross-DO call, cached) to determine whether this room
        // requires an authorized announcer. In open mode, any valid signed
        // envelope succeeds. In authority mode, the announcer's session
        // pubkey OR identity pubkey must match the configured authority.
        const policy = await this.loadPolicy(payload.room);
        if (policy.mode === 'authority') {
            const authorizedSession = envelope.from === policy.authority;
            const authorizedIdentity =
                announcerIdentity !== undefined &&
                announcerIdentity === policy.authority;
            if (!authorizedSession && !authorizedIdentity) {
                logEvent('info', 'openroom.directory_announce_denied', {
                    room: payload.room,
                    reason: 'not the configured authority',
                    session: envelope.from,
                    identity: announcerIdentity,
                    authority: policy.authority,
                });
                return jsonResult({
                    type: 'announce_result',
                    id: envelope.id,
                    success: false,
                    error: 'announcement denied: room requires authority signature',
                });
            }
        }

        const record: StoredAnnouncement = {
            v: SCHEMA_VERSION,
            room: payload.room,
            description: payload.description,
            announcer_session: envelope.from,
            ...(announcerIdentity !== undefined && {
                announcer_identity: announcerIdentity,
            }),
            announced_at: now,
            expires_at: expiresAt,
        };

        await this.state.storage.put(
            ANNOUNCEMENT_KEY_PREFIX + payload.room,
            record
        );

        const summary: AnnouncementSummary = {
            room: record.room,
            description: record.description,
            announcer_session: record.announcer_session,
            ...(record.announcer_identity !== undefined && {
                announcer_identity: record.announcer_identity,
            }),
            announced_at: record.announced_at,
            expires_at: record.expires_at,
        };

        logEvent('info', 'openroom.directory_announce', {
            room: record.room,
            announcer_session: record.announcer_session,
            announcer_identity: record.announcer_identity,
        });

        return jsonResult({
            type: 'announce_result',
            id: envelope.id,
            success: true,
            summary,
        });
    }

    private async handleUnannounce(
        envelope: Envelope<UnannouncePayload>
    ): Promise<Response> {
        const room = envelope.payload?.room;
        if (typeof room !== 'string' || room.length === 0) {
            return jsonResult({
                type: 'unannounce_result',
                id: envelope.id,
                success: false,
                room: room ?? '',
                error: 'invalid room name',
            });
        }

        const existing = (await this.state.storage.get(
            ANNOUNCEMENT_KEY_PREFIX + room
        )) as StoredAnnouncement | null;

        if (!existing) {
            return jsonResult({
                type: 'unannounce_result',
                id: envelope.id,
                success: false,
                room,
                error: 'no such announcement',
            });
        }

        // Authorization: the caller must either
        //   (a) be the original announcer (session pubkey match), OR
        //   (b) match the room's configured authority (if authority mode)
        // Authority mode also lets a new session of the same identity
        // unannounce, which matters after reconnects.
        const policy = await this.loadPolicy(room);
        const isOriginalAnnouncer =
            existing.announcer_session === envelope.from;
        const isAuthority =
            policy.mode === 'authority' &&
            policy.authority !== undefined &&
            (envelope.from === policy.authority ||
                existing.announcer_identity === policy.authority);
        if (!isOriginalAnnouncer && !isAuthority) {
            return jsonResult({
                type: 'unannounce_result',
                id: envelope.id,
                success: false,
                room,
                error: 'only the original announcer or configured authority can unannounce',
            });
        }

        await this.state.storage.delete(ANNOUNCEMENT_KEY_PREFIX + room);

        logEvent('info', 'openroom.directory_unannounce', {
            room,
            announcer_session: envelope.from,
        });

        return jsonResult({
            type: 'unannounce_result',
            id: envelope.id,
            success: true,
            room,
        });
    }
}

function jsonError(status: number, error: string): Response {
    return new Response(JSON.stringify({ error }), {
        status,
        headers: { 'content-type': 'application/json' },
    });
}

function jsonResult(body: unknown): Response {
    return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
    });
}

function isValidEnvelope(value: unknown): value is Envelope {
    if (!value || typeof value !== 'object') return false;
    const e = value as Partial<Envelope>;
    return (
        typeof e.type === 'string' &&
        typeof e.id === 'string' &&
        typeof e.from === 'string' &&
        typeof e.sig === 'string' &&
        typeof e.ts === 'number' &&
        e.payload !== undefined
    );
}
