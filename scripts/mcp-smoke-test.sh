#!/usr/bin/env bash
# MCP adapter smoke test.
#
# Runs packages/cli/scripts/mcp-adapter-demo.ts, which boots the openroom
# MCP server as a subprocess, connects an MCP stdio client to it, exercises
# the exposed tools, and verifies that an inbound message from a peer is
# delivered both via list_recent_messages and via a notifications/openroom/
# channel notification.

set -euo pipefail

PORT="${PORT:-19800}"
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
    pnpm --filter openroom exec tsx scripts/mcp-adapter-demo.ts

echo "PASS: mcp adapter smoke test"
