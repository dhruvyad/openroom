// Direct message smoke test.
//
// openroom DMs are NOT private — the target field is a UI hint, not a
// routing constraint. Every agent in the room receives the direct_message
// event. This test proves exactly that: when A DMs B, a third observer C
// in the same room must also receive the event. DMs to cross-room targets
// or offline targets are rejected.
//
// This visibility is intentional: viewers and researchers must be able to
// see all coordination happening in a room. Hidden side-channels would
// defeat openroom's observability pitch.

import { generateKeypair } from 'openroom-sdk';
import { Client } from '../src/client.js';

const RELAY_URL = process.env.OPENROOM_RELAY ?? 'ws://localhost:19975';
const ROOM_A = `direct-demo-${Date.now()}`;
const ROOM_B = `direct-demo-other-${Date.now()}`;

function pass(label: string, ok: boolean, detail?: unknown) {
    const tag = ok ? 'ok' : 'FAIL';
    console.log(
        `${tag} ${label}${!ok && detail !== undefined ? ' — ' + JSON.stringify(detail) : ''}`
    );
    if (!ok) process.exitCode = 1;
}

async function sleep(ms: number) {
    return new Promise((r) => setTimeout(r, ms));
}

interface Inbox {
    topicMessages: Array<{ from: string; body: string }>;
    directs: Array<{ from: string; target: string; body: string }>;
}

function makeClient(
    room: string,
    label: string,
    inbox: Inbox
): Client {
    const kp = generateKeypair();
    return new Client(
        {
            relayUrl: RELAY_URL,
            room,
            displayName: label,
            onMessage: (event) => {
                inbox.topicMessages.push({
                    from: event.envelope.from,
                    body: event.envelope.payload.body,
                });
            },
            onDirectMessage: (event) => {
                inbox.directs.push({
                    from: event.envelope.from,
                    target: event.envelope.payload.target,
                    body: event.envelope.payload.body,
                });
            },
            onError: () => {},
        },
        kp
    );
}

async function run() {
    const aInbox: Inbox = { topicMessages: [], directs: [] };
    const bInbox: Inbox = { topicMessages: [], directs: [] };
    const cInbox: Inbox = { topicMessages: [], directs: [] };
    const dInbox: Inbox = { topicMessages: [], directs: [] };

    const a = makeClient(ROOM_A, 'alice', aInbox);
    const b = makeClient(ROOM_A, 'bob', bInbox);
    const c = makeClient(ROOM_A, 'carol-observer', cInbox);
    const d = makeClient(ROOM_B, 'dave-other-room', dInbox);

    await Promise.all([a.connect(), b.connect(), c.connect(), d.connect()]);
    await sleep(150);

    const bPubkey = b.sessionPubkey;

    // --- 1. A sends a DM to B. ---
    await a.sendDirect(bPubkey, 'hello bob, just between us (kind of)');
    await sleep(200);

    pass(
        '1 target B received the direct message',
        bInbox.directs.length === 1 &&
            bInbox.directs[0]!.body ===
                'hello bob, just between us (kind of)' &&
            bInbox.directs[0]!.target === bPubkey
    );

    pass(
        '1 observer C in the SAME room also received the direct message',
        cInbox.directs.length === 1 &&
            cInbox.directs[0]!.body ===
                'hello bob, just between us (kind of)' &&
            cInbox.directs[0]!.target === bPubkey
    );

    pass(
        '1 sender A did NOT receive their own broadcast (ack is enough)',
        aInbox.directs.length === 0
    );

    pass(
        '1 agent D in a DIFFERENT room did NOT receive it',
        dInbox.directs.length === 0
    );

    // --- 2. DM to a non-existent target in the same room is rejected. ---
    let err: string | null = null;
    try {
        await a.sendDirect(
            'A'.repeat(43), // bogus base64url
            'this should not go through'
        );
    } catch (e) {
        err = (e as Error).message;
    }
    pass(
        '2 DM to missing target rejected',
        err !== null && /target not in room/i.test(err),
        err
    );

    // Confirm B and C did NOT see the bogus DM.
    pass(
        '2 observers did not see the rejected DM',
        bInbox.directs.length === 1 && cInbox.directs.length === 1
    );

    // --- 3. B can reply via DM back to A, and A receives it. ---
    await b.sendDirect(a.sessionPubkey, 'hi alice, and hi observers too');
    await sleep(200);
    pass(
        '3 A received reply DM',
        aInbox.directs.length === 1 &&
            aInbox.directs[0]!.body === 'hi alice, and hi observers too'
    );
    pass(
        '3 observer C received reply DM',
        cInbox.directs.length === 2 &&
            cInbox.directs[1]!.body === 'hi alice, and hi observers too'
    );

    a.leave();
    b.leave();
    c.leave();
    d.leave();
    await sleep(150);
    process.exit(process.exitCode ?? 0);
}

run().catch((e) => {
    console.error(e);
    process.exit(1);
});
