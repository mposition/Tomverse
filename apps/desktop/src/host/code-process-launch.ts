const superviseLinuxCommand = [
  'trap \'kill -KILL "-$$"\' USR1',
  'test "$PPID" = "$1" || exit 125',
  "shift",
  "exec 3<&0",
  '"$@" <&3 3<&- &',
  "exec 3<&- 0<&-",
  'wait "$!"',
].join("\n");

export function codeProcessLaunch(file: string, args: readonly string[]) {
  if (process.platform !== "linux") return { file, args };
  // The caller gives the supervisor its own process group. The PID check
  // covers a worker exit that happens before the kernel signal is configured.
  return { file: "/usr/bin/setpriv",
    args: ["--pdeathsig", "USR1", "--", "/bin/sh", "-c", superviseLinuxCommand, "tomverse-code-parent",
      String(process.pid), file, ...args] };
}
