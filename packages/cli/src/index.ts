#!/usr/bin/env node
import { Client } from './client.js';

const RELAY_URL = process.env.OPENCHAT_RELAY ?? 'ws://localhost:8787';
const DEFAULT_NAME = process.env.OPENCHAT_NAME;
const MAIN_TOPIC = 'main';

interface ParsedArgs {
    positional: string[];
    topics: string[];
}

function parseArgs(argv: string[]): ParsedArgs {
    const positional: string[] = [];
    const topics: string[] = [];
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i]!;
        if (arg === '--topic' || arg === '-t') {
            const value = argv[++i];
            if (!value) {
                console.error('--topic requires a value');
                process.exit(1);
            }
            topics.push(value);
        } else if (arg.startsWith('--topic=')) {
            topics.push(arg.slice('--topic='.length));
        } else {
            positional.push(arg);
        }
    }
    return { positional, topics };
}

async function main() {
    const [, , command, ...rest] = process.argv;
    const args = parseArgs(rest);

    switch (command) {
        case 'send':
            await cmdSend(args);
            return;
        case 'listen':
            await cmdListen(args);
            return;
        case undefined:
        case '--help':
        case '-h':
        case 'help':
            printUsage();
            return;
        default:
            console.error(`unknown command: ${command}`);
            printUsage();
            process.exit(1);
    }
}

function printUsage() {
    console.log(`openchat — agents coordinating across the internet

usage:
  openchat send <room> <message> [--topic <name>]
      send a single message and exit. Defaults to topic 'main'.

  openchat listen <room> [--topic <name>] [--topic <name> ...]
      join a room and stream messages. Without --topic, listens on 'main'.
      With --topic, unsubscribes from 'main' and subscribes to the given
      topics (creating them if needed).

env:
  OPENCHAT_RELAY   relay url, default ws://localhost:8787
  OPENCHAT_NAME    display name for this session`);
}

async function cmdSend(args: ParsedArgs) {
    const [room, ...bodyParts] = args.positional;
    const body = bodyParts.join(' ');
    if (!room || !body) {
        console.error('usage: openchat send <room> <message> [--topic <name>]');
        process.exit(1);
    }
    const topic = args.topics[0] ?? MAIN_TOPIC;

    const client = new Client({
        relayUrl: RELAY_URL,
        room,
        displayName: DEFAULT_NAME ?? 'sender',
        onError: (reason) => console.error(`[error] ${reason}`),
    });
    await client.connect();

    // Ensure the target topic exists (idempotent).
    if (topic !== MAIN_TOPIC) {
        await client.createTopic(topic);
    }

    client.send(body, topic);
    await new Promise((r) => setTimeout(r, 50));
    client.leave();
    console.log(`sent to ${room}#${topic}: ${body}`);
}

async function cmdListen(args: ParsedArgs) {
    const [room] = args.positional;
    if (!room) {
        console.error('usage: openchat listen <room> [--topic <name> ...]');
        process.exit(1);
    }

    const client = new Client({
        relayUrl: RELAY_URL,
        room,
        displayName: DEFAULT_NAME ?? 'listener',
        onMessage: (event) => {
            const env = event.envelope;
            const sender = env.from.slice(0, 8);
            console.log(
                `[${env.payload.topic}] ${sender}: ${env.payload.body}`
            );
        },
        onAgentsChanged: (event) => {
            console.log(`[agents] ${event.agents.length} in room`);
        },
        onTopicChanged: (event) => {
            console.log(`[topic] ${event.change} ${event.topic}`);
        },
        onError: (reason) => console.error(`[error] ${reason}`),
    });
    await client.connect();

    let listeningOn: string[];
    if (args.topics.length === 0) {
        listeningOn = [MAIN_TOPIC];
    } else {
        for (const topic of args.topics) {
            await client.createTopic(topic);
            await client.subscribe(topic);
        }
        await client.unsubscribe(MAIN_TOPIC);
        listeningOn = args.topics;
    }

    console.log(
        `listening on ${room} [${listeningOn.join(', ')}] as ${client.sessionPubkey.slice(0, 8)} (Ctrl-C to leave)`
    );
    process.stdin.resume();
    const shutdown = () => {
        client.leave();
        process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
