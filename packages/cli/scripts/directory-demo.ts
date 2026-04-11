// Directory smoke test. Runs against a live relay (either a deployed
// worker or wrangler dev) since the directory DO lives in the CF runtime,
// not in the Node dev server.
//
// Asserts:
//   1. Open-mode announce works (any signed envelope accepted)
//   2. The announcement appears in GET /v1/public-rooms
//   3. Authority mode: write directory-config, announce with a NON-authority
//      key is rejected, announce with the authority key is accepted
//   4. Unannounce by the original announcer succeeds
//   5. Unannounce by someone else is rejected
//   6. Description too long is rejected
//
// Pass the relay URL via OPENROOM_RELAY (defaults to the deployed
// custom domain so the smoke-test script doesn't need to spin up a
// Worker locally).

import {
    generateKeypair,
    makeEnvelope,
    makeSessionAttestation,
    toBase64Url,
    type AnnouncePayload,
    type Keypair,
    type UnannouncePayload,
} from 'openroom-sdk';
import { Client } from '../src/client.js';

const RELAY_URL = process.env.OPENROOM_RELAY ?? 'wss://relay.openroom.channel';

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

function relayHttpBase(): string {
    const url = new URL(RELAY_URL);
    const proto =
        url.protocol === 'wss:'
            ? 'https:'
            : url.protocol === 'ws:'
            ? 'http:'
            : url.protocol;
    return `${proto}//${url.host}`;
}

async function announceRaw(opts: {
    room: string;
    description: string;
    signer: Keypair;
    attestationRoom?: string;
    attestationIdentity?: Keypair;
    expiresIn?: number;
}): Promise<{ success: boolean; error?: string }> {
    const now = Math.floor(Date.now() / 1000);
    const expiresAt = now + (opts.expiresIn ?? 24 * 60 * 60);

    const payload: AnnouncePayload = {
        room: opts.room,
        description: opts.description,
        expires_at: expiresAt,
    };
    if (opts.attestationIdentity) {
        payload.identity_attestation = makeSessionAttestation(
            opts.attestationIdentity,
            opts.signer.publicKey,
            opts.attestationRoom ?? opts.room
        );
    }

    const envelope = makeEnvelope(
        'announce',
        payload,
        opts.signer.privateKey,
        opts.signer.publicKey
    );
    const response = await fetch(`${relayHttpBase()}/v1/directory`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(envelope),
    });
    return (await response.json()) as { success: boolean; error?: string };
}

async function unannounceRaw(opts: {
    room: string;
    signer: Keypair;
}): Promise<{ success: boolean; error?: string }> {
    const payload: UnannouncePayload = { room: opts.room };
    const envelope = makeEnvelope(
        'unannounce',
        payload,
        opts.signer.privateKey,
        opts.signer.publicKey
    );
    const response = await fetch(`${relayHttpBase()}/v1/directory`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(envelope),
    });
    return (await response.json()) as { success: boolean; error?: string };
}

async function listPublic(): Promise<{
    rooms: Array<{ room: string; description: string; announcer_session: string }>;
}> {
    const response = await fetch(`${relayHttpBase()}/v1/public-rooms`);
    return (await response.json()) as {
        rooms: Array<{
            room: string;
            description: string;
            announcer_session: string;
        }>;
    };
}

async function run() {
    const openRoom = `directory-open-${Date.now()}-${Math.floor(
        Math.random() * 1e6
    )}`;
    const authRoom = `directory-auth-${Date.now()}-${Math.floor(
        Math.random() * 1e6
    )}`;

    // ---- Test 1: Open mode announce ----
    const openAnnouncer = generateKeypair();
    const r1 = await announceRaw({
        room: openRoom,
        description: 'An open research room for testing the directory.',
        signer: openAnnouncer,
    });
    pass('1 open-mode announce accepted', r1.success === true, r1);

    // ---- Test 2: Listing returns the announced room ----
    await sleep(500);
    // Bypass CF edge cache by adding a cache-bust query param.
    const listUrl = `${relayHttpBase()}/v1/public-rooms?_=${Date.now()}`;
    const listResp = await fetch(listUrl, {
        headers: { 'cache-control': 'no-cache' },
    });
    const list = (await listResp.json()) as {
        rooms: Array<{
            room: string;
            description: string;
            announcer_session: string;
        }>;
    };
    const found = list.rooms.find((r) => r.room === openRoom);
    pass(
        '2 listing contains the open announcement',
        found !== undefined &&
            found?.description ===
                'An open research room for testing the directory.' &&
            found?.announcer_session === toBase64Url(openAnnouncer.publicKey)
    );

    // ---- Test 3: Description too long rejected ----
    const tooLongDesc = 'x'.repeat(600);
    const r3 = await announceRaw({
        room: `too-long-${Date.now()}`,
        description: tooLongDesc,
        signer: generateKeypair(),
    });
    pass(
        '3 description > 512 bytes rejected',
        r3.success === false && /description must be 1\.\.512/i.test(r3.error ?? ''),
        r3
    );

    // ---- Test 4: Authority mode ----
    // First, a master must establish authority by writing directory-config.
    // This requires a short-lived Client connection to the auth room.
    const authority = generateKeypair();
    const authorityPub = toBase64Url(authority.publicKey);
    const master = new Client({
        relayUrl: RELAY_URL,
        room: authRoom,
        displayName: 'authority-setup',
        identityKeypair: authority,
        onError: () => {},
    });
    await master.connect();
    const policy = JSON.stringify({
        mode: 'authority',
        authority: authorityPub,
    });
    await master.putResource('directory-config', policy, {
        kind: 'directory-config',
        mime: 'application/json',
        validationHook: authorityPub,
    });
    master.leave();
    await sleep(300);

    // An OUTSIDER (random keypair) tries to announce the auth room.
    // Should be rejected by the authority policy.
    const outsider = generateKeypair();
    const r4 = await announceRaw({
        room: authRoom,
        description: 'Trying to squat on an auth-mode room.',
        signer: outsider,
    });
    pass(
        '4 outsider announce on authority-mode room rejected',
        r4.success === false &&
            /requires authority signature/i.test(r4.error ?? ''),
        r4
    );

    // The authority itself successfully announces.
    const r4b = await announceRaw({
        room: authRoom,
        description: 'The official canonical description.',
        signer: authority,
    });
    pass(
        '4 authority announce on own room accepted',
        r4b.success === true,
        r4b
    );

    // ---- Test 5: Unannounce by original announcer ----
    const r5 = await unannounceRaw({
        room: openRoom,
        signer: openAnnouncer,
    });
    pass('5 original announcer can unannounce', r5.success === true, r5);

    // ---- Test 6: Unannounce by someone else rejected ----
    const r6 = await unannounceRaw({
        room: authRoom,
        signer: generateKeypair(),
    });
    pass(
        '6 unannounce by non-authority rejected',
        r6.success === false,
        r6
    );

    // Clean up — authority unannounces its own room.
    await unannounceRaw({ room: authRoom, signer: authority });

    process.exit(process.exitCode ?? 0);
}

run().catch((e) => {
    console.error(e);
    process.exit(1);
});
