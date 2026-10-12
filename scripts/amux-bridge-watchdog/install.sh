#!/bin/bash
# Installs the AMUX bridge watchdog on the Ubuntu host.
#
#   sudo bash install.sh <bundle directory>
#
# Run by the operator from the admin account, never from the worker account:
# the files it installs run as root-owned units, and the bundle must come from
# a directory the worker account cannot write (docs/ops/amux/bridge-monitoring.md
# §2 fetches it at a pinned commit into a fresh mktemp directory).
#
# Asks for the monitor's ping URL on the terminal, without echoing it, only
# when none is installed yet. To replace the URL, delete
# /etc/tomverse-bridge-watchdog/ping-url and run this again.
#
# Ends with one watchdog run, so a URL that does not answer, or a unit that
# cannot read the bridge's state, fails the install instead of the first alert.
set -euo pipefail
umask 077

fail() {
  echo "install.sh: $*" >&2
  exit 2
}

test "$(id -u)" = 0 || fail "run with sudo"
test "$#" = 1 || fail "usage: sudo bash install.sh <bundle directory>"
src=$(realpath -- "$1")
test -d "$src" || fail "$src is not a directory"
test "$(stat -c %U "$src")" != tommy || fail "the bundle is owned by the worker account"
# A directory nobody but its owner can enter: what is inside cannot be swapped
# between the download and this install, whatever the files' own modes are.
test -z "$(find "$src" -maxdepth 0 -perm /077 -print)" ||
  fail "the bundle directory is open to its group or others (use mktemp -d)"

files=(tomverse-bridge-watchdog tomverse-bridge-watchdog.service tomverse-bridge-watchdog.timer)
for file in "${files[@]}"; do
  test -f "$src/$file" && test ! -L "$src/$file" || fail "missing $file"
done

url_pattern='^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?(/[A-Za-z0-9._~-]+)+$'
config=/etc/tomverse-bridge-watchdog
url_file="$config/ping-url"

install -d -o root -g root -m 0700 "$config"
test ! -L "$url_file" || fail "$url_file is a symbolic link"
if test ! -s "$url_file"; then
  printf 'Ping URL of the bridge check (input is not shown): ' >&2
  IFS= read -rs url
  printf '\n' >&2
  url=${url//[[:space:]]/}
  [[ "$url" =~ $url_pattern ]] || fail "not a plain https URL; nothing was installed"
  printf '%s\n' "$url" >"$url_file.new"
  chmod 0600 "$url_file.new"
  mv -f "$url_file.new" "$url_file"
  unset url
fi

# From here on the installed files change. Any failure below -- a unit that
# does not verify, a run that cannot deliver, a run that sent nothing -- leaves
# the timer off, so a broken watchdog never keeps running on its own (an
# earlier install's timer included).
timer_off() {
  systemctl disable --now tomverse-bridge-watchdog.timer >/dev/null 2>&1 || true
}
trap 'timer_off; echo "install.sh: failed; the timer is off. Pause the Healthchecks check" >&2' ERR

# The unit's own system account. Created once; an existing one is checked, not
# changed: it must have no login shell and no group but its own, so it can
# never be the worker account or one that holds sudo.
watch_user=tomverse-bridge-watchdog
if ! getent passwd "$watch_user" >/dev/null; then
  useradd --system --user-group --no-create-home --home-dir /nonexistent \
    --shell /usr/sbin/nologin "$watch_user"
fi
test "$(getent passwd "$watch_user" | cut -d: -f7)" = /usr/sbin/nologin
test "$(id -nG "$watch_user")" = "$watch_user"

install -d -o root -g root -m 0755 /usr/local/libexec
install -o root -g root -m 0755 "$src/tomverse-bridge-watchdog" \
  /usr/local/libexec/tomverse-bridge-watchdog
install -o root -g root -m 0644 "$src/tomverse-bridge-watchdog.service" \
  /etc/systemd/system/tomverse-bridge-watchdog.service
install -o root -g root -m 0644 "$src/tomverse-bridge-watchdog.timer" \
  /etc/systemd/system/tomverse-bridge-watchdog.timer

systemd-analyze verify /etc/systemd/system/tomverse-bridge-watchdog.service \
  /etc/systemd/system/tomverse-bridge-watchdog.timer
systemctl daemon-reload
# A oneshot start waits for the run and fails if a signal could not be
# delivered. A run that sent nothing exits 0, so this run's own journal lines
# are read as well: the first install reported success while every run read
# the bridge as unreadable and sent nothing.
#
# The run's lines are the ones after a journal cursor taken once the timer is
# off and no run is in progress, so no earlier run's "sent up" can count for
# this one. Not by InvocationID: a oneshot unit clears it the moment the run
# ends, so the third install found no lines and failed a run that had sent
# its signal (2026-10-12). Not by time either: a second-resolution bound can
# include an earlier run that ended in the same second.
timer_off
systemctl stop tomverse-bridge-watchdog.service
journalctl --sync
cursor=$(journalctl -n 1 --show-cursor --no-pager -q -o cat | sed -n 's/^-- cursor: //p')
test -n "$cursor"
started=yes
systemctl start tomverse-bridge-watchdog.service || started=no
journalctl --sync
run_log=$(journalctl -u tomverse-bridge-watchdog.service --after-cursor="$cursor" --no-pager -o cat)
printf '%s\n' "$run_log"
if test "$started" = no || ! grep -qE '; sent (up|down)$' <<<"$run_log"; then
  timer_off
  trap - ERR
  fail "the watchdog run failed or sent no signal (lines above); the timer is off. Pause the Healthchecks check and report the lines above"
fi
systemctl enable --now tomverse-bridge-watchdog.timer
trap - ERR
echo TOMVERSE_BRIDGE_WATCHDOG_INSTALLED
