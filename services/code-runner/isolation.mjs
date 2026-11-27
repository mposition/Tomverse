// How a job's agent process is isolated. On Linux (the runner image) every job runs under bubblewrap in its own user,
// PID, mount, IPC, UTS and network namespaces: an empty environment, no network at all (the model adapter is a Unix
// socket bound into the sandbox), read-only system folders, and only its own working copy, home and socket folder
// writable. prlimit adds per-process CPU time, file size, open files and process count limits; the supervisor adds
// the wall-clock limit and the heap limit. What this does not bound: memory of the commands the agent runs (that needs
// cgroups, which an unprivileged container does not get; the container's own memory limit is the bound) and total
// disk use of the working copy (bounded by the container's disk).
//
// Anywhere else (Windows and macOS development machines) there is no such sandbox. The runner refuses to start there
// unless CODE_RUNNER_ALLOW_UNISOLATED=true, which only local tests set; even then the environment is emptied.
import { spawnSync } from "node:child_process";
import { dirname } from "node:path";

export const DEFAULT_LIMITS = {
  cpuSeconds: 30 * 60,
  fileBytes: 256 * 1024 * 1024,
  openFiles: 1024,
  processes: 512,
  heapMegabytes: 1536,
};

const works = (command, args) => {
  try {
    return spawnSync(command, args, { stdio: "ignore", timeout: 10_000 }).status === 0;
  } catch {
    return false;
  }
};

/** What this machine can enforce. `bwrap` must actually create the namespaces here, not merely be installed. */
export function detectIsolation(platform = process.platform) {
  if (platform !== "linux") return { kind: "none", prlimit: false };
  const bwrap = works("bwrap", ["--unshare-all", "--die-with-parent", "--ro-bind", "/", "/", "true"]);
  return { kind: bwrap ? "bwrap" : "none", prlimit: works("prlimit", ["--cpu=10", "true"]) };
}

const SYSTEM_PATHS = ["/usr", "/bin", "/sbin", "/lib", "/lib64", "/etc/alternatives", "/etc/ssl", "/etc/ld.so.cache", "/etc/passwd", "/etc/group", "/etc/localtime", "/etc/gitconfig"];

/**
 * The command that starts the worker for one job. `paths.readOnly` are the runner's own code folders (the worker
 * script and the CLI engine); `paths.writable` are the job's working copy, home and socket folder.
 */
export function sandboxCommand({ isolation, node, args, cwd, env, paths, limits = DEFAULT_LIMITS }) {
  const nodeArgs = [`--max-old-space-size=${limits.heapMegabytes}`, ...args];
  if (isolation.kind !== "bwrap") return { command: node, args: nodeArgs, env, isolated: false };
  const bwrap = ["--unshare-all", "--die-with-parent", "--new-session", "--clearenv",
    ...SYSTEM_PATHS.flatMap((path) => ["--ro-bind-try", path, path]),
    ...[...new Set([dirname(node), ...paths.readOnly])].flatMap((path) => ["--ro-bind", path, path]),
    ...paths.writable.flatMap((path) => ["--bind", path, path]),
    "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp",
    "--chdir", cwd,
    ...Object.entries(env).flatMap(([name, value]) => ["--setenv", name, value]),
    "--"];
  const prlimit = isolation.prlimit
    ? ["prlimit", `--cpu=${limits.cpuSeconds}`, `--fsize=${limits.fileBytes}`, `--nofile=${limits.openFiles}`, `--nproc=${limits.processes}`, "--"] : [];
  return { command: "bwrap", args: [...bwrap, ...prlimit, node, ...nodeArgs], env: {}, isolated: true };
}
