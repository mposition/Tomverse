#!/usr/bin/env bash
set -euo pipefail

# Operator-only preparation. This script never enables, starts, stops or
# restarts a unit. Activation remains a separate approved operation.
if [[ ${1:-} != "--prepare-only" || $EUID -ne 0 ]]; then
  echo "usage: sudo ./install-amux-v22-recovery-controller.sh --prepare-only" >&2
  exit 2
fi

source_dir=$(cd -- "$(dirname -- "$0")" && pwd -P)
artifact=${AMUX_V22_RECOVERY_CONTROLLER_ARTIFACT:-}
if [[ ! $artifact =~ ^/[^[:cntrl:]]+/recovery-controller\.mjs$ || ! -f $artifact || -L $artifact ]]; then
  echo "fixed recovery controller artifact is required" >&2
  exit 2
fi

/usr/bin/install -d -o root -g root -m 0700 /etc/tomverse-amux-v22 \
  /var/lib/tomverse-amux-v22/recovery-stop-intents
/usr/bin/install -d -o root -g root -m 0755 /opt/tomverse-amux-v22
/usr/bin/install -o root -g root -m 0555 "$artifact" /opt/tomverse-amux-v22/recovery-controller.mjs
/usr/bin/install -o root -g root -m 0644 \
  "$source_dir/systemd/amux-v22-recovery-controller.service" \
  /etc/systemd/system/amux-v22-recovery-controller.service
/usr/bin/install -o root -g root -m 0644 \
  "$source_dir/systemd/amux-v22-recovery-controller.timer" \
  /etc/systemd/system/amux-v22-recovery-controller.timer

if [[ ! -e /etc/tomverse-amux-v22/recovery-controller.env ]]; then
  /usr/bin/install -o root -g root -m 0600 \
    "$source_dir/systemd/amux-v22-recovery-controller.env.example" \
    /etc/tomverse-amux-v22/recovery-controller.env
fi

# The operator supplies and reviews this versioned file before any later run.
if [[ ! -e /etc/tomverse-amux-v22/recovery-profiles.json ]]; then
  /usr/bin/printf '%s\n' '{"profiles":[],"version":1}' \
    > /etc/tomverse-amux-v22/recovery-profiles.json
  /usr/bin/chown root:root /etc/tomverse-amux-v22/recovery-profiles.json
  /usr/bin/chmod 0600 /etc/tomverse-amux-v22/recovery-profiles.json
fi

/usr/bin/systemd-analyze verify /etc/systemd/system/amux-v22-recovery-controller.service \
  /etc/systemd/system/amux-v22-recovery-controller.timer
/usr/bin/systemctl daemon-reload
/usr/bin/printf '%s\n' \
  'prepared only; controller timer remains disabled and inactive, and the service has not been started'
