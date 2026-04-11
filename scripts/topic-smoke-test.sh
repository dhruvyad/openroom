#!/usr/bin/env bash
# Topic isolation smoke test:
# - Listener A subscribes to topic 'decisions' (unsubscribing from main).
# - Listener B subscribes to topic 'proposals' (unsubscribing from main).
# - Listener C stays on 'main'.
# - Sender posts one message to each of decisions, proposals, and main.
# Expectations:
# - A sees only 'decisions', not 'proposals', not 'main'.
# - B sees only 'proposals', not 'decisions', not 'main'.
# - C sees only 'main', not 'decisions', not 'proposals'.

set -euo pipefail

PORT="${PORT:-18788}"
ROOM="topic-smoke-test-$$"
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LOG_DIR="$(mktemp -d)"
RELAY_LOG="$LOG_DIR/relay.log"
A_LOG="$LOG_DIR/listen-a.log"
B_LOG="$LOG_DIR/listen-b.log"
C_LOG="$LOG_DIR/listen-c.log"

cleanup() {
    local status=$?
    for pid in "${A_PID:-}" "${B_PID:-}" "${C_PID:-}" "${RELAY_PID:-}"; do
        [[ -n "$pid" ]] && kill "$pid" 2>/dev/null || true
    done
    wait 2>/dev/null || true
    if [[ $status -ne 0 ]]; then
        echo "--- relay log ---" >&2
        cat "$RELAY_LOG" >&2 2>/dev/null || true
        echo "--- listener A (decisions) log ---" >&2
        cat "$A_LOG" >&2 2>/dev/null || true
        echo "--- listener B (proposals) log ---" >&2
        cat "$B_LOG" >&2 2>/dev/null || true
        echo "--- listener C (main) log ---" >&2
        cat "$C_LOG" >&2 2>/dev/null || true
    fi
    rm -rf "$LOG_DIR"
    exit $status
}
trap cleanup EXIT

cd "$ROOT_DIR"

PORT="$PORT" pnpm --filter openroom-relay dev > "$RELAY_LOG" 2>&1 &
RELAY_PID=$!
sleep 1

OPENROOM_RELAY="ws://localhost:$PORT" OPENROOM_NAME=listen-a \
    pnpm --filter openroom dev listen "$ROOM" --topic decisions --no-identity > "$A_LOG" 2>&1 &
A_PID=$!

OPENROOM_RELAY="ws://localhost:$PORT" OPENROOM_NAME=listen-b \
    pnpm --filter openroom dev listen "$ROOM" --topic proposals --no-identity > "$B_LOG" 2>&1 &
B_PID=$!

OPENROOM_RELAY="ws://localhost:$PORT" OPENROOM_NAME=listen-c \
    pnpm --filter openroom dev listen "$ROOM" --no-identity > "$C_LOG" 2>&1 &
C_PID=$!

sleep 2

for topic in decisions proposals main; do
    flag=""
    [[ "$topic" != "main" ]] && flag="--topic $topic"
    OPENROOM_RELAY="ws://localhost:$PORT" OPENROOM_NAME=sender \
        pnpm --filter openroom dev send "$ROOM" "hello-$topic" $flag --no-identity > /dev/null
    sleep 0.5
done

sleep 1
kill "$A_PID" "$B_PID" "$C_PID" 2>/dev/null || true
wait "$A_PID" "$B_PID" "$C_PID" 2>/dev/null || true

assert_has() {
    local log="$1" pattern="$2" label="$3"
    if ! grep -q "$pattern" "$log"; then
        echo "FAIL: $label did not see $pattern" >&2
        exit 1
    fi
}

assert_not() {
    local log="$1" pattern="$2" label="$3"
    if grep -q "$pattern" "$log"; then
        echo "FAIL: $label unexpectedly saw $pattern" >&2
        exit 1
    fi
}

assert_has "$A_LOG" "#decisions hello-decisions" "listener A"
assert_not "$A_LOG" "#proposals hello-proposals" "listener A"
assert_not "$A_LOG" "#main hello-main" "listener A"

assert_has "$B_LOG" "#proposals hello-proposals" "listener B"
assert_not "$B_LOG" "#decisions hello-decisions" "listener B"
assert_not "$B_LOG" "#main hello-main" "listener B"

assert_has "$C_LOG" "#main hello-main" "listener C"
assert_not "$C_LOG" "#decisions hello-decisions" "listener C"
assert_not "$C_LOG" "#proposals hello-proposals" "listener C"

echo "PASS: topic isolation smoke test"
