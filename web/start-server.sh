#!/bin/bash
# Career-Ops Web — server starter shared by the native wrapper (desktop/) and
# launch-web-app.sh. Serves the pre-built production bundle when it matches the
# current source (instant page loads, no dev-mode "compiling" pauses); when the
# source changed since the last build, falls back to `next dev` for this launch
# and rebuilds the production bundle in the background so the NEXT launch is
# fast again. All pages are force-dynamic, so the production server still reads
# the user's local data fresh on every request.
#
# exec-transparent: whichever server is chosen replaces this process, so a
# parent that kills our PID (Swift wrapper, launch script's process group)
# reaches the actual next server.
set -u
WEB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$WEB_DIR" || exit 1

PROD_DIST=".next-prod"
STAMP_FILE="$PROD_DIST/career-ops-source-stamp"
BUILD_LOG="/tmp/career-ops-web-build.log"
BUILD_LOCK="/tmp/career-ops-web-build.lock"

# Fingerprint everything that affects the built output. stat -f is macOS-only,
# which is fine: both launchers that call this script are macOS-only.
source_stamp() {
  {
    find src public -type f -print0 2>/dev/null | xargs -0 stat -f '%N %m %z' 2>/dev/null | sort
    stat -f '%N %m %z' package.json package-lock.json next.config.mjs postcss.config.mjs tsconfig.json 2>/dev/null
  } | shasum | cut -d' ' -f1
}

STAMP="$(source_stamp)"

background_rebuild() {
  # Single-flight: a second launch while a rebuild is running must not start a
  # competing build into the same dist dir. mkdir is the atomic primitive; a
  # stale lock (crashed builder) is reclaimed.
  if ! mkdir "$BUILD_LOCK" 2>/dev/null; then
    local owner
    owner="$(cat "$BUILD_LOCK/pid" 2>/dev/null)"
    if [ -n "$owner" ] && kill -0 "$owner" 2>/dev/null; then
      return 0
    fi
    rm -rf "$BUILD_LOCK"
    mkdir "$BUILD_LOCK" 2>/dev/null || return 0
  fi
  # Separate bash invocation (not a subshell): macOS ships bash 3.2, which has
  # no BASHPID — in a fresh process $$ is the worker's own PID. nohup detaches
  # it from this script, which is about to exec the dev server.
  # Stamp is written only after a successful build, so a crashed/killed build
  # leaves no stamp and the next launch rebuilds again.
  nohup bash -c '
    echo "$$" > "$1/pid"
    trap "rm -rf \"$1\"" EXIT
    rm -f "$2"
    if BUILD_DIST="$3" ./node_modules/.bin/next build > "$4" 2>&1; then
      echo "$5" > "$2"
      echo "career-ops: production bundle ready — next launch serves it instantly" >> "$4"
    fi
  ' build-worker "$BUILD_LOCK" "$STAMP_FILE" "$PROD_DIST" "$BUILD_LOG" "$STAMP" > /dev/null 2>&1 &
  disown 2>/dev/null || true
}

if [ -f "$PROD_DIST/BUILD_ID" ] && [ "$(cat "$STAMP_FILE" 2>/dev/null)" = "$STAMP" ]; then
  exec env BUILD_DIST="$PROD_DIST" ./node_modules/.bin/next start
fi

# No fresh production bundle: serve dev now, build for next time.
background_rebuild
exec ./node_modules/.bin/next dev
