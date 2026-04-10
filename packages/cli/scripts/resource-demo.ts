// End-to-end smoke test for the resource protocol.
//
// Scenario:
//   1. Master joins with an identity key and puts a `room-spec` resource
//      with validation_hook = master identity pubkey.
//   2. Peer joins, reads the spec via resource_get, verifies the content.
//   3. Third agent (worker) tries to overwrite the spec WITHOUT a cap —
//      should be rejected.
//   4. Master rotates the spec (writes new content) using its own root cap.
//   5. Peer subscribes to the resource, observes the resource_changed
//      notification, re-reads and sees the new content.

import {
    delegateCap,
    generateKeypair,
    makeRootCap,
    toBase64Url,
    type Keypair,
} from 'openroom-sdk';
import { Client } from '../src/client.js';

const RELAY_URL = process.env.OPENROOM_RELAY ?? 'ws://localhost:19900';
const ROOM = `resource-demo-${Date.now()}`;

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

function makeClient(
    label: string,
    identity?: Keypair,
    onResource?: (e: { name: string; change: string }) => void
): Client {
    return new Client({
        relayUrl: RELAY_URL,
        room: ROOM,
        displayName: label,
        identityKeypair: identity,
        onResourceChanged: (e) => onResource?.(e),
        onError: () => {},
    });
}

async function run() {
    const masterId = generateKeypair();
    const masterIdPub = toBase64Url(masterId.publicKey);

    // Master's durable root cap signed by its identity key. Covers all
    // resource actions in the room.
    const masterRootCap = makeRootCap(
        masterId.publicKey,
        masterId.privateKey,
        { resource: `room:${ROOM}/*`, action: '*' }
    );

    const master = makeClient('master', masterId);
    await master.connect();

    // 1. Put the initial room-spec resource, gated on master's identity.
    const specV1 = '# openroom research-swarm\n\nv1: invitation-only.';
    const putV1 = await master.putResource('room-spec', specV1, {
        kind: 'room-spec',
        mime: 'text/markdown',
        validationHook: masterIdPub,
    });
    pass(
        '1 master put room-spec v1',
        putV1.cid.startsWith('blake3:') &&
            putV1.kind === 'room-spec' &&
            putV1.validation_hook === masterIdPub
    );

    // 2. Peer joins and reads the spec.
    const peerResourceEvents: Array<{ name: string; change: string }> = [];
    const peer = makeClient('peer', undefined, (e) => {
        peerResourceEvents.push({ name: e.name, change: e.change });
    });
    await peer.connect();
    pass(
        '2 peer saw room-spec in cached joined resources',
        peer.cachedResources.some((r) => r.name === 'room-spec')
    );
    const read = await peer.getResource({ name: 'room-spec' });
    pass(
        '2 peer read matches master put content',
        new TextDecoder().decode(read.content) === specV1 &&
            read.summary.cid === putV1.cid
    );

    // 3. Worker (no identity, no cap) tries to overwrite.
    const worker = makeClient('worker');
    await worker.connect();
    let workerErr: string | null = null;
    try {
        await worker.putResource('room-spec', 'v2: wide open!', {
            kind: 'room-spec',
            mime: 'text/markdown',
        });
    } catch (e) {
        workerErr = (e as Error).message;
    }
    pass(
        '3 worker overwrite without cap rejected',
        workerErr !== null && /denied|no valid cap/i.test(workerErr),
        workerErr
    );

    // Confirm peer still sees v1 content unchanged.
    const readAfterAttempt = await peer.getResource({ name: 'room-spec' });
    pass(
        '3 spec content unchanged after rejected overwrite',
        new TextDecoder().decode(readAfterAttempt.content) === specV1
    );

    // 4. Master rotates the spec using its root cap.
    const specV2 =
        '# openroom research-swarm\n\nv2: now with trusted proposer tier.';
    // Peer subscribes FIRST so we can watch the change notification.
    await peer.subscribeResource('room-spec');
    const eventsBefore = peerResourceEvents.length;

    const putV2 = await master.putResource('room-spec', specV2, {
        kind: 'room-spec',
        mime: 'text/markdown',
        cap: masterRootCap,
    });
    pass('4 master rotated spec', putV2.cid !== putV1.cid);

    await sleep(250);
    const peerGotChange = peerResourceEvents
        .slice(eventsBefore)
        .some((e) => e.name === 'room-spec' && e.change === 'put');
    pass('4 peer received resource_changed for rotation', peerGotChange);

    // 5. Peer re-reads and sees v2.
    const readV2 = await peer.getResource({ name: 'room-spec' });
    pass(
        '5 peer read v2 after rotation',
        new TextDecoder().decode(readV2.content) === specV2 &&
            readV2.summary.cid === putV2.cid
    );

    // 6. CID-based read returns the same content.
    const byCid = await peer.getResource({ cid: putV2.cid });
    pass(
        '6 cid-addressed read returns v2 content',
        new TextDecoder().decode(byCid.content) === specV2
    );

    // 7. List resources returns the room-spec.
    const listed = await peer.listResources('room-spec');
    pass(
        '7 list_resources with kind filter returns the spec',
        listed.length === 1 && listed[0]!.name === 'room-spec'
    );

    master.leave();
    peer.leave();
    worker.leave();
    await sleep(150);
    process.exit(process.exitCode ?? 0);
}

run().catch((e) => {
    console.error(e);
    process.exit(1);
});
