#!/usr/bin/env bash
# Resource protocol smoke test.
#
# Runs packages/cli/scripts/resource-demo.ts, which exercises put/get/list/
# subscribe, CID-addressed reads, validation_hook enforcement, and
# resource_changed notifications for rotations.

set -euo pipefail

PORT="${PORT:-19900}"
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
    pnpm --filter openroom exec tsx scripts/resource-demo.ts

echo "PASS: resource protocol smoke test"
