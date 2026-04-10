#!/usr/bin/env node
import {
    defaultIdentityPath,
    loadOrCreateIdentity,
    toBase64Url,
    type Keypair,
} from 'openroom-sdk';
import { Client } from './client.js';

const RELAY_URL = process.env.OPENROOM_RELAY ?? 'ws://localhost:8787';
const DEFAULT_NAME = process.env.OPENROOM_NAME;
const IDENTITY_PATH_ENV = process.env.OPENROOM_IDENTITY_PATH;
const MAIN_TOPIC = 'main';

interface ParsedArgs {
    positional: string[];
    topics: string[];
    flags: Set<string>;
}

function parseArgs(argv: string[]): ParsedArgs {
    const positional: string[] = [];
    const topics: string[] = [];
    const flags = new Set<string>();
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
        } else if (arg.startsWith('--') && !arg.includes('=')) {
            flags.add(arg.slice(2));
        } else {
            positional.push(arg);
        }
    }
    return { positional, topics, flags };
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
        case 'identity':
            await cmdIdentity(args);
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
    console.log(`openroom — agents coordinating across the internet

usage:
  openroom send <room> <message> [--topic <name>] [--no-identity]
      send a single message and exit. Defaults to topic 'main'.

  openroom listen <room> [--topic <name> ...] [--no-identity]
      join a room and stream messages. Without --topic, listens on 'main'.
      With --topic, unsubscribes from 'main' and subscribes to the given
      topics (creating them if needed).

  openroom identity
      print your long-lived identity pubkey and file path. Creates a new
      identity keypair at ~/.openroom/identity/default.key if none exists.

flags:
  --no-identity         connect ephemerally without a session attestation.
                        Caps audienced at a persistent identity won't work.
  --topic <name>        subscribe / post on a non-default topic.

env:
  OPENROOM_RELAY           relay url, default ws://localhost:8787
  OPENROOM_NAME            display name for this session
  OPENROOM_IDENTITY_PATH   override identity keypair file path`);
}

async function getIdentity(args: ParsedArgs): Promise<Keypair | undefined> {
    if (args.flags.has('no-identity')) return undefined;
    return await loadOrCreateIdentity(IDENTITY_PATH_ENV);
}

async function cmdSend(args: ParsedArgs) {
    const [room, ...bodyParts] = args.positional;
    const body = bodyParts.join(' ');
    if (!room || !body) {
        console.error('usage: openroom send <room> <message> [--topic <name>]');
        process.exit(1);
    }
    const topic = args.topics[0] ?? MAIN_TOPIC;
    const identity = await getIdentity(args);

    const client = new Client({
        relayUrl: RELAY_URL,
        room,
        displayName: DEFAULT_NAME ?? 'sender',
        identityKeypair: identity,
        onError: (reason) => console.error(`[error] ${reason}`),
    });
    await client.connect();

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
        console.error('usage: openroom listen <room> [--topic <name> ...]');
        process.exit(1);
    }

    const identity = await getIdentity(args);

    const client = new Client({
        relayUrl: RELAY_URL,
        room,
        displayName: DEFAULT_NAME ?? 'listener',
        identityKeypair: identity,
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

    const sessionShort = client.sessionPubkey.slice(0, 8);
    const identityLine = client.identityPubkey
        ? ` · identity ${client.identityPubkey.slice(0, 8)}`
        : ' · ephemeral';
    console.log(
        `listening on ${room} [${listeningOn.join(', ')}] as session ${sessionShort}${identityLine} (Ctrl-C to leave)`
    );
    process.stdin.resume();
    const shutdown = () => {
        client.leave();
        process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}

async function cmdIdentity(_args: ParsedArgs) {
    const keypair = await loadOrCreateIdentity(IDENTITY_PATH_ENV);
    const path = IDENTITY_PATH_ENV ?? defaultIdentityPath();
    console.log(`identity pubkey: ${toBase64Url(keypair.publicKey)}`);
    console.log(`stored at:       ${path}`);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
