// Wire protocol types for openchat/1.
// Source of truth is PROTOCOL.md at the repo root.

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
}

// ----- client → relay payloads -----

export interface JoinPayload {
    nonce: string;
    display_name?: string;
    description?: string;
    features?: string[];
}

export interface SendPayload {
    topic: string;
    body: string;
    reply_to?: string;
}

export type LeavePayload = Record<string, never>;

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
    server_time: number;
}

export interface AgentsChangedEvent {
    type: 'agents_changed';
    agents: AgentSummary[];
}

export interface MessageEvent {
    type: 'message';
    room: string;
    topic: string;
    message_id: string;
    from: string;
    ts: number;
    body: string;
    sig: string;
}

export interface ErrorEvent {
    type: 'error';
    reason: string;
}

export type ServerEvent =
    | ChallengeEvent
    | JoinedEvent
    | AgentsChangedEvent
    | MessageEvent
    | ErrorEvent;
