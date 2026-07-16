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

# GUI applets launch with a bare PATH; node (which next needs, and which the
# prefs seeding below uses) typically lives in one of these.
PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"

# If the app window is already open (a Chrome process using our dedicated
# profile), bring it to the front instead of spawning a second window.
# Without this, relaunching the .app opened a duplicate/blank Chrome window.
EXISTING_WINDOW_PID=""
for pid in $(pgrep -f -- "--user-data-dir=$PROFILE" 2>/dev/null); do
  if osascript -e "tell application \"System Events\" to set frontmost of (first process whose unix id is $pid) to true" > /dev/null 2>&1; then
    EXISTING_WINDOW_PID="$pid"
    break
  fi
done

# Only short-circuit when the server is actually serving — if it crashed while
# the window stayed open, fall through and restart it before returning.
if [ -n "$EXISTING_WINDOW_PID" ] && curl -s -o /dev/null --max-time 2 "$URL"; then
  exit 0
fi

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

# Window already open (server was down and got restarted above): nudge it off
# the error page with a Cmd+R to the focused window — best-effort, since
# keystrokes need Accessibility permission the user may not have granted.
# Then stay alive only to shut down the server we just started once that
# window closes; never open a second window.
if [ -n "$EXISTING_WINDOW_PID" ]; then
  osascript -e "tell application \"System Events\" to tell (first process whose unix id is $EXISTING_WINDOW_PID)" \
            -e "set frontmost to true" \
            -e "keystroke \"r\" using command down" \
            -e "end tell" > /dev/null 2>&1 || true
  if [ "$STARTED_BY_US" = "1" ]; then
    while kill -0 "$EXISTING_WINDOW_PID" 2>/dev/null; do sleep 5; done
    kill -- "-$SERVER_PID" 2>/dev/null || kill "$SERVER_PID" 2>/dev/null
  fi
  exit 0
fi

if [ -x "$CHROME" ]; then
  # Point the profile's startup/homepage at the app URL. The app-mode Chrome
  # shows up in the Dock as "Google Chrome"; clicking that icon makes Chrome
  # think it has no browser windows and open a fresh one — these prefs make
  # that window load career-ops instead of a blank new-tab page.
  # node is on PATH by now (prepended above; the server itself needs it too).
  # Missing profile file = fresh profile (fine); any other read/parse error
  # aborts without touching the profile. Write via tmp+rename so a crash can't
  # leave Preferences half-written.
  node -e '
    const fs = require("fs"), path = require("path");
    const [p, url] = process.argv.slice(1);
    let j = {};
    try {
      j = JSON.parse(fs.readFileSync(p, "utf8"));
    } catch (e) {
      if (e.code !== "ENOENT") { console.error("prefs unreadable, not seeding:", e.message); process.exit(1); }
    }
    j.session = { ...(j.session || {}), restore_on_startup: 4, startup_urls: [url] };
    j.homepage = url;
    j.homepage_is_newtabpage = false;
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const tmp = p + ".career-ops-tmp";
    try {
      fs.writeFileSync(tmp, JSON.stringify(j));
      fs.renameSync(tmp, p);
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch {}
      throw e;
    }
  ' "$PROFILE/Default/Preferences" "$URL" || echo "career-ops: prefs seeding failed (window still works; dock-click may show a blank tab)" >&2
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
