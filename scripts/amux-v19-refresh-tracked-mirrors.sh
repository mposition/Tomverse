#!/usr/bin/env bash
# Fetch every v19 tracked mirror (<root>/<owner>/<repo>) before a cycle can
# claim budget. Read-only toward the working tree: only remote-tracking refs
# and objects change. Runs as the runner account with its own Git
# credential; the sandboxed CLI never sees it. Any failure stops the cycle.
set -euo pipefail
root=${TOMVERSE_AMUX_V19_TRACKED_REPOSITORY_ROOT:?}
case "$root" in /*) ;; *) exit 2 ;; esac
test -d "$root" && test ! -L "$root"
shopt -s nullglob
count=0
for git_dir in "$root"/*/*/.git; do
  repo=${git_dir%/.git}
  test ! -L "$repo" && test ! -L "$git_dir"
  timeout 120 /usr/bin/git -C "$repo" -c core.hooksPath=/dev/null \
    fetch --quiet --prune --no-tags origin
  count=$((count + 1))
done
test "$count" -gt 0
