#!/usr/bin/env bash
# Viewer-mode smoke test.
#
# Runs packages/cli/scripts/viewer-demo.ts which spins up a viewer-flagged
# client alongside a normal participant and asserts that:
#   * the viewer shows up in agents with viewer:true
#   * the viewer still receives broadcast messages (read access works)
#   * the viewer cannot send, DM, create topics, or write resources
#
# This is the behavioral contract the openroom.channel browser viewer
# depends on: watching is always allowed, participating is not.

set -euo pipefail

PORT="${PORT:-19976}"
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
    pnpm --filter openroom exec tsx scripts/viewer-demo.ts

echo "PASS: viewer-mode smoke test"
