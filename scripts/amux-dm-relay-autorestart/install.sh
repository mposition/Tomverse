#!/bin/bash
# Installs the AMUX Decision Maker relay auto-restart on the Ubuntu host.
#
#   sudo bash install.sh <bundle directory>
#
# Installing it is turning it on: it gives an autonomous unit a new permission
# (restart the relay), so it is the operator's step, never part of a deploy.
# Turning it off is `sudo systemctl disable --now tomverse-dm-relay-autorestart.timer`.
#
# Run by the operator from the admin account, never from the worker account:
# the files it installs run as root-owned units and a polkit rule, and the
# bundle must come from a directory the worker account cannot write
# (docs/ops/amux/bridge-monitoring.md §6 fetches it at a pinned commit into a
# fresh mktemp directory).
#
# Before it enables the timer it proves the polkit rule does exactly what it
# says: the account may restart the relay unit and may not stop or start it,
# or restart anything else. Then it runs the service once.
set -euo pipefail
umask 077

timer_off() {
  systemctl disable --now tomverse-dm-relay-autorestart.timer >/dev/null 2>&1 || true
}

# Once the installed files start to change, every way out but success leaves
# the timer off, so a rule or script that did not pass its checks never runs
# on its own (an earlier install's timer included).
changing=no
fail() {
  declare -F stop_subject >/dev/null && stop_subject
  [[ "$changing" == yes ]] && timer_off && echo "install.sh: the timer is off" >&2
  echo "install.sh: $*" >&2
  exit 2
}

test "$(id -u)" = 0 || fail "run with sudo"
test "$#" = 1 || fail "usage: sudo bash install.sh <bundle directory>"
src=$(realpath -- "$1")
test -d "$src" || fail "$src is not a directory"
test "$(stat -c %U "$src")" != tommy || fail "the bundle is owned by the worker account"
test -z "$(find "$src" -maxdepth 0 -perm /077 -print)" ||
  fail "the bundle directory is open to its group or others (use mktemp -d)"

files=(tomverse-dm-relay-autorestart tomverse-dm-relay-autorestart.service
  tomverse-dm-relay-autorestart.timer 50-tomverse-dm-relay-autorestart.rules)
for file in "${files[@]}"; do
  test -f "$src/$file" && test ! -L "$src/$file" || fail "missing $file"
done

changing=yes
timer_off
trap 'timer_off; echo "install.sh: failed; the timer is off" >&2' ERR

restart_user=tomverse-dm-relay-autorestart
if ! getent passwd "$restart_user" >/dev/null; then
  useradd --system --user-group --no-create-home --home-dir /nonexistent \
    --shell /usr/sbin/nologin "$restart_user"
fi
test "$(getent passwd "$restart_user" | cut -d: -f7)" = /usr/sbin/nologin
test "$(id -nG "$restart_user")" = "$restart_user"

install -d -o root -g root -m 0755 /usr/local/libexec
install -o root -g root -m 0755 "$src/tomverse-dm-relay-autorestart" \
  /usr/local/libexec/tomverse-dm-relay-autorestart
install -o root -g root -m 0644 "$src/tomverse-dm-relay-autorestart.service" \
  /etc/systemd/system/tomverse-dm-relay-autorestart.service
install -o root -g root -m 0644 "$src/tomverse-dm-relay-autorestart.timer" \
  /etc/systemd/system/tomverse-dm-relay-autorestart.timer
install -d -o root -g root -m 0755 /etc/polkit-1/rules.d
install -o root -g root -m 0644 "$src/50-tomverse-dm-relay-autorestart.rules" \
  /etc/polkit-1/rules.d/50-tomverse-dm-relay-autorestart.rules

systemd-analyze verify /etc/systemd/system/tomverse-dm-relay-autorestart.service \
  /etc/systemd/system/tomverse-dm-relay-autorestart.timer
systemctl daemon-reload
# polkitd reads rules.d on change; give it a moment, then ask it directly.
sleep 2

# Asks polkit whether the account may <verb> <unit>, the way systemd asks it.
# The subject is a process running as the account and the question is put by
# root: polkitd refuses details from an unprivileged caller (bridge
# auto-restart, first install, 2026-10-14).
setpriv --reuid="$restart_user" --regid="$restart_user" --clear-groups sleep 120 &
subject=$!
stop_subject() { kill "$subject" 2>/dev/null || true; }
trap 'stop_subject; timer_off; echo "install.sh: failed; the timer is off" >&2' ERR
trap 'stop_subject' EXIT
trap 'timer_off; exit 130' INT TERM
sleep 1
test "$(stat -c %U "/proc/$subject")" = "$restart_user" ||
  fail "could not start a process as $restart_user to ask polkit about"

# Prints pkcheck's exit status: 0 authorized, 1 or 2 not authorized (2 would
# need a password), anything else an error that answers nothing.
answer() {
  local status=0
  pkcheck --action-id org.freedesktop.systemd1.manage-units --process "$subject" \
    --detail unit "$1" --detail verb "$2" >/dev/null 2>&1 || status=$?
  echo "$status"
}
granted() {
  local status
  status=$(answer "$1" "$2")
  test "$status" = 0 || fail "polkit does not let the account $2 $1 (pkcheck exit $status)"
}
refused() {
  local status
  status=$(answer "$1" "$2")
  case "$status" in
    1 | 2) ;;
    0) fail "polkit lets the account $2 $1; the rule is wider than approved" ;;
    *) fail "polkit gave no answer for $2 $1 (pkcheck exit $status)" ;;
  esac
}
granted tomverse-amux-dm-relay.service restart
refused tomverse-amux-dm-relay.service stop
refused tomverse-amux-dm-relay.service start
refused tomverse-amux-bridge@codex-impl.service restart
refused amux-dm-broker.service restart
refused tomverse-bridge-watchdog.service restart
refused ssh.service restart
stop_subject
trap 'timer_off; echo "install.sh: failed; the timer is off" >&2' ERR

timer_off
systemctl start tomverse-dm-relay-autorestart.service
systemctl enable --now tomverse-dm-relay-autorestart.timer
trap - ERR
echo TOMVERSE_DM_RELAY_AUTORESTART_INSTALLED
