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
  # The app pins a repository that has develop at its develop head, so its
  # mirror carries that branch too. A remote without develop (ls-remote
  # exit 2) keeps the default branch only; any other failure stops the cycle.
  if timeout 60 /usr/bin/git -C "$repo" -c core.hooksPath=/dev/null \
      ls-remote --exit-code --heads origin refs/heads/develop >/dev/null; then
    timeout 120 /usr/bin/git -C "$repo" -c core.hooksPath=/dev/null \
      fetch --quiet --no-tags origin \
      "+refs/heads/develop:refs/remotes/origin/develop"
  else
    status=$?
    test "$status" -eq 2 || exit "$status"
  fi
  count=$((count + 1))
done
test "$count" -gt 0
