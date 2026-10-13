#!/usr/bin/env bash
set -euo pipefail

# Operator-only preparation. This script does not create an account or instance
# environment and never enables, starts, stops or restarts a unit.
if [[ ${1:-} != "--prepare-only" || $EUID -ne 0 ]]; then
  echo "usage: sudo ./install-amux-v22-recovery-inspector.sh --prepare-only" >&2
  exit 2
fi

source_dir=$(cd -- "$(dirname -- "$0")" && pwd -P)
artifact=${AMUX_V22_RECOVERY_INSPECTOR_ARTIFACT:-}
if [[ ! $artifact =~ ^/[^[:cntrl:]]+/recovery-checker\.mjs$ || ! -f $artifact || -L $artifact ]]; then
  echo "fixed recovery inspector artifact is required" >&2
  exit 2
fi

inspector_user=tomverse-amux-v22-inspector
inspector_group=amux-v22-ipc
inspector_uid=$(/usr/bin/id -u "$inspector_user")
if ! inspector_group_record=$(/usr/bin/getent group "$inspector_group"); then
  echo "pre-created unprivileged inspector account and IPC group are required" >&2
  exit 2
fi
IFS=: read -r _ _ inspector_gid _ <<<"$inspector_group_record"
inspector_group_ids=" $(/usr/bin/id -G "$inspector_user") "
if (( inspector_uid == 0 )) || [[ ! $inspector_gid =~ ^[0-9]+$ ]] ||
  [[ $inspector_group_ids != *" $inspector_gid "* ]]; then
  echo "pre-created unprivileged inspector account and IPC group are required" >&2
  exit 2
fi

/usr/bin/install -d -o root -g root -m 0700 /etc/tomverse-amux-v22
/usr/bin/install -d -o root -g root -m 0755 /opt/tomverse-amux-v22
/usr/bin/install -o root -g root -m 0555 "$artifact" /opt/tomverse-amux-v22/recovery-checker.mjs
/usr/bin/install -o root -g root -m 0644 \
  "$source_dir/systemd/amux-v22-recovery-inspector@.service" \
  /etc/systemd/system/amux-v22-recovery-inspector@.service
/usr/bin/install -o root -g root -m 0644 \
  "$source_dir/systemd/amux-v22-recovery-inspector@.timer" \
  /etc/systemd/system/amux-v22-recovery-inspector@.timer
if [[ ! -e /etc/tomverse-amux-v22/recovery-inspector.env.example ]]; then
  /usr/bin/install -o root -g root -m 0600 \
    "$source_dir/systemd/amux-v22-recovery-inspector.env.example" \
    /etc/tomverse-amux-v22/recovery-inspector.env.example
fi

/usr/bin/systemd-analyze verify \
  /etc/systemd/system/amux-v22-recovery-inspector@.service \
  /etc/systemd/system/amux-v22-recovery-inspector@.timer
/usr/bin/systemctl daemon-reload
/usr/bin/printf '%s\n' \
  'prepared only; no instance environment was created and every inspector timer remains disabled and inactive'
