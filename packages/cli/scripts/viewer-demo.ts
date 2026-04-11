// Viewer-mode smoke test.
//
// Asserts:
//   1. A viewer-flagged agent joins and appears in agents_changed with
//      viewer:true, while a normal agent appears without the flag.
//   2. A viewer receives message events broadcast to topics they subscribe
//      to (read-only observation works).
//   3. A viewer's send() call is rejected by the relay.
//   4. A viewer's sendDirect() call is rejected by the relay.
//   5. A viewer's createTopic() call is rejected.
//   6. A viewer's putResource() call is rejected.
//
// Runs against $OPENROOM_RELAY (defaults to ws://localhost:18790).

import { Client } from '../src/client.js';
import type { AgentSummary, MessageEvent } from 'openroom-sdk';

const RELAY_URL = process.env.OPENROOM_RELAY ?? 'ws://localhost:18790';

function pass(label: string, ok: boolean, detail?: unknown) {
    const tag = ok ? 'ok' : 'FAIL';
    console.log(
        `${tag} ${label}${!ok && detail !== undefined ? ' — ' + JSON.stringify(detail) : ''}`
    );
    if (!ok) process.exitCode = 1;
}

function sleep(ms: number) {
    return new Promise((r) => setTimeout(r, ms));
}

async function run() {
    const room = `viewer-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

    // Normal participant.
    const participant = new Client({
        relayUrl: RELAY_URL,
        room,
        displayName: 'participant',
        onError: () => {},
    });
    await participant.connect();

    // Read-only viewer.
    const viewerMessages: MessageEvent[] = [];
    const viewer = new Client({
        relayUrl: RELAY_URL,
        room,
        displayName: 'viewer',
        viewer: true,
        onMessage: (e) => viewerMessages.push(e),
        onError: () => {},
    });
    await viewer.connect();

    // ---- Test 1: agent summary reflects the viewer flag ----
    await sleep(100);
    const agents: readonly AgentSummary[] = participant.agents;
    const participantSummary = agents.find(
        (a) => a.display_name === 'participant'
    );
    const viewerSummary = agents.find((a) => a.display_name === 'viewer');
    pass(
        '1 participant agent has no viewer flag',
        participantSummary !== undefined && participantSummary.viewer !== true,
        participantSummary
    );
    pass(
        '1 viewer agent is flagged viewer:true',
        viewerSummary !== undefined && viewerSummary.viewer === true,
        viewerSummary
    );

    // ---- Test 2: viewer receives broadcast messages ----
    await participant.send('hello from participant');
    await sleep(150);
    pass(
        '2 viewer received participant broadcast',
        viewerMessages.some((m) => {
            try {
                const body =
                    typeof m.envelope.payload === 'object' &&
                    m.envelope.payload !== null
                        ? (m.envelope.payload as { body?: unknown }).body
                        : undefined;
                return body === 'hello from participant';
            } catch {
                return false;
            }
        }),
        viewerMessages.length
    );

    // ---- Test 3: viewer.send() is rejected ----
    let sendRejected = false;
    try {
        await viewer.send('should be blocked');
    } catch (e) {
        sendRejected = /viewer/i.test((e as Error).message);
    }
    pass('3 viewer send rejected with viewer error', sendRejected);

    // ---- Test 4: viewer.sendDirect() is rejected ----
    let directRejected = false;
    try {
        await viewer.sendDirect(participant.sessionPubkey, 'hi');
    } catch (e) {
        directRejected = /viewer/i.test((e as Error).message);
    }
    pass('4 viewer sendDirect rejected', directRejected);

    // ---- Test 5: viewer.createTopic() is rejected ----
    let createRejected = false;
    try {
        await viewer.createTopic('viewer-made-topic');
    } catch (e) {
        createRejected = /viewer/i.test((e as Error).message);
    }
    pass('5 viewer createTopic rejected', createRejected);

    // ---- Test 6: viewer.putResource() is rejected ----
    let putRejected = false;
    try {
        await viewer.putResource('blob', 'payload', { kind: 'blob' });
    } catch (e) {
        putRejected = /viewer/i.test((e as Error).message);
    }
    pass('6 viewer putResource rejected', putRejected);

    viewer.leave();
    participant.leave();
    await sleep(100);

    process.exit(process.exitCode ?? 0);
}

run().catch((e) => {
    console.error(e);
    process.exit(1);
});
