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

# If the app window is already open (a Chrome process using our dedicated
# profile), just bring it to the front instead of spawning a second window.
# Without this, relaunching the .app opened a duplicate/blank Chrome window.
for pid in $(pgrep -f -- "--user-data-dir=$PROFILE" 2>/dev/null); do
  if osascript -e "tell application \"System Events\" to set frontmost of (first process whose unix id is $pid) to true" > /dev/null 2>&1; then
    exit 0
  fi
done

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
  # Point the profile's startup/homepage at the app URL. The app-mode Chrome
  # shows up in the Dock as "Google Chrome"; clicking that icon makes Chrome
  # think it has no browser windows and open a fresh one — these prefs make
  # that window load career-ops instead of a blank new-tab page.
  if command -v node > /dev/null 2>&1; then
    node -e '
      const fs = require("fs"), path = require("path");
      const [p, url] = process.argv.slice(1);
      let j = {};
      try { j = JSON.parse(fs.readFileSync(p, "utf8")); } catch {}
      j.session = { ...(j.session || {}), restore_on_startup: 4, startup_urls: [url] };
      j.homepage = url;
      j.homepage_is_newtabpage = false;
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, JSON.stringify(j));
    ' "$PROFILE/Default/Preferences" "$URL" 2>/dev/null
  fi
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
