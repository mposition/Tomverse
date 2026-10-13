#!/usr/bin/env bash
set -euo pipefail
umask 077

fail() {
  echo "install-amux-v22-recovery-controller.sh: $*" >&2
  exit 2
}

controller_install_state_allows_prepare() {
  local role=${1:-} load_state=${2:-} unit_file_state=${3:-}
  local active_state=${4:-} sub_state=${5:-} job=${6:-}
  case "$job" in
    ""|0|"[0, /]") ;;
    *) return 1 ;;
  esac
  if [[ $load_state == "not-found" ]]; then
    [[ -z $unit_file_state || $unit_file_state == "not-found" ]] &&
      [[ $active_state == "inactive" && $sub_state == "dead" ]]
    return
  fi
  [[ $load_state == "loaded" && $active_state == "inactive" &&
    $sub_state == "dead" ]] || return 1
  case "$role:$unit_file_state" in
    service:static|timer:disabled) return 0 ;;
    *) return 1 ;;
  esac
}

controller_systemctl_show() {
  /usr/bin/systemctl show "$1" --all \
    --property=LoadState,UnitFileState,ActiveState,SubState,Job --no-pager
}

inspect_controller_install_state() {
  local role=$1 unit=$2 output line key value
  local load_state=__missing__ unit_file_state=__missing__
  local active_state=__missing__ sub_state=__missing__ job=__missing__
  if ! output=$(controller_systemctl_show "$unit" 2>/dev/null); then
    fail "controller unit state is unavailable"
  fi
  while IFS= read -r line; do
    [[ $line == *=* ]] || fail "controller unit state is unavailable"
    key=${line%%=*}
    value=${line#*=}
    case "$key" in
      LoadState) [[ $load_state == __missing__ ]] || fail "controller unit state is unavailable"
        load_state=$value ;;
      UnitFileState) [[ $unit_file_state == __missing__ ]] ||
          fail "controller unit state is unavailable"
        unit_file_state=$value ;;
      ActiveState) [[ $active_state == __missing__ ]] || fail "controller unit state is unavailable"
        active_state=$value ;;
      SubState) [[ $sub_state == __missing__ ]] || fail "controller unit state is unavailable"
        sub_state=$value ;;
      Job) [[ $job == __missing__ ]] || fail "controller unit state is unavailable"
        job=$value ;;
      *) fail "controller unit state is unavailable" ;;
    esac
  done <<<"$output"
  if ! controller_install_state_allows_prepare "$role" "$load_state" "$unit_file_state" \
    "$active_state" "$sub_state" "$job"; then
    fail "controller unit is installed in a state that forbids preparation"
  fi
}

assert_controller_install_safe() {
  inspect_controller_install_state service amux-v22-recovery-controller.service
  inspect_controller_install_state timer amux-v22-recovery-controller.timer
}

# Sourcing exposes only deterministic/read-only preflight functions for the
# controlled synthetic tests. It never reaches an installation operation.
if [[ ${BASH_SOURCE[0]} != "$0" ]]; then
  return 0
fi

# Operator-only preparation. This script never enables, starts, stops or
# restarts a unit. Activation remains a separate approved operation.
if [[ ${1:-} != "--prepare-only" || $EUID -ne 0 ]]; then
  fail "usage: sudo ./install-amux-v22-recovery-controller.sh --prepare-only"
fi

source_dir=$(cd -- "$(dirname -- "$0")" && pwd -P)
artifact=${AMUX_V22_RECOVERY_CONTROLLER_ARTIFACT:-}
if [[ ! $artifact =~ ^/[^[:cntrl:]]+/recovery-controller\.mjs$ ]]; then
  fail "fixed recovery controller artifact is required"
fi
artifact_real=$(/usr/bin/realpath -e -- "$artifact") ||
  fail "fixed recovery controller artifact is required"
if [[ $artifact_real != "$artifact" || ! -f $artifact || -L $artifact ]]; then
  fail "fixed recovery controller artifact is required"
fi

# The reviewed artifact must be staged below a root-owned tree that no
# unprivileged account can replace while this root-only preparation runs.
artifact_parent=$(/usr/bin/dirname -- "$artifact")
cursor=$artifact_parent
while :; do
  if [[ ! -d $cursor || -L $cursor ]]; then
    fail "artifact parent is not a fixed directory"
  fi
  parent_uid=$(/usr/bin/stat -Lc '%u' -- "$cursor")
  parent_mode=$(/usr/bin/stat -Lc '%a' -- "$cursor")
  if [[ $parent_uid != 0 || ! $parent_mode =~ ^[0-7]{3,4}$ ]] ||
    (( (8#$parent_mode & 0022) != 0 )); then
    fail "artifact parent must be root-owned and not group/other writable"
  fi
  [[ $cursor == / ]] && break
  cursor=$(/usr/bin/dirname -- "$cursor")
done

# Bind the copy to one opened inode. Rechecking the path identity catches a
# final-component swap; copying through the shell's descriptor prevents a
# later rename from changing the bytes that are installed.
exec {artifact_fd}<"$artifact" || fail "fixed recovery controller artifact is required"
artifact_fd_path=/proc/$$/fd/$artifact_fd
IFS=: read -r artifact_uid artifact_mode artifact_links < <(
  /usr/bin/stat -Lc '%u:%a:%h' -- "$artifact_fd_path"
)
artifact_identity=$(/usr/bin/stat -Lc '%d:%i' -- "$artifact_fd_path")
path_identity=$(/usr/bin/stat -Lc '%d:%i' -- "$artifact")
if [[ ! -f $artifact_fd_path || $artifact_uid != 0 ||
  ! $artifact_mode =~ ^[0-7]{3,4}$ || $artifact_links != 1 ||
  $artifact_identity != "$path_identity" || -L $artifact ]] ||
  (( (8#$artifact_mode & 0022) != 0 )); then
  fail "artifact must be a fixed root-owned regular file"
fi
artifact_digest=$(/usr/bin/sha256sum -- "$artifact_fd_path")
artifact_digest=${artifact_digest%% *}

assert_controller_install_safe

/usr/bin/install -d -o root -g root -m 0700 /etc/tomverse-amux-v22 \
  /var/lib/tomverse-amux-v22/recovery-stop-intents
/usr/bin/install -d -o root -g root -m 0755 /opt/tomverse-amux-v22
staged_controller=/opt/tomverse-amux-v22/.recovery-controller.mjs.prepare.$$
trap '/usr/bin/rm -f -- "$staged_controller"' EXIT
/usr/bin/install -o root -g root -m 0555 "$artifact_fd_path" "$staged_controller"
source_digest_after=$(/usr/bin/sha256sum -- "$artifact_fd_path")
source_digest_after=${source_digest_after%% *}
staged_digest=$(/usr/bin/sha256sum -- "$staged_controller")
staged_digest=${staged_digest%% *}
if [[ $artifact_digest != "$source_digest_after" || $artifact_digest != "$staged_digest" ]]; then
  fail "artifact changed while it was copied"
fi
/usr/bin/mv -fT -- "$staged_controller" /opt/tomverse-amux-v22/recovery-controller.mjs
trap - EXIT
exec {artifact_fd}<&-
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
assert_controller_install_safe
/usr/bin/printf '%s\n' \
  'prepared only; controller service is inactive and its timer is disabled and inactive; no activation action was issued'
