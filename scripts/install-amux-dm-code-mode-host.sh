#!/usr/bin/env bash
# Codex's Code Mode host for the AMUX Decision Maker (docs/policy/amux-decision-maker.md
# §5a, "함께 두는 파일"). Codex 0.162 runs every tool call of gpt-6-astra through
# Code Mode, whose host is `codex-code-mode-host` beside the CLI; without it
# every DM command fails closed and the DM cannot read its workspace
# (AMUX-CRAWL-002, 2026-11-21). The operator runs this as root on the runner:
#
#   sudo bash install-amux-dm-code-mode-host.sh                      # dry run
#   sudo bash install-amux-dm-code-mode-host.sh --apply              # install
#   sudo bash install-amux-dm-code-mode-host.sh --rollback <backup>  # undo one --apply
#
# The dry run downloads the release asset into a private temporary directory,
# checks the asset's sha256 and the one binary's sha256, prints the plan and
# changes nothing. --apply then installs the binary root:root 0555 at
# DM_HOST_DEST, staged in the same directory and renamed into place. What was
# at the destination before (nothing, or a file) is first recorded in a fresh
# /var/backups/tomverse-amux-dm-code-mode-host/<UTC time>/; --rollback with
# that directory puts it back. Install this before the launcher release that
# expects the host: the earlier launcher passes `--disable code_mode_host` and
# does not run the file, the later one refuses to start without it.
#
# It downloads one public file from github.com and nothing else; never runs a
# CLI or the host; sends nothing to any model; and does not touch the units,
# the accounts or their homes, /var/lib/amux-dm, the egress rules or the bridge.
set -euo pipefail
umask 077

# tests/amuxDecisionMakerInstall.test.mjs holds these equal to
# lib/amux/decisionMakerLauncherCore.ts and the policy.
readonly DM_HOST_DEST=/opt/tomverse-amux-dm/codex-cli-0.162.1/codex-code-mode-host
readonly DM_HOST_SHA256=ec71830690a7c0024916ee0c99fbdc635bc6e747ff665ea4f03a8389bbcb6b30
readonly DM_HOST_ASSET_URL=https://github.com/openai/codex/releases/download/rust-v0.162.1/codex-code-mode-host-x86_64-unknown-linux-musl.tar.gz
readonly DM_HOST_ASSET_SHA256=458239ea45c1fc508d89695f180ab352f2834709a8a46929a4466f4f04399ada
readonly DM_HOST_ASSET_MEMBER=codex-code-mode-host-x86_64-unknown-linux-musl
readonly DM_HOST_BACKUP_ROOT=/var/backups/tomverse-amux-dm-code-mode-host

dm_fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}
dm_say() { printf '%s\n' "$*"; }

dm_sha256_of() {
  local digest
  digest=$(/usr/bin/sha256sum -- "$1" 2>/dev/null) || return 1
  printf '%s' "${digest%% *}"
}

# The destination's directory, and the backup root when it exists: root's, a
# real directory, not writable by group or others.
dm_directory_safe() {
  local path=$1 meta
  [[ -d $path && ! -L $path ]] || return 1
  meta=$(/usr/bin/stat -c '%u %a' -- "$path") || return 1
  [[ ${meta%% *} == 0 ]] || return 1
  (( (8#${meta##* } & 8#022) == 0 ))
}

# absent | same | other | refused (a link, a directory or anything not a regular file)
dm_dest_state() {
  if [[ ! -e $DM_HOST_DEST && ! -L $DM_HOST_DEST ]]; then
    printf 'absent'
  elif [[ -L $DM_HOST_DEST || ! -f $DM_HOST_DEST ]]; then
    printf 'refused'
  elif [[ $(dm_sha256_of "$DM_HOST_DEST") == "$DM_HOST_SHA256" && $(/usr/bin/stat -c '%u %g %a %h' -- "$DM_HOST_DEST") == "0 0 555 1" ]]; then
    printf 'same'
  else
    printf 'other'
  fi
}

# Puts a checked file in place: staged beside the destination, checked, renamed.
dm_place() {
  local source=$1 wanted=$2 stage
  dm_directory_safe "$(dirname -- "$DM_HOST_DEST")" || dm_fail "$(dirname -- "$DM_HOST_DEST") is not root's directory closed to others"
  stage="$(dirname -- "$DM_HOST_DEST")/.codex-code-mode-host.stage.$$"
  /usr/bin/install -o root -g root -m 0555 -- "$source" "$stage"
  if [[ $(dm_sha256_of "$stage") != "$wanted" ]]; then
    rm -f -- "$stage"
    dm_fail "the staged copy does not match its sha256; nothing moved"
  fi
  mv -T -- "$stage" "$DM_HOST_DEST"
}

dm_rollback() {
  local backup=$1 recorded
  [[ $EUID -eq 0 ]] || dm_fail "run as root"
  [[ $backup == "$DM_HOST_BACKUP_ROOT"/* ]] || dm_fail "the backup must be under $DM_HOST_BACKUP_ROOT"
  dm_directory_safe "$backup" || dm_fail "$backup is not root's directory closed to others"
  recorded=$(cat -- "$backup/state" 2>/dev/null) || dm_fail "$backup has no state file"
  case $recorded in
    absent)
      [[ -L $DM_HOST_DEST || -f $DM_HOST_DEST ]] && rm -f -- "$DM_HOST_DEST"
      dm_say "rolled back: $DM_HOST_DEST removed (nothing was there before)" ;;
    file)
      [[ -f $backup/codex-code-mode-host && ! -L $backup/codex-code-mode-host ]] || dm_fail "$backup has no saved file"
      dm_place "$backup/codex-code-mode-host" "$(dm_sha256_of "$backup/codex-code-mode-host")"
      dm_say "rolled back: $DM_HOST_DEST restored from $backup" ;;
    *) dm_fail "$backup/state is neither absent nor file" ;;
  esac
}

dm_main() {
  local apply=0 work state backup
  case ${1:-} in
    "") ;;
    --apply) apply=1 ;;
    --rollback)
      [[ $# -eq 2 ]] || dm_fail "usage: --rollback <backup directory>"
      dm_rollback "$2"
      return ;;
    *) dm_fail "usage: bash install-amux-dm-code-mode-host.sh [--apply | --rollback <backup directory>]" ;;
  esac
  [[ $# -le 1 ]] || dm_fail "usage: bash install-amux-dm-code-mode-host.sh [--apply | --rollback <backup directory>]"
  [[ $EUID -eq 0 ]] || dm_fail "run as root"
  for tool in /usr/bin/curl /usr/bin/sha256sum /usr/bin/stat /usr/bin/install /usr/bin/tar; do
    [[ -x $tool ]] || dm_fail "$tool is missing"
  done

  work=$(mktemp -d)
  trap 'rm -rf -- "$work"' EXIT
  /usr/bin/curl -fsSL --proto '=https' --max-time 300 -o "$work/asset.tar.gz" -- "$DM_HOST_ASSET_URL" || dm_fail "download failed"
  [[ $(dm_sha256_of "$work/asset.tar.gz") == "$DM_HOST_ASSET_SHA256" ]] || dm_fail "the release asset's sha256 is not $DM_HOST_ASSET_SHA256"
  [[ $(/usr/bin/tar -tzf "$work/asset.tar.gz") == "$DM_HOST_ASSET_MEMBER" ]] || dm_fail "the release asset holds more or other than $DM_HOST_ASSET_MEMBER"
  /usr/bin/tar -xzf "$work/asset.tar.gz" -C "$work" --no-same-owner -- "$DM_HOST_ASSET_MEMBER"
  [[ -f $work/$DM_HOST_ASSET_MEMBER && ! -L $work/$DM_HOST_ASSET_MEMBER ]] || dm_fail "the release asset's member is not a regular file"
  [[ $(dm_sha256_of "$work/$DM_HOST_ASSET_MEMBER") == "$DM_HOST_SHA256" ]] || dm_fail "the host binary's sha256 is not $DM_HOST_SHA256"
  dm_say "ok: release asset and host binary match their sha256"

  dm_directory_safe "$(dirname -- "$DM_HOST_DEST")" || dm_fail "$(dirname -- "$DM_HOST_DEST") is not root's directory closed to others"
  if [[ -e $DM_HOST_BACKUP_ROOT || -L $DM_HOST_BACKUP_ROOT ]]; then
    dm_directory_safe "$DM_HOST_BACKUP_ROOT" || dm_fail "$DM_HOST_BACKUP_ROOT is not root's directory closed to others"
  fi
  state=$(dm_dest_state)
  case $state in
    same) dm_say "nothing to do: $DM_HOST_DEST is already root's 0555 file with the pinned sha256"; return ;;
    refused) dm_fail "$DM_HOST_DEST is a link, a directory or not a regular file; refusing" ;;
    absent) dm_say "plan: install $DM_HOST_DEST (nothing there now)" ;;
    other) dm_say "plan: back up the file at $DM_HOST_DEST, then replace it" ;;
  esac
  if [[ $apply -eq 0 ]]; then
    dm_say "dry run: nothing changed. Run again with --apply to install."
    return
  fi

  /usr/bin/install -d -o root -g root -m 0700 -- "$DM_HOST_BACKUP_ROOT"
  backup="$DM_HOST_BACKUP_ROOT/$(date -u +%Y%m%dT%H%M%SZ)"
  [[ ! -e $backup ]] || dm_fail "$backup already exists"
  /usr/bin/install -d -o root -g root -m 0700 -- "$backup"
  if [[ $state == absent ]]; then
    printf 'absent\n' > "$backup/state"
  else
    /usr/bin/install -o root -g root -m 0400 -- "$DM_HOST_DEST" "$backup/codex-code-mode-host"
    printf 'file\n' > "$backup/state"
  fi
  dm_place "$work/$DM_HOST_ASSET_MEMBER" "$DM_HOST_SHA256"
  [[ $(dm_dest_state) == same ]] || dm_fail "installed $DM_HOST_DEST is not root's 0555 file with the pinned sha256"
  dm_say "installed: $DM_HOST_DEST"
  dm_say "backup: $backup (undo with --rollback $backup)"
}

if [[ ${BASH_SOURCE[0]} == "$0" ]]; then
  dm_main "$@"
fi
