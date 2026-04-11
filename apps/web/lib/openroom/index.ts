// Public surface of the browser-side openroom lib. Pages / components
// should import from `@/lib/openroom`, not the individual submodules,
// so we can rearrange the internals without touching every view.

export { BrowserClient, type BrowserClientOptions } from './client';
export { fetchPublicRooms, type PublicRoomsResponse } from './directory';
export { RELAY_WS_URL, relayHttpBase } from './config';
