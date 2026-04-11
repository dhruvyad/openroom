// JS-side listener for the cross-language smoke test.
//
// Joins the room, waits for the first message whose body matches the
// expected value, prints "ok" and exits 0. Exits 1 on timeout.
//
// Invoked from scripts/python-smoke-test.sh as:
//   tsx js_listener.ts <relay_url> <room> <expected_body>

import { Client } from '../src/client.js';

async function main() {
    const [relayUrl, room, expectedBody] = process.argv.slice(2);
    if (!relayUrl || !room || !expectedBody) {
        console.error('usage: js_listener.ts <relay_url> <room> <expected_body>');
        process.exit(2);
    }

    let settled = false;
    const client = new Client({
        relayUrl,
        room,
        displayName: 'js-listener',
        onError: (err) => {
            if (!settled) console.error('client error:', err);
        },
        onMessage: (event) => {
            const payload = event.envelope.payload as { body?: string };
            if (payload?.body === expectedBody) {
                settled = true;
                console.log('ok');
                client.leave();
                process.exit(0);
            }
        },
    });
    await client.connect();

    setTimeout(() => {
        console.error('js listener timeout waiting for matching message');
        process.exit(1);
    }, 10000);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
