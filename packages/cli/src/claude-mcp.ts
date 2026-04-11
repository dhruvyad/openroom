// MCP server adapter that exposes an openroom room to a Claude Code session.
//
// Entry point: `openroom mcp-server` (or directly via tsx). Reads config from
// env vars: OPENROOM_ROOM (required), OPENROOM_RELAY, OPENROOM_NAME,
// OPENROOM_IDENTITY_PATH, OPENROOM_NO_IDENTITY.
//
// Architecture:
//   - Client connects to the relay and joins the room.
//   - Adapter keeps a ring buffer of recent messages for the
//     `list_recent_messages` tool and bridges Client callbacks to MCP
//     notifications via `notifications/openroom/channel`.
//   - MCP Server (low-level, not McpServer) declares experimental capability
//     `openroom/channel` so Claude knows notifications will flow, and handles
//     tool calls by delegating to the adapter.
//
// Tools exposed:
//   send_message, subscribe_topic, unsubscribe_topic, create_topic,
//   list_topics, list_agents, list_recent_messages
//
// Note: `openroom/channel` is an experimental capability shape we own. If
// Claude ever adopts a standardized "channel notifications" pattern we'd
// switch to that method name, but for v1 a namespaced custom notification
// is the pragmatic choice.

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
    CallToolRequestSchema,
    ListToolsRequestSchema,
    type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { type Keypair } from 'openroom-sdk';
import { loadOrCreateIdentity } from 'openroom-sdk/node';

import { Client } from './client.js';

interface RecentMessage {
    message_id: string;
    topic: string;
    from: string;
    from_identity?: string;
    ts: number;
    body: string;
}

const MESSAGE_BUFFER_SIZE = 200;

class OpenroomAdapter {
    private client: Client;
    private recent: RecentMessage[] = [];
    private onMessageHook?: (message: RecentMessage) => void;
    private onAgentsChangedHook?: () => void;

    constructor(client: Client) {
        this.client = client;
    }

    static async create(config: {
        relayUrl: string;
        room: string;
        displayName?: string;
        description?: string;
        identityKeypair?: Keypair;
    }): Promise<OpenroomAdapter> {
        let adapter!: OpenroomAdapter;
        const client = new Client({
            relayUrl: config.relayUrl,
            room: config.room,
            displayName: config.displayName,
            description: config.description,
            identityKeypair: config.identityKeypair,
            onMessage: (event) => adapter.handleInbound(event),
            onAgentsChanged: () => adapter.onAgentsChangedHook?.(),
            onError: (reason) => {
                // Route through stderr so it shows up in claude-cli logs
                // without corrupting the MCP stdio channel.
                process.stderr.write(`[openroom] ${reason}\n`);
            },
        });
        adapter = new OpenroomAdapter(client);
        await client.connect();
        return adapter;
    }

    private handleInbound(event: {
        envelope: {
            id: string;
            ts: number;
            from: string;
            payload: { topic: string; body: string };
        };
    }) {
        const agent = this.client.agents.find(
            (a) => a.pubkey === event.envelope.from
        );
        const record: RecentMessage = {
            message_id: event.envelope.id,
            topic: event.envelope.payload.topic,
            from: event.envelope.from,
            from_identity: agent?.identity_attestation?.identity_pubkey,
            ts: event.envelope.ts,
            body: event.envelope.payload.body,
        };
        this.recent.push(record);
        if (this.recent.length > MESSAGE_BUFFER_SIZE) {
            this.recent.splice(0, this.recent.length - MESSAGE_BUFFER_SIZE);
        }
        this.onMessageHook?.(record);
    }

    onMessage(hook: (message: RecentMessage) => void) {
        this.onMessageHook = hook;
    }

    onAgentsChanged(hook: () => void) {
        this.onAgentsChangedHook = hook;
    }

    // --- Tool implementations ---

    async sendMessage(body: string, topic?: string, replyTo?: string) {
        // Client.send signature doesn't take reply_to yet — the spec says
        // it's part of SendPayload but the Client hasn't been extended.
        // For v1 of the adapter we drop reply_to silently; the base send
        // works and the protocol-level field can be threaded through later.
        void replyTo;
        await this.client.send(body, topic ?? 'main');
    }

    async subscribeTopic(name: string) {
        await this.client.subscribe(name);
    }

    async unsubscribeTopic(name: string) {
        await this.client.unsubscribe(name);
    }

    async createTopic(
        name: string,
        subscribeCap?: string | null,
        postCap?: string | null
    ) {
        return await this.client.createTopic(name, {
            subscribeCap: subscribeCap ?? null,
            postCap: postCap ?? null,
        });
    }

    async listTopics() {
        return await this.client.listTopics();
    }

    listAgents() {
        return this.client.agents.map((a) => ({
            session_pubkey: a.pubkey,
            display_name: a.display_name,
            description: a.description,
            identity_pubkey: a.identity_attestation?.identity_pubkey,
        }));
    }

    listRecentMessages(limit?: number): RecentMessage[] {
        const n = Math.max(1, Math.min(limit ?? 50, MESSAGE_BUFFER_SIZE));
        return this.recent.slice(-n);
    }

    close() {
        this.client.leave();
    }

    get sessionPubkey() {
        return this.client.sessionPubkey;
    }

    get identityPubkey() {
        return this.client.identityPubkey;
    }

    get room() {
        return this.client.room;
    }
}

// ---- Tool schemas ------------------------------------------------------

const TOOLS: Tool[] = [
    {
        name: 'send_message',
        description:
            'Send a message to a topic in the current openroom. Defaults to the "main" topic.',
        inputSchema: {
            type: 'object',
            properties: {
                body: {
                    type: 'string',
                    description: 'Message text to send.',
                },
                topic: {
                    type: 'string',
                    description:
                        'Topic name. Defaults to "main". The topic must exist (create it first with create_topic if needed).',
                },
                reply_to: {
                    type: 'string',
                    description:
                        'Optional message_id this is a reply to. Reserved; currently ignored.',
                },
            },
            required: ['body'],
        },
    },
    {
        name: 'subscribe_topic',
        description:
            'Subscribe to a topic so future messages posted to it are delivered as notifications.',
        inputSchema: {
            type: 'object',
            properties: {
                name: { type: 'string' },
            },
            required: ['name'],
        },
    },
    {
        name: 'unsubscribe_topic',
        description:
            'Unsubscribe from a topic. Future messages on that topic will not be delivered.',
        inputSchema: {
            type: 'object',
            properties: {
                name: { type: 'string' },
            },
            required: ['name'],
        },
    },
    {
        name: 'create_topic',
        description:
            'Create a topic in the current room (or fetch its summary if it already exists with matching cap fields).',
        inputSchema: {
            type: 'object',
            properties: {
                name: { type: 'string' },
                subscribe_cap: {
                    type: 'string',
                    description:
                        'Base64url pubkey of the root authority required to subscribe. Omit for an open topic.',
                },
                post_cap: {
                    type: 'string',
                    description:
                        'Base64url pubkey of the root authority required to post. Omit for an open topic.',
                },
            },
            required: ['name'],
        },
    },
    {
        name: 'list_topics',
        description: 'List all topics currently known in the room.',
        inputSchema: { type: 'object', properties: {} },
    },
    {
        name: 'list_agents',
        description:
            'List agents currently joined to the room, including their identity pubkey if they attested one.',
        inputSchema: { type: 'object', properties: {} },
    },
    {
        name: 'list_recent_messages',
        description:
            'Return the most recent messages the adapter has observed since joining the room. Useful for catching up on conversation history at the start of a turn.',
        inputSchema: {
            type: 'object',
            properties: {
                limit: {
                    type: 'number',
                    description: `Maximum number of messages to return (1-${MESSAGE_BUFFER_SIZE}). Defaults to 50.`,
                },
            },
        },
    },
];

// ---- MCP server -------------------------------------------------------

async function loadIdentityFromEnv(): Promise<Keypair | undefined> {
    if (process.env.OPENROOM_NO_IDENTITY === '1') return undefined;
    return await loadOrCreateIdentity(process.env.OPENROOM_IDENTITY_PATH);
}

export async function runMcpServer() {
    const room = process.env.OPENROOM_ROOM;
    if (!room) {
        process.stderr.write(
            'openroom mcp-server: OPENROOM_ROOM env var is required\n'
        );
        process.exit(1);
    }
    const relayUrl = process.env.OPENROOM_RELAY ?? 'ws://localhost:8787';
    const displayName = process.env.OPENROOM_NAME ?? 'claude';
    const description =
        process.env.OPENROOM_DESCRIPTION ?? 'Claude session via openroom';
    const identity = await loadIdentityFromEnv();

    const adapter = await OpenroomAdapter.create({
        relayUrl,
        room,
        displayName,
        description,
        identityKeypair: identity,
    });

    const server = new Server(
        {
            name: 'openroom',
            version: '0.0.2',
        },
        {
            capabilities: {
                tools: {},
                experimental: {
                    'openroom/channel': {},
                },
            },
        }
    );

    server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: TOOLS,
    }));

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const { name, arguments: args } = request.params;
        const a = (args ?? {}) as Record<string, unknown>;

        try {
            switch (name) {
                case 'send_message': {
                    await adapter.sendMessage(
                        String(a.body ?? ''),
                        a.topic as string | undefined,
                        a.reply_to as string | undefined
                    );
                    return textContent('sent');
                }
                case 'subscribe_topic': {
                    await adapter.subscribeTopic(String(a.name));
                    return textContent(`subscribed to ${a.name}`);
                }
                case 'unsubscribe_topic': {
                    await adapter.unsubscribeTopic(String(a.name));
                    return textContent(`unsubscribed from ${a.name}`);
                }
                case 'create_topic': {
                    const summary = await adapter.createTopic(
                        String(a.name),
                        a.subscribe_cap as string | null | undefined,
                        a.post_cap as string | null | undefined
                    );
                    return jsonContent(summary);
                }
                case 'list_topics': {
                    return jsonContent(await adapter.listTopics());
                }
                case 'list_agents': {
                    return jsonContent(adapter.listAgents());
                }
                case 'list_recent_messages': {
                    return jsonContent(
                        adapter.listRecentMessages(a.limit as number | undefined)
                    );
                }
                default:
                    return {
                        content: [
                            { type: 'text', text: `unknown tool: ${name}` },
                        ],
                        isError: true,
                    };
            }
        } catch (err) {
            return {
                content: [
                    {
                        type: 'text',
                        text: `error: ${(err as Error).message}`,
                    },
                ],
                isError: true,
            };
        }
    });

    // Push inbound room messages as MCP notifications. Claude Code can
    // surface these into the model's context when it supports the
    // experimental channel capability; otherwise the notification is
    // harmlessly dropped.
    adapter.onMessage((msg) => {
        server
            .notification({
                method: 'notifications/openroom/channel',
                params: {
                    content: `[${msg.topic}] ${msg.from.slice(0, 8)}: ${msg.body}`,
                    meta: {
                        room: adapter.room,
                        topic: msg.topic,
                        message_id: msg.message_id,
                        from: msg.from,
                        from_identity: msg.from_identity,
                        ts: msg.ts,
                    },
                },
            })
            .catch(() => {});
    });

    const transport = new StdioServerTransport();
    await server.connect(transport);

    const shutdown = () => {
        try {
            adapter.close();
        } finally {
            process.exit(0);
        }
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}

function textContent(text: string) {
    return { content: [{ type: 'text' as const, text }] };
}

function jsonContent(value: unknown) {
    return {
        content: [
            {
                type: 'text' as const,
                text: JSON.stringify(value, null, 2),
            },
        ],
    };
}

// Allow running this file directly: `tsx src/claude-mcp.ts` or
// `node dist/claude-mcp.js`. When imported as a module, the caller
// must invoke runMcpServer() explicitly.
const isDirectRun =
    process.argv[1] !== undefined &&
    (process.argv[1].endsWith('claude-mcp.ts') ||
        process.argv[1].endsWith('claude-mcp.js'));
if (isDirectRun) {
    runMcpServer().catch((err) => {
        process.stderr.write(`openroom mcp-server fatal: ${err}\n`);
        process.exit(1);
    });
}
