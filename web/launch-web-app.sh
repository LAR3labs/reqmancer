#!/bin/bash
# Launched by Career-Ops Web.app — starts the local web UI, shows it in an
# app-style window, and shuts the server down when the window is closed.
# Portable: derives its location instead of hardcoding a path, so the repo
# can live anywhere (and the script survives moves/renames/other machines).
#
# NOTE: superseded by the native wrapper (web/desktop/) on macOS; kept as the
# fallback path for setups without Xcode Command Line Tools.
WEB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT=3000
URL="http://localhost:$PORT"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
PROFILE="$HOME/.career-ops-web-window"   # separate profile so the window is its own process
LOCK="$PROFILE.launch-lock"

cd "$WEB_DIR" || exit 1

# GUI applets launch with a bare PATH; node (which next needs, and which the
# prefs seeding below uses) typically lives in one of these.
PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"

# ── helpers ──────────────────────────────────────────────────────────────────

# Find the PID of the main browser process owning our profile's window.
# Literal substring matching (awk index), not regex — the profile path may
# contain metacharacters — and a boundary check so a sibling profile whose
# path merely starts with ours can't match. Helpers ("…Google Chrome Helper
# --type=…") are excluded by anchoring on the main binary's "Chrome --".
window_pid() {
  ps -axo pid=,command= | awk -v prof="--user-data-dir=$PROFILE" '
    index($0, "MacOS/Google Chrome --") > 0 {
      i = index($0, prof)
      if (i > 0) {
        rest = substr($0, i + length(prof), 1)
        if (rest == "" || rest == " ") { print $1; exit }
      }
    }'
}

focus_window() { # $1 = pid; best-effort (needs Automation permission)
  osascript -e "tell application \"System Events\" to set frontmost of (first process whose unix id is $1) to true" > /dev/null 2>&1 || true
}

healthy() { # only a 2xx counts — a 404/500 or foreign service must not pass
  curl -fsS -o /dev/null --max-time 2 "$URL" 2>/dev/null
}

# ── single-flight lock (the window/server checks + launch are a TOCTOU race
#    for two rapid invocations; mkdir is the atomic primitive) ────────────────
acquire_lock() {
  while ! mkdir "$LOCK" 2>/dev/null; do
    local owner
    owner="$(cat "$LOCK/pid" 2>/dev/null)"
    if [ -n "$owner" ] && kill -0 "$owner" 2>/dev/null; then
      return 1  # live launcher already owns this profile
    fi
    rm -rf "$LOCK"  # stale (crashed owner) — reclaim and retry
  done
  echo $$ > "$LOCK/pid"
  return 0
}

if ! acquire_lock; then
  # Another launcher is alive: the window is either open or about to appear.
  # Just bring it forward if it exists; never start a second server/window.
  pid="$(window_pid)"
  [ -n "$pid" ] && focus_window "$pid"
  exit 0
fi

# ── cleanup: idempotent, runs on every exit path ─────────────────────────────
STARTED_BY_US=0
KEEP_SERVER=0   # fallback browser path can't detect window close → leave server up
SERVER_PID=""
CLEANED=0
cleanup() {
  [ "$CLEANED" = "1" ] && return
  CLEANED=1
  if [ "$STARTED_BY_US" = "1" ] && [ "$KEEP_SERVER" != "1" ] && [ -n "$SERVER_PID" ]; then
    # negative PID = the process group we created via set -m
    kill -- "-$SERVER_PID" 2>/dev/null || kill "$SERVER_PID" 2>/dev/null
  fi
  rm -rf "$LOCK"
}
trap cleanup EXIT INT TERM

# If the app window is already open AND the server is healthy, just focus it.
# A crashed server behind an open window falls through and gets restarted.
EXISTING_WINDOW_PID="$(window_pid)"
if [ -n "$EXISTING_WINDOW_PID" ]; then
  focus_window "$EXISTING_WINDOW_PID"
  if healthy; then
    exit 0
  fi
fi

if ! healthy; then
  # Job control on: the background server becomes its own process-group
  # leader, so cleanup can kill exactly its tree (next + children) and
  # nothing else — no pkill pattern matching.
  set -m
  ./start-server.sh > /tmp/career-ops-web.log 2>&1 &
  SERVER_PID=$!
  set +m
  STARTED_BY_US=1
  READY=0
  for i in $(seq 1 45); do
    sleep 2
    if healthy; then READY=1; break; fi
  done
  # Fail closed: a window pointing at a dead server helps nobody — the trap
  # cleans up the process group we spawned.
  if [ "$READY" != "1" ]; then
    echo "career-ops: server did not become ready — see /tmp/career-ops-web.log" >&2
    exit 1
  fi
fi

# Window already open (server was down and got restarted above): nudge it off
# the error page with a Cmd+R to the focused window — best-effort, since
# keystrokes need Accessibility permission the user may not have granted.
# Then stay alive only to shut down the server we just started once that
# window closes (via the trap); never open a second window.
if [ -n "$EXISTING_WINDOW_PID" ]; then
  osascript -e "tell application \"System Events\" to tell (first process whose unix id is $EXISTING_WINDOW_PID)" \
            -e "set frontmost to true" \
            -e "keystroke \"r\" using command down" \
            -e "end tell" > /dev/null 2>&1 || true
  if [ "$STARTED_BY_US" = "1" ]; then
    while kill -0 "$EXISTING_WINDOW_PID" 2>/dev/null; do sleep 5; done
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
  # or unexpected JSON shape aborts without touching the profile. Write via
  # per-invocation tmp+rename so a crash can't leave Preferences half-written.
  node -e '
    const fs = require("fs"), path = require("path");
    const [p, url] = process.argv.slice(1);
    let j = {};
    try {
      j = JSON.parse(fs.readFileSync(p, "utf8"));
    } catch (e) {
      if (e.code !== "ENOENT") { console.error("prefs unreadable, not seeding:", e.message); process.exit(1); }
    }
    if (j === null || typeof j !== "object" || Array.isArray(j)) {
      console.error("prefs has unexpected JSON shape, not seeding");
      process.exit(1);
    }
    if (j.session != null && (typeof j.session !== "object" || Array.isArray(j.session))) {
      console.error("prefs session has unexpected JSON shape, not seeding");
      process.exit(1);
    }
    j.session = { ...(j.session || {}), restore_on_startup: 4, startup_urls: [url] };
    j.homepage = url;
    j.homepage_is_newtabpage = false;
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const tmp = `${p}.${process.pid}.career-ops-tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(j));
      fs.renameSync(tmp, p);
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch {}
      throw e;
    }
  ' "$PROFILE/Default/Preferences" "$URL" || echo "career-ops: prefs seeding failed (window still works; dock-click may show a blank tab)" >&2

  # Blocks until the app window is closed; the trap then stops the server we
  # started (and releases the lock).
  "$CHROME" --app="$URL" --user-data-dir="$PROFILE" --no-first-run --no-default-browser-check > /dev/null 2>&1
else
  # No Chrome: plain browser tab; server keeps running (no way to detect close)
  KEEP_SERVER=1
  open "$URL"
fi
