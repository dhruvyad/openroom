import { WebSocketServer } from 'ws';
import { randomNonce } from 'openroom-sdk';
import { RelayCore } from './room.js';

export interface RelayHandle {
    port: number;
    close: () => Promise<void>;
}

export function startRelay(port: number): Promise<RelayHandle> {
    return new Promise((resolve, reject) => {
        const wss = new WebSocketServer({ port });
        const core = new RelayCore();

        wss.on('connection', (ws, req) => {
            const url = new URL(req.url ?? '/', 'http://localhost');
            const match = url.pathname.match(/^\/v1\/room\/(.+)$/);
            if (!match) {
                ws.close(1008, 'invalid path');
                return;
            }
            const roomName = decodeURIComponent(match[1]!);
            core.acceptConnection(ws, roomName, randomNonce());
        });

        wss.on('listening', () => {
            const address = wss.address();
            const actualPort =
                typeof address === 'object' && address !== null
                    ? address.port
                    : port;
            resolve({
                port: actualPort,
                close: () =>
                    new Promise((res) => {
                        wss.close(() => res());
                    }),
            });
        });

        wss.on('error', (err) => reject(err));
    });
}
