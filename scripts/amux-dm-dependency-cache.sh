#!/usr/bin/env bash
# The AMUX Decision Maker's offline dependency cache (docs/policy/amux-decision-maker.md
# §0f-4, §5a "의존성"). The DM's launcher installs each workspace tree's locked
# dependencies inside its command jail with `npm ci --offline`, from this
# cache, because the vendor accounts have no registry network
# (lib/amux/decisionMakerWorkCopy.ts). The operator runs it as root:
#
#   bash amux-dm-dependency-cache.sh --refresh   # fill the cache now from develop's public head
#   bash amux-dm-dependency-cache.sh --install   # install this script and its daily timer (not enabled)
#   systemctl enable --now amux-dm-dependency-cache.timer
#
# --refresh: everything that reaches the network or runs the repository's
# code (git clone of the public repository, npm ci without package scripts,
# `prisma generate`, which reads prisma.config.ts) runs as `nobody` in a
# fresh directory under /var/tmp, starting from a copy of the current cache,
# so the cache only grows: a workspace on an older commit keeps finding its
# packages. Root then gives the new cache root's owner, read-only to others,
# and swaps it into place:
#
#   /var/cache/tomverse-amux-dm/npm      npm's cache (cacache) for `npm ci --offline`
#   /var/cache/tomverse-amux-dm/prisma   Prisma's engine downloads (XDG_CACHE_HOME/prisma)
#
# A request that is installing while the cache is swapped keeps the directory
# it bound. Nothing here touches the vendor accounts, their homes or logins,
# the request root, the units of the launcher or broker, or the egress rules.
set -euo pipefail
umask 022

readonly DM_CACHE_ROOT=/var/cache/tomverse-amux-dm
readonly DM_CACHE_REPOSITORY=https://github.com/mposition/Tomverse.git
readonly DM_CACHE_BRANCH=develop
# lib/amux/decisionMakerWorkCopy.ts DM_PINNED_NPM_CLI: Ubuntu's own npm refuses this lockfile.
readonly DM_CACHE_NPM_CLI=/opt/tomverse-amux-v22/npm-10.9.4/bin/npm-cli.js
readonly DM_CACHE_LOCK=/run/amux-dm-dependency-cache.lock
readonly DM_CACHE_SCRIPT_DEST=/opt/tomverse-amux-dm/dependency-cache.sh
readonly DM_CACHE_UNITS=(amux-dm-dependency-cache.service amux-dm-dependency-cache.timer)
readonly DM_CACHE_UNIT_DIR=/etc/systemd/system

dm_cache_fail() {
  printf 'amux-dm-dependency-cache.sh: %s\n' "$*" >&2
  exit 2
}

dm_cache_as_nobody() {
  local work=$1
  shift
  /usr/sbin/runuser -u nobody -- /usr/bin/env -i HOME="$work/home" PATH=/usr/bin:/bin LANG=C.UTF-8 \
    XDG_CACHE_HOME="$work/xdg" CHECKPOINT_DISABLE=1 NEXT_TELEMETRY_DISABLED=1 PRISMA_HIDE_UPDATE_MESSAGE=1 \
    GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_TERMINAL_PROMPT=0 "$@"
}

# Each refresh is a new generation directory, <name>.gen-<epoch seconds>, and
# <name> is a symbolic link to the current one, replaced in one rename: there is
# no moment without a cache (review r-20261123-110507-a9b409). The launcher's jail
# binds the whole cache root, so the link resolves inside it. When the link
# moves on, the generation it left is renamed <name>.old-<replaced at>-<made at>
# and stays this long from the moment it was replaced -- a request that started
# on it keeps reading it until its hard timeout (2 h, plus the install's share
# of it) ends (reviews r-20261123-105620-63d64b, r-20261123-111521-e19df9) --
# and a later refresh removes it.
readonly DM_CACHE_KEEP_REPLACED_SECONDS=$((3 * 60 * 60))

# Renames every generation of <name> the link no longer points to as replaced now.
dm_cache_retire_replaced() {
  local root=$1 name=$2 now=$3 entry current=""
  [[ -L $root/$name ]] && current=$(/usr/bin/readlink -- "$root/$name")
  for entry in "$root/$name.gen-"*; do
    [[ -d $entry && ! -L $entry ]] || continue
    [[ ${entry##*/} != "$current" ]] || continue
    /usr/bin/mv -T -- "$entry" "$root/$name.old-$now-${entry##*.gen-}"
  done
}

# Removes replaced generations of <name> replaced more than
# DM_CACHE_KEEP_REPLACED_SECONDS ago, judged by the replacement time in their name.
dm_cache_prune_replaced() {
  local root=$1 name=$2 now=$3 entry stamp
  for entry in "$root/$name.old-"*; do
    [[ -d $entry && ! -L $entry ]] || continue
    stamp=${entry##*.old-}
    stamp=${stamp%%-*}
    [[ $stamp =~ ^[0-9]+$ ]] || continue
    if ((now - stamp > DM_CACHE_KEEP_REPLACED_SECONDS)); then
      /usr/bin/rm -rf -- "$entry"
    fi
  done
}

# Moves a finished directory into the cache as a new generation (root's,
# readable by all, writable by none but root) and points <name> at it.
dm_cache_swap() {
  local source=$1 name=$2 now generation
  now=$(/usr/bin/date +%s)
  generation=$name.gen-$now
  /usr/bin/chown -R root:root -- "$source"
  /usr/bin/chmod -R u+rwX,go+rX,go-w -- "$source"
  /usr/bin/mv -T -- "$source" "$DM_CACHE_ROOT/$generation"
  # A cache from before generations is a directory, not a link: it becomes one generation.
  if [[ -d $DM_CACHE_ROOT/$name && ! -L $DM_CACHE_ROOT/$name ]]; then
    /usr/bin/mv -T -- "$DM_CACHE_ROOT/$name" "$DM_CACHE_ROOT/$name.gen-$((now - 1))"
  fi
  /usr/bin/ln -sfn -- "$generation" "$DM_CACHE_ROOT/.$name.link-$now"
  /usr/bin/mv -T -- "$DM_CACHE_ROOT/.$name.link-$now" "$DM_CACHE_ROOT/$name"
  dm_cache_retire_replaced "$DM_CACHE_ROOT" "$name" "$now"
  dm_cache_prune_replaced "$DM_CACHE_ROOT" "$name" "$now"
}

dm_cache_refresh() {
  [[ -f $DM_CACHE_NPM_CLI ]] || dm_cache_fail "the pinned npm $DM_CACHE_NPM_CLI is not installed"
  exec 9>"$DM_CACHE_LOCK"
  /usr/bin/flock -n 9 || dm_cache_fail "another refresh is running"
  [[ -d $DM_CACHE_ROOT && ! -L $DM_CACHE_ROOT ]] || /usr/bin/install -d -o root -g root -m 0755 -- "$DM_CACHE_ROOT"
  [[ $(/usr/bin/stat -c '%U:%G:%a' -- "$DM_CACHE_ROOT") == root:root:755 ]] ||
    dm_cache_fail "$DM_CACHE_ROOT must be root:root 755 and not a link"

  local work quoted
  work=$(/usr/bin/mktemp -d /var/tmp/amux-dm-dependency-cache.XXXXXXXX)
  printf -v quoted '%q' "$work"
  trap "/usr/bin/rm -rf -- $quoted" EXIT
  /usr/bin/mkdir -p -- "$work/home" "$work/xdg"
  # The current generation's content (through the link), so the cache only grows.
  /usr/bin/mkdir -- "$work/npm" "$work/xdg/prisma"
  if [[ -d $DM_CACHE_ROOT/npm ]]; then /usr/bin/cp -a -- "$DM_CACHE_ROOT/npm/." "$work/npm/"; fi
  if [[ -d $DM_CACHE_ROOT/prisma ]]; then /usr/bin/cp -a -- "$DM_CACHE_ROOT/prisma/." "$work/xdg/prisma/"; fi
  /usr/bin/chown -R nobody:nogroup -- "$work"

  dm_cache_as_nobody "$work" /usr/bin/git -c credential.helper= -c core.hooksPath=/dev/null clone -q --depth=1 \
    --branch "$DM_CACHE_BRANCH" "$DM_CACHE_REPOSITORY" "$work/src"
  (cd -- "$work/src" && dm_cache_as_nobody "$work" /usr/bin/node "$DM_CACHE_NPM_CLI" ci --ignore-scripts \
    --no-audit --no-fund --loglevel=error --cache "$work/npm")
  (cd -- "$work/src" && dm_cache_as_nobody "$work" /usr/bin/node node_modules/prisma/build/index.js generate >/dev/null)
  [[ -n $(/usr/bin/ls -A -- "$work/xdg/prisma") ]] || dm_cache_fail "prisma generate downloaded no engine"
  local head
  head=$(/usr/bin/git -C "$work/src" -c safe.directory='*' rev-parse HEAD)

  dm_cache_swap "$work/npm" npm
  dm_cache_swap "$work/xdg/prisma" prisma
  printf 'refreshed %s from %s %s\n' "$DM_CACHE_ROOT" "$DM_CACHE_BRANCH" "$head"
}

dm_cache_install() {
  local here unit
  here=$(cd -- "$(/usr/bin/dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
  for unit in "${DM_CACHE_UNITS[@]}"; do
    [[ -f $here/systemd/$unit ]] || dm_cache_fail "$here/systemd/$unit is missing"
  done
  /usr/bin/install -d -o root -g root -m 0755 -- "$(/usr/bin/dirname -- "$DM_CACHE_SCRIPT_DEST")"
  /usr/bin/install -o root -g root -m 0555 -- "${BASH_SOURCE[0]}" "$DM_CACHE_SCRIPT_DEST"
  printf 'put      %s\n' "$DM_CACHE_SCRIPT_DEST"
  for unit in "${DM_CACHE_UNITS[@]}"; do
    /usr/bin/install -o root -g root -m 0644 -- "$here/systemd/$unit" "$DM_CACHE_UNIT_DIR/$unit"
    printf 'put      %s\n' "$DM_CACHE_UNIT_DIR/$unit"
  done
  /usr/bin/systemctl daemon-reload
  printf 'installed; the timer is not enabled: systemctl enable --now amux-dm-dependency-cache.timer\n'
}

# Sourcing exposes the functions to tests and stops here.
if [[ ${BASH_SOURCE[0]} != "$0" ]]; then
  return 0
fi

(($# == 1)) || dm_cache_fail "usage: bash amux-dm-dependency-cache.sh --refresh | --install"
((EUID == 0)) || dm_cache_fail "run as root"
case $1 in
  --refresh) dm_cache_refresh ;;
  --install) dm_cache_install ;;
  *) dm_cache_fail "usage: bash amux-dm-dependency-cache.sh --refresh | --install" ;;
esac
