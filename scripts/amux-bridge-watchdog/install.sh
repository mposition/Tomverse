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
# A oneshot start waits for the run and fails if the signal did not go out.
systemctl start tomverse-bridge-watchdog.service
systemctl enable --now tomverse-bridge-watchdog.timer
journalctl -u tomverse-bridge-watchdog.service -n 1 --no-pager -o cat
echo TOMVERSE_BRIDGE_WATCHDOG_INSTALLED
