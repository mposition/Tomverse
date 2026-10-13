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

# Asks polkit, as the account, whether <verb> on <unit> is allowed. The shell
# execs into pkcheck, so the process it names is the account's own.
allowed() {
  runuser -u "$restart_user" -- sh -c \
    'exec pkcheck --action-id org.freedesktop.systemd1.manage-units --process $$ --detail unit "$1" --detail verb "$2"' \
    sh "$1" "$2" >/dev/null 2>&1
}
allowed tomverse-bridge.service restart || fail "polkit does not let the account restart tomverse-bridge.service"
allowed tomverse-amux-v22-bridge@claude-impl.service restart ||
  fail "polkit does not let the account restart a v22 bridge"
if allowed tomverse-bridge.service stop; then
  fail "polkit lets the account stop a bridge; the rule is wider than approved"
fi
if allowed ssh.service restart; then
  fail "polkit lets the account restart ssh.service; the rule is wider than approved"
fi
if allowed tomverse-amux-v22-sidecar@claude-impl.service restart; then
  fail "polkit lets the account restart a sidecar; the rule is wider than approved"
fi

timer_off
systemctl start tomverse-bridge-autorestart.service
systemctl enable --now tomverse-bridge-autorestart.timer
trap - ERR
echo TOMVERSE_BRIDGE_AUTORESTART_INSTALLED
