// JS-side sender for the cross-language smoke test.
//
// Joins the room, sends one message, leaves. The Python listener on the
// other side verifies the signature and body.

import { Client } from '../src/client.js';

async function main() {
    const [relayUrl, room, body] = process.argv.slice(2);
    if (!relayUrl || !room || !body) {
        console.error('usage: js_sender.ts <relay_url> <room> <body>');
        process.exit(2);
    }

    const client = new Client({
        relayUrl,
        room,
        displayName: 'js-sender',
        onError: () => {},
    });
    await client.connect();
    await client.send(body);
    // Brief grace so the send_result lands before leave tears down the ws.
    await new Promise((r) => setTimeout(r, 150));
    client.leave();
    console.log('ok');
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
