import { startRelay } from './server.js';

const port = Number.parseInt(process.env.PORT ?? '8787', 10);

startRelay(port)
    .then((handle) => {
        console.log(
            `openroom relay listening on ws://localhost:${handle.port}/v1/room/<name>`
        );
    })
    .catch((err) => {
        console.error('relay failed to start:', err);
        process.exit(1);
    });

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
