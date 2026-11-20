#!/usr/bin/env bash
# Install (or update) the auto-rec agent runner and its credential gateway.
#
#   sudo bash install.sh [branch-or-tag]      default: develop
#
# Idempotent. It copies the code from a fresh, root-owned clone of the public
# repository -- never from the autorec account's mirror, which that account
# (and the agent's code) can change -- installs the systemd units, and creates
# the directories and an empty /etc/autorec/autorec.env if there is none. It
# does not fill in a secret, enable a unit or start anything: README.md says
# what the operator does next.
set -euo pipefail

REF="${1:-develop}"
MODE="${2:-router}"
REPO_URL="https://github.com/mposition/Tomverse.git"
DEST=/usr/local/lib/autorec-agent
UNIT_DIR=/etc/systemd/system
ACCOUNT=autorec
HOME_DIR=/home/autorec
# The gateway's account: a system user with no login and no home, never autorec.
GATEWAY_ACCOUNT=autorec-gw
# Installed under $DEST/npm; lib/contract.mjs DEFAULTS.npmBin points there.
NPM_VERSION=10.9.10

FILES=(
  tools/auto-rec-agent/bin/autorec-runner.mjs
  tools/auto-rec-agent/bin/autorec-gateway.mjs
  tools/auto-rec-agent/lib/contract.mjs
  tools/auto-rec-agent/lib/core.mjs
  tools/auto-rec-agent/lib/agentAuthorityFiles.generated.mjs
  tools/review-orchestrator/lib/fsutil.mjs
  tools/review-orchestrator/client/review.mjs
  tools/auto-rec-agent/deploy/review-ssh
)
UNITS=(
  autorec-runner.service
  autorec-runner.timer
  autorec-gateway.socket
  autorec-gateway@.service
)

fail() { echo "install: $*" >&2; exit "${2:-1}"; }

[ "$(id -u)" -eq 0 ] || fail "run as root (sudo)" 77
[[ "$MODE" == router || "$MODE" == daily-product ]] || fail "mode must be router or daily-product" 64
# Never replace the trusted runner while an attempt may still be publishing.
systemctl is-active --quiet autorec-runner.service && fail "runner is busy; install after it finishes" 75
[[ "$REF" =~ ^[A-Za-z0-9._/-]+$ ]] || fail "ref must be a branch or tag name" 64
id "$ACCOUNT" >/dev/null 2>&1 || fail "account $ACCOUNT does not exist" 64
# Only /etc/passwd counts: while an older DynamicUser gateway instance runs,
# nss-systemd resolves the same name, and that account vanishes when it stops.
# Stopping the instances first also frees the name for useradd.
if ! getent -s files passwd "$GATEWAY_ACCOUNT" >/dev/null; then
  systemctl stop 'autorec-gateway@*.service' 2>/dev/null || true
  id "$GATEWAY_ACCOUNT" >/dev/null 2>&1 && fail "$GATEWAY_ACCOUNT still resolves to a dynamic account; stop autorec-gateway and run again" 75
  if getent -s files group "$GATEWAY_ACCOUNT" >/dev/null; then
    useradd --system --gid "$GATEWAY_ACCOUNT" --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin "$GATEWAY_ACCOUNT"
  else
    useradd --system --user-group --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin "$GATEWAY_ACCOUNT"
  fi
fi
[ "$(id -u "$GATEWAY_ACCOUNT")" != "$(id -u "$ACCOUNT")" ] || fail "$GATEWAY_ACCOUNT and $ACCOUNT must be different accounts" 64
id -nG "$ACCOUNT" | tr ' ' '\n' | grep -qx "$GATEWAY_ACCOUNT" && fail "$ACCOUNT must not be in the $GATEWAY_ACCOUNT group" 64
command -v git >/dev/null || fail "git is not installed" 64
[ -x /usr/bin/node ] || fail "/usr/bin/node not found (the units use that path)" 64
# Ask node itself for the flags the units use, instead of comparing versions
# (23.0-23.6 are newer than 22.14 and still lack --disable-sigusr1). No
# TypeScript support is needed: Ubuntu's nodejs package has none, so the
# runner reads the plain-JS manifest copy (agentAuthorityFiles.generated.mjs).
/usr/bin/node --disable-sigusr1 --no-warnings=ExperimentalWarning -e 0 2>/dev/null \
  || fail "this node does not accept --disable-sigusr1 (use 22.14+ or 23.7+)" 64

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
# Deployment may name the reviewed immutable commit instead of a moving branch.
if [[ "$REF" =~ ^[0-9a-f]{40}$ ]]; then
  git init --quiet "$WORK/repo"
  git -C "$WORK/repo" fetch --quiet --filter=blob:none --depth 1 "$REPO_URL" "$REF"
  git -C "$WORK/repo" update-ref HEAD FETCH_HEAD
  [ "$(git -C "$WORK/repo" rev-parse HEAD)" = "$REF" ] || fail "commit mismatch" 65
else
  git clone --quiet --filter=blob:none --no-checkout --depth 1 --branch "$REF" "$REPO_URL" "$WORK/repo"
fi
git -C "$WORK/repo" checkout --quiet HEAD -- "${FILES[@]}" "${UNITS[@]/#/tools/auto-rec-agent/deploy/}" \
  tools/auto-rec-agent/deploy/autorec.env.example tools/auto-rec-agent/deploy/review-ssh.conf \
  tools/auto-rec-agent/deploy/autorec-daily-product.timer \
  tools/auto-rec-agent/deploy/daily-product-runner.conf tools/auto-rec-agent/deploy/daily-product-gateway.conf
COMMIT="$(git -C "$WORK/repo" rev-parse HEAD)"

# Code: root-owned, readable, replaced as a whole so a removed file does not linger.
STAGE="$(mktemp -d "${DEST}.new.XXXXXX")"
for file in "${FILES[@]}"; do
  install -D -m 0644 -o root -g root "$WORK/repo/$file" "$STAGE/$file"
done
# The npm the runner installs dependencies with: the one Node 22 ships and CI
# uses. Ubuntu's nodejs package brings npm 9, whose `npm ci` refuses this
# repository's lockfile (apps/mobile's file: link to native-auth).
/usr/bin/npm install --global --prefix "$STAGE/npm" --ignore-scripts --no-audit --no-fund --loglevel=error "npm@$NPM_VERSION" >/dev/null
# sudo may retain a restrictive caller umask. This tree contains public npm
# tools: the runner needs read/execute access, never permission to change them.
chmod -R a+rX,go-w "$STAGE/npm"
[ "$("$STAGE/npm/bin/npm" --version)" = "$NPM_VERSION" ] || fail "npm $NPM_VERSION did not install" 69
# The installed tree has no package.json of its own; this one makes the .ts module ESM.
printf '{ "private": true, "type": "module" }\n' > "$STAGE/package.json"
printf '%s %s\n' "$REF" "$COMMIT" > "$STAGE/INSTALLED_FROM"
printf '%s\n' "$MODE" > "$STAGE/INSTALLED_MODE"
chmod 0644 "$STAGE/package.json" "$STAGE/INSTALLED_FROM" "$STAGE/INSTALLED_MODE"
chmod 0755 "$STAGE/tools/auto-rec-agent/deploy/review-ssh"
find "$STAGE" -type d -exec chmod 0755 {} +
chown -R root:root "$STAGE"
rm -rf "${DEST}.old"
[ -d "$DEST" ] && mv "$DEST" "${DEST}.old"
mv "$STAGE" "$DEST"
rm -rf "${DEST}.old"

# Units.
for unit in "${UNITS[@]}"; do
  install -m 0644 -o root -g root "$WORK/repo/tools/auto-rec-agent/deploy/$unit" "$UNIT_DIR/$unit"
done
if [ "$MODE" = daily-product ]; then
  install -m 0644 -o root -g root "$WORK/repo/tools/auto-rec-agent/deploy/autorec-daily-product.timer" "$UNIT_DIR/autorec-runner.timer"
  install -D -m 0644 -o root -g root "$WORK/repo/tools/auto-rec-agent/deploy/daily-product-runner.conf" "$UNIT_DIR/autorec-runner.service.d/daily-product.conf"
  install -D -m 0644 -o root -g root "$WORK/repo/tools/auto-rec-agent/deploy/daily-product-gateway.conf" "$UNIT_DIR/autorec-gateway@.service.d/daily-product.conf"
else
  # Remove only this installer's mode overrides when explicitly returning to router mode.
  rm -f "$UNIT_DIR/autorec-runner.service.d/daily-product.conf" "$UNIT_DIR/autorec-gateway@.service.d/daily-product.conf"
fi

# Secrets directory and file: root only. An existing file is never overwritten.
install -d -m 0700 -o root -g root /etc/autorec
if [ ! -e /etc/autorec/autorec.env ]; then
  install -m 0600 -o root -g root "$WORK/repo/tools/auto-rec-agent/deploy/autorec.env.example" /etc/autorec/autorec.env
fi
chown root:root /etc/autorec/autorec.env
chmod 0600 /etc/autorec/autorec.env

# The review client's ssh config and the pinned key of this host's sshd: root
# owned and world-readable, so autorec can use them and cannot change them.
install -d -m 0755 -o root -g root /etc/autorec-ssh
install -m 0644 -o root -g root "$WORK/repo/tools/auto-rec-agent/deploy/review-ssh.conf" /etc/autorec-ssh/config
if [ ! -s /etc/autorec-ssh/known_hosts ]; then
  ssh-keyscan -t ed25519 127.0.0.1 2>/dev/null > /etc/autorec-ssh/known_hosts || true
  [ -s /etc/autorec-ssh/known_hosts ] || echo "install: warning: no ed25519 host key from 127.0.0.1:22; fill /etc/autorec-ssh/known_hosts by hand" >&2
fi
chown root:root /etc/autorec-ssh/known_hosts
chmod 0644 /etc/autorec-ssh/known_hosts

# The gateway refuses to run where the runner's children could attach to it.
scope="$(cat /proc/sys/kernel/yama/ptrace_scope 2>/dev/null || echo missing)"
case "$scope" in
  1|2|3) ;;
  *) echo "install: warning: kernel.yama.ptrace_scope is $scope; the gateway answers nothing until it is 1 or more" >&2 ;;
esac

# The runner's working and log directories.
install -d -m 0700 -o "$ACCOUNT" -g "$ACCOUNT" "$HOME_DIR/work" "$HOME_DIR/logs"

systemctl daemon-reload
echo "installed $REF at $COMMIT into $DEST"
echo "enabled units: $(systemctl is-enabled autorec-runner.timer 2>/dev/null || true) (timer), $(systemctl is-enabled autorec-gateway.socket 2>/dev/null || true) (socket)"
