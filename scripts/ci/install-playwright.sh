#!/usr/bin/env bash
#
# Installs Playwright's system dependencies and browsers for CI.
#
# `npx playwright install --with-deps <browser>` does two unrelated things
# behind one command: an apt transaction against the distribution mirror, and a
# browser download from Playwright's CDN. Splitting them matters because only
# the second is covered by the `~/.cache/ms-playwright` cache every workflow
# already restores -- so a cache *hit* still paid the full apt cost on every
# run.
#
# On 2026-08-05 that cost was a red pull request. The mobile-chromium shard of
# PR Fast Gate spent its whole ten-minute step budget inside apt, fetching font
# packages from azure.archive.ubuntu.com at a few tens of kB/s
# (`fonts-freefont-ttf` 2m43s, `fonts-wqy-zenhei` 3m30s), hit the step timeout
# and uploaded an empty `test-results`. No test ever started. The
# desktop-chromium shard of the same commit passed, having drawn a healthy
# mirror minute.
#
# Neither half retries on its own: Playwright runs apt once, and a step timeout
# kills the job rather than trying again. Both halves are retried here, and apt
# is additionally configured to retry an individual stalled download so one bad
# package does not cost a whole attempt.
#
# The fonts are not optional, which is why the fix is retries rather than
# dropping `--with-deps`. They are what renders CJK text in the UI, and this
# repository pins both a typography contract and screenshot baselines -- a
# browser missing them would not fail loudly, it would quietly change what the
# baselines mean.
#
# Usage:
#   scripts/ci/install-playwright.sh            # chromium
#   scripts/ci/install-playwright.sh chromium webkit
set -uo pipefail

BROWSERS=("$@")
if [ "${#BROWSERS[@]}" -eq 0 ]; then
  BROWSERS=(chromium)
fi

ATTEMPTS="${PLAYWRIGHT_INSTALL_ATTEMPTS:-3}"

# Each attempt is bounded well inside the step's own timeout, which is the
# difference between a retry that can happen and one that cannot: the run that
# prompted this script spent its entire budget inside a single attempt, so
# there was nothing left to retry with. A healthy install-deps takes well under
# a minute, so five is generous rather than tight.
#
# Abandoning a slow download is not throwing the work away -- apt keeps partial
# files in /var/cache/apt/archives/partial and resumes them, so the next
# attempt starts from where the last one stopped.
#
# Worst case is 3 attempts plus 30s and 60s of backoff per half, and the step
# timeouts in the workflows are set above that so an exhausted retry loop
# reports which half failed instead of dying as a bare step timeout.
ATTEMPT_TIMEOUT="${PLAYWRIGHT_INSTALL_ATTEMPT_TIMEOUT:-300}"

# Backoff, not a tight loop: the failure being retried is a mirror or CDN
# having a bad minute, and asking again immediately mostly asks the same bad
# minute.
retry() {
  local label="$1"
  shift
  local attempt=1
  while true; do
    if timeout --signal=TERM --kill-after=30s "$ATTEMPT_TIMEOUT" "$@"; then
      return 0
    fi
    if [ "$attempt" -ge "$ATTEMPTS" ]; then
      echo "::error::${label} failed after ${attempt} attempt(s)."
      return 1
    fi
    local delay=$((attempt * 30))
    echo "::warning::${label} failed (attempt ${attempt}/${ATTEMPTS}). Retrying in ${delay}s."
    sleep "$delay"
    attempt=$((attempt + 1))
  done
}

# Applies to the apt-get calls Playwright makes for us, which is the only way
# to reach them -- `install-deps` takes no apt flags. Written before the first
# attempt so even a single-attempt run benefits.
if [ -d /etc/apt/apt.conf.d ]; then
  printf 'Acquire::Retries "3";\nAcquire::http::Timeout "30";\n' |
    sudo tee /etc/apt/apt.conf.d/99-tomverse-ci-retries >/dev/null ||
    echo "::warning::Could not write apt retry config; continuing without it."
fi

retry "playwright install-deps" npx playwright install-deps "${BROWSERS[@]}" || exit 1
# Second, and separately: on a cache hit this is a no-op that costs a second,
# which is the whole reason the two are not one command.
retry "playwright install" npx playwright install "${BROWSERS[@]}" || exit 1

echo "Playwright ready: ${BROWSERS[*]}"
