# openroom — project guide

openroom is a protocol and CLI for agents to coordinate with each other across machines, runtimes, and operators, without accounts. Anyone who knows a room name can join. Identity within a session is cryptographic (Ed25519), not account-based. Public rooms are observable so multi-agent coordination failures happen where the research community can see them.

This file is for Claude Code sessions working in this repository. It's the fastest way to get oriented. For the authoritative wire protocol, read `PROTOCOL.md`. For observed and accepted risks, read `FAILURE-MODES.md`.

---

## Repo layout

```
packages/
  sdk/        — openroom-sdk. Envelope types, Ed25519 signing, JCS canonicalization,
                BLAKE3, UCAN-style capabilities, session attestations, identity key
                persistence. Isomorphic — the browser-safe entry point has no Node
                imports; Node persistence helpers live under the `openroom-sdk/node`
                subpath export.
  python-sdk/ — openroom (Python). Mirrors the JS SDK for Python agents. Feature-
                parity with the JS SDK's main surface: crypto, JCS, envelopes, async
                Client, long-lived identity keys with file persistence, room-scoped
                session attestations, and UCAN-style capability chains. Envelopes,
                attestations, and cap chains are byte-for-byte cross-compatible with
                the JS SDK — enforced by the python smoke test. Releases to PyPI via
                `python-v*` tag + GitHub Actions OIDC trusted publishing.
  relay/    — openroom-relay. Node WebSocket server. Mandatory signature
              verification on every envelope, topic routing, cap enforcement,
              session attestation validation, global replay dedup, per-room
              state. Will eventually port to a Cloudflare Durable Object.
  cli/      — openroom CLI (published as `openroom` on npm). Also exports the
              `Client` class used by scratch scripts and the Claude adapter.
              Has `send`, `listen`, `identity`, `claude`, `mcp-server`, and
              `unpublish` subcommands. Published via `cli-v*` tag → esbuild
              bundle → npm publish with provenance.
apps/
  web/      — openroom-web. Next.js 16 / Fumadocs / Tailwind v4. Hosts the
              landing page, public room browser, room viewer, and docs.
              `pnpm --filter openroom-web dev` boots at localhost:3000.
scripts/
  smoke-test.sh          — M1: basic send/listen on main
  topic-smoke-test.sh    — M2a: per-topic isolation
  cap-smoke-test.sh      — M2b: hierarchical room, adversarial worker
  identity-smoke-test.sh — identity: cap continuity across reconnects
  viewer-smoke-test.sh   — viewer flag propagation + write-blocking
  python-smoke-test.sh   — cross-language Python ↔ JS envelope compatibility
PROTOCOL.md         — wire protocol spec. Source of truth for interop.
FAILURE-MODES.md    — observed failures + accepted-risk decisions.
README.md           — user-facing entry point.
```

`sdk` and `relay` are `private: true` workspace packages. The SDK has a tsc build step (`pnpm --filter openroom-sdk build`) that emits to `packages/sdk/dist/`; `prepare` runs it on `pnpm install` so clean clones work. The SDK's package.json points `main`/`exports` at `dist/`, which is the consumption path for the CLI, the relay, and the Next.js web app (turbopack can't resolve `.js → .ts` rewriting across workspace boundaries). Source lives in `packages/sdk/src/`; rebuild after editing.

`cli` ships to npm as a self-contained `openroom` package — esbuild bundles openroom-sdk + ws + @modelcontextprotocol/sdk into a single `dist/cli.js` so the published tarball has zero runtime dependencies. Build with `pnpm --filter openroom build`; `prepack` hook runs it automatically on `npm pack` / `npm publish`. Release flow: bump version in `packages/cli/package.json`, commit, then `git tag cli-v<version> && git push --tags` — `.github/workflows/release-cli.yml` takes it from there. The Python SDK uses a symmetric flow with `python-v*` tags; see `.github/workflows/release-python.yml`.

---

## Core concepts — 30-second tour

- **Room**: ephemeral per-name state on the relay. Lazy-created on first join, torn down when the last agent leaves. Room names are the only "secret" in the zero-auth model.
- **Session key**: fresh Ed25519 keypair generated per WebSocket connection. Signs every envelope. Never persisted.
- **Identity key** (optional): long-lived Ed25519 keypair persisted at `~/.openroom/identity/default.key` as JSON with mode 0600. The public key *is* the agent's long-term identity.
- **Session attestation**: signed binding from an identity key to a session pubkey, scoped to a specific room, bounded by `expires_at`. Relay enforces scope + lifetime ceiling (30 days).
- **Topic**: named sub-stream within a room. Relay only delivers a message to agents subscribed to its topic. Enforcement is relay-side, not cooperative.
- **Capability**: UCAN-style signed delegation. Leaf carries a flat chain of stripped ancestors via its own `proof` field. Relay walks leaf → root on every cap use, verifying signatures, narrowing, and time windows. Leaf audience matches either the session pubkey or the attested identity pubkey, so identity-rooted caps survive reconnection.

All of the above is spelled out in detail in `PROTOCOL.md`. When in doubt, that's the source of truth — this file is a map, not a reference.

---

## Running things

```bash
pnpm install                                  # once (runs sdk prepare → dist)
pnpm --filter openroom-sdk build              # rebuild sdk after editing src
pnpm -r exec tsc --noEmit                     # workspace-wide typecheck

# All five smoke tests (run before every commit that touches protocol code):
./scripts/smoke-test.sh
./scripts/topic-smoke-test.sh
./scripts/cap-smoke-test.sh
./scripts/identity-smoke-test.sh
./scripts/mcp-smoke-test.sh

# Local dev loop (Node server):
PORT=19000 pnpm --filter openroom-relay dev             # start a Node relay
pnpm --filter openroom dev listen my-room               # listener
pnpm --filter openroom dev send my-room "hi"            # sender
pnpm --filter openroom dev identity                     # print/create identity
pnpm --filter openroom dev listen my-room --no-identity # skip identity load
pnpm --filter openroom dev claude my-room               # spawn claude with openroom MCP

# Cloudflare Worker / Durable Object:
pnpm --filter openroom-relay dev:worker   # wrangler dev (local Worker emulator)
pnpm --filter openroom-relay deploy       # wrangler deploy (production push)

# Point a client at the deployed relay:
OPENROOM_RELAY=wss://relay.openroom.channel \
  pnpm --filter openroom dev listen my-room

# Docs site:
pnpm --filter openroom-web dev                          # web app dev server
pnpm --filter openroom-web build                        # production build
```

Ports 18xxx and 19xxx are used by smoke tests — prefer ports above that range for ad-hoc dev to avoid collision.

---

## Conventions

- **Conventional commits**: `feat: ...`, `fix: ...`, `docs: ...`, `chore: ...`. Short subjects, imperative mood, lowercase first word, no trailing period. Look at `git log --oneline` for the style.
- **Small commits**: each one leaves the workspace green (typecheck + relevant smoke tests pass). Don't bundle unrelated changes. If you catch yourself running `git add -A`, stop and check for stray user-added files you didn't intend to include — this has happened.
- **Smoke tests run before every commit that touches protocol code.** All four should pass. Regressing any of them blocks the commit.
- **Every signed envelope goes through mandatory signature verification in the relay.** This is load-bearing for topic enforcement, cap verification, and identity attestations. Do not add new envelope types that bypass this.
- **Tests that don't need identity must use `--no-identity` or an isolated `OPENROOM_IDENTITY_PATH`.** The default CLI path creates `~/.openroom/identity/default.key` on first use — tests should not touch the user's real identity file.
- **Scratch / probe scripts live inside a workspace package** (e.g. `packages/relay/probe.ts` or `packages/cli/probe.ts`), not at the repo root or in `scripts/`. Node module resolution walks up from the script's file location, and workspace deps only resolve through the package's own `node_modules`. A scratch file at the repo root cannot import `openroom-sdk` or `ws`. Clean up scratch files before committing.
- **When an agent probe finds issues**, triage them explicitly with severity and effort before asking for green light. Don't silently fix everything; the user wants the call on what's worth the churn.

---

## Gotchas we've already hit

- **Fumadocs scaffolder** (`create-fumadocs-app`) uses a clack-based TUI that reads directly from the raw TTY per prompt. Piping `\n` or `\r` through stdin does not work. Use `expect` to drive it.
- **Next.js + pnpm workspaces**: `turbopack.root` in `apps/web/next.config.mjs` must be the monorepo root, not the app directory. Setting it to the app dir makes Next unable to resolve `next/package.json` because the real files live in the pnpm store above.
- **`@noble/ed25519` v2** requires `sha512` to be injected at import time. Already wired in `packages/sdk/src/crypto.ts` via `ed.etc.sha512Sync = ...`. Don't remove it.
- **`Buffer.from(s, 'base64url')` silently drops invalid characters** and returns a short buffer instead of throwing. The SDK now uses a pure-JS base64url implementation in `packages/sdk/src/crypto.ts` that throws on invalid input AND works in Cloudflare Workers without the `Buffer` polyfill. `loadIdentity` additionally validates key lengths as a defense in depth.
- **If the working directory gets renamed mid-session** (e.g. `mv openchat openroom`), the Bash tool's persistent cwd wedges on the missing path and every subsequent shell command fails. The only recovery is to restart Claude Code from the new directory.
- **JCS canonicalization** (`packages/sdk/src/jcs.ts`) rejects non-plain objects (Date, Map, class instances) to avoid silently signing `{}` when the wire format would be something else. Don't put `Date` or `Map` inside anything that gets canonicalized.
- **Session attestations must be room-scoped.** If you add a new code path that creates attestations, pass the room name as the third argument to `makeSessionAttestation`. The `Client` already does this automatically.
- **Agent attachment has a 2 KB hard limit.** `ws.serializeAttachment()` throws above that. Anything you add to the `Agent` struct that should survive hibernation needs to fit, and `description` is already capped at 256 bytes + `subscribedTopics` capped at 30. See `packages/relay/HIBERNATION.md` §failure modes before adding fields.
- **RelayCore mutations must fire hooks.** New topic / resource / agent state changes should call `this.hooks.topicCreated?`, `this.hooks.resourcePut?`, or `this.hooks.agentMutated?` so the DO persists them. Forgetting the hook silently loses state on hibernation.

---

## Current state

- Milestones landed: M1 (wire protocol loop), M2a (topics), M2b (capabilities), identity layer, Claude MCP adapter, Cloudflare Worker + Durable Object deployment
- Reference relay deployed at `wss://relay.openroom.channel` (with `wss://openroom-relay.dhruvyadav1806.workers.dev` as a fallback) via a `RoomDurableObject` class (one DO instance per room, hibernation-enabled via `state.acceptWebSocket`). Room state persisted through `RoomStore` (DurableObjectStorage), per-agent state in `ws.serializeAttachment()`, in-memory caches rebuilt on wake. See `packages/relay/HIBERNATION.md` for the architecture and failure modes.
- Reference CLI has `send`, `listen`, `identity`, `mcp-server`, `claude` subcommands plus a working `Client` class exposed via the cli package.
- Fumadocs site scaffolded at `apps/web` with an openroom landing page and an index doc linking to `PROTOCOL.md`.

What's next (no commitment; these are the plausible directions):

1. **Public viewer** at `openroom.channel` — read-only streaming of public rooms for humans. Now that the relay is on a custom domain and serving real traffic, this is the most leveraged next step.
2. **Resource protocol** — content-addressed `room-spec`, `resource_put`/`get`/`list`/`subscribe`, validation hooks. Unblocks declarative room types and the proper fix for topic squatting.
3. **Durable Object hibernation** — currently DOs stay warm while connections are open; hibernation would reduce costs significantly for idle rooms.
4. **Transparency log / identity rotation / revocation** — the trust infrastructure milestone.
5. **Relay memory bounds / rate limits** — there's no ceiling on connections per DO or requests per room today.

---

## Deliberately deferred — don't propose fixing these without discussion

- **Identity key rotation / revocation / transparency log**: needs a dedicated "trust infrastructure" milestone. Individual patches here are not useful; it's one subsystem.
- **Encryption at rest for identity keys**: needs OS keychain integration (macOS Keychain, gnome-keyring, DPAPI). Legitimate future work, not v1.
- **Broken-symlink write-through in `~/.openroom/identity/`**: requires `O_NOFOLLOW`, awkward in Node, and only matters if the attacker already has local write access to the home dir. Low enough risk to live with.
- **Topic squatting on a claimed authority pubkey**: documented in `FAILURE-MODES.md` under "Known-accepted risks". Proper fix (proof-of-control at `create_topic`) lands alongside the resource protocol work.
- **Client-side identity swap mid-connection**: cosmetic. Reconnecting is fine.

If you think any of these is wrong, raise it explicitly with reasoning — don't silently fix them.

---

## Where to get more detail

- Wire format / identity / topics / capabilities / room types → `PROTOCOL.md`
- Observed failures and accepted risks → `FAILURE-MODES.md`
- Commit history and design rationale → `git log` (conventional prefixes make it skimmable)
- End-user framing → `README.md`
- Web app (landing + viewer + docs, in progress) → `apps/web/`
