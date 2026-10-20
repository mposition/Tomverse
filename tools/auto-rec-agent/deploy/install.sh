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
REPO_URL="https://github.com/mposition/Tomverse.git"
DEST=/usr/local/lib/autorec-agent
UNIT_DIR=/etc/systemd/system
ACCOUNT=autorec
HOME_DIR=/home/autorec

FILES=(
  tools/auto-rec-agent/bin/autorec-runner.mjs
  tools/auto-rec-agent/bin/autorec-gateway.mjs
  tools/auto-rec-agent/lib/contract.mjs
  tools/auto-rec-agent/lib/core.mjs
  lib/agentAuthorityFiles.ts
  tools/review-orchestrator/lib/fsutil.mjs
  tools/review-orchestrator/client/review.mjs
)
UNITS=(
  autorec-runner.service
  autorec-runner.timer
  autorec-gateway.socket
  autorec-gateway@.service
)

fail() { echo "install: $*" >&2; exit "${2:-1}"; }

[ "$(id -u)" -eq 0 ] || fail "run as root (sudo)" 77
[[ "$REF" =~ ^[A-Za-z0-9._/-]+$ ]] || fail "ref must be a branch or tag name" 64
id "$ACCOUNT" >/dev/null 2>&1 || fail "account $ACCOUNT does not exist" 64
command -v git >/dev/null || fail "git is not installed" 64
[ -x /usr/bin/node ] || fail "/usr/bin/node not found (the units use that path)" 64
/usr/bin/node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=6)?0:1)' \
  || fail "Node 22.6 or later is required (type stripping)" 64

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
# A blobless clone fetches only the files checked out below.
git clone --quiet --filter=blob:none --no-checkout --depth 1 --branch "$REF" "$REPO_URL" "$WORK/repo"
git -C "$WORK/repo" checkout --quiet HEAD -- "${FILES[@]}" "${UNITS[@]/#/tools/auto-rec-agent/deploy/}" tools/auto-rec-agent/deploy/autorec.env.example
COMMIT="$(git -C "$WORK/repo" rev-parse HEAD)"

# Code: root-owned, readable, replaced as a whole so a removed file does not linger.
STAGE="$(mktemp -d "${DEST}.new.XXXXXX")"
for file in "${FILES[@]}"; do
  install -D -m 0644 -o root -g root "$WORK/repo/$file" "$STAGE/$file"
done
# The installed tree has no package.json of its own; this one makes the .ts module ESM.
printf '{ "private": true, "type": "module" }\n' > "$STAGE/package.json"
printf '%s %s\n' "$REF" "$COMMIT" > "$STAGE/INSTALLED_FROM"
chmod 0644 "$STAGE/package.json" "$STAGE/INSTALLED_FROM"
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

# Secrets directory and file: root only. An existing file is never overwritten.
install -d -m 0700 -o root -g root /etc/autorec
if [ ! -e /etc/autorec/autorec.env ]; then
  install -m 0600 -o root -g root "$WORK/repo/tools/auto-rec-agent/deploy/autorec.env.example" /etc/autorec/autorec.env
fi
chown root:root /etc/autorec/autorec.env
chmod 0600 /etc/autorec/autorec.env

# The runner's working and log directories.
install -d -m 0700 -o "$ACCOUNT" -g "$ACCOUNT" "$HOME_DIR/work" "$HOME_DIR/logs"

systemctl daemon-reload
echo "installed $REF at $COMMIT into $DEST"
echo "enabled units: $(systemctl is-enabled autorec-runner.timer 2>/dev/null || true) (timer), $(systemctl is-enabled autorec-gateway.socket 2>/dev/null || true) (socket)"
