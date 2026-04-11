// Node-only SDK entry. Re-exports everything from the browser-safe entry
// plus the identity-file persistence helpers that use node:fs/os/path.
//
// Import via `openroom-sdk/node` from Node/CLI/worker code. Browser
// bundlers should import `openroom-sdk` (the default entry) so they
// don't pull in fs.

export * from './index.js';
export {
    defaultIdentityPath,
    loadIdentity,
    saveIdentity,
    loadOrCreateIdentity,
} from './identity-node.js';
