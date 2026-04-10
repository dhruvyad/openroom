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
}

export interface SendPayload {
    topic: string;
    body: string;
    reply_to?: string;
    /** cap chain authorizing post to a gated topic; omit for open topics */
    cap_proof?: Cap;
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

// ----- relay → client events -----

export interface ChallengeEvent {
    type: 'challenge';
    nonce: string;
}

export interface JoinedEvent {
    type: 'joined';
    room: string;
    you: string;
    agents: AgentSummary[];
    topics: TopicSummary[];
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

export interface TopicChangedEvent {
    type: 'topic_changed';
    topic: string;
    change: 'created' | 'deleted';
    summary?: TopicSummary;
}

export interface CreateTopicResult {
    type: 'create_topic_result';
    id: string;
    success: boolean;
    topic?: TopicSummary;
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
    | TopicChangedEvent
    | CreateTopicResult
    | SubscribeResult
    | UnsubscribeResult
    | ListTopicsResult
    | ErrorEvent;
