// Runs the hierarchical room type scenario end-to-end against a local relay.
// Master creates three topics with caps, delegates to a trusted agent, and
// a capless worker tries (and fails) to reach the gated decisions topic.
// Asserts behaviors, exits non-zero on any failure.

import {
    delegateCap,
    generateKeypair,
    makeRootCap,
    toBase64Url,
    type Cap,
} from 'openroom-sdk';
import { Client } from '../src/client.js';

const RELAY_URL = process.env.OPENROOM_RELAY ?? 'ws://localhost:19200';
const ROOM = process.env.OPENROOM_ROOM ?? `cap-demo-${Date.now()}`;

function pass(label: string, ok: boolean, detail?: unknown) {
    const tag = ok ? 'ok' : 'FAIL';
    console.log(
        `${tag} ${label}${!ok && detail !== undefined ? ' — ' + JSON.stringify(detail) : ''}`
    );
    if (!ok) process.exitCode = 1;
}

interface Inbox {
    topic: string;
    body: string;
    from: string;
}

function makeClient(
    kp: { privateKey: Uint8Array; publicKey: Uint8Array },
    label: string,
    inbox: Inbox[]
): Client {
    return new Client(
        {
            relayUrl: RELAY_URL,
            room: ROOM,
            displayName: label,
            onMessage: (event) => {
                inbox.push({
                    topic: event.envelope.payload.topic,
                    body: event.envelope.payload.body,
                    from: event.envelope.from,
                });
            },
            onError: () => {
                // Swallow errors during the demo; we assert via other paths.
            },
        },
        kp
    );
}

async function sleep(ms: number) {
    return new Promise((r) => setTimeout(r, ms));
}

async function run() {
    // Identities
    const masterKp = generateKeypair();
    const trustedKp = generateKeypair();
    const workerKp = generateKeypair();

    const masterPub = toBase64Url(masterKp.publicKey);
    const trustedPub = toBase64Url(trustedKp.publicKey);
    const workerPub = toBase64Url(workerKp.publicKey);

    const masterInbox: Inbox[] = [];
    const trustedInbox: Inbox[] = [];
    const workerInbox: Inbox[] = [];

    // Master issues a self-root cap over the entire room.
    const masterRootCap = makeRootCap(
        masterKp.publicKey,
        masterKp.privateKey,
        { resource: `room:${ROOM}/*`, action: '*' }
    );

    // ---- Master ----
    const master = makeClient(masterKp, 'master', masterInbox);
    await master.connect();

    // Gated both ways
    await master.createTopic('decisions', {
        subscribeCap: masterPub,
        postCap: masterPub,
    });
    // Subscribe gated, post open
    await master.createTopic('review', {
        subscribeCap: masterPub,
        postCap: null,
    });
    // Fully open
    await master.createTopic('proposals');

    // Master subscribes to decisions (uses its own root cap as proof).
    await master.subscribe('decisions', { cap: masterRootCap });

    // ---- Trusted agent joins ----
    const trusted = makeClient(trustedKp, 'trusted', trustedInbox);
    await trusted.connect();

    // Master delegates to trusted: full access to decisions + subscribe to review.
    const trustedDecisionsCap = delegateCap(
        masterRootCap,
        trustedPub,
        { resource: `room:${ROOM}/topic:decisions`, action: '*' },
        masterKp.privateKey
    );
    const trustedReviewCap = delegateCap(
        masterRootCap,
        trustedPub,
        { resource: `room:${ROOM}/topic:review`, action: 'subscribe' },
        masterKp.privateKey
    );

    // Trusted uses its caps to subscribe.
    await trusted.subscribe('decisions', { cap: trustedDecisionsCap });
    await trusted.subscribe('review', { cap: trustedReviewCap });

    // ---- Worker joins ----
    const worker = makeClient(workerKp, 'worker', workerInbox);
    await worker.connect();

    // Worker with no caps: subscribe to decisions MUST fail.
    let workerDecisionsSubErr: string | null = null;
    try {
        await worker.subscribe('decisions');
    } catch (e) {
        workerDecisionsSubErr = (e as Error).message;
    }
    pass(
        'worker cannot subscribe to gated decisions without cap',
        workerDecisionsSubErr !== null &&
            /denied|no valid cap|missing cap/i.test(workerDecisionsSubErr),
        workerDecisionsSubErr
    );

    // Worker can subscribe to proposals (fully open).
    await worker.subscribe('proposals');

    // ---- Exercise the gated topics ----
    // 1. Trusted posts to decisions using its cap: should fan out.
    await trusted.send('decision-from-trusted', 'decisions', {
        cap: trustedDecisionsCap,
    });

    // 2. Worker attempts to post to decisions WITHOUT a cap: the relay
    //    now returns a send_result with success=false, which surfaces as
    //    a rejected promise. Catch and verify the relay dropped the send.
    let workerDecisionsPostErr: string | null = null;
    try {
        await worker.send('worker-sneaking-into-decisions', 'decisions');
    } catch (e) {
        workerDecisionsPostErr = (e as Error).message;
    }
    pass(
        'worker post to gated decisions returns error',
        workerDecisionsPostErr !== null &&
            /denied|no valid cap/i.test(workerDecisionsPostErr),
        workerDecisionsPostErr
    );

    // 3. Worker posts to proposals (open): should reach master-if-subscribed.
    //    Master is not subscribed to proposals, so only worker itself and
    //    anyone else subscribed to proposals will see it. Relay ACKs success.
    await worker.send('worker-proposal', 'proposals');

    // 4. Master posts to decisions using its root cap: should fan out.
    await master.send('decision-from-master', 'decisions', {
        cap: masterRootCap,
    });

    // 5. Worker posts to review (post is OPEN on review): should fan out
    //    to review subscribers (master isn't on review, but trusted is).
    await worker.send('worker-note-in-review', 'review');

    await sleep(200);

    // ---- Assertions on delivery ----

    // Master should have received trusted's decision.
    const masterGotTrustedDecision = masterInbox.some(
        (m) =>
            m.topic === 'decisions' &&
            m.body === 'decision-from-trusted' &&
            m.from === trustedPub
    );
    pass(
        'master received trusted decision-from-trusted',
        masterGotTrustedDecision
    );

    // Master should NOT receive its OWN post echoed back — the relay
    // suppresses self-echoes to avoid feedback loops in agent-driven
    // flows. The send_result ack is the authoritative delivery
    // confirmation.
    const masterGotSelfDecision = masterInbox.some(
        (m) =>
            m.topic === 'decisions' &&
            m.body === 'decision-from-master' &&
            m.from === masterPub
    );
    pass(
        'master did NOT self-echo decision-from-master',
        !masterGotSelfDecision
    );

    // Master must NOT have received the worker's attempted decisions post.
    const masterGotWorkerAttempt = masterInbox.some(
        (m) =>
            m.topic === 'decisions' &&
            m.body === 'worker-sneaking-into-decisions'
    );
    pass(
        'master did NOT receive worker sneaking attempt',
        !masterGotWorkerAttempt
    );

    // Trusted should have received the master's decision.
    const trustedGotMasterDecision = trustedInbox.some(
        (m) =>
            m.topic === 'decisions' &&
            m.body === 'decision-from-master' &&
            m.from === masterPub
    );
    pass('trusted received master decision', trustedGotMasterDecision);

    // Trusted should have received worker's review note (open post on review,
    // trusted is subscribed).
    const trustedGotWorkerReview = trustedInbox.some(
        (m) => m.topic === 'review' && m.body === 'worker-note-in-review'
    );
    pass('trusted received worker review note', trustedGotWorkerReview);

    // Worker must NOT have received anything from decisions (never subscribed).
    const workerGotAnyDecisions = workerInbox.some(
        (m) => m.topic === 'decisions'
    );
    pass(
        'worker did NOT receive any decisions messages',
        !workerGotAnyDecisions
    );

    // Cleanup
    master.leave();
    trusted.leave();
    worker.leave();
    await sleep(150);
    process.exit(process.exitCode ?? 0);
}

run().catch((e) => {
    console.error(e);
    process.exit(1);
});
