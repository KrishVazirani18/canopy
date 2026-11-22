#!/bin/sh
# Canopy's update helper (run by src/core/app-update.mjs). It waits for Canopy to quit, moves the old Canopy.app
# aside, moves the new one into its place, and, when asked, opens it again. Both moves are renames, so there is never
# half an app where Canopy should be. The old app is kept until the new one has started: if the new one does not
# start, the old one is put back and opened instead.
#
#   sh app-update-swap.sh <pid> <target.app> <staged.app> <previous.app> <started.json> <result.json> <version> <relaunch: 0|1>
#
#   pid            the running Canopy: nothing is touched until it has gone
#   target.app     where Canopy is installed (/Applications/Canopy.app)
#   staged.app     the new Canopy, already unpacked and checked
#   previous.app   where the old one is kept until the new one has started
#   started.json   written by a Canopy that got as far as showing its window: {"version":"…",…}
#   result.json    what happened, for the next Canopy to read: {"ok":true|false,"version":"…","reason":"…"}.
#                  Written before the new Canopy is opened, so that Canopy itself can say it was updated; written
#                  again, as a failure, only when the old one has to be put back
#   relaunch       1: open the new Canopy and wait for it to start (Restart to update). 0: Canopy was quit, so the new
#                  one is only put in place; it confirms itself the next time it is opened.
#
# Everything it prints goes to updates/swap.log.
set -u

PID=$1; TARGET=$2; STAGED=$3; PREVIOUS=$4; STARTED=$5; RESULT=$6; VERSION=$7; RELAUNCH=$8

say() { printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"; }

# reason is always one of this script's own words, and the version was checked before it got here: both are safe in JSON.
result() {
  printf '{"ok":%s,"version":"%s","reason":"%s","at":%s}\n' "$1" "$VERSION" "$2" "$(date +%s)" > "$RESULT.tmp" && mv -f "$RESULT.tmp" "$RESULT"
}

# Through LaunchServices, like a double-click, so the new Canopy is its own app to macOS and not a child of this
# script. A copy under test keeps its settings (the CANOPY_* variables it was started with).
launch() {
  set -- -n "$TARGET"
  for name in $(env | sed -n 's/^\(CANOPY_[A-Z0-9_]*\)=.*/\1/p'); do
    eval "value=\${$name}"
    set -- "$@" --env "$name=$value"
  done
  /usr/bin/open "$@" --args --canopy-reopen
}

# The processes of the Canopy at the target path. Compared as plain text: a path is not a pattern.
running() {
  ps -axo pid=,command= | while read -r pid command; do
    case "$command" in "$TARGET/Contents/"*) echo "$pid" ;; esac
  done
}

rollback() {
  say "the new Canopy did not start ($1): putting the old one back"
  for pid in $(running); do kill -9 "$pid" 2>/dev/null; done
  sleep 1
  rm -rf "$TARGET.failed"
  if mv "$TARGET" "$TARGET.failed" && mv "$PREVIOUS" "$TARGET"; then
    rm -rf "$TARGET.failed"
    result false "$1"
    launch || say "the old Canopy could not be opened either"
  else
    say "could not put the old Canopy back: it is at $PREVIOUS"
    result false "$1"
  fi
  exit 0
}

say "update to $VERSION: waiting for Canopy (pid $PID) to quit"
waited=0
while kill -0 "$PID" 2>/dev/null; do
  waited=$((waited + 1))
  if [ "$waited" -gt 600 ]; then say "Canopy is still running after two minutes: nothing changed"; result false still-running; exit 0; fi
  sleep 0.2
done

if [ ! -d "$STAGED/Contents" ]; then say "nothing to install at $STAGED"; result false nothing-staged; exit 0; fi
if [ ! -d "$TARGET" ]; then say "Canopy is no longer at $TARGET: nothing changed"; result false moved; exit 0; fi

rm -rf "$PREVIOUS"
mkdir -p "$(dirname "$PREVIOUS")"
if ! mv "$TARGET" "$PREVIOUS"; then say "could not move the old Canopy aside: nothing changed"; result false not-allowed; exit 0; fi
if ! mv "$STAGED" "$TARGET"; then
  say "could not move the new Canopy into place: putting the old one back"
  mv "$PREVIOUS" "$TARGET"
  result false not-allowed
  [ "$RELAUNCH" = 1 ] && launch
  exit 0
fi
say "Canopy $VERSION is in place at $TARGET"
result true installed

if [ "$RELAUNCH" != 1 ]; then exit 0; fi

rm -f "$STARTED"
launch || rollback could-not-open

# Started means it wrote started.json with its own version (it does once its window is up). Ninety seconds at most;
# sooner when no process of it is left, which is a Canopy that quit or crashed on the way up.
waited=0; gone=0
while [ "$waited" -lt 450 ]; do
  if [ -f "$STARTED" ] && grep -q "\"version\":\"$VERSION\"" "$STARTED"; then
    say "Canopy $VERSION started"
    rm -rf "$PREVIOUS"
    exit 0
  fi
  if [ "$waited" -gt 50 ] && [ $((waited % 10)) -eq 0 ]; then
    if [ -z "$(running)" ]; then gone=$((gone + 1)); else gone=0; fi
    [ "$gone" -ge 3 ] && rollback quit-on-start
  fi
  waited=$((waited + 1))
  sleep 0.2
done
rollback did-not-start
