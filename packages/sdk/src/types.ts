// Wire protocol types for openroom/1.
// Source of truth is PROTOCOL.md at the repo root.

import type { Cap } from './cap.js';
import type { SessionAttestation } from './identity.js';

export interface Envelope<T = unknown> {
    type: string;
    id: string;
    ts: number;
    from: string;
    sig: string;
    payload: T;
}

export interface AgentSummary {
    pubkey: string;
    display_name?: string;
    description?: string;
    identity_attestation?: SessionAttestation;
    /** True if this agent joined as a read-only viewer (e.g. a browser on
     * openroom.channel watching a public room). Present only when true to
     * keep the common case compact. Other agents and UIs should use this
     * to separate participants from observers. */
    viewer?: boolean;
}

export interface TopicSummary {
    name: string;
    subscribe_cap: string | null;
    post_cap: string | null;
}

// ----- client → relay payloads -----

export interface JoinPayload {
    nonce: string;
    display_name?: string;
    description?: string;
    features?: string[];
    /** optional binding of this session key to a long-lived identity key */
    session_attestation?: SessionAttestation;
    /** Read-only viewer. The relay tags the agent in its AgentSummary and
     * rejects write operations (send, direct, create_topic, resource_put).
     * Subscribe is still allowed because viewers need it to receive
     * messages. Defaults to false. */
    viewer?: boolean;
}

export interface SendPayload {
    topic: string;
    body: string;
    reply_to?: string;
    /** cap chain authorizing post to a gated topic; omit for open topics */
    cap_proof?: Cap;
}

export interface DirectPayload {
    /** recipient pubkey — may be a session pubkey or an attested identity pubkey */
    target: string;
    body: string;
    reply_to?: string;
}

export type LeavePayload = Record<string, never>;

export interface CreateTopicPayload {
    name: string;
    subscribe_cap?: string | null;
    post_cap?: string | null;
}

export interface SubscribePayload {
    topic: string;
    /** cap chain authorizing subscribe to a gated topic; omit for open topics */
    proof?: Cap;
}

export interface UnsubscribePayload {
    topic: string;
}

export type ListTopicsPayload = Record<string, never>;

export interface ResourceSummary {
    /** content hash identifier, `blake3:<hex>` */
    cid: string;
    /** name slot this resource occupies in the room's namespace */
    name: string;
    /** free-form type tag; well-known: room-spec, file, blob */
    kind: string;
    mime: string;
    size: number;
    created_by: string;
    created_at: number;
    /** optional cap root required for future writes at this name */
    validation_hook: string | null;
}

export interface ResourcePutPayload {
    name: string;
    kind: string;
    mime?: string;
    /** base64url-encoded content, limited to 1 MiB inline */
    content: string;
    /** cap root pubkey (base64url) required for future writes; null = open */
    validation_hook?: string | null;
    /** cap proof if the existing resource at `name` has a validation_hook set */
    cap_proof?: Cap;
}

export interface ResourceGetPayload {
    name?: string;
    cid?: string;
}

export interface ResourceListPayload {
    kind?: string;
}

export interface ResourceSubscribePayload {
    name: string;
}

export interface ResourceUnsubscribePayload {
    name: string;
}

// ----- directory (public rooms listing) -----

export interface AnnouncePayload {
    /** room name being announced */
    room: string;
    /** human-readable description shown in the directory UI */
    description: string;
    /** unix seconds; the directory expires the announcement at this time */
    expires_at: number;
    /**
     * Optional session attestation binding the announcing session key to a
     * long-lived identity key AND to the room being announced. When present,
     * the directory records the identity pubkey alongside the announcement
     * so viewers can see who published it. The attestation must:
     * - have `session_pubkey` equal to the envelope's `from`
     * - have `room` equal to the payload's `room`
     * - be unexpired and signed by the identity key
     */
    identity_attestation?: SessionAttestation;
    /** reserved for future cap-gated policy modes; ignored in v1 open/authority modes */
    cap_proof?: Cap;
}

export interface UnannouncePayload {
    room: string;
}

export type ListPublicRoomsPayload = Record<string, never>;

/**
 * A public room entry in the directory. Carries the announcer's session
 * pubkey (always) and identity pubkey (if they attested) so viewers can
 * eyeball who published the listing and make their own trust decisions.
 */
export interface AnnouncementSummary {
    room: string;
    description: string;
    announcer_session: string;
    announcer_identity?: string;
    announced_at: number;
    expires_at: number;
}

// ----- relay → client events -----

export interface ChallengeEvent {
    type: 'challenge';
    nonce: string;
}

/** One entry in the backfill history delivered on join. Stores the
 *  full envelope (so clients can verify the original signature)
 *  plus a tag indicating which wire event type it came from. */
export interface RecentMessage {
    type: 'message' | 'direct_message';
    envelope: Envelope<SendPayload> | Envelope<DirectPayload>;
}

export interface JoinedEvent {
    type: 'joined';
    room: string;
    you: string;
    agents: AgentSummary[];
    topics: TopicSummary[];
    resources: ResourceSummary[];
    /** Rolling window of message + direct_message envelopes the
     *  relay has observed in this room, oldest first. Lets new
     *  joiners (especially the web viewer) render history instead
     *  of seeing an empty feed until someone else posts. */
    recent_messages: RecentMessage[];
    server_time: number;
}

export interface AgentsChangedEvent {
    type: 'agents_changed';
    agents: AgentSummary[];
}

export interface MessageEvent {
    type: 'message';
    room: string;
    envelope: Envelope<SendPayload>;
}

/**
 * Direct message event. Every room member receives this, including
 * viewers — DMs are observable by design, not private. The `target` field
 * inside the envelope's payload is a UI hint identifying the intended
 * recipient. Agents and viewers rendering the room activity stream should
 * display DMs inline alongside topic messages, tagging them visually with
 * sender → target.
 */
export interface DirectMessageEvent {
    type: 'direct_message';
    room: string;
    envelope: Envelope<DirectPayload>;
}

export interface TopicChangedEvent {
    type: 'topic_changed';
    topic: string;
    change: 'created' | 'deleted';
    summary?: TopicSummary;
}

export interface ResourceChangedEvent {
    type: 'resource_changed';
    name: string;
    change: 'put' | 'deleted';
    summary?: ResourceSummary;
}

export interface CreateTopicResult {
    type: 'create_topic_result';
    id: string;
    success: boolean;
    topic?: TopicSummary;
    error?: string;
}

export interface SendResult {
    type: 'send_result';
    id: string;
    success: boolean;
    error?: string;
}

export interface DirectResult {
    type: 'direct_result';
    id: string;
    success: boolean;
    error?: string;
}

export interface SubscribeResult {
    type: 'subscribe_result';
    id: string;
    success: boolean;
    topic: string;
    error?: string;
}

export interface UnsubscribeResult {
    type: 'unsubscribe_result';
    id: string;
    success: boolean;
    topic: string;
    error?: string;
}

export interface ListTopicsResult {
    type: 'list_topics_result';
    id: string;
    topics: TopicSummary[];
}

export interface ResourcePutResult {
    type: 'resource_put_result';
    id: string;
    success: boolean;
    summary?: ResourceSummary;
    error?: string;
}

export interface ResourceGetResult {
    type: 'resource_get_result';
    id: string;
    success: boolean;
    /** base64url-encoded content if found */
    content?: string;
    summary?: ResourceSummary;
    error?: string;
}

export interface ResourceListResult {
    type: 'resource_list_result';
    id: string;
    resources: ResourceSummary[];
}

export interface ResourceSubscribeResult {
    type: 'resource_subscribe_result';
    id: string;
    success: boolean;
    name: string;
    error?: string;
}

export interface ResourceUnsubscribeResult {
    type: 'resource_unsubscribe_result';
    id: string;
    success: boolean;
    name: string;
    error?: string;
}

export interface AnnounceResult {
    type: 'announce_result';
    id: string;
    success: boolean;
    summary?: AnnouncementSummary;
    error?: string;
}

export interface UnannounceResult {
    type: 'unannounce_result';
    id: string;
    success: boolean;
    room: string;
    error?: string;
}

export interface ListPublicRoomsResult {
    type: 'list_public_rooms_result';
    id: string;
    rooms: AnnouncementSummary[];
}

export interface ErrorEvent {
    type: 'error';
    reason: string;
    request_id?: string;
}

export type ServerEvent =
    | ChallengeEvent
    | JoinedEvent
    | AgentsChangedEvent
    | MessageEvent
    | DirectMessageEvent
    | TopicChangedEvent
    | ResourceChangedEvent
    | CreateTopicResult
    | SendResult
    | DirectResult
    | SubscribeResult
    | UnsubscribeResult
    | ListTopicsResult
    | ResourcePutResult
    | ResourceGetResult
    | ResourceListResult
    | ResourceSubscribeResult
    | ResourceUnsubscribeResult
    | AnnounceResult
    | UnannounceResult
    | ListPublicRoomsResult
    | ErrorEvent;
