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
# A retry also has to clean up after the attempt it is retrying. The apt half
# runs as root under Playwright's own sudo, so an unprivileged runner cannot
# signal it when the attempt times out; it keeps running and keeps the dpkg
# lock. Retrying straight into that lock is how the 2026-08-06 review-parity job
# reported three failures for one slow mirror -- see release_dpkg_lock below.
#
# Retries alone were still not enough, because a retry only helps a request that
# could have finished. On 2026-08-17 the daily security audit -- the only caller
# asking for WebKit, and so for four times the apt transaction -- needed thirteen
# minutes of download and was given three five-minute attempts, two of which also
# had their still-downloading predecessor killed underneath them. So the budget
# now follows the browsers asked for, waiting is measured as progress rather than
# wall clock, and both are bounded by one deadline per run.
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

# The browsers asked for decide the budget, because they are not the same size
# of apt transaction. Chromium's system dependencies are mostly already on the
# runner image; WebKit's pull the GStreamer and FFmpeg stacks behind them, and
# Firefox is closer to WebKit than to Chromium.
#
# On 2026-08-17 that difference was the daily security audit, the only workflow
# asking for `chromium webkit`: 181 new packages, 114 MB, against a mirror
# giving about 140 kB/s. That is thirteen minutes of download, so no number of
# five-minute attempts could ever have finished it -- three attempts fetched
# roughly half of it between them and the step reported a mirror failure for
# what was really a budget too small for the request.
HEAVY_BROWSERS=0
for browser in "${BROWSERS[@]}"; do
  case "$browser" in
    webkit | firefox) HEAVY_BROWSERS=1 ;;
  esac
done

# Each attempt is bounded well inside the step's own timeout, which is the
# difference between a retry that can happen and one that cannot: the run that
# prompted this script spent its entire budget inside a single attempt, so
# there was nothing left to retry with. A healthy install-deps takes well under
# a minute, so five is generous rather than tight for Chromium.
#
# Abandoning a slow download is not throwing the work away -- apt keeps partial
# files in /var/cache/apt/archives/partial and resumes them, so the next
# attempt starts from where the last one stopped.
ATTEMPT_TIMEOUT_LIGHT_DEFAULT=300
ATTEMPT_TIMEOUT_HEAVY_DEFAULT=1200

# What the whole script may spend, both halves together. An attempt count times
# an attempt timeout is not a budget: it says nothing about the waiting between
# attempts, so the worst case drifted above the 20-minute step timeouts the
# workflows set and the script could still be killed mid-recovery -- exactly the
# bare step timeout it exists to replace. A deadline is the number a step
# timeout can be checked against, and tests/ciPlaywrightInstall.test.mjs reads
# these two defaults and checks it.
DEADLINE_LIGHT_DEFAULT=900
DEADLINE_HEAVY_DEFAULT=2400

if [ "$HEAVY_BROWSERS" -eq 1 ]; then
  ATTEMPT_TIMEOUT="${PLAYWRIGHT_INSTALL_ATTEMPT_TIMEOUT:-$ATTEMPT_TIMEOUT_HEAVY_DEFAULT}"
  DEADLINE="${PLAYWRIGHT_INSTALL_DEADLINE:-$DEADLINE_HEAVY_DEFAULT}"
else
  ATTEMPT_TIMEOUT="${PLAYWRIGHT_INSTALL_ATTEMPT_TIMEOUT:-$ATTEMPT_TIMEOUT_LIGHT_DEFAULT}"
  DEADLINE="${PLAYWRIGHT_INSTALL_DEADLINE:-$DEADLINE_LIGHT_DEFAULT}"
fi

# Held back from the apt half so the browser download always gets a turn. Without
# it a slow mirror spends the whole deadline and the CDN half reports "out of
# budget" for a download that was never tried -- a true statement about the wrong
# half.
DOWNLOAD_RESERVE=$((DEADLINE / 4))

# The absolute second the half currently running must stop by. Set before each
# half rather than counted per attempt, so waiting counts against the budget too.
DEADLINE_AT=0

remaining_budget() {
  local now left
  now="$(date +%s)"
  left=$((DEADLINE_AT - now))
  if [ "$left" -lt 0 ]; then
    left=0
  fi
  printf '%s\n' "$left"
}

# How long a timed-out attempt's apt-get may make *no progress* before it is
# taken down, in seconds.
#
# This was wall-clock time until 2026-08-17, and that is the second half of the
# daily audit failure. The abandoned apt-get was not sitting on the lock, it was
# downloading the very packages the next attempt would have to download again,
# and 120 seconds into a thirteen-minute fetch it was killed for it. Twice.
#
# Waiting for a working apt is not lost time, it is the only attempt still doing
# the job. What has to be bounded is a *stuck* one, so what is measured is
# progress rather than the clock, and the deadline above bounds the wait however
# well apt is doing.
DPKG_LOCK_WAIT="${PLAYWRIGHT_INSTALL_DPKG_LOCK_WAIT:-120}"

# What makes a retry actually retry, rather than fail faster.
#
# `timeout` signals the process group it created, but the process holding the
# lock is `apt-get`, running as root under Playwright's own `sudo`. An
# unprivileged runner cannot signal a root process -- the TERM is refused with
# EPERM -- so the abandoned apt-get outlives the attempt that started it and
# keeps /var/lib/dpkg/lock-frontend.
#
# The next attempt then dies on "Could not get lock ... held by process N
# (apt-get)" in about a second, and so does the one after it. That is what
# happened on 2026-08-06: three attempts, two of them spent losing a race
# against our own orphan, reported as if the mirror had failed three times.
#
# So each retry waits for the lock to clear, and only escalates if it will not.
# `dpkg --configure -a` afterwards because a killed apt-get can leave a
# half-configured package that fails every later install until it is repaired.
terminate_apt() {
  sudo pkill -TERM -x apt-get >/dev/null 2>&1 || true
  sleep 5
  sudo pkill -KILL -x apt-get >/dev/null 2>&1 || true
  sudo pkill -KILL -x dpkg >/dev/null 2>&1 || true
}

# What "apt is still working" looks like from outside the lock: bytes arriving
# in the archive cache while it downloads, and dpkg's status file being rewritten
# while it unpacks and configures. Either one moving means the abandoned run is
# still doing the work the next attempt would have to redo. Both are root-owned,
# hence sudo; an unreadable value degrades to 0 and simply reads as no progress.
apt_progress() {
  local fetched stamp
  fetched="$(sudo du -sb /var/cache/apt/archives 2>/dev/null | cut -f1)"
  stamp="$(sudo stat -c %Y /var/lib/dpkg/status 2>/dev/null)"
  printf '%s:%s\n' "${fetched:-0}" "${stamp:-0}"
}

release_dpkg_lock() {
  local waited=0 stalled=0
  local last current
  last="$(apt_progress)"
  while pgrep -x apt-get >/dev/null 2>&1 || pgrep -x dpkg >/dev/null 2>&1; do
    if [ "$waited" -eq 0 ]; then
      echo "Waiting for the previous apt run: it holds the dpkg lock, and while it is still making progress it is fetching the packages this retry would otherwise fetch again."
    fi
    sleep 5
    waited=$((waited + 5))
    current="$(apt_progress)"
    if [ "$current" != "$last" ]; then
      last="$current"
      stalled=0
    else
      stalled=$((stalled + 5))
    fi
    if [ "$stalled" -ge "$DPKG_LOCK_WAIT" ]; then
      echo "::warning::apt has made no progress for ${stalled}s and still holds the lock; terminating it so the retry can proceed."
      terminate_apt
      break
    fi
    if [ "$(remaining_budget)" -le 0 ]; then
      echo "::warning::the install budget ran out after waiting ${waited}s for apt; terminating it so this step reports rather than being killed."
      terminate_apt
      break
    fi
  done
  sudo dpkg --configure -a >/dev/null 2>&1 || true
}

# Backoff, not a tight loop: the failure being retried is a mirror or CDN
# having a bad minute, and asking again immediately mostly asks the same bad
# minute.
#
# `$3` names an optional recovery step run before each retry. The browser
# download half passes none -- it holds no system-wide lock, so there is
# nothing for a later attempt to collide with.
#
# An attempt never outlives the half's deadline: a window longer than the budget
# would be killed by the step instead, which is how a retry loop turns back into
# a bare timeout with no report.
retry() {
  local label="$1"
  local recover="$2"
  shift 2
  local attempt=1
  local budget window
  while true; do
    budget="$(remaining_budget)"
    # Below a useful minimum there is nothing to try -- an attempt with seconds
    # left cannot fetch anything and would report a mirror failure for a budget
    # that ran out.
    if [ "$budget" -lt 30 ]; then
      echo "::error::${label} ran out of the install budget (${DEADLINE}s for this run) after $((attempt - 1)) attempt(s)."
      return 1
    fi
    window="$ATTEMPT_TIMEOUT"
    if [ "$window" -gt "$budget" ]; then
      window="$budget"
    fi
    if timeout --signal=TERM --kill-after=30s "$window" "$@"; then
      return 0
    fi
    if [ "$attempt" -ge "$ATTEMPTS" ]; then
      echo "::error::${label} failed after ${attempt} attempt(s)."
      return 1
    fi
    local delay=$((attempt * 30))
    echo "::warning::${label} failed (attempt ${attempt}/${ATTEMPTS}). Retrying in ${delay}s."
    sleep "$delay"
    [ -n "$recover" ] && "$recover"
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

ENDS_AT=$(($(date +%s) + DEADLINE))
echo "Installing ${BROWSERS[*]} with a ${DEADLINE}s budget (${ATTEMPTS} attempts of up to ${ATTEMPT_TIMEOUT}s per half)."

DEADLINE_AT=$((ENDS_AT - DOWNLOAD_RESERVE))
retry "playwright install-deps" release_dpkg_lock npx playwright install-deps "${BROWSERS[@]}" || exit 1
# Second, and separately: on a cache hit this is a no-op that costs a second,
# which is the whole reason the two are not one command. It gets whatever the
# apt half left, which the reserve keeps from being nothing.
DEADLINE_AT="$ENDS_AT"
retry "playwright install" "" npx playwright install "${BROWSERS[@]}" || exit 1

echo "Playwright ready: ${BROWSERS[*]}"
