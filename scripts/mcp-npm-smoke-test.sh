#!/usr/bin/env bash
# MCP adapter smoke test against the published npm package.
#
# Installs whatever version of `openroom` is currently on npm into a
# tmp directory, spins up a local relay, and runs mcp-adapter-demo.ts
# with OPENROOM_MCP_SERVER_CMD pointing at the installed binary so the
# demo spawns the published artifact (not the workspace source) as the
# MCP server subprocess. Validates the full Claude-integration flow —
# tools/list, tools/call send_message, inbound message notifications —
# against exactly what users get when they `npm install openroom`.
#
# If this passes, `openroom claude <room>` is shippable.

set -euo pipefail

PORT="${PORT:-19979}"
NPM_VERSION="${NPM_VERSION:-latest}"
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LOG_DIR="$(mktemp -d)"
RELAY_LOG="$LOG_DIR/relay.log"
INSTALL_DIR="$LOG_DIR/install"

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

# Install the published artifact into an isolated npm project so the
# workspace's node_modules can't shadow it.
mkdir -p "$INSTALL_DIR"
(cd "$INSTALL_DIR" && npm init -y > /dev/null && npm install --silent "openroom@$NPM_VERSION")

INSTALLED_BIN="$INSTALL_DIR/node_modules/.bin/openroom"
if [[ ! -x "$INSTALLED_BIN" ]]; then
    echo "FAIL: installed openroom binary not found at $INSTALLED_BIN" >&2
    exit 1
fi

INSTALLED_VERSION="$("$INSTALLED_BIN" --version 2>/dev/null || echo "unknown")"
echo "installed openroom at $INSTALLED_BIN (version: $INSTALLED_VERSION)"

PORT="$PORT" pnpm --filter openroom-relay dev > "$RELAY_LOG" 2>&1 &
RELAY_PID=$!
sleep 1

OPENROOM_RELAY="ws://localhost:$PORT" \
OPENROOM_MCP_SERVER_CMD="$INSTALLED_BIN" \
    pnpm --filter openroom exec tsx scripts/mcp-adapter-demo.ts

echo "PASS: mcp npm smoke test (against openroom@$NPM_VERSION)"
