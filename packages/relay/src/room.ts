import type { WebSocket } from 'ws';
import {
    verifyEnvelope,
    type AgentSummary,
    type Envelope,
    type JoinPayload,
    type SendPayload,
    type ServerEvent,
} from '@dhruvy/openchat-sdk';

interface Agent {
    ws: WebSocket;
    sessionPubkey: string;
    displayName?: string;
    description?: string;
    joined: boolean;
    challengeNonce: string;
}

interface Room {
    name: string;
    agents: Map<string, Agent>;
    // Replay protection: remember recent (from, id) pairs briefly
    recentIds: Map<string, number>;
}

const TIMESTAMP_DRIFT_SECONDS = 300;
const REPLAY_WINDOW_SECONDS = 600;
const MAIN_TOPIC = 'main';

export class RelayCore {
    private rooms = new Map<string, Room>();

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

        // After signature verification we can trust `from` matches the signer.
        if (agent.joined && envelope.from !== agent.sessionPubkey) {
            this.sendError(agent.ws, 'envelope from does not match session');
            return;
        }

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

        let room = this.rooms.get(roomName);
        if (!room) {
            room = {
                name: roomName,
                agents: new Map(),
                recentIds: new Map(),
            };
            this.rooms.set(roomName, room);
        }
        // If a previous session with the same pubkey is lingering, evict it.
        const existing = room.agents.get(agent.sessionPubkey);
        if (existing && existing !== agent) {
            existing.ws.close();
            room.agents.delete(agent.sessionPubkey);
        }
        room.agents.set(agent.sessionPubkey, agent);

        const agents = this.snapshotAgents(room);
        this.sendEvent(agent.ws, {
            type: 'joined',
            room: roomName,
            you: agent.sessionPubkey,
            agents,
            server_time: Math.floor(Date.now() / 1000),
        });

        this.broadcast(
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

        const replayKey = `${envelope.from}:${envelope.id}`;
        const now = Math.floor(Date.now() / 1000);
        const seen = room.recentIds.get(replayKey);
        if (seen !== undefined && now - seen < REPLAY_WINDOW_SECONDS) {
            return;
        }
        room.recentIds.set(replayKey, now);
        this.pruneReplayWindow(room, now);

        // Milestone 1: only the default topic.
        if (envelope.payload.topic !== MAIN_TOPIC) {
            this.sendError(
                agent.ws,
                `unknown topic: ${envelope.payload.topic}`
            );
            return;
        }

        const event: ServerEvent = {
            type: 'message',
            room: roomName,
            topic: MAIN_TOPIC,
            message_id: envelope.id,
            from: envelope.from,
            ts: envelope.ts,
            body: envelope.payload.body,
            sig: envelope.sig,
        };
        this.broadcast(room, event);
    }

    private handleLeave(agent: Agent, roomName: string) {
        const room = this.rooms.get(roomName);
        if (!room) return;
        if (room.agents.get(agent.sessionPubkey) !== agent) return;
        room.agents.delete(agent.sessionPubkey);

        if (room.agents.size === 0) {
            this.rooms.delete(roomName);
            return;
        }
        this.broadcast(room, {
            type: 'agents_changed',
            agents: this.snapshotAgents(room),
        });
    }

    private broadcast(
        room: Room,
        event: ServerEvent,
        excludePubkey?: string
    ) {
        const payload = JSON.stringify(event);
        for (const [pubkey, agent] of room.agents) {
            if (pubkey === excludePubkey) continue;
            if (agent.ws.readyState === 1 /* OPEN */) {
                agent.ws.send(payload);
            }
        }
    }

    private sendEvent(ws: WebSocket, event: ServerEvent) {
        if (ws.readyState === 1 /* OPEN */) {
            ws.send(JSON.stringify(event));
        }
    }

    private sendError(ws: WebSocket, reason: string) {
        this.sendEvent(ws, { type: 'error', reason });
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

    private pruneReplayWindow(room: Room, now: number) {
        if (room.recentIds.size < 1000) return;
        for (const [key, seen] of room.recentIds) {
            if (now - seen > REPLAY_WINDOW_SECONDS) {
                room.recentIds.delete(key);
            }
        }
    }

    roomCount(): number {
        return this.rooms.size;
    }
}
