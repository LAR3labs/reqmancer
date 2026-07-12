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
  # Job control on: the background server becomes its own process-group
  # leader, so cleanup can kill exactly its tree (next + children) and
  # nothing else — no pkill pattern matching.
  set -m
  ./node_modules/.bin/next dev > /tmp/career-ops-web.log 2>&1 &
  SERVER_PID=$!
  set +m
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
    # Kill the whole process group we started (negative PID = PGID thanks
    # to set -m above); fall back to the single PID if that fails.
    kill -- "-$SERVER_PID" 2>/dev/null || kill "$SERVER_PID" 2>/dev/null
  fi
else
  # No Chrome: plain browser tab; server keeps running (no way to detect close)
  open "$URL"
fi
