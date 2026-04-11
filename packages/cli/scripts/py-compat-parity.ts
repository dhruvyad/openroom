// JS side of the cross-language parity helper used by
// scripts/python-smoke-test.sh.
//
// Modes (first argv):
//   make-attestation       — emit a fresh session attestation as JSON
//   verify-attestation     — read an attestation from stdin, print ok/fail
//   make-cap               — emit a root → delegate cap chain + metadata
//   verify-cap             — read a cap chain from stdin, verify, print ok/fail
//
// Each "make" mode emits a JSON object with everything the opposite-
// SDK verifier needs to check the output, so the two sides don't need
// to coordinate state out-of-band.

import {
    generateKeypair,
    makeRootCap,
    delegateCap,
    makeSessionAttestation,
    toBase64Url,
    verifyCapChain,
    verifySessionAttestation,
    type Cap,
    type SessionAttestation,
} from 'openroom-sdk';

async function readStdin(): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks).toString('utf8');
}

async function main() {
    const [mode, ...rest] = process.argv.slice(2);
    if (!mode) {
        console.error('usage: py-compat-parity.ts <mode> [args...]');
        process.exit(2);
    }

    if (mode === 'make-attestation') {
        const room = rest[0] ?? 'parity-test-room';
        const identity = generateKeypair();
        const session = generateKeypair();
        const attestation = makeSessionAttestation(
            identity,
            session.publicKey,
            room
        );
        console.log(
            JSON.stringify({
                room,
                identity_pubkey: toBase64Url(identity.publicKey),
                session_pubkey: toBase64Url(session.publicKey),
                attestation,
            })
        );
        return;
    }

    if (mode === 'verify-attestation') {
        const raw = await readStdin();
        let wrapper: { attestation: SessionAttestation };
        try {
            wrapper = JSON.parse(raw);
        } catch (e) {
            console.error(`invalid json: ${(e as Error).message}`);
            process.exit(1);
        }
        if (verifySessionAttestation(wrapper.attestation)) {
            console.log('ok');
            return;
        }
        console.error('attestation verification failed');
        process.exit(1);
    }

    if (mode === 'make-cap') {
        const master = generateKeypair();
        const trusted = generateKeypair();
        const resource = 'room:parity/topic:decisions';
        const action = 'post';
        const root = makeRootCap(master.publicKey, master.privateKey, {
            resource: 'room:parity/*',
            action: '*',
        });
        const leaf = delegateCap(
            root,
            toBase64Url(trusted.publicKey),
            { resource, action },
            master.privateKey
        );
        console.log(
            JSON.stringify({
                expected_audience: toBase64Url(trusted.publicKey),
                expected_root: toBase64Url(master.publicKey),
                required_resource: resource,
                required_action: action,
                cap: leaf,
            })
        );
        return;
    }

    if (mode === 'verify-cap') {
        const raw = await readStdin();
        let wrapper: {
            expected_audience: string;
            expected_root: string;
            required_resource: string;
            required_action: string;
            cap: Cap;
        };
        try {
            wrapper = JSON.parse(raw);
        } catch (e) {
            console.error(`invalid json: ${(e as Error).message}`);
            process.exit(1);
        }
        const result = verifyCapChain(wrapper.cap, {
            expectedAudience: wrapper.expected_audience,
            expectedRoot: wrapper.expected_root,
            requiredResource: wrapper.required_resource,
            requiredAction: wrapper.required_action,
        });
        if (result.ok) {
            console.log('ok');
            return;
        }
        console.error(`cap verification failed: ${result.reason}`);
        process.exit(1);
    }

    console.error(`unknown mode: ${mode}`);
    process.exit(2);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
