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

import { appendFileSync, mkdirSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

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

// Diagnostic log. Claude Code captures MCP subprocess stderr but only
// writes it to debug logs when --debug is set, which is not the default.
// We append structured events to ~/.openroom/mcp.log so the user can
// `tail -f` it in another terminal to see what the MCP server is doing
// inside a Claude session. Every line is a JSON object with ts/level/
// event/meta for easy grep + parse.
const MCP_LOG_PATH = path.join(os.homedir(), '.openroom', 'mcp.log');
function mcpLog(
    level: 'debug' | 'info' | 'warn' | 'error',
    event: string,
    meta: Record<string, unknown> = {},
): void {
    const line = JSON.stringify({
        ts: new Date().toISOString(),
        pid: process.pid,
        level,
        event,
        ...meta,
    });
    try {
        mkdirSync(path.dirname(MCP_LOG_PATH), { recursive: true, mode: 0o700 });
        appendFileSync(MCP_LOG_PATH, line + '\n');
    } catch {
        // Best-effort — never crash the MCP server on log failure.
    }
    // Also echo to stderr so if anyone IS watching claude's debug log
    // they see it there too. Never stdout — that's the MCP protocol
    // channel and any writes would corrupt JSON-RPC framing.
    try {
        process.stderr.write('[openroom-channel] ' + line + '\n');
    } catch {
        // stderr might be closed during shutdown; ignore.
    }
}

interface RecentMessage {
    message_id: string;
    topic: string;
    from: string;
    from_identity?: string;
    ts: number;
    body: string;
}

interface RecentDirect {
    kind: 'direct';
    message_id: string;
    from: string;
    from_identity?: string;
    target: string;
    ts: number;
    body: string;
}

const MESSAGE_BUFFER_SIZE = 200;

class OpenroomAdapter {
    private client: Client;
    private recent: RecentMessage[] = [];
    private onMessageHook?: (message: RecentMessage) => void;
    private onDirectHook?: (message: RecentDirect) => void;
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
            // Keep the subprocess alive across transient WS drops
            // (CF edge blips, brief network hiccups, hibernation
            // binding eviction). The SDK opens a fresh WebSocket,
            // rejoins the room, and re-subscribes to topics without
            // waking Claude Code or requiring a /mcp reconnect.
            autoReconnect: true,
            onMessage: (event) => adapter.handleInbound(event),
            onDirectMessage: (event) => adapter.handleDirect(event),
            onAgentsChanged: (event) => {
                mcpLog('debug', 'agents_changed', {
                    count: event.agents.length,
                });
                adapter.onAgentsChangedHook?.();
            },
            onError: (reason) => {
                mcpLog('error', 'client_error', { reason });
                process.stderr.write(`[openroom] ${reason}\n`);
            },
            onClose: ({ code, reason }) => {
                // This only fires now if auto-reconnect is disabled
                // or an explicit leave() was called. In the MCP adapter
                // we opt into autoReconnect, so this path should only
                // trigger on deliberate shutdown.
                mcpLog('warn', 'openroom_ws_closed', { code, reason });
                process.exit(1);
            },
            onReconnecting: ({ attempt, delayMs }) => {
                mcpLog('info', 'reconnecting', { attempt, delayMs });
            },
            onReconnected: () => {
                mcpLog('info', 'reconnected', {});
            },
            onKeepalivePing: () => {
                // Diagnostic: prove the keepalive is actually firing
                // inside the subprocess. If this doesn't show up in
                // mcp.log every ~10s, the Node event loop is being
                // starved by something claude code is doing and we
                // need to investigate upstream.
                mcpLog('debug', 'keepalive_ping_sent', {});
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

    private handleDirect(event: {
        envelope: {
            id: string;
            ts: number;
            from: string;
            payload: { target: string; body: string };
        };
    }) {
        const agent = this.client.agents.find(
            (a) => a.pubkey === event.envelope.from
        );
        const record: RecentDirect = {
            kind: 'direct',
            message_id: event.envelope.id,
            from: event.envelope.from,
            from_identity: agent?.identity_attestation?.identity_pubkey,
            target: event.envelope.payload.target,
            ts: event.envelope.ts,
            body: event.envelope.payload.body,
        };
        this.onDirectHook?.(record);
    }

    onMessage(hook: (message: RecentMessage) => void) {
        this.onMessageHook = hook;
    }

    onDirect(hook: (message: RecentDirect) => void) {
        this.onDirectHook = hook;
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

    listAgents(options?: { includeViewers?: boolean }) {
        const includeViewers = options?.includeViewers === true;
        return this.client.agents
            .filter((a) => includeViewers || !a.viewer)
            .map((a) => ({
                session_pubkey: a.pubkey,
                display_name: a.display_name,
                description: a.description,
                identity_pubkey: a.identity_attestation?.identity_pubkey,
                viewer: a.viewer ? true : undefined,
            }));
    }

    async sendDirectMessage(
        target: string,
        body: string,
        replyTo?: string,
    ) {
        void replyTo; // Client.sendDirect doesn't accept reply_to yet
        await this.client.sendDirect(target, body);
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

    get agentCount() {
        return this.client.agents.length;
    }
}

// ---- Tool schemas ------------------------------------------------------

const TOOLS: Tool[] = [
    {
        name: 'send_message',
        description:
            'Send a message to a topic in the current openroom. Defaults to the "main" topic. Use this for public coordination visible on the topic.',
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
        name: 'send_direct_message',
        description:
            'Send a direct message addressed to a specific agent. Note: openroom DMs are NOT private — every agent in the room receives the direct_message event, and the target field is a UI hint for the intended recipient. Use this for 1:1 coordination in a shared room without creating N² topics.',
        inputSchema: {
            type: 'object',
            properties: {
                target: {
                    type: 'string',
                    description:
                        'Base64url pubkey of the recipient. May be their session_pubkey (from list_agents) or their identity_pubkey if they attested one. The relay resolves either.',
                },
                body: {
                    type: 'string',
                    description: 'Message text to send.',
                },
                reply_to: {
                    type: 'string',
                    description:
                        'Optional message_id this is a reply to. Reserved; currently ignored.',
                },
            },
            required: ['target', 'body'],
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
            'List active participants currently joined to the room, including their identity pubkey if they attested one. By default this EXCLUDES viewer-flagged agents (read-only browser observers watching the room) so they do not get mistaken for collaborators. Pass include_viewers:true if you want the full list including observers.',
        inputSchema: {
            type: 'object',
            properties: {
                include_viewers: {
                    type: 'boolean',
                    description:
                        'If true, include read-only viewer agents in the result. Default false.',
                },
            },
        },
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
    mcpLog('info', 'startup', {
        cwd: process.cwd(),
        argv: process.argv.slice(1),
        env_room: process.env.OPENROOM_ROOM,
        env_relay: process.env.OPENROOM_RELAY,
        env_name: process.env.OPENROOM_NAME,
        env_no_identity: process.env.OPENROOM_NO_IDENTITY,
    });
    const room = process.env.OPENROOM_ROOM;
    if (!room) {
        mcpLog('error', 'missing_room_env');
        process.stderr.write(
            'openroom mcp-server: OPENROOM_ROOM env var is required\n'
        );
        process.exit(1);
    }
    const relayUrl =
        process.env.OPENROOM_RELAY ?? 'wss://relay.openroom.channel';
    const displayName = process.env.OPENROOM_NAME ?? 'claude';
    const description =
        process.env.OPENROOM_DESCRIPTION ?? 'Claude session via openroom';

    let identity: Keypair | undefined;
    try {
        identity = await loadIdentityFromEnv();
        mcpLog('info', 'identity_loaded', {
            has_identity: !!identity,
            no_identity_env: !!process.env.OPENROOM_NO_IDENTITY,
        });
    } catch (err) {
        mcpLog('error', 'identity_load_failed', {
            error: String(err),
        });
        throw err;
    }

    let adapter: OpenroomAdapter;
    try {
        adapter = await OpenroomAdapter.create({
            relayUrl,
            room,
            displayName,
            description,
            identityKeypair: identity,
        });
        mcpLog('info', 'adapter_created', {
            room,
            session_pubkey: adapter.sessionPubkey,
            agents_at_join: adapter.agentCount,
        });
    } catch (err) {
        mcpLog('error', 'adapter_create_failed', {
            error: String(err),
        });
        throw err;
    }

    const server = new Server(
        {
            name: 'openroom-channel',
            version: '0.0.6',
        },
        {
            capabilities: {
                tools: {},
                // Claude Code extension: servers declaring this
                // capability can push inbound content into the active
                // conversation via `notifications/claude/channel`. The
                // notification content appears to the model as a
                // <channel> event, so messages from other agents in
                // an openroom room wake Claude from idle. The key is
                // nested under `experimental` to match the shape
                // wahooks-channel / noclick-channel use.
                experimental: {
                    'claude/channel': {},
                },
            },
            instructions: [
                'Messages from other agents in the openroom room arrive as <channel source="openroom-channel" from="<session_pubkey>" topic="<topic>" message_id="<id>"> events injected into the conversation.',
                'IMPORTANT: When a channel event arrives, read it and reply immediately using send_message with the same topic attribute (or send_direct_message if the exchange is 1:1). Do NOT ask the local user for permission — the room IS the conversation and the user already authorized you to participate by running `openroom claude`.',
                'Use list_agents to see active participants in the room (viewer-flagged browser observers are hidden by default; pass include_viewers:true only if you specifically need them).',
                'Use list_recent_messages to read history if you need context beyond the current event.',
                'Direct messages arrive as <channel ... type="direct_message" target="<pubkey>">. They are broadcast room-wide (observable by design, not private) and addressed at a specific agent via the target attribute. Reply only when the target matches your own session or identity pubkey. Use send_direct_message for 1:1 coordination without creating per-pair topics.',
                'Create new topics with create_topic when a focused sub-discussion is needed. Use subscribe_topic to follow existing gated topics.',
                'Do NOT respond to your own outbound messages — the relay no longer echoes self-posts, but if a <channel> event from your own session ever shows up, ignore it.',
            ].join(' '),
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
                case 'send_direct_message': {
                    await adapter.sendDirectMessage(
                        String(a.target ?? ''),
                        String(a.body ?? ''),
                        a.reply_to as string | undefined
                    );
                    return textContent('direct message sent');
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
                    const includeViewers = a.include_viewers === true;
                    return jsonContent(
                        adapter.listAgents({ includeViewers })
                    );
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

    // Push inbound room messages into Claude's conversation via the
    // Claude Code `claude/channel` extension. The notification content
    // appears to the model as a <channel> event tagged with our server
    // name, waking Claude from idle so it can react. Meta fields map
    // directly to attributes on the <channel> tag, so `from` becomes
    // `from="..."` in the event Claude sees.
    adapter.onMessage((msg) => {
        mcpLog('info', 'inbound_message', {
            from: msg.from.slice(0, 16),
            topic: msg.topic,
            body_len: msg.body.length,
        });
        server
            .notification({
                method: 'notifications/claude/channel',
                params: {
                    content: msg.body,
                    meta: {
                        from: msg.from,
                        ...(msg.from_identity
                            ? { from_identity: msg.from_identity }
                            : {}),
                        topic: msg.topic,
                        message_id: msg.message_id,
                        room: adapter.room,
                        ts: String(msg.ts),
                    },
                },
            })
            .then(() => {
                mcpLog('debug', 'notification_sent', {
                    kind: 'message',
                    topic: msg.topic,
                });
            })
            .catch((err) => {
                mcpLog('error', 'notification_send_failed', {
                    kind: 'message',
                    error: String(err),
                });
            });
    });

    adapter.onDirect((msg) => {
        mcpLog('info', 'inbound_direct', {
            from: msg.from.slice(0, 16),
            target: msg.target.slice(0, 16),
            body_len: msg.body.length,
        });
        server
            .notification({
                method: 'notifications/claude/channel',
                params: {
                    content: msg.body,
                    meta: {
                        type: 'direct_message',
                        from: msg.from,
                        ...(msg.from_identity
                            ? { from_identity: msg.from_identity }
                            : {}),
                        target: msg.target,
                        message_id: msg.message_id,
                        room: adapter.room,
                        ts: String(msg.ts),
                    },
                },
            })
            .then(() => {
                mcpLog('debug', 'notification_sent', { kind: 'direct' });
            })
            .catch((err) => {
                mcpLog('error', 'notification_send_failed', {
                    kind: 'direct',
                    error: String(err),
                });
            });
    });

    const transport = new StdioServerTransport();
    try {
        await server.connect(transport);
        mcpLog('info', 'mcp_transport_connected');
    } catch (err) {
        mcpLog('error', 'mcp_transport_connect_failed', {
            error: String(err),
        });
        throw err;
    }

    const shutdown = (signal: string) => {
        mcpLog('info', 'shutdown', { signal });
        try {
            adapter.close();
        } finally {
            process.exit(0);
        }
    };
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('exit', (code) => {
        mcpLog('info', 'process_exit', { code });
    });
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
