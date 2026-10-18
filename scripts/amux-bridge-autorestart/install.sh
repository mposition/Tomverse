#!/bin/bash
# Installs the AMUX bridge auto-restart on the Ubuntu host.
#
#   sudo bash install.sh <bundle directory>
#
# Run by the operator from the admin account, never from the worker account:
# the files it installs run as root-owned units and a polkit rule, and the
# bundle must come from a directory the worker account cannot write
# (docs/ops/amux/bridge-monitoring.md §5 fetches it at a pinned commit into a
# fresh mktemp directory).
#
# Before it enables the timer it proves the polkit rule does exactly what it
# says: the account may restart a bridge unit and may not stop one, or restart
# anything else. Then it runs the service once.
set -euo pipefail
umask 077

timer_off() {
  systemctl disable --now tomverse-bridge-autorestart.timer >/dev/null 2>&1 || true
}

# Once the installed files start to change, every way out but success leaves
# the timer off -- an explicit failure as much as an unexpected one -- so a
# rule or script that did not pass its checks never runs on its own (an
# earlier install's timer included).
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

files=(tomverse-bridge-autorestart tomverse-bridge-autorestart.service
  tomverse-bridge-autorestart.timer 50-tomverse-bridge-autorestart.rules)
for file in "${files[@]}"; do
  test -f "$src/$file" && test ! -L "$src/$file" || fail "missing $file"
done

changing=yes
timer_off
trap 'timer_off; echo "install.sh: failed; the timer is off" >&2' ERR

restart_user=tomverse-bridge-autorestart
if ! getent passwd "$restart_user" >/dev/null; then
  useradd --system --user-group --no-create-home --home-dir /nonexistent \
    --shell /usr/sbin/nologin "$restart_user"
fi
test "$(getent passwd "$restart_user" | cut -d: -f7)" = /usr/sbin/nologin
test "$(id -nG "$restart_user")" = "$restart_user"

install -d -o root -g root -m 0755 /usr/local/libexec
install -o root -g root -m 0755 "$src/tomverse-bridge-autorestart" \
  /usr/local/libexec/tomverse-bridge-autorestart
install -o root -g root -m 0644 "$src/tomverse-bridge-autorestart.service" \
  /etc/systemd/system/tomverse-bridge-autorestart.service
install -o root -g root -m 0644 "$src/tomverse-bridge-autorestart.timer" \
  /etc/systemd/system/tomverse-bridge-autorestart.timer
install -d -o root -g root -m 0755 /etc/polkit-1/rules.d
install -o root -g root -m 0644 "$src/50-tomverse-bridge-autorestart.rules" \
  /etc/polkit-1/rules.d/50-tomverse-bridge-autorestart.rules

systemd-analyze verify /etc/systemd/system/tomverse-bridge-autorestart.service \
  /etc/systemd/system/tomverse-bridge-autorestart.timer
systemctl daemon-reload
# polkitd reads rules.d on change; give it a moment, then ask it directly.
sleep 2

# Asks polkit whether the account may <verb> <unit>, the way systemd asks it.
#
# The subject is a process running as the account, and the question is put
# by root: polkitd refuses details (unit, verb) from an unprivileged caller
# ("Only trusted callers (e.g. uid 0 or an action owner) can use
# CheckAuthorization() and pass details"), so asking as the account itself
# failed every check on the first install (2026-10-14). setpriv execs
# straight into sleep, so the process it leaves is the account's own.
setpriv --reuid="$restart_user" --regid="$restart_user" --clear-groups sleep 120 &
subject=$!
stop_subject() { kill "$subject" 2>/dev/null || true; }
trap 'stop_subject; timer_off; echo "install.sh: failed; the timer is off" >&2' ERR
# An interrupted install (Ctrl+C, SIGTERM) also stops it, and leaves the
# timer off like any other failure.
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
granted tomverse-bridge.service restart
granted tomverse-amux-v22-bridge@claude-impl.service restart
granted tomverse-amux-bridge@codex-impl.service restart
refused tomverse-bridge.service stop
refused tomverse-amux-bridge@codex-impl.service stop
refused tomverse-amux-bridge@codex-impl.service start
refused ssh.service restart
refused tomverse-amux-v22-sidecar@claude-impl.service restart
stop_subject
trap 'timer_off; echo "install.sh: failed; the timer is off" >&2' ERR

timer_off
systemctl start tomverse-bridge-autorestart.service
systemctl enable --now tomverse-bridge-autorestart.timer
trap - ERR
echo TOMVERSE_BRIDGE_AUTORESTART_INSTALLED
