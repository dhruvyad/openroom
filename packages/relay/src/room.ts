import type { WebSocket } from 'ws';
import {
    verifyCapChain,
    verifyEnvelope,
    type AgentSummary,
    type Cap,
    type CreateTopicPayload,
    type Envelope,
    type JoinPayload,
    type ListTopicsPayload,
    type SendPayload,
    type ServerEvent,
    type SubscribePayload,
    type TopicSummary,
    type UnsubscribePayload,
} from 'openroom-sdk';

interface Agent {
    ws: WebSocket;
    sessionPubkey: string;
    displayName?: string;
    description?: string;
    joined: boolean;
    challengeNonce: string;
}

interface Topic {
    name: string;
    subscribeCap: string | null;
    postCap: string | null;
    members: Set<string>; // session pubkeys
}

interface Room {
    name: string;
    agents: Map<string, Agent>;
    topics: Map<string, Topic>;
}

const TIMESTAMP_DRIFT_SECONDS = 300;
const REPLAY_WINDOW_SECONDS = 600;
const REPLAY_PRUNE_THRESHOLD = 4096;
const MAIN_TOPIC = 'main';
const WS_OPEN = 1;

export class RelayCore {
    private rooms = new Map<string, Room>();
    // Global replay protection keyed by `${from}:${id}`. Applies to every
    // signed envelope, not just `send` — the spec calls for dedup on all
    // envelopes, and without it `subscribe` / `create_topic` replays would
    // be trivially accepted within the ±5 min timestamp window.
    private recentEnvelopes = new Map<string, number>();

    acceptConnection(ws: WebSocket, roomName: string, challengeNonce: string) {
        const agent: Agent = {
            ws,
            sessionPubkey: '',
            joined: false,
            challengeNonce,
        };

        this.sendEvent(ws, { type: 'challenge', nonce: challengeNonce });

        ws.on('message', (data) => {
            this.handleMessage(agent, roomName, data.toString());
        });

        ws.on('close', () => {
            if (agent.joined) {
                this.handleLeave(agent, roomName);
            }
        });

        ws.on('error', () => {
            if (agent.joined) {
                this.handleLeave(agent, roomName);
            }
        });
    }

    private handleMessage(agent: Agent, roomName: string, raw: string) {
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

        agent.sessionPubkey = envelope.from;
        agent.displayName = envelope.payload.display_name;
        agent.description = envelope.payload.description;
        agent.joined = true;

        const room = this.ensureRoom(roomName);
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

        const agents = this.snapshotAgents(room);
        const topics = this.snapshotTopics(room);

        this.sendEvent(agent.ws, {
            type: 'joined',
            room: roomName,
            you: agent.sessionPubkey,
            agents,
            topics,
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
        if (!agent.joined) {
            this.sendError(agent.ws, 'not joined');
            return;
        }
        const room = this.rooms.get(roomName);
        if (!room) return;

        const topicName = envelope.payload.topic;
        const topic = room.topics.get(topicName);
        if (!topic) {
            this.sendError(agent.ws, `unknown topic: ${topicName}`);
            return;
        }

        if (topic.postCap !== null) {
            const check = this.checkCap(
                envelope.payload.cap_proof,
                agent.sessionPubkey,
                topic.postCap,
                roomName,
                topicName,
                'post'
            );
            if (!check.ok) {
                this.sendError(
                    agent.ws,
                    `post denied: ${check.reason ?? 'no valid cap'}`
                );
                return;
            }
        }

        const event: ServerEvent = {
            type: 'message',
            room: roomName,
            envelope,
        };
        this.broadcastToTopic(room, topic, event);
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
            topic = {
                name,
                subscribeCap,
                postCap,
                members: new Set(),
            };
            room.topics.set(name, topic);
            created = true;
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
                agent.sessionPubkey,
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
        }

        topic.members.add(agent.sessionPubkey);
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
        if (topic) {
            topic.members.delete(agent.sessionPubkey);
        }
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
            };
            room.topics.set(MAIN_TOPIC, {
                name: MAIN_TOPIC,
                subscribeCap: null,
                postCap: null,
                members: new Set(),
            });
            this.rooms.set(roomName, room);
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

    private sendEvent(ws: WebSocket, event: ServerEvent) {
        if (ws.readyState === WS_OPEN) {
            ws.send(JSON.stringify(event));
        }
    }

    private sendResult(ws: WebSocket, result: ServerEvent) {
        this.sendEvent(ws, result);
    }

    private sendError(ws: WebSocket, reason: string) {
        this.sendEvent(ws, { type: 'error', reason });
    }

    private checkCap(
        proof: Cap | undefined,
        audience: string,
        expectedRoot: string,
        roomName: string,
        topicName: string,
        action: 'subscribe' | 'post'
    ): { ok: boolean; reason?: string } {
        if (!proof || typeof proof !== 'object') {
            return { ok: false, reason: 'missing cap proof' };
        }
        const resource = `room:${roomName}/topic:${topicName}`;
        return verifyCapChain(proof, {
            expectedAudience: audience,
            expectedRoot,
            requiredResource: resource,
            requiredAction: action,
            now: Math.floor(Date.now() / 1000),
        });
    }

    private snapshotAgents(room: Room): AgentSummary[] {
        return Array.from(room.agents.values())
            .filter((a) => a.joined)
            .map((a) => ({
                pubkey: a.sessionPubkey,
                display_name: a.displayName,
                description: a.description,
            }));
    }

    private snapshotTopics(room: Room): TopicSummary[] {
        return Array.from(room.topics.values()).map((t) => ({
            name: t.name,
            subscribe_cap: t.subscribeCap,
            post_cap: t.postCap,
        }));
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
