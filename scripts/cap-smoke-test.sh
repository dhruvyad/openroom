#!/usr/bin/env bash
# Capability enforcement smoke test for the hierarchical room type.
#
# Runs packages/cli/scripts/cap-hierarchical-demo.ts against a fresh relay.
# The demo itself asserts: worker without caps cannot subscribe or post to
# gated topics, trusted agent with delegated caps can, master can use its
# own root cap, and nothing from a gated topic leaks to an uncapped worker.

set -euo pipefail

PORT="${PORT:-19200}"
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
    pnpm --filter openroom exec tsx scripts/cap-hierarchical-demo.ts

echo "PASS: capability enforcement smoke test"
