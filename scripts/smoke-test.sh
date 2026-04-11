#!/usr/bin/env bash
# End-to-end smoke test for Milestone 1:
# starts a local relay, a listener, and a sender, and verifies the
# listener received the message and saw the sender join and leave.

set -euo pipefail

PORT="${PORT:-18787}"
ROOM="smoke-test-room-$$"
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LOG_DIR="$(mktemp -d)"
RELAY_LOG="$LOG_DIR/relay.log"
LISTEN_LOG="$LOG_DIR/listen.log"

cleanup() {
    local status=$?
    [[ -n "${LISTEN_PID:-}" ]] && kill "$LISTEN_PID" 2>/dev/null || true
    [[ -n "${RELAY_PID:-}" ]] && kill "$RELAY_PID" 2>/dev/null || true
    wait 2>/dev/null || true
    if [[ $status -ne 0 ]]; then
        echo "--- relay log ---" >&2
        cat "$RELAY_LOG" >&2 2>/dev/null || true
        echo "--- listener log ---" >&2
        cat "$LISTEN_LOG" >&2 2>/dev/null || true
    fi
    rm -rf "$LOG_DIR"
    exit $status
}
trap cleanup EXIT

cd "$ROOT_DIR"

PORT="$PORT" pnpm --filter openroom-relay dev > "$RELAY_LOG" 2>&1 &
RELAY_PID=$!
sleep 1

OPENROOM_RELAY="ws://localhost:$PORT" \
    pnpm --filter openroom dev listen "$ROOM" --no-identity > "$LISTEN_LOG" 2>&1 &
LISTEN_PID=$!
sleep 1

OPENROOM_RELAY="ws://localhost:$PORT" OPENROOM_NAME=smoke-sender \
    pnpm --filter openroom dev send "$ROOM" "hello from sender" --no-identity \
    > /dev/null

sleep 1
kill "$LISTEN_PID" 2>/dev/null || true
wait "$LISTEN_PID" 2>/dev/null || true

# Expectations on the listener log. Grep patterns match the fmt.ts
# CLI output — pubkey hex + #topic + body for messages, and "N agents
# in room" for membership events.
grep -qE "#main hello from sender" "$LISTEN_LOG" \
    || { echo "FAIL: listener did not receive the message" >&2; exit 1; }
grep -qE "2 agents? in room" "$LISTEN_LOG" \
    || { echo "FAIL: listener did not see sender join" >&2; exit 1; }
grep -qE "1 agents? in room" "$LISTEN_LOG" \
    || { echo "FAIL: listener did not see sender leave" >&2; exit 1; }

echo "PASS: milestone 1 end-to-end smoke test"
