#!/usr/bin/env bash
# Direct message smoke test.
#
# Runs packages/cli/scripts/direct-demo.ts which exercises the room-wide
# broadcast semantics of direct messages: when A DMs B, the target receives
# it AND any observer in the same room receives it AND agents in OTHER
# rooms do not. This is load-bearing for openroom's observability pitch —
# hidden side-channels would defeat the whole point.

set -euo pipefail

PORT="${PORT:-19975}"
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LOG_DIR="$(mktemp -d)"
RELAY_LOG="$LOG_DIR/relay.log"

cleanup() {
    local status=$?
    [[ -n "${RELAY_PID:-}" ]] && kill "$RELAY_PID" 2>/dev/null || true
    wait 2>/dev/null || true
    if [[ $status -ne 0 ]]; then
        echo "--- relay log ---" >&2
        cat "$RELAY_LOG" >&2 2>/dev/null || true
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
    pnpm --filter openroom exec tsx scripts/direct-demo.ts

echo "PASS: direct message smoke test"
