import { SKIPPED_DIRS } from "./workspace.js";

/**
 * The shell the CLI sends to the remote machine, one script per kind of operation. Nothing is installed there: each run is
 * `sh -c '<script>' sh <arguments>` and needs only a POSIX shell and the usual tools (cat, mv, rm, mkdir, chmod, find, wc, stat,
 * readlink, mktemp, grep, xargs). Every value the model or the user chose arrives as a quoted argument ($1, $2, ...), never inside
 * the script text.
 *
 * The scripts do the checks that must be made on the machine where the files are: that a path really is inside the project
 * folder after the remote links are followed, and that a file is still the one that was approved. Their exit codes are listed
 * in SCRIPT_EXIT (remote-target.ts).
 */

const PRELUDE = String.raw`LC_ALL=C; export LC_ALL
inside() { case "$1" in "$2"|"$2"/*) return 0;; esac; return 1; }
ident() { stat -c '%d:%i:%a' "$1" 2>/dev/null || stat -f '%d:%i:%Lp' "$1" 2>/dev/null; }
NL='
'
plain() { case $1 in *"$NL"*) return 1;; esac; return 0; }
fid() { stat -L -c '%d:%i' "$1" 2>/dev/null || stat -L -f '%d:%i' "$1" 2>/dev/null; }
same() { [ "$(fid "$1")" = "$(fid "$2")" ]; }
rp() {
  p=$1; n=0
  while [ -L "$p" ]; do
    n=$((n+1)); [ "$n" -gt 40 ] && return 1
    t=$(readlink "$p") || return 1
    case $t in /*) p=$t;; *) p=\${p%/*}/$t;; esac
  done
  case $p in
    */.|*/..) d=$(cd -P -- "$p" 2>/dev/null && pwd -P) || return 1; printf '%s\n' "$d"; return 0;;
  esac
  d=\${p%/*}; [ -z "$d" ] && d=/
  b=\${p##*/}
  d=$(cd -P -- "$d" 2>/dev/null && pwd -P) || return 1
  if [ "$d" = / ]; then printf '%s\n' "/$b"; else printf '%s\n' "$d/$b"; fi
}
# A name from a list is usable only if it is a regular file that is not a link and no folder on its way is a link: a link anywhere
# in the name makes the real path differ from the name, whatever it points to. Needs root (the real project folder); a run of
# names in one folder checks the folder once.
safe() {
  { [ -f "$1" ] && [ ! -L "$1" ]; } || return 1
  case $1 in */*) ;; *) return 0;; esac
  sd=\${1%/*}
  [ "$sd" = "$sd_ok" ] && return 0
  [ "$(cd -P -- "$sd" 2>/dev/null && pwd -P)" = "$root/$sd" ] || return 1
  sd_ok=$sd
}
`.replaceAll("\\${", "${");

/**
 * The answers of the scripts that print "key=value" lines (probe, resolve, write) start with this line, and the parser takes the
 * lines after it. A real path with a line break in it is refused before anything is printed (exit 49), and the parser refuses a
 * repeated or unknown key, so a name can never write a line of its own.
 */
export const FIELDS_MARKER = "@tv-fields";

/** What a probe finds: the real project folder, the home folder (too broad to work in) and the system. */
export const PROBE_SCRIPT = PRELUDE + String.raw`[ -d "$1" ] || { [ -e "$1" ] && exit 41; exit 40; }
r=$(cd -P -- "$1" 2>/dev/null && pwd -P) || exit 40
h=$(cd -P -- "\${HOME:-/}" 2>/dev/null && pwd -P)
{ plain "$r" && plain "$h" && same "$r" "$1"; } || { echo name >&2; exit 49; }
for c in cat mv rm mkdir chmod find wc readlink mktemp stat grep xargs tr cut sleep; do
  command -v "$c" >/dev/null 2>&1 || { echo "$c" >&2; exit 47; }
done
ident "$r" >/dev/null || { echo stat >&2; exit 47; }
printf '@tv-fields\nroot=%s\nhome=%s\nos=%s\n' "$r" "$h" "$(uname -s 2>/dev/null)"
`.replaceAll("\\${", "${");

/**
 * Where a path really is, after the remote links are followed: $1 the real project folder, $2 an absolute path that is
 * lexically inside it. Says whether it exists, whether it is a link, what it is, and the identity of the file and of the
 * nearest existing folder around it (what an approval is bound to).
 */
export const RESOLVE_SCRIPT = PRELUDE + String.raw`root=$1; p=$2
inside "$p" "$root" || exit 42
q=$p
while [ ! -e "$q" ] && [ ! -L "$q" ]; do q=\${q%/*}; [ -z "$q" ] && { q=/; break; }; done
r=$(rp "$q") || exit 42
same "$r" "$q" || exit 42
if [ "$q" = "$p" ]; then a=$r; ex=1; else a=$r\${p#"$q"}; ex=0; fi
inside "$a" "$root" || exit 42
plain "$a" || exit 49
lk=0; [ -L "$p" ] && lk=1
kind=none
if [ "$ex" = 1 ]; then
  if [ -d "$a" ]; then kind=dir; elif [ -f "$a" ]; then kind=file; else kind=other; fi
fi
f=\${a%/*}; [ -z "$f" ] && f=/
while [ ! -d "$f" ]; do f=\${f%/*}; [ -z "$f" ] && f=/; done
plain "$f" || exit 49
printf '@tv-fields\nabs=%s\nexists=%s\nlink=%s\nkind=%s\n' "$a" "$ex" "$lk" "$kind"
[ "$kind" = file ] && printf 'ident=%s\n' "$(ident "$a")"
printf 'folder=%s\nfident=%s\n' "$f" "$(ident "$f")"
exit 0
`.replaceAll("\\${", "${");

/** $1 root, $2 the real absolute path, $3 the largest size to send. Prints "size=N ident=I" and a newline, then the bytes. */
export const READ_SCRIPT = PRELUDE + String.raw`root=$1; p=$2; max=$3
inside "$p" "$root" || exit 42
r=$(rp "$p") || exit 44
[ "$r" = "$p" ] || exit 42
[ -f "$p" ] || exit 44
sz=$(wc -c < "$p" | tr -d ' ') || exit 44
[ "$sz" -le "$max" ] || { printf 'size=%s\n' "$sz"; exit 48; }
printf 'size=%s ident=%s\n' "$sz" "$(ident "$p")"
cat -- "$p"
`;

/**
 * Writes one file so a reader sees the old or the new bytes: the content (on stdin) goes to a temporary file in the same
 * folder, is checked for length, and replaces the target with one rename. An update only goes ahead if the file still has the
 * identity it had when it was approved ($3), a create only if there is nothing there yet ($4 = 1). A create puts the finished
 * file in place with a hard link, which fails if the name is taken; where hard links are not available the target is created
 * and filled through one exclusive open (noclobber), so a file that appears at that name in the meantime is never replaced, and
 * a target that did not get all its content is removed again. An update has to rename over the file, so the identity is checked
 * as late as the shell allows, but a change in the moment between that check and the rename cannot be excluded.
 * $1 root, $2 path, $3 expected identity, $4 create, $5 size, $6 the approved folder, $7 its approved identity (dev:ino), $8 permissions to set (octal digits) or empty.
 */
export const WRITE_SCRIPT = PRELUDE + String.raw`root=$1; p=$2; expect=$3; create=$4; size=$5; bound=$6; boundid=$7; setmode=$8
inside "$p" "$root" || exit 42
if [ -n "$bound" ]; then
  [ "$(ident "$bound" | cut -d: -f1,2)" = "$boundid" ] || exit 43
fi
d=\${p%/*}; [ -z "$d" ] && d=/
f=$d
while [ ! -d "$f" ]; do f=\${f%/*}; [ -z "$f" ] && f=/; done
fr=$(rp "$f") || exit 42
[ "$fr" = "$f" ] || exit 42
inside "$fr" "$root" || exit 42
mkdir -p -- "$d" || exit 42
dr=$(rp "$d") || exit 42
[ "$dr" = "$d" ] || exit 42
inside "$dr" "$root" || exit 42
if [ "$create" = 1 ]; then
  { [ ! -e "$p" ] && [ ! -L "$p" ]; } || exit 46
  mode=644
else
  { [ -f "$p" ] && [ ! -L "$p" ]; } || exit 44
  [ "$(ident "$p")" = "$expect" ] || exit 43
  mode=\${expect##*:}
fi
tmp=$(mktemp "$d/.tomverse-XXXXXXXX") || exit 42
mark=; half=0
cleanup() {
  if [ "$half" = 1 ] && [ -s "$mark" ] && [ -f "$p" ] && [ ! -L "$p" ]; then rm -f -- "$p"; fi
  rm -f -- "$tmp"
  if [ -n "$mark" ]; then rm -f -- "$mark"; fi
  return 0
}
trap cleanup EXIT
trap 'exit 45' HUP INT TERM
cat > "$tmp" || exit 45
got=$(wc -c < "$tmp" | tr -d ' ')
[ "$got" = "$size" ] || exit 45
[ -n "$setmode" ] && mode=$setmode
chmod "$mode" "$tmp" || exit 45
if [ "$create" = 1 ]; then
  if ln "$tmp" "$p" 2>/dev/null; then :; else
    { [ -e "$p" ] || [ -L "$p" ]; } && exit 46
    mark=$(mktemp "$d/.tomverse-XXXXXXXX") || exit 42
    half=1
    ( umask 077; set -C; { echo c >&3; cat -- "$tmp" || exit 9; } > "$p" ) 3>"$mark" 2>/dev/null
    rc=$?
    if [ ! -s "$mark" ]; then
      half=0
      { [ -e "$p" ] || [ -L "$p" ]; } && exit 46
      exit 45
    fi
    [ "$rc" = 0 ] || exit 45
    { [ -f "$p" ] && [ ! -L "$p" ]; } || exit 45
    [ "$(wc -c < "$p" | tr -d ' ')" = "$size" ] || exit 45
    chmod "$mode" "$p" || exit 45
    half=0
  fi
else
  [ "$(ident "$p")" = "$expect" ] || exit 43
  mv -f "$tmp" "$p" || exit 45
fi
printf '@tv-fields\nident=%s\nfident=%s\n' "$(ident "$p")" "$(ident "$d")"
`.replaceAll("\\${", "${");

/** $1 root, $2 path, $3 expected identity. */
export const REMOVE_SCRIPT = PRELUDE + String.raw`root=$1; p=$2; expect=$3
inside "$p" "$root" || exit 42
r=$(rp "$p") || exit 44
[ "$r" = "$p" ] || exit 42
{ [ -f "$p" ] && [ ! -L "$p" ]; } || exit 44
[ "$(ident "$p")" = "$expect" ] || exit 43
rm -f -- "$p" || exit 45
printf 'removed=1\n'
`;

const skipped = [...SKIPPED_DIRS];
if (skipped.some((name) => !/^[A-Za-z0-9._-]+$/.test(name))) throw new Error("A skipped folder name is not safe to place in the remote script.");
const PRUNE = skipped.map((name) => `-name ${name}`).join(" -o ");

/**
 * $1 root, $2 the start folder relative to it ("." for all), $3 1 to prefer git. Prints NUL-separated paths relative to the root:
 * regular files only, never a link and never a name that goes through one (git lists a tracked link as a file, and a tracked
 * folder may have been replaced by a link since).
 */
export const LIST_SCRIPT = PRELUDE + String.raw`root=$1; start=$2; git=$3
cd -P -- "$root" 2>/dev/null || exit 44
[ "$(pwd -P)" = "$root" ] || exit 42
if [ "$start" != . ]; then
  [ -d "$start" ] || exit 44
  [ "$(cd -P -- "$start" 2>/dev/null && pwd -P)" = "$root/$start" ] || exit 42
fi
if [ "$git" = 1 ] && [ -e .git ] && command -v git >/dev/null 2>&1 && git rev-parse --git-dir >/dev/null 2>&1; then
  GIT_OPTIONAL_LOCKS=0 GIT_TERMINAL_PROMPT=0 GIT_CONFIG_NOSYSTEM=1 git -c core.fsmonitor=false -c core.untrackedCache=false ls-files --cached --others --exclude-standard -z -- "$start" \
    | tr '\0' '\n' | while IFS= read -r f; do safe "$f" && printf '%s\n' "$f"; done | tr '\n' '\0'
  exit 0
fi
if [ "$start" = . ]; then base=.; else base="./$start"; fi
find "$base" ! -path "$base" -type d \( ${PRUNE} \) -prune -o -type f -print0
exit 0
`;

/**
 * $1 root, $2 F (fixed text) or E (regular expression), $3 i (ignore case) or s, $4 the pattern. The files, NUL-separated and
 * relative to the root, arrive on stdin. They are checked again here with the same rule as the listing (grep follows a link it is
 * given), so a name that is, or has become, a link is never read. /dev/null keeps xargs from running grep on nothing.
 */
export const SEARCH_SCRIPT = PRELUDE + String.raw`root=$1; mode=$2; icase=$3; pat=$4
cd -P -- "$root" 2>/dev/null || exit 44
[ "$(pwd -P)" = "$root" ] || exit 42
fl=-nIH
if [ "$mode" = F ]; then fl="$fl -F"; else fl="$fl -E"; fi
[ "$icase" = i ] && fl="$fl -i"
{
  printf '/dev/null\n'
  tr '\0' '\n' | while IFS= read -r f; do safe "$f" && printf '%s\n' "$f"; done
} | tr '\n' '\0' | xargs -0 grep $fl --null -e "$pat" -- 2>/dev/null
exit 0
`;

/**
 * Runs a command in a folder inside the project. $1 root, $2 folder, $3 "argv" (then $5... is the program and its arguments) or
 * "shell" (then $5 is a shell line), $4 how the command is started: "sh" (as it is) or "bash-login" (through `bash -lc`, which reads the
 * remote user's profile; a machine without bash refuses with exit 47 before anything starts). It prints a start marker first, so the caller can tell a command that failed from one
 * that never started. The command's input is closed; a second process waits on the connection's own input and ends the command
 * (its whole process group) when the connection goes away, so a cancelled or dropped task does not leave it running.
 */
export const EXEC_MARKER = "@tv-start";
export const EXEC_SCRIPT = PRELUDE + String.raw`root=$1; cwd=$2; mode=$3; login=$4; shift 4
case $login in sh) ;; bash-login) command -v bash >/dev/null 2>&1 || { echo bash >&2; exit 47; };; *) echo shell >&2; exit 47;; esac
cd -P -- "$cwd" 2>/dev/null || exit 44
[ "$(pwd -P)" = "$cwd" ] || exit 42
inside "$cwd" "$root" || exit 42
printf '@tv-start\n'
(set -m) 2>/dev/null && set -m
if [ "$login" = bash-login ]; then
  if [ "$mode" = shell ]; then bash -lc "$1" </dev/null & else bash -lc 'exec "$@"' bash "$@" </dev/null & fi
else
  if [ "$mode" = shell ]; then sh -c "$1" </dev/null & else "$@" </dev/null & fi
fi
pid=$!
(
  cat >/dev/null
  kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null
  sleep 2
  kill -KILL -- "-$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null
) >/dev/null 2>&1 &
wd=$!
wait "$pid"
rc=$?
kill "$wd" 2>/dev/null
exit "$rc"
`;
