#!/usr/bin/env bash
set -euo pipefail
umask 077

fail() {
  echo "install-amux-v22-read-only-api-sidecar.sh: $*" >&2
  exit 2
}

api_template_listing_allows_prepare() {
  local status=${1:-} output=${2-}
  if [[ $status == 1 && -z $output ]]; then
    return 0
  fi
  [[ $status == 0 && -n $output && $output != *$'\n'* ]] || return 1
  local unit state preset extra
  read -r unit state preset extra <<<"$output"
  [[ $unit == "amux-v22-read-only-api-sidecar@.service" &&
    $state == "static" && $preset == "-" && -z $extra ]]
}

api_account_groups_are_exact() {
  local primary_gid=${1:-} ipc_gid=${2:-} group_ids=${3:-}
  [[ $primary_gid =~ ^[1-9][0-9]*$ && $ipc_gid =~ ^[1-9][0-9]*$ &&
    $primary_gid == "$ipc_gid" && $group_ids == "$ipc_gid" ]]
}

inspect_api_template_state() {
  local output status=0
  output=$(LANG=C LC_ALL=C SYSTEMD_COLORS=0 \
    /usr/bin/systemctl list-unit-files --no-legend --plain \
    'amux-v22-read-only-api-sidecar@.service' 2>/dev/null) || status=$?
  api_template_listing_allows_prepare "$status" "$output" ||
    fail "API sidecar unit is installed in a state that forbids preparation"
}

assert_no_live_api_instances() {
  local output
  output=$(/usr/bin/systemctl list-units --all --type=service --no-legend --plain \
    'amux-v22-read-only-api-sidecar@*.service' 2>/dev/null) ||
    fail "API sidecar instance state is unavailable"
  [[ -z $output ]] || fail "API sidecar instance exists; preparation requires no loaded instances"
  output=$(/usr/bin/systemctl list-jobs --no-legend --plain 2>/dev/null) ||
    fail "API sidecar job state is unavailable"
  [[ $output != *"amux-v22-read-only-api-sidecar@"* ]] ||
    fail "API sidecar job is queued"
}

assert_install_safe() {
  inspect_api_template_state
  assert_no_live_api_instances
}

# Sourcing exposes deterministic preflight functions to synthetic tests only.
if [[ ${BASH_SOURCE[0]} != "$0" ]]; then
  return 0
fi

# Preparation installs reviewed inert artifacts and may create only the fixed
# non-login API account and IPC group. It never copies a key, creates a live
# profile, changes an existing bridge account, or enables/starts/stops any service.
if [[ ${1:-} != "--prepare-only" || $EUID -ne 0 ]]; then
  fail "usage: sudo ./install-amux-v22-read-only-api-sidecar.sh --prepare-only"
fi

source_dir=$(cd -- "$(dirname -- "$0")" && pwd -P)
unit_source=$source_dir/systemd/amux-v22-read-only-api-sidecar@.service
expected_unit_digest=138b4a7eb58a3a6139b5a381127241f06efe3494223b050779ecb48c789c146d
unit_source_digest=$(/usr/bin/sha256sum -- "$unit_source") ||
  fail "fixed API sidecar unit artifact is required"
unit_source_digest=${unit_source_digest%% *}
[[ $unit_source_digest == "$expected_unit_digest" ]] ||
  fail "fixed API sidecar unit artifact is required"
artifact=${AMUX_V22_READ_ONLY_API_SIDECAR_ARTIFACT:-}
if [[ ! $artifact =~ ^/[^[:cntrl:]]+/amux-v22-read-only-api-sidecar\.mjs$ ]]; then
  fail "fixed bundled API sidecar artifact is required"
fi
artifact_real=$(/usr/bin/realpath -e -- "$artifact") ||
  fail "fixed bundled API sidecar artifact is required"
if [[ $artifact_real != "$artifact" || ! -f $artifact || -L $artifact ]]; then
  fail "fixed bundled API sidecar artifact is required"
fi

artifact_parent=$(/usr/bin/dirname -- "$artifact")
cursor=$artifact_parent
while :; do
  [[ -d $cursor && ! -L $cursor ]] || fail "artifact parent is not fixed"
  parent_uid=$(/usr/bin/stat -Lc '%u' -- "$cursor")
  parent_mode=$(/usr/bin/stat -Lc '%a' -- "$cursor")
  if [[ $parent_uid != 0 || ! $parent_mode =~ ^[0-7]{3,4}$ ]] ||
    (( (8#$parent_mode & 0022) != 0 )); then
    fail "artifact parent must be root-owned and not group/other writable"
  fi
  [[ $cursor == / ]] && break
  cursor=$(/usr/bin/dirname -- "$cursor")
done

exec {artifact_fd}<"$artifact" || fail "fixed bundled API sidecar artifact is required"
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

assert_install_safe
api_user=tomverse-amux-v22-api
ipc_group=amux-v22-ipc
if ! /usr/bin/getent group "$ipc_group" >/dev/null; then
  /usr/sbin/groupadd --system "$ipc_group" || fail "could not create fixed IPC group"
fi
if ! /usr/bin/getent passwd "$api_user" >/dev/null; then
  /usr/sbin/useradd --system --gid "$ipc_group" --home-dir /nonexistent \
    --no-create-home --shell /usr/sbin/nologin "$api_user" ||
    fail "could not create fixed API executor account"
fi
group_record=$(/usr/bin/getent group "$ipc_group") || fail "fixed IPC group is required"
IFS=: read -r _ _ ipc_gid _ <<<"$group_record"
api_passwd=$(/usr/bin/getent passwd "$api_user") ||
  fail "fixed API executor account is required"
IFS=: read -r api_name _ api_uid api_primary_gid _ api_home api_shell <<<"$api_passwd"
if [[ $api_name != "$api_user" || ! $api_uid =~ ^[0-9]+$ ||
  $api_home != /nonexistent || $api_shell != /usr/sbin/nologin ]]; then
  fail "fixed non-login API executor account is required"
fi
api_groups=$(/usr/bin/id -G "$api_user") ||
  fail "fixed API executor group boundary is unavailable"
if (( api_uid == 0 )) ||
  ! api_account_groups_are_exact "$api_primary_gid" "$ipc_gid" "$api_groups"; then
  fail "API executor must have only the fixed IPC primary group"
fi
assert_install_safe

/usr/bin/install -d -o root -g root -m 0755 /opt/tomverse-amux-v22
/usr/bin/install -d -o root -g root -m 0755 /etc/tomverse-amux-v22 \
  /etc/tomverse-amux-v22/read-only-api /srv/tomverse-amux-v22-read-only-api \
  /srv/tomverse-amux-v22-read-only-api/repository
staged_artifact=/opt/tomverse-amux-v22/.read-only-api-sidecar.mjs.prepare.$$
trap '/usr/bin/rm -f -- "$staged_artifact"' EXIT
/usr/bin/install -o root -g root -m 0555 "$artifact_fd_path" "$staged_artifact"
source_digest_after=$(/usr/bin/sha256sum -- "$artifact_fd_path")
source_digest_after=${source_digest_after%% *}
staged_digest=$(/usr/bin/sha256sum -- "$staged_artifact")
staged_digest=${staged_digest%% *}
if [[ $artifact_digest != "$source_digest_after" || $artifact_digest != "$staged_digest" ]]; then
  fail "artifact changed while it was copied"
fi
/usr/bin/mv -fT -- "$staged_artifact" /opt/tomverse-amux-v22/read-only-api-sidecar.mjs
trap - EXIT
exec {artifact_fd}<&-

/usr/bin/install -o root -g root -m 0644 \
  "$unit_source" \
  /etc/systemd/system/amux-v22-read-only-api-sidecar@.service
installed_unit_digest=$(/usr/bin/sha256sum -- \
  /etc/systemd/system/amux-v22-read-only-api-sidecar@.service)
installed_unit_digest=${installed_unit_digest%% *}
[[ $installed_unit_digest == "$expected_unit_digest" ]] ||
  fail "installed API sidecar unit artifact changed"
for example in amux-v22-read-only-api-sidecar.env.example \
  amux-v22-read-only-api-credential-profile.example.json; do
  target=/etc/tomverse-amux-v22/read-only-api/$example
  if [[ ! -e $target ]]; then
    /usr/bin/install -o root -g root -m 0644 "$source_dir/systemd/$example" "$target"
  fi
done

/usr/bin/systemd-analyze verify \
  /etc/systemd/system/amux-v22-read-only-api-sidecar@.service
/usr/bin/systemctl daemon-reload
assert_install_safe
/usr/bin/printf '%s\n' \
  'prepared only; the fixed API account/group and inert artifacts may have been created; no existing bridge account, API key, live profile or worker instance was changed; no service action was issued'
