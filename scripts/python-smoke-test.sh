#!/usr/bin/env bash
# Cross-language smoke test for the Python SDK.
#
# Asserts that:
#   1. A Python agent can join a room on the Node reference relay and
#      send a message whose signature the JS-side listener verifies.
#   2. A JS agent sending through the CLI produces a message whose
#      signature the Python listener verifies.
#
# Both halves route through the same reference relay we already use for
# every other smoke test, and both halves use the full signed envelope
# path (JCS → Ed25519 → base64url). If either direction fails, the wire
# format has diverged between the two SDKs.

set -euo pipefail

PORT="${PORT:-19977}"
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PYSDK_DIR="$ROOT_DIR/packages/python-sdk"
LOG_DIR="$(mktemp -d)"
RELAY_LOG="$LOG_DIR/relay.log"
LISTENER_LOG="$LOG_DIR/listener.log"
RELAY_URL="ws://localhost:$PORT"

cleanup() {
    local status=$?
    [[ -n "${LISTENER_PID:-}" ]] && kill "$LISTENER_PID" 2>/dev/null || true
    [[ -n "${RELAY_PID:-}" ]] && kill "$RELAY_PID" 2>/dev/null || true
    wait 2>/dev/null || true
    if [[ $status -ne 0 ]]; then
        echo "--- relay log ---" >&2
        cat "$RELAY_LOG" >&2 2>/dev/null || true
        echo "--- listener log ---" >&2
        cat "$LISTENER_LOG" >&2 2>/dev/null || true
    fi
    rm -rf "$LOG_DIR"
    exit $status
}
trap cleanup EXIT

cd "$ROOT_DIR"

# Ensure the Python venv exists and has the SDK installed. Idempotent.
if [[ ! -x "$PYSDK_DIR/.venv/bin/python" ]]; then
    echo "creating python venv at $PYSDK_DIR/.venv" >&2
    python3 -m venv "$PYSDK_DIR/.venv"
    "$PYSDK_DIR/.venv/bin/pip" install -q -e "$PYSDK_DIR[dev]"
fi
PY="$PYSDK_DIR/.venv/bin/python"

PORT="$PORT" pnpm --filter openroom-relay dev > "$RELAY_LOG" 2>&1 &
RELAY_PID=$!
sleep 1

ROOM_1="py-to-js-$(date +%s)-$RANDOM"
ROOM_2="js-to-py-$(date +%s)-$RANDOM"
BODY_1="hello from python sdk"
BODY_2="hello from js sdk"

# ---- Direction 1: Python sends, JS listener verifies ----
echo "direction 1: python sender → js listener ($ROOM_1)"

(pnpm --filter openroom exec tsx scripts/py-compat-listener.ts \
    "$RELAY_URL" "$ROOM_1" "$BODY_1" > "$LISTENER_LOG" 2>&1) &
LISTENER_PID=$!
sleep 1  # let the JS listener join before the Python sender fires

"$PY" "$PYSDK_DIR/scripts/sender_demo.py" \
    "$RELAY_URL" "$ROOM_1" "$BODY_1"

wait "$LISTENER_PID"
unset LISTENER_PID

if ! grep -q "^ok$" "$LISTENER_LOG"; then
    echo "FAIL direction 1: js listener did not acknowledge" >&2
    exit 1
fi
echo "ok direction 1"

# ---- Direction 2: JS sends, Python listener verifies ----
echo "direction 2: js sender → python listener ($ROOM_2)"

("$PY" "$PYSDK_DIR/scripts/listener_demo.py" \
    "$RELAY_URL" "$ROOM_2" "$BODY_2" > "$LISTENER_LOG" 2>&1) &
LISTENER_PID=$!
sleep 1

pnpm --filter openroom exec tsx scripts/py-compat-sender.ts \
    "$RELAY_URL" "$ROOM_2" "$BODY_2"

wait "$LISTENER_PID"
unset LISTENER_PID

if ! grep -q "^ok$" "$LISTENER_LOG"; then
    echo "FAIL direction 2: python listener did not acknowledge" >&2
    exit 1
fi
echo "ok direction 2"

echo "PASS: python cross-language smoke test"
