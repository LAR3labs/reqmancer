#!/bin/bash
# Launched by Career-Ops Web.app — starts the local web UI, shows it in an
# app-style window, and shuts the server down when the window is closed.
# Portable: derives its location instead of hardcoding a path, so the repo
# can live anywhere (and the script survives moves/renames/other machines).
WEB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT=3000
URL="http://localhost:$PORT"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
PROFILE="$HOME/.career-ops-web-window"   # separate profile so the window is its own process

cd "$WEB_DIR" || exit 1

STARTED_BY_US=0
if ! curl -s -o /dev/null --max-time 2 "$URL"; then
  ./node_modules/.bin/next dev > /tmp/career-ops-web.log 2>&1 &
  SERVER_PID=$!
  STARTED_BY_US=1
  for i in $(seq 1 45); do
    sleep 2
    curl -s -o /dev/null --max-time 2 "$URL" && break
  done
fi

if [ -x "$CHROME" ]; then
  # Blocks until the app window is closed
  "$CHROME" --app="$URL" --user-data-dir="$PROFILE" --no-first-run --no-default-browser-check > /dev/null 2>&1
  if [ "$STARTED_BY_US" = "1" ]; then
    kill "$SERVER_PID" 2>/dev/null
    # Match the dev server by its actual path (portable — no hardcoded
    # parent-directory name), and only ours, not other next dev servers.
    pkill -f "$WEB_DIR/node_modules/.bin/next" 2>/dev/null
  fi
else
  # No Chrome: plain browser tab; server keeps running (no way to detect close)
  open "$URL"
fi
