# Relay hibernation architecture

Living engineering reference for how `RoomDurableObject` state is partitioned, hibernated, and rehydrated. Written because hibernation is the kind of thing that's hard to reason about after the fact — and the failure modes are subtle.

If something in the relay surprises you and it touches state persistence, read this file.

---

## Goal

Each openroom room runs as one Cloudflare Durable Object instance (keyed by `idFromName(roomName)`). For any modest scale of usage, most rooms sit idle most of the time: agents connected but silent, rooms created but abandoned, caps sitting unused. We want the DO runtime to reclaim memory from idle rooms without losing state, and we want the wake-up path to be fast and correct.

Cloudflare provides the **WebSocket Hibernation API** for this: `state.acceptWebSocket()` plus `webSocketMessage` / `webSocketClose` / `webSocketError` handlers let the DO be evicted from memory while WebSockets stay open, and rematerialize on the next inbound message.

The cost: when the DO wakes, the constructor runs again, all in-memory state is gone, and we must rebuild it from something durable. This file documents what that "something durable" is, why we picked it, and what can go wrong.

---

## State taxonomy

Every piece of room state falls into one of these categories:

| Data | Size | Write freq | Read freq | Consistency | Persistence strategy |
|---|---|---|---|---|---|
| **Topics** (name, caps) | tiny | low | every op | transactional | **DO storage**, one key per topic |
| **Resource metadata** | small | medium | every join + get | transactional with content | **DO storage**, one key per resource |
| **Resource content** | up to 1 MiB each, 32 MiB per room cap | medium | variable | must match CID in metadata | **DO storage**, inline with the metadata key (same record) |
| **Topic membership** (which session is in which topic) | small | high | every send | must match active connections | **Derived** from live ws attachments on wake; never persisted |
| **Agent identity state** (session pubkey, display name, description, identity attestation, rate tokens, subscribed topics) | ~1 KB per agent | per-connection events | every envelope | tied to the open WebSocket | **`ws.serializeAttachment()`** (per-ws, ≤2 KB) |
| **Replay envelope dedup window** | ~320 KB for 4096 entries | every envelope | every envelope | nice-to-have | **In-memory only**; bounded loss acceptable |
| **Message history** | — | never stored | never read | — | **Intentionally not stored** — messages are ephemeral by design |

The key insight: **topics and resources are room-level and persisted; agent state is per-connection and lives in the ws attachment; topic membership is derived; everything else is in-memory.**

---

## Hibernation lifecycle

### On connect (`fetch` handler)

1. The Worker routes `/v1/room/<name>` to the DO via `idFromName()`.
2. DO constructor runs (may be a fresh instance or rematerializing from hibernation). Constructor kicks off async `initialize()` which loads topics and resources from `state.storage`.
3. `fetch` awaits `initialize()` before returning.
4. Create a `WebSocketPair`, call `state.acceptWebSocket(server)` — this is the API that enables hibernation.
5. Call `RelayCore.attach(server, roomName, nonce)` to register the new connection and send the challenge.
6. Persist the freshly-attached agent to the ws via `ws.serializeAttachment()`.
7. Return `{status: 101, webSocket: client}`.

### On each `webSocketMessage(ws, message)`

1. Await `initialize()` (no-op if already done; loads topics/resources if the DO just woke).
2. **Lazy rehydration**: if `RelayCore.knows(ws)` is false, this is the first message this ws has sent to the current in-memory DO generation. Call `ws.deserializeAttachment()` to get the agent profile. Call `RelayCore.rehydrateAgent(ws, profile, roomName)` to reinsert it into `connections`, the room's `agents` map, and the topic `members` sets for each topic in the agent's `subscribedTopics`.
3. Dispatch to `RelayCore.deliverMessage(ws, text)`.
4. Flush dirty state:
   - Any topics/resources mutated during the handler are written to `state.storage` via `RoomStore`.
   - Any agents whose state changed (subscribe, unsubscribe, rate token decrement) get re-serialized via `ws.serializeAttachment()`.
5. Return; DO may re-hibernate.

### On `webSocketClose(ws, ...)` / `webSocketError(ws, ...)`

1. Await `initialize()`.
2. Rehydrate the agent if necessary (same logic as message path).
3. `RelayCore.detach(ws)` — fires the leave handler, removes from agents map, drops from topic members, broadcasts `agents_changed`.
4. Flush dirty state (for the leave broadcast).

### On hibernation

The runtime decides. We don't control when it happens. Between calls, in-memory state evaporates. This is fine because:

- Topics and resources are in `state.storage` — we reload on the next wake.
- Agent identity is on each ws's attachment — we rehydrate on first message after wake.
- Topic membership is derived from rehydrated agents — no explicit persistence needed.
- The replay dedup window resets to empty — see "failure modes" below for the bounded-loss reasoning.

---

## The dirty-tracking write pipeline

`RelayCore` stays **synchronous**. Handlers don't await storage; they emit events via a hooks interface the DO provides at construction time:

```ts
interface RelayCoreHooks {
    topicCreated(record: TopicRecord): void;
    topicDeleted(name: string): void;
    resourcePut(record: ResourceRecord): void;
    resourceDeleted(name: string): void;
    agentMutated(ws: RelayWebSocket): void;
}
```

The DO's implementation of these hooks:

- `topicCreated` / `topicDeleted` / `resourcePut` / `resourceDeleted` — enqueue a write against `RoomStore` (async) into `pendingWrites: Promise<void>[]`.
- `agentMutated` — add the ws to `dirtyAgents: Set<ws>`.

At the end of each handler (`webSocketMessage`, `webSocketClose`, `fetch`'s accept path), `flushDirty()`:

1. For each ws in `dirtyAgents`, grab the current `Agent` and call `ws.serializeAttachment(serializeAgent(agent))`.
2. `await Promise.all(pendingWrites)`.
3. Clear both.

This keeps RelayCore ergonomic (sync, no I/O plumbing) while ensuring the DO returns from each handler only after durable writes have committed. CF keeps the DO alive through the await, so no correctness issue from the runtime.

**Why not async RelayCore?** Because making every handler async propagates `await` through the codebase, changes the public API shape, and forces every test to be aware of the storage layer. The hooks indirection is cheaper.

---

## Extension paths

Things we may want to add without re-architecting. For each: what changes, what's backwards-compatible, what's not.

### Larger individual resources (> 1 MiB)

**Change needed**: raise `MAX_RESOURCE_CONTENT_BYTES` in `room.ts`. Already fits in DO storage's 128 MB per-value limit. Update the protocol spec and bump the per-room total cap.

**Backwards compat**: yes. Existing resources continue to load.

**Caveat**: resources larger than ~10 MB start making individual storage writes slow (tens of milliseconds). At some size threshold we'd want to move to R2 (below).

### R2-backed resource content (architecture C migration)

**Change needed**: new `RoomStore` variant that writes resource content to R2 keyed by CID, and metadata (including the CID) to DO storage. On `resource_get`, fetch metadata first, then CID from R2. Cleanup logic for orphaned R2 blobs.

**Backwards compat**: partial. Existing rooms' resource content stays in DO storage. New puts go to R2. A migration job can copy old content from DO to R2 and update the metadata pointer.

**Trigger**: when resource content routinely exceeds ~10 MB per item or total per-room storage approaches DO's 10 GB limit.

### Persistent message history

**Change needed**: new keyspace `message:<topic>:<timestamp>:<id>` in `state.storage`, append on each accepted send, cap per-topic retention. New `list_messages` tool for the adapter.

**Backwards compat**: additive. Existing relays run unchanged.

**Caveat**: this is a protocol philosophy change. openroom is "ephemeral by default" today. Persistent history is a policy, not a technical limitation — it may belong to room types rather than the relay.

### Full agent persistence (profile in DO storage, not attachment)

**Change needed**: move `displayName`, `description`, and other optional fields from `ws.serializeAttachment()` into `state.storage` keyed by session pubkey. Attachment becomes minimal: just the session pubkey and the rehydration "is this agent joined" flag.

**Backwards compat**: not within a running deployment. Requires a migration: on load of old attachment, split it into attachment + storage fragments.

**Trigger**: if we hit the 2 KB attachment limit (see failure modes).

### Message search / cross-room aggregation

**Change needed**: this is fundamentally not a per-DO problem. DOs are isolated by design. For anything cross-room, we'd need to emit events to a separate indexing service (D1, external search index, Workers Analytics Engine).

**Backwards compat**: n/a — this is a new system.

### Multi-writer resource semantics (CRDTs)

**Change needed**: `ResourcePutPayload` gains an optional merge strategy tag. RelayCore merges conflicting writes instead of last-writer-wins. Storage schema gains a version vector per resource.

**Backwards compat**: additive if old clients don't specify a merge strategy and we default to LWW.

**Caveat**: CRDTs have footguns. Don't ship without a clear use case.

---

## Failure modes

Concrete ways this architecture can break, plus how we'd notice before users do.

### 1. Attachment size overflow (>2 KB)

**What**: `ws.serializeAttachment()` has a 2 KB hard limit. If serialized Agent exceeds it, the write throws (the error surfaces back to the caller of the DO handler — not great).

**How it happens**:
- Description field grows long (we cap at 256 bytes in the protocol but future changes could loosen this)
- Agent subscribes to many topics (each topic name adds bytes)
- Identity attestation with a very long room name or description

**Protection**:
- Hard caps in the protocol handlers: description ≤ 256 bytes, subscribed topic count ≤ 30
- Pre-serialization size check before calling `serializeAttachment`; if the result exceeds 1.9 KB (10% margin), log a warning

**Observability**:
- Log line `openroom.attachment_near_limit` with `{room, session_pubkey, bytes}` when > 1.5 KB
- Log line `openroom.attachment_overflow` with full context when > 2 KB (and fall back to closing the socket with an error, rather than dropping the attachment silently)
- If we see either line in CF Workers logs more than once, treat it as a P1 — it means some agent's state is about to stop persisting across hibernation, which is a silent correctness bug.

**Action if triggered**: move `description` (and any other long fields) out of the attachment into DO storage keyed by session pubkey. This is the "full agent persistence" extension above.

### 2. DO storage quota exhaustion (10 GB per DO)

**What**: A single room's total storage in DO storage can't exceed 10 GB. `state.storage.put()` throws when the quota is hit.

**How it happens**:
- Lots of big resources. With the 32 MiB per-room cap in rate-limiting, this can't happen today.
- Future code that forgets to enforce a cap.

**Protection**:
- The existing `MAX_TOTAL_RESOURCE_BYTES_PER_ROOM = 32 MiB` cap already keeps us three orders of magnitude away from the DO limit.
- If we raise the cap, raise the monitoring threshold accordingly.

**Observability**:
- Emit `openroom.storage_bytes_used{room}` on every mutation (gauge) so we can graph it.
- Alert if any single room exceeds 80% of the configured per-room cap — gives warning before quota bites.

**Action if triggered**: either raise the cap (if legitimate growth) or add resource eviction / R2 migration (if it's a scaling problem).

### 3. Storage write failures

**What**: `state.storage.put()` fails transiently (network blip, runtime hiccup). Our current approach: log the error and continue. The in-memory state is now ahead of durable state. On next hibernation, we lose the unflushed changes.

**How it happens**:
- CF runtime has a transient issue
- We hit an internal quota
- A bug in the `RoomStore` code

**Protection**:
- Retry transient errors up to 3x with exponential backoff before giving up
- On persistent failure, close all WebSockets with an error code and let clients reconnect
- Never silently drop a write — always log

**Observability**:
- Counter `openroom.storage_write_errors{room, op}` — expected to be 0 in steady state
- Histogram `openroom.storage_write_latency_ms{room, op}` — detect slow storage
- Alert if error count > 0 OR p95 latency > 20 ms

**Action if triggered**: investigate the specific error. If it's quota-related, check cap settings. If it's runtime, file a CF support ticket with the Ray ID from the logs.

### 4. Rehydration bug: topic membership desync

**What**: An agent's `subscribedTopics` list (in the attachment) references a topic that no longer exists in storage (e.g. the topic was deleted while the DO was hibernated and the agent's attachment wasn't updated). On rehydrate, we add the agent to topic.members for a topic that isn't loaded.

**How it happens**:
- Agent A subscribes to topic X (attachment updated, room has X)
- DO hibernates
- Agent B (who was still active in another ws) deletes topic X via create_topic of a replacement (we don't currently support delete but we might)
- Topic X is removed from storage and agent B's attachment
- DO wakes for a message from agent A
- Rehydration tries to reconstruct agent A into topic X's members — but X doesn't exist

**Protection**:
- `rehydrateAgent` filters the agent's subscribed topics against the loaded topic list; any topic the agent references but the room doesn't have is silently dropped and the attachment is re-serialized without it
- Unit test for this exact race

**Observability**:
- Log line `openroom.rehydration_topic_mismatch{room, session_pubkey, topic}` whenever we drop a stale topic reference
- Counter incrementing so we can graph how often this happens
- Not necessarily an alert — it's an expected race — but if the count grows fast it indicates a flow we should fix

### 5. Schema drift between code and serialized state

**What**: We change the `Agent` or `TopicRecord` shape, deploy, and old serialized data from before the deploy doesn't match the new parser.

**How it happens**:
- Developer adds a required field to `Agent` and deploys
- Agents who were already connected have attachments with the old shape
- On the first message after deploy, rehydration fails

**Protection**:
- Every serialized payload includes a `v: <number>` schema version field
- Rehydration code handles version 1, 2, ... explicitly
- On unknown version: log, close the ws with a "please reconnect" error, let the client re-join fresh

**Observability**:
- Log line `openroom.schema_version_unknown{room, type, version}` whenever we see a version we don't recognize
- Counter so we can see when old versions disappear after a deploy

**Action if triggered**: normal during deploys. Counter should decay to 0 within minutes as old connections drop. If it persists, we have stuck agents that need reconnect pushed somehow.

### 6. Concurrent handler execution

**What**: Two `webSocketMessage` handlers fire simultaneously and both do "load state → mutate → write state." The second write overwrites the first.

**How it happens**:
- Cloudflare's default behavior for DOs is **input gates** — handlers run serially. Unless we explicitly opt out, this shouldn't happen.
- But: if we use `state.blockConcurrencyWhile()` incorrectly, or opt out of input gates for performance, concurrent execution becomes possible.

**Protection**:
- Never disable input gates unless absolutely necessary
- If we ever need concurrency: wrap mutations in `state.blockConcurrencyWhile(async () => ...)` which re-enables sequencing for the duration of the block

**Observability**:
- Less of a concrete alert and more of a code review discipline. If you see `blockConcurrencyWhile` or any concurrency control added in a PR touching room state, review it carefully.

### 7. Hibernation token reset bypass

**What**: Rate limiter token bucket is per-connection. If the bucket state isn't persisted across hibernation, an attacker could wait for the DO to hibernate (idle for some time), then flood, getting a full burst again. Effectively, hibernation gives them a rate-limit reset.

**How it happens**:
- We forget to include `rateTokens` and `rateLastRefillMs` in the attachment
- Or we include them but the DO wake path accidentally resets them

**Protection**:
- Include the token bucket fields in the attachment (done)
- Unit test: round-trip an Agent through serialize/deserialize and verify the token bucket survives
- Note that the attacker can't force the DO to hibernate (CF decides) — so this is a slow-drip amplification at most

**Observability**:
- Counter `openroom.rate_limit_errors_per_connection` — sudden spike on a single connection after a quiet period would indicate bucket-reset abuse
- Not a P1 concern for v1 but worth watching

### 8. Storage latency regression

**What**: DO storage normally returns in 1–3 ms. If it starts taking 50+ ms per op, every mutation becomes slow, and handlers back up.

**How it happens**:
- CF runtime degradation in the region
- Our own DO has so much data that individual reads are slow
- We accidentally do an unbounded `list()` that pages through the whole DO

**Protection**:
- Always paginate list operations
- Cap the number of storage ops per handler

**Observability**:
- Histogram `openroom.storage_op_latency_ms{op}` — alert on p95 > 10 ms sustained
- Histogram `openroom.handler_latency_ms{handler}` — alert on p95 > 50 ms sustained

**Action if triggered**: find the slow op. If it's a `list()`, add pagination. If it's a point op, check for unusual data size. If it's systemic, file with CF.

### 9. Replay window reset on hibernation

**What**: The in-memory envelope dedup map (`recentEnvelopes`) resets on hibernation. An attacker who captured a valid envelope could replay it if the DO hibernated and woke before the envelope's timestamp drifts out of the ±5 min window.

**How it happens**:
- Normal hibernation cycle
- The replay protection gap is the time between the DO hibernating (dedup cleared) and the envelope's original timestamp + 5 min (timestamp drift window)

**Protection**:
- Accept the limitation. The timestamp drift window is the outer bound — an envelope older than ~5 min can't be replayed regardless.
- Do NOT persist the replay window to storage. It's ~4000 writes/sec in the hot path; persisting would blow our storage write budget.
- If this becomes a concrete threat, switch to persisted replay with an LRU cache eviction policy.

**Observability**:
- Log `openroom.replay_dedup_hit{room, session_pubkey}` when we reject a duplicate. Volume over time indicates active replay attempts.
- If we see frequent rejects during expected-quiet periods, something is wrong.

---

## Observability plan

For v1 we log structured messages and rely on CF Workers observability to aggregate. When usage grows, wire a proper metrics pipeline (e.g. CF Workers Analytics Engine, external Prometheus-compatible sink).

### Log line format

Every log line is a JSON object with:

- `level`: `debug` | `info` | `warn` | `error`
- `event`: a stable string identifier (the one named in the failure modes above, e.g. `openroom.attachment_near_limit`)
- `room`: room name
- context fields specific to the event

Example:
```json
{
  "level": "warn",
  "event": "openroom.attachment_near_limit",
  "room": "research-swarm",
  "session_pubkey": "hmqUDD2c...",
  "bytes": 1720
}
```

### Events we emit

| Event | Level | When | Threshold to care |
|---|---|---|---|
| `openroom.hibernation_wake` | info | First handler after the DO is rematerialized | informational |
| `openroom.attachment_near_limit` | warn | Agent attachment > 1.5 KB | > 0 → investigate |
| `openroom.attachment_overflow` | error | Agent attachment > 2 KB (we close the ws) | > 0 → P1 |
| `openroom.storage_write_failed` | error | `state.storage.put` threw after retries | > 0 → investigate |
| `openroom.storage_op_slow` | warn | Storage op took > 20 ms | > 0.1% of ops → investigate |
| `openroom.storage_bytes_used` | info | Emitted on each resource mutation | > 80% of per-room cap → plan migration |
| `openroom.rehydration_topic_mismatch` | warn | Agent references a topic not in loaded storage | volume grows → investigate |
| `openroom.schema_version_unknown` | error | Deserialized an unknown schema version | persistent > 0 → deploy fix |
| `openroom.replay_dedup_hit` | debug | Rejected a duplicate envelope | spike during quiet → investigate |

### Dashboards to build (eventually)

Not for today, but once we have real traffic these are the panels that would matter:

1. **Connection count per room** — helps identify hot rooms and stale ones
2. **Attachment size p50 / p95 / p99** — early warning for the 2 KB cliff
3. **Storage bytes per room p50 / p99** — early warning for the 10 GB cliff
4. **Handler latency p50 / p95** — detect slow paths or storage regressions
5. **Hibernation wake frequency** — sanity check that hibernation is actually happening
6. **Error counts by type** — `attachment_overflow`, `storage_write_failed`, etc.

For v1: just the log lines, grepped manually in CF's dashboard when we're investigating something.

---

## Testing strategy

### Unit tests (in-process)

1. **Attachment size regression** — construct a maximally-full Agent (256-byte description, 30 subscribed topics, full identity attestation). Serialize. Assert size < 1.9 KB. Fail the build if it grows.

2. **Schema version round-trip** — serialize v1, deserialize v1, verify. Later: serialize v1, deserialize v2 (with migration), verify.

3. **Rehydration correctness** — create a `RelayCore`, register agents, subscribe to topics, put resources. Serialize everything (to a mock storage and mock attachments). Build a fresh `RelayCore`. Call `loadSnapshot` with the stored topics/resources, call `rehydrateAgent` for each ws attachment. Assert the new state matches the original.

### Integration tests

1. **Hibernation smoke test** — deploys the relay, connects a client, sends a message (verifies it works), waits for hibernation (or forces via wrangler), sends another message (verifies state survived). Realistically this lives as a manual script run against the deployed relay since forcing hibernation locally is hard.

2. **Existing smoke tests against deployed hibernation-enabled relay** — all six smoke tests (smoke, topic, cap, identity, mcp, resource, rate-limit) should pass against `wss://relay.openroom.channel` after the hibernation refactor lands. If any fail, the refactor is wrong.

### Chaos tests (later)

1. Kill a DO mid-handler (via a deliberate exception) and verify the next handler call recovers cleanly
2. Inject storage errors and verify retry + graceful degradation

---

## What's NOT in this architecture and why

- **R2 for content** — premature given our 1 MiB resource cap and typical resource sizes measured in KB. Listed as an extension path; implement when content routinely exceeds ~10 MB.
- **Persistent message history** — contrary to the ephemeral-by-design protocol philosophy. If we want it, it should be a room type choice, not a relay default.
- **Cross-DO queries** — DOs are isolated by design. Anything cross-room goes to a separate indexing service.
- **CRDT merge semantics on resources** — last-writer-wins is simple and correct for single-writer workflows. CRDTs have real footguns.
- **Hibernation of the replay dedup window** — see failure mode #9. Accept the bounded loss.

---

## If you're changing hibernation-related code

Before you commit, verify:

- [ ] The attachment size unit test still passes
- [ ] A round-trip test covering your change exists
- [ ] The `event` strings in your log lines are in the table above (or add them)
- [ ] You haven't disabled input gates
- [ ] All six existing smoke tests pass locally
- [ ] At least one smoke test (ideally the resource one) still passes against the deployed relay after deploy
