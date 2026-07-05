#!/usr/bin/env bash
# gen-favicon.sh — regenerate the Aztec-diamond favicon (SVG + PNG).
#
# 1. gen-favicon.ts draws AD(n) from the demo's own shuffle code → favicon.svg
#    (transparent, one <rect> per domino).
# 2. Launch a private headless Chrome with a debug port and rasterize that SVG
#    to favicon.png over CDP with a transparent page background (rasterize-cdp.mjs)
#    — the "screenshot with no background". The diamond's square corners stay clear.
#
# Usage: scripts/gen-favicon.sh [seed] [order] [png-size]
set -euo pipefail
cd "$(dirname "$0")/.."

SEED="${1:-7}"
ORDER="${2:-10}"
SIZE="${3:-512}"

# Locate a Chrome binary: prefer the project's managed Chrome for Testing,
# fall back to a system Google Chrome.
CHROME=""
for c in \
  "$HOME"/.cache/aiui/chrome/chrome/*/chrome-mac-arm64/"Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing" \
  "$HOME"/.cache/aiui/chrome/chrome/*/chrome-linux64/chrome \
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  "$(command -v google-chrome || true)" \
  "$(command -v chromium || true)"; do
  if [[ -n "$c" && -x "$c" ]]; then CHROME="$c"; break; fi
done
[[ -n "$CHROME" ]] || { echo "gen-favicon: no Chrome binary found" >&2; exit 1; }

pnpm exec tsx scripts/gen-favicon.ts "$SEED" "$ORDER"

# Private headless browser with an ephemeral profile + auto-assigned debug port.
PROFILE="$(mktemp -d)"
"$CHROME" --headless=new --disable-gpu --no-first-run --no-default-browser-check \
  --user-data-dir="$PROFILE" --remote-debugging-port=0 about:blank \
  >/dev/null 2>&1 &
CHROME_PID=$!
cleanup() {
  kill "$CHROME_PID" 2>/dev/null || true
  wait "$CHROME_PID" 2>/dev/null || true # let Chrome release the profile first
  rm -rf "$PROFILE"
}
trap cleanup EXIT

# Wait for Chrome to publish its port (line 1 of DevToolsActivePort).
PORT=""
for _ in $(seq 1 50); do
  if [[ -f "$PROFILE/DevToolsActivePort" ]]; then
    PORT="$(head -1 "$PROFILE/DevToolsActivePort")"
    [[ -n "$PORT" ]] && break
  fi
  sleep 0.2
done
[[ -n "$PORT" ]] || { echo "gen-favicon: Chrome never opened a debug port" >&2; exit 1; }

node scripts/rasterize-cdp.mjs "$PORT" "file://$PWD/public/favicon.svg" \
  "$PWD/public/favicon.png" "$SIZE"
