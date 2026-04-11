// Bundle the CLI entry into a single executable dist/cli.js.
//
// Target: Node 20+, ESM, platform node. Bundles the workspace
// openroom-sdk (which itself has been tsc-built to dist/) and the ws
// package so the published artifact has zero runtime dependencies. A
// banner preserves the shebang that src/index.ts relies on for
// /usr/bin/env node execution.
//
// Used by the prepack script and the release-cli.yml workflow.

import esbuild from 'esbuild';
import { chmod, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(__dirname, '..');
const outFile = path.join(pkgRoot, 'dist', 'cli.js');

await rm(path.join(pkgRoot, 'dist'), { recursive: true, force: true });
await mkdir(path.join(pkgRoot, 'dist'), { recursive: true });

await esbuild.build({
    entryPoints: [path.join(pkgRoot, 'src', 'index.ts')],
    bundle: true,
    outfile: outFile,
    platform: 'node',
    target: 'node20',
    format: 'esm',
    // esbuild preserves the #!/usr/bin/env node shebang from
    // src/index.ts into the bundle automatically. The banner is
    // inserted after that shebang and provides a createRequire shim
    // so CJS dependencies bundled into this ESM output (notably `ws`,
    // which internally calls require('events')) can still use dynamic
    // require at runtime. Without this, Node throws "Dynamic require
    // is not supported" on first WebSocket use.
    banner: {
        js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
    },
    // Force ESM-compatible __dirname/__filename shims in case a bundled
    // dep reaches for them via CJS interop.
    define: {
        'import.meta.vitest': 'undefined',
    },
    // Node built-ins are auto-external under platform: 'node'. Keep
    // `inspector` / `worker_threads` out of the bundle even if a dep
    // tries to conditionally import them.
    external: [],
    // Legal comments bloat output; we ship the license via the package
    // itself, not inline banners.
    legalComments: 'none',
    logLevel: 'info',
});

await chmod(outFile, 0o755);
console.log(`\n✅ bundled → ${path.relative(pkgRoot, outFile)}`);
