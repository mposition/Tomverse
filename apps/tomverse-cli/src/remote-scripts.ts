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
`.replaceAll("\\${", "${");

/** What a probe finds: the real project folder, the home folder (too broad to work in) and the system. */
export const PROBE_SCRIPT = PRELUDE + String.raw`[ -d "$1" ] || { [ -e "$1" ] && exit 41; exit 40; }
r=$(cd -P -- "$1" 2>/dev/null && pwd -P) || exit 40
h=$(cd -P -- "\${HOME:-/}" 2>/dev/null && pwd -P)
for c in cat mv rm mkdir chmod find wc readlink mktemp stat grep xargs tr cut sleep; do
  command -v "$c" >/dev/null 2>&1 || { echo "$c" >&2; exit 47; }
done
ident "$r" >/dev/null || { echo stat >&2; exit 47; }
printf 'root=%s\nhome=%s\nos=%s\n' "$r" "$h" "$(uname -s 2>/dev/null)"
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
if [ "$q" = "$p" ]; then a=$r; ex=1; else a=$r\${p#"$q"}; ex=0; fi
inside "$a" "$root" || exit 42
lk=0; [ -L "$p" ] && lk=1
kind=none
if [ "$ex" = 1 ]; then
  if [ -d "$a" ]; then kind=dir; elif [ -f "$a" ]; then kind=file; else kind=other; fi
fi
f=\${a%/*}; [ -z "$f" ] && f=/
while [ ! -d "$f" ]; do f=\${f%/*}; [ -z "$f" ] && f=/; done
printf 'abs=%s\nexists=%s\nlink=%s\nkind=%s\n' "$a" "$ex" "$lk" "$kind"
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
 * identity it had when it was approved ($3), a create only if there is nothing there yet ($4 = 1).
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
trap 'rm -f "$tmp"' EXIT
trap 'exit 45' HUP INT TERM
cat > "$tmp" || exit 45
got=$(wc -c < "$tmp" | tr -d ' ')
[ "$got" = "$size" ] || exit 45
[ -n "$setmode" ] && mode=$setmode
chmod "$mode" "$tmp" || exit 45
if [ "$create" = 1 ]; then
  if ln "$tmp" "$p" 2>/dev/null; then :; else
    { [ -e "$p" ] || [ -L "$p" ]; } && exit 46
    mv "$tmp" "$p" || exit 45
  fi
else
  [ "$(ident "$p")" = "$expect" ] || exit 43
  mv -f "$tmp" "$p" || exit 45
fi
printf 'ident=%s\nfident=%s\n' "$(ident "$p")" "$(ident "$d")"
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

/** $1 root, $2 the start folder relative to it ("." for all), $3 1 to prefer git. Prints NUL-separated paths relative to the root. */
export const LIST_SCRIPT = PRELUDE + String.raw`root=$1; start=$2; git=$3
cd -P -- "$root" 2>/dev/null || exit 44
[ "$(pwd -P)" = "$root" ] || exit 42
if [ "$start" != . ]; then
  [ -d "$start" ] || exit 44
  [ "$(cd -P -- "$start" 2>/dev/null && pwd -P)" = "$root/$start" ] || exit 42
fi
if [ "$git" = 1 ] && [ -e .git ] && command -v git >/dev/null 2>&1 && git rev-parse --git-dir >/dev/null 2>&1; then
  GIT_OPTIONAL_LOCKS=0 GIT_TERMINAL_PROMPT=0 GIT_CONFIG_NOSYSTEM=1 git -c core.fsmonitor=false -c core.untrackedCache=false ls-files --cached --others --exclude-standard -z -- "$start"
  exit 0
fi
if [ "$start" = . ]; then base=.; else base="./$start"; fi
find "$base" ! -path "$base" -type d \( ${PRUNE} \) -prune -o -type f -print0
exit 0
`;

/** $1 root, $2 F (fixed text) or E (regular expression), $3 i (ignore case) or s, $4 the pattern. The files, NUL-separated and relative to the root, arrive on stdin. */
export const SEARCH_SCRIPT = PRELUDE + String.raw`root=$1; mode=$2; icase=$3; pat=$4
cd -P -- "$root" 2>/dev/null || exit 44
[ "$(pwd -P)" = "$root" ] || exit 42
fl=-nIH
if [ "$mode" = F ]; then fl="$fl -F"; else fl="$fl -E"; fi
[ "$icase" = i ] && fl="$fl -i"
xargs -0 grep $fl --null -e "$pat" -- 2>/dev/null
exit 0
`;

/**
 * Runs a command in a folder inside the project. $1 root, $2 folder, $3 "argv" (then $4... is the program and its arguments) or
 * "shell" (then $4 is a shell line). It prints a start marker first, so the caller can tell a command that failed from one
 * that never started. The command's input is closed; a second process waits on the connection's own input and ends the command
 * (its whole process group) when the connection goes away, so a cancelled or dropped task does not leave it running.
 */
export const EXEC_MARKER = "@tv-start";
export const EXEC_SCRIPT = PRELUDE + String.raw`root=$1; cwd=$2; mode=$3; shift 3
cd -P -- "$cwd" 2>/dev/null || exit 44
[ "$(pwd -P)" = "$cwd" ] || exit 42
inside "$cwd" "$root" || exit 42
printf '@tv-start\n'
(set -m) 2>/dev/null && set -m
if [ "$mode" = shell ]; then sh -c "$1" </dev/null & else "$@" </dev/null & fi
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
