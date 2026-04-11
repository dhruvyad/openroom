#!/usr/bin/env bash
# Directory smoke test.
#
# Runs packages/cli/scripts/directory-demo.ts against a live relay. The
# directory DurableObject only exists in the CF runtime, so this test
# does NOT spin up a Node dev server — it hits whichever relay URL is
# configured via OPENROOM_RELAY (defaults to wss://relay.openroom.channel).

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

: "${OPENROOM_RELAY:=wss://relay.openroom.channel}"
export OPENROOM_RELAY

pnpm --filter openroom exec tsx scripts/directory-demo.ts
echo "PASS: directory smoke test (relay=$OPENROOM_RELAY)"
