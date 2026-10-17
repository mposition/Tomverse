#!/usr/bin/env bash
# AMUX Decision Maker runner installation: docs/policy/amux-decision-maker.md
# policy version 2, §5 (the broker and the vendor accounts' launchers) and §5a
# (the CLIs at root-owned paths with their sha256, the schema file), stage
# S2-3b. The operator runs it as root from the release directory that
# `npm run build:amux-decision-maker` made, copied to a root-owned place:
#
#   bash <release>/install-amux-decision-maker.sh --manifest-sha256 <hex>           # dry run
#   bash <release>/install-amux-decision-maker.sh --manifest-sha256 <hex> --apply   # install
#
# The dry run (the default) runs every check, prints the plan and changes
# nothing. --apply installs only when every check passes:
#
#   /opt/tomverse-amux-dm/{broker.mjs,launcher.mjs,dm-output-schema-v1.json}
#   /opt/tomverse-amux-dm/codex-cli-0.162.1/codex        copied from the vendor account's install
#   /opt/tomverse-amux-dm/claude-code-2.1.296/claude     copied from the vendor account's install
#   /etc/systemd/system/amux-dm-*.{socket,service}       six units
#
# A destination is left alone only when it is already root's regular file,
# root's group, exactly the wanted mode, one link, with the expected bytes.
# Anything else there -- other bytes, or the right bytes with another owner,
# mode or a second link -- is first copied to
# /var/backups/tomverse-amux-dm/<UTC time>/ and then replaced. A link or a
# directory at a destination is refused. Every existing directory on the way
# to a destination or the backup must be root's, not a link and not writable
# by group or others (checked in the dry run too, and again before each move).
# Every copy is staged in its destination's directory, checked against its
# expected sha256 and renamed into place. Then `systemctl daemon-reload`.
#
# It never enables, starts, stops or restarts a unit; never runs a CLI except
# `--version` (as nobody, with no network and an empty environment); sends
# nothing to any model; and does not touch the accounts, their homes or
# logins, /var/lib/amux-dm, the egress rules or the bridge.
set -euo pipefail
umask 077

readonly DM_OPT=/opt/tomverse-amux-dm
readonly DM_UNIT_DIR=/etc/systemd/system
readonly DM_BACKUP_ROOT=/var/backups/tomverse-amux-dm

# §5a: the root-owned executables and their sha256, and the schema file.
# tests/amuxDecisionMakerInstall.test.mjs holds these equal to
# lib/amux/decisionMakerLauncherCore.ts.
readonly DM_CODEX_DEST=/opt/tomverse-amux-dm/codex-cli-0.162.1/codex
readonly DM_CLAUDE_DEST=/opt/tomverse-amux-dm/claude-code-2.1.296/claude
readonly DM_CODEX_SHA256=628e35487d888a28f0427fc37501da529dd3d81fcbad7a2c3421c1e8670d92e1
readonly DM_CLAUDE_SHA256=24972e3bc859fab2b46ed4c1e51f7d6130f06d3bd550811a114640de3370d0de
readonly DM_CODEX_VERSION="codex-cli 0.162.1"
readonly DM_CLAUDE_VERSION="2.1.296"
readonly DM_SCHEMA_DEST=/opt/tomverse-amux-dm/dm-output-schema-v1.json
readonly DM_SCHEMA_SHA256=11cfb4a3e73ce61bb036c5da6547f3b13e2ed9259c41427afa56ec1bc00d41b7

# §5a: the files the operator measured on 2026-10-17, in the vendor accounts' homes.
readonly DM_CODEX_SOURCE=/home/amux-dm-openai/.codex/packages/standalone/releases/0.162.1-x86_64-unknown-linux-musl/bin/codex
readonly DM_CLAUDE_SOURCE=/home/amux-dm-anthropic/.local/share/claude/versions/2.1.296

# S0's accounts (docs/ops/amux/decision-maker-s0-records/2026-10-13__a3f51403afccf147442f7c2ca7eeb4ccf97b8068.md).
readonly DM_BROKER_USER=amux-dm-broker
readonly DM_BROKER_UID=993
readonly DM_OPENAI_USER=amux-dm-openai
readonly DM_OPENAI_UID=992
readonly DM_ANTHROPIC_USER=amux-dm-anthropic
readonly DM_ANTHROPIC_UID=991
readonly DM_BRIDGE_USER=tomverse-bridge
readonly DM_BRIDGE_UID=995

readonly DM_UNITS=(
  amux-dm-broker.socket
  amux-dm-broker.service
  amux-dm-launcher-openai.socket
  "amux-dm-launcher-openai@.service"
  amux-dm-launcher-anthropic.socket
  "amux-dm-launcher-anthropic@.service"
)

# Exactly what scripts/build-amux-decision-maker.mjs puts in manifest.sha256.
readonly DM_RELEASE_FILES=(
  broker.mjs
  launcher.mjs
  dm-output-schema-v1.json
  install-amux-decision-maker.sh
  systemd/amux-dm-broker.socket
  systemd/amux-dm-broker.service
  systemd/amux-dm-launcher-openai.socket
  "systemd/amux-dm-launcher-openai@.service"
  systemd/amux-dm-launcher-anthropic.socket
  "systemd/amux-dm-launcher-anthropic@.service"
)

dm_fail() {
  printf 'install-amux-decision-maker.sh: %s\n' "$*" >&2
  exit 2
}

dm_usage() {
  dm_fail "usage: bash install-amux-decision-maker.sh --manifest-sha256 <64 hex> [--apply]"
}

dm_is_sha256() {
  [[ ${1:-} =~ ^[0-9a-f]{64}$ ]]
}

# Sets DM_APPLY (0 or 1) and DM_MANIFEST_SHA256. Anything else is a usage error.
dm_parse_args() {
  DM_APPLY=0
  DM_MANIFEST_SHA256=
  while (($# > 0)); do
    case $1 in
      --apply)
        ((DM_APPLY == 0)) || dm_usage
        DM_APPLY=1
        shift ;;
      --manifest-sha256)
        [[ -z $DM_MANIFEST_SHA256 && $# -ge 2 ]] || dm_usage
        dm_is_sha256 "$2" || dm_usage
        DM_MANIFEST_SHA256=$2
        shift 2 ;;
      *) dm_usage ;;
    esac
  done
  [[ -n $DM_MANIFEST_SHA256 ]] || dm_usage
}

dm_sha256_of() {
  local digest
  digest=$(/usr/bin/sha256sum -- "$1" 2>/dev/null) || return 1
  printf '%s\n' "${digest%% *}"
}

# What is at a destination, without following a link:
#   absent | link | other | unreadable | file <uid> <gid> <mode> <links> <sha256>
dm_file_state() {
  local path=$1 meta digest
  if [[ -L $path ]]; then
    printf 'link\n'
  elif [[ ! -e $path ]]; then
    printf 'absent\n'
  elif [[ ! -f $path ]]; then
    printf 'other\n'
  elif meta=$(/usr/bin/stat -c '%u %g %a %h' -- "$path" 2>/dev/null) && digest=$(dm_sha256_of "$path"); then
    printf 'file %s %s\n' "$meta" "$digest"
  else
    printf 'unreadable\n'
  fi
}

# The action for one destination, from its state, the wanted sha256 and mode:
#   install  nothing there
#   same     root's regular file, root's group, exactly the mode, one link, the bytes: left alone
#   repair   the bytes, but anything else differs: replaced atomically like any other file
#   replace  other bytes: kept in the backup, then replaced
# A link, a directory, anything else or anything unreadable is refused (non-zero).
# Equal bytes alone never mean "same": a file its account can rewrite, or with a
# second name somebody else holds, would change what systemd runs later.
dm_file_action() {
  local state=${1:-} wanted=${2:-} mode=${3:-} kind uid gid have links digest extra
  dm_is_sha256 "$wanted" && [[ $mode =~ ^0?[0-7]{3}$ ]] || return 1
  read -r kind uid gid have links digest extra <<<"$state"
  case $kind in
    absent)
      [[ -z $uid ]] || return 1
      printf 'install\n'
      return 0 ;;
    file) ;;
    *) return 1 ;;
  esac
  [[ $uid =~ ^[0-9]+$ && $gid =~ ^[0-9]+$ && $have =~ ^[0-7]{3,4}$ && $links =~ ^[1-9][0-9]*$ && -z $extra ]] || return 1
  dm_is_sha256 "$digest" || return 1
  if [[ $digest != "$wanted" ]]; then
    printf 'replace\n'
  elif [[ $uid == 0 && $gid == 0 && $links == 1 ]] && ((8#$have == 8#$mode)); then
    printf 'same\n'
  else
    printf 'repair\n'
  fi
}

# A directory, without following a link: absent | link | other | dir <uid> <mode>
dm_directory_state() {
  local path=$1 meta
  if [[ -L $path ]]; then
    printf 'link\n'
  elif [[ ! -e $path ]]; then
    printf 'absent\n'
  elif [[ ! -d $path ]]; then
    printf 'other\n'
  elif meta=$(/usr/bin/stat -c '%u %a' -- "$path" 2>/dev/null); then
    printf 'dir %s\n' "$meta"
  else
    printf 'other\n'
  fi
}

# A directory something is installed or backed up under: root's, a real directory, no group or other write.
dm_directory_fits() {
  local kind uid mode extra
  read -r kind uid mode extra <<<"${1:-}"
  [[ $kind == dir && $uid == 0 && $mode =~ ^[0-7]{3,4}$ && -z $extra ]] && (((8#$mode & 0022) == 0))
}

# Every existing directory from the one holding $1 up to /, deepest first.
# Prints the first that does not fit, with why (link, not-a-directory, owner,
# writable), and fails. Directories that do not exist yet are skipped: the
# installer makes them, under one that was checked.
dm_ancestors_problem() {
  local cursor state kind uid mode reasons
  cursor=$(/usr/bin/dirname -- "$1")
  while :; do
    state=$(dm_directory_state "$cursor")
    if [[ $state != absent ]] && ! dm_directory_fits "$state"; then
      read -r kind uid mode <<<"$state"
      case $kind in
        link) reasons=link ;;
        dir)
          reasons=
          [[ $uid == 0 ]] || reasons="$reasons owner"
          [[ $mode =~ ^[0-7]{3,4}$ ]] && (((8#$mode & 0022) == 0)) || reasons="$reasons writable"
          reasons=${reasons# } ;;
        *) reasons=not-a-directory ;;
      esac
      printf '%s %s\n' "$cursor" "$reasons"
      return 1
    fi
    [[ $cursor == / ]] && return 0
    cursor=$(/usr/bin/dirname -- "$cursor")
  done
}

# Every path the apply may write: the eleven destinations, and one inside the backup root.
dm_destination_paths() {
  local unit
  printf '%s\n' "$DM_OPT/broker.mjs" "$DM_OPT/launcher.mjs" "$DM_SCHEMA_DEST" "$DM_CODEX_DEST" "$DM_CLAUDE_DEST"
  for unit in "${DM_UNITS[@]}"; do
    printf '%s\n' "$DM_UNIT_DIR/$unit"
  done
  printf '%s\n' "$DM_BACKUP_ROOT/run"
}

# Two word lists name the same set (order and repeats ignored).
dm_same_words() {
  local left right
  left=$(printf '%s\n' ${1:-} | LC_ALL=C sort -u)
  right=$(printf '%s\n' ${2:-} | LC_ALL=C sort -u)
  [[ $left == "$right" ]]
}

# One line of manifest.sha256: `<sha256>  <release path>` with a known path.
dm_manifest_line_fits() {
  local line=${1:-} digest path known
  [[ $line =~ ^([0-9a-f]{64})\ \ ([A-Za-z0-9@._/-]+)$ ]] || return 1
  digest=${BASH_REMATCH[1]}
  path=${BASH_REMATCH[2]}
  for known in "${DM_RELEASE_FILES[@]}"; do
    [[ $path == "$known" ]] && return 0
  done
  return 1
}

# A unit state that permits replacing its file: not running and not about to.
dm_unit_state_allows_install() {
  case ${1:-} in
    inactive|failed|unknown) return 0 ;;
    *) return 1 ;;
  esac
}

# Sourcing exposes the deterministic functions above to tests and stops here.
if [[ ${BASH_SOURCE[0]} != "$0" ]]; then
  return 0
fi

DM_FAILURES=0
dm_check() {
  local name=$1
  shift
  if "$@"; then
    printf 'check ok    %s\n' "$name"
  else
    printf 'check FAIL  %s\n' "$name"
    DM_FAILURES=$((DM_FAILURES + 1))
  fi
}

# A regular file, not a link, owned by root and not writable by group or others, one link.
dm_root_file() {
  [[ -f $1 && ! -L $1 ]] || return 1
  local uid mode links
  IFS=: read -r uid mode links < <(/usr/bin/stat -c '%u:%a:%h' -- "$1") || return 1
  [[ $uid == 0 && $links == 1 && $mode =~ ^[0-7]{3,4}$ ]] && (((8#$mode & 0022) == 0))
}

# Every directory from $1 up to / is root's, not a link, and not group/other writable.
dm_root_chain() {
  local cursor=$1 uid mode
  while :; do
    [[ -d $cursor && ! -L $cursor ]] || return 1
    IFS=: read -r uid mode < <(/usr/bin/stat -c '%u:%a' -- "$cursor") || return 1
    [[ $uid == 0 && $mode =~ ^[0-7]{3,4}$ ]] && (((8#$mode & 0022) == 0)) || return 1
    [[ $cursor == / ]] && return 0
    cursor=$(/usr/bin/dirname -- "$cursor")
  done
}

dm_owner_mode_is() {
  [[ -d $1 && ! -L $1 && $(/usr/bin/stat -c '%U:%G:%a' -- "$1") == "$2" ]]
}

dm_account_is() {
  local user=$1 uid=$2 groups=$3
  [[ $(/usr/bin/id -u -- "$user" 2>/dev/null) == "$uid" ]] &&
    dm_same_words "$(/usr/bin/id -nG -- "$user" 2>/dev/null)" "$groups"
}

dm_bridge_group_is_its_own() {
  # SocketGroup=tomverse-bridge: the bridge's own primary group, with no other members.
  local members
  [[ $(/usr/bin/id -u -- "$DM_BRIDGE_USER" 2>/dev/null) == "$DM_BRIDGE_UID" ]] || return 1
  [[ $(/usr/bin/id -gn -- "$DM_BRIDGE_USER" 2>/dev/null) == "$DM_BRIDGE_USER" ]] || return 1
  members=$(/usr/bin/getent group "$DM_BRIDGE_USER" | /usr/bin/cut -d: -f4) || return 1
  [[ -z $members ]]
}

dm_units_not_running() {
  local unit state instances
  for unit in amux-dm-broker.socket amux-dm-broker.service amux-dm-launcher-openai.socket \
    amux-dm-launcher-anthropic.socket; do
    state=$(/usr/bin/systemctl is-active -- "$unit" 2>/dev/null || true)
    dm_unit_state_allows_install "$state" || return 1
  done
  instances=$(/usr/bin/systemctl list-units --all --type=service --no-legend --plain \
    'amux-dm-launcher-openai@*.service' 'amux-dm-launcher-anthropic@*.service' 2>/dev/null) || return 1
  [[ -z $instances ]]
}

dm_manifest_fits() {
  local manifest=$DM_RELEASE/manifest.sha256 line digest path seen=" " expected actual
  dm_root_file "$manifest" || return 1
  [[ $(dm_sha256_of "$manifest") == "$DM_MANIFEST_SHA256" ]] || return 1
  while IFS= read -r line || [[ -n $line ]]; do
    dm_manifest_line_fits "$line" || return 1
    digest=${line%%  *}
    path=${line#*  }
    [[ $seen != *" $path "* ]] || return 1
    seen="$seen$path "
    dm_root_file "$DM_RELEASE/$path" || return 1
    [[ $(dm_sha256_of "$DM_RELEASE/$path") == "$digest" ]] || return 1
    DM_RELEASE_SHA256[$path]=$digest
  done <"$manifest"
  for expected in "${DM_RELEASE_FILES[@]}"; do
    [[ -n ${DM_RELEASE_SHA256[$expected]:-} ]] || return 1
  done
  actual=${DM_RELEASE_SHA256[dm-output-schema-v1.json]}
  [[ $actual == "$DM_SCHEMA_SHA256" ]]
}

dm_cli_source_fits() {
  [[ -f $1 && ! -L $1 && $(dm_sha256_of "$1") == "$2" ]]
}

dm_tools_present() {
  local tool
  for tool in /usr/bin/node /usr/bin/sha256sum /usr/bin/stat /usr/bin/install /usr/bin/systemctl \
    /usr/bin/systemd-analyze /usr/bin/unshare /usr/sbin/runuser /usr/bin/env /usr/bin/timeout; do
    [[ -x $tool ]] || return 1
  done
}

# `<executable> --version` as nobody, in a new network namespace, with an empty environment.
dm_cli_version_fits() {
  local executable=$1 expected=$2 output
  output=$(cd / && /usr/bin/unshare --net -- /usr/sbin/runuser -u nobody -- /usr/bin/env -i \
    HOME=/nonexistent PATH=/usr/bin:/bin LANG=C.UTF-8 LC_ALL=C.UTF-8 \
    /usr/bin/timeout --signal=KILL 30 "$executable" --version 2>/dev/null) || return 1
  [[ $output == *"$expected"* ]]
}

# Every directory that exists on the way to a destination or the backup fits
# (dm_ancestors_problem); each one that does not is listed once.
dm_destinations_safe() {
  local path problem problems=""
  while IFS= read -r path; do
    problem=$(dm_ancestors_problem "$path") || problems+="$problem"$'\n'
  done < <(dm_destination_paths)
  [[ -z $problems ]] && return 0
  printf '%s' "$problems" | LC_ALL=C sort -u | while IFS= read -r problem; do
    printf '            unsafe directory: %s\n' "$problem"
  done
  return 1
}

# One destination: its source in the release (or a vendor home), wanted sha256 and mode.
declare -a DM_PLAN_DEST=() DM_PLAN_SOURCE=() DM_PLAN_SHA=() DM_PLAN_MODE=() DM_PLAN_ACTION=()
dm_plan() {
  local dest=$1 source=$2 wanted=$3 mode=$4 state action
  state=$(dm_file_state "$dest")
  action=$(dm_file_action "$state" "$wanted" "$mode") || {
    printf 'plan FAIL   %s is %s, which this script does not replace\n' "$dest" "${state%% *}"
    DM_FAILURES=$((DM_FAILURES + 1))
    return 0
  }
  DM_PLAN_DEST+=("$dest")
  DM_PLAN_SOURCE+=("$source")
  DM_PLAN_SHA+=("$wanted")
  DM_PLAN_MODE+=("$mode")
  DM_PLAN_ACTION+=("$action")
  printf 'plan %-8s %s  %s\n' "$action" "$dest" "$wanted"
}

# Staged files not yet moved into place; removed on any exit.
DM_STAGED=()
dm_remove_staged() {
  local stage
  for stage in "${DM_STAGED[@]}"; do
    /usr/bin/rm -f -- "$stage"
  done
}

# Stages a copy in the destination's own checked directory (root's 0600 file,
# same filesystem), checks its bytes, gives it root's owner and the mode, checks
# the directories on the way again, and renames it over the destination -- an
# atomic replacement that never follows a link and leaves no second name. The
# result must then be exactly what the plan calls "same".
dm_put() {
  local dest=$1 source=$2 wanted=$3 mode=$4 directory problem stage
  directory=$(/usr/bin/dirname -- "$dest")
  problem=$(dm_ancestors_problem "$dest") || dm_fail "not installing $dest: unsafe directory $problem"
  [[ -d $directory && ! -L $directory ]] || dm_fail "not installing $dest: its directory is missing"
  stage=$(/usr/bin/mktemp -- "$directory/.amux-dm-install.XXXXXXXX") || dm_fail "not installing $dest: cannot stage it"
  DM_STAGED+=("$stage")
  /usr/bin/cp -- "$source" "$stage"
  [[ $(dm_sha256_of "$stage") == "$wanted" ]] || dm_fail "copy of $dest does not match its sha256; nothing moved for it"
  /usr/bin/chown root:root -- "$stage"
  /usr/bin/chmod "$mode" -- "$stage"
  problem=$(dm_ancestors_problem "$dest") || dm_fail "not installing $dest: unsafe directory $problem"
  /usr/bin/mv -fT -- "$stage" "$dest"
  [[ $(dm_file_action "$(dm_file_state "$dest")" "$wanted" "$mode") == same ]] ||
    dm_fail "installed $dest is not root's regular file with mode $mode, one link and its sha256"
}

dm_main() {
  dm_parse_args "$@"
  ((EUID == 0)) || dm_fail "run as root (the vendor homes are readable only by their accounts)"
  DM_RELEASE=$(cd -- "$(/usr/bin/dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
  declare -gA DM_RELEASE_SHA256=()

  printf 'AMUX Decision Maker install (%s)\n' "$( ((DM_APPLY)) && printf apply || printf 'dry run: nothing is changed')"
  dm_check "tools present" dm_tools_present
  dm_check "release directory is root's and not writable by others" dm_root_chain "$DM_RELEASE"
  dm_check "manifest.sha256 has the given sha256 and every release file matches it" dm_manifest_fits
  dm_check "account $DM_BROKER_USER is uid $DM_BROKER_UID in its own and both vendor groups" \
    dm_account_is "$DM_BROKER_USER" "$DM_BROKER_UID" "$DM_BROKER_USER $DM_OPENAI_USER $DM_ANTHROPIC_USER"
  dm_check "account $DM_OPENAI_USER is uid $DM_OPENAI_UID in its own group only" \
    dm_account_is "$DM_OPENAI_USER" "$DM_OPENAI_UID" "$DM_OPENAI_USER"
  dm_check "account $DM_ANTHROPIC_USER is uid $DM_ANTHROPIC_UID in its own group only" \
    dm_account_is "$DM_ANTHROPIC_USER" "$DM_ANTHROPIC_UID" "$DM_ANTHROPIC_USER"
  dm_check "bridge $DM_BRIDGE_USER is uid $DM_BRIDGE_UID and its group has no other member" dm_bridge_group_is_its_own
  dm_check "/home/$DM_OPENAI_USER is $DM_OPENAI_USER:$DM_OPENAI_USER 700" \
    dm_owner_mode_is "/home/$DM_OPENAI_USER" "$DM_OPENAI_USER:$DM_OPENAI_USER:700"
  dm_check "/home/$DM_ANTHROPIC_USER is $DM_ANTHROPIC_USER:$DM_ANTHROPIC_USER 700" \
    dm_owner_mode_is "/home/$DM_ANTHROPIC_USER" "$DM_ANTHROPIC_USER:$DM_ANTHROPIC_USER:700"
  dm_check "/var/lib/amux-dm is root:root 755" dm_owner_mode_is /var/lib/amux-dm root:root:755
  dm_check "/var/lib/amux-dm/requests is $DM_BROKER_USER:$DM_BROKER_USER 711" \
    dm_owner_mode_is /var/lib/amux-dm/requests "$DM_BROKER_USER:$DM_BROKER_USER:711"
  dm_check "no managed settings for claude (/etc/claude-code absent)" test ! -e /etc/claude-code -a ! -L /etc/claude-code
  dm_check "codex source is §5a's file" dm_cli_source_fits "$DM_CODEX_SOURCE" "$DM_CODEX_SHA256"
  dm_check "claude source is §5a's file" dm_cli_source_fits "$DM_CLAUDE_SOURCE" "$DM_CLAUDE_SHA256"
  dm_check "no Decision Maker unit is running" dm_units_not_running
  dm_check "every existing directory on the way to a destination or the backup is root's, not a link, not writable by others" \
    dm_destinations_safe

  if ((DM_FAILURES == 0)); then
    dm_plan "$DM_OPT/broker.mjs" "$DM_RELEASE/broker.mjs" "${DM_RELEASE_SHA256[broker.mjs]}" 0444
    dm_plan "$DM_OPT/launcher.mjs" "$DM_RELEASE/launcher.mjs" "${DM_RELEASE_SHA256[launcher.mjs]}" 0444
    dm_plan "$DM_SCHEMA_DEST" "$DM_RELEASE/dm-output-schema-v1.json" "$DM_SCHEMA_SHA256" 0444
    dm_plan "$DM_CODEX_DEST" "$DM_CODEX_SOURCE" "$DM_CODEX_SHA256" 0555
    dm_plan "$DM_CLAUDE_DEST" "$DM_CLAUDE_SOURCE" "$DM_CLAUDE_SHA256" 0555
    local unit
    for unit in "${DM_UNITS[@]}"; do
      dm_plan "$DM_UNIT_DIR/$unit" "$DM_RELEASE/systemd/$unit" "${DM_RELEASE_SHA256[systemd/$unit]}" 0644
    done
  fi
  if ((DM_FAILURES > 0)); then
    printf '%d check(s) failed; nothing was changed\n' "$DM_FAILURES"
    exit 2
  fi
  local units=()
  for unit in "${DM_UNITS[@]}"; do units+=("$DM_RELEASE/systemd/$unit"); done
  /usr/bin/systemd-analyze verify "${units[@]}" || dm_fail "systemd-analyze rejects the release's units; nothing was changed"
  if ((DM_APPLY == 0)); then
    printf 'dry run: nothing was changed. Run again with --apply to install the plan above.\n'
    exit 0
  fi

  local stamp backup index problem
  stamp=$(/usr/bin/date -u +%Y%m%dT%H%M%SZ)
  backup=$DM_BACKUP_ROOT/$stamp
  trap dm_remove_staged EXIT
  # Again right before the first change; then only directories of this
  # installation are made or given a mode, each under a checked one.
  dm_destinations_safe || dm_fail "a directory on the way to a destination or the backup is unsafe; nothing was changed"
  /usr/bin/install -d -o root -g root -m 0700 -- "$DM_BACKUP_ROOT"
  /usr/bin/install -d -o root -g root -m 0755 -- "$DM_OPT"
  /usr/bin/install -d -o root -g root -m 0755 -- \
    "$(/usr/bin/dirname -- "$DM_CODEX_DEST")" "$(/usr/bin/dirname -- "$DM_CLAUDE_DEST")"
  for index in "${!DM_PLAN_DEST[@]}"; do
    case ${DM_PLAN_ACTION[$index]} in
      same) continue ;;
      replace|repair)
        problem=$(dm_ancestors_problem "$backup/x") || dm_fail "not keeping a backup: unsafe directory $problem"
        /usr/bin/install -d -o root -g root -m 0700 -- "$backup$(/usr/bin/dirname -- "${DM_PLAN_DEST[$index]}")"
        /usr/bin/cp -a -- "${DM_PLAN_DEST[$index]}" "$backup${DM_PLAN_DEST[$index]}"
        printf 'kept     %s -> %s\n' "${DM_PLAN_DEST[$index]}" "$backup${DM_PLAN_DEST[$index]}" ;;
    esac
    dm_put "${DM_PLAN_DEST[$index]}" "${DM_PLAN_SOURCE[$index]}" "${DM_PLAN_SHA[$index]}" "${DM_PLAN_MODE[$index]}"
    printf 'put      %s\n' "${DM_PLAN_DEST[$index]}"
  done
  /usr/bin/systemctl daemon-reload

  local versions=0
  dm_cli_version_fits "$DM_CODEX_DEST" "$DM_CODEX_VERSION" || versions=1
  dm_cli_version_fits "$DM_CLAUDE_DEST" "$DM_CLAUDE_VERSION" || versions=1
  dm_units_not_running || dm_fail "a Decision Maker unit is running after the install; it was not started by this script"
  if ((versions)); then
    printf 'installed, but an executable at its root-owned path did not print its §5a version; no unit was enabled or started\n'
    exit 3
  fi
  printf 'installed; both executables print their §5a version; no unit was enabled or started\n'
}

dm_main "$@"
