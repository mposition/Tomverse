import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

/**
 * The implement shell for the v22 Claude and Copilot workers (owner request
 * 2026-11-09). Codex's shell runs in Codex's own OS sandbox (v22ChannelRun.mjs);
 * these two CLIs get the same boundary from one bubblewrap jail the sidecar
 * owns: the checkout is the only writable path (its .git stays read-only, as
 * in Codex's workspace-write), there is no network (a fresh network namespace
 * with loopback only), /tmp is empty and read-only, and the sidecar's CLI
 * sign-in directory, home and journal are not in the jail at all. The jail's
 * environment is rebuilt from a fixed list, so a token the CLI holds in its
 * own environment (Copilot's COPILOT_GITHUB_TOKEN) never reaches a command.
 *
 * The CLI itself keeps its network and is not jailed; only the shell it starts
 * is. Claude Code wraps every Bash tool call in CLAUDE_CODE_SHELL_PREFIX;
 * Copilot finds `bash` on PATH, so a per-run directory first on PATH holds the
 * jail under that name. Both routes were measured on the box with the
 * installed CLIs (2026-11-09, no model call: a local fake Messages endpoint
 * asked each CLI for one shell command).
 *
 * bwrap cannot nest on the box (Ubuntu's unpriv_bwrap AppArmor profile denies
 * capabilities inside a bwrap user namespace), so the CLI cannot be wrapped as
 * a whole. bwrap's --unshare-net needs AF_NETLINK to bring up loopback, which
 * the worker unit allows (as for Codex).
 *
 * The jail has no /proc. The worker unit's ProtectKernelTunables= covers
 * /proc/sys, and the kernel refuses a fresh proc mount in a user namespace
 * while a locked mount covers part of the existing one (Codex has a no-proc
 * mode for the same case). Binding the unit's /proc instead would hand the
 * command /proc/<pid>/environ and /proc/<pid>/root of the CLI itself: its
 * token and every file the jail leaves out. Without /proc, node reports its
 * execPath as "node", found on PATH, and `node --import tsx --test` runs
 * (measured on the box 2026-11-09).
 *
 * No --disable-userns either: bwrap implements it by writing
 * /proc/sys/user/max_user_namespaces, which the same ProtectKernelTunables=
 * keeps read-only, and every command then failed to start (the rollout's
 * self-test in the worker sandbox, 2026-11-09). A namespace made inside the
 * jail gains nothing: the unpriv_bwrap profile denies every capability there,
 * so it can mount nothing and reach no network.
 */

/** Names copied into the jail when the CLI set them; none carries a secret. */
export const AMUX_V22_SHELL_ENV_KEEP = Object.freeze(["TERM", "COLUMNS", "LINES",
  "NO_COLOR", "FORCE_COLOR", "CLICOLOR", "PAGER", "GIT_PAGER", "GIT_EDITOR",
  "CLAUDECODE", "CI"]);

const BWRAP = "/usr/bin/bwrap";
const BASH = "/usr/bin/bash";
// A path that bash would need to quote cannot be written into the script.
const SAFE_PATH = /^\/[A-Za-z0-9._/-]+$/;

const quote = (value) => {
  if (typeof value !== "string" || !SAFE_PATH.test(value) || value.includes("/../") ||
      value.endsWith("/..")) throw new TypeError("unsafe jail path");
  return `'${value}'`;
};

/**
 * The fixed bwrap argument list for one checkout. `tmpPath` is the checkout's
 * ignored temp directory (AMUX_V22_WORKTREE_TMP), which is also the jail's
 * HOME so npm and tsx caches land inside the checkout.
 */
export function amuxV22ShellJailArgs({ worktreePath, tmpPath, gitPath }) {
  for (const path of [worktreePath, tmpPath, gitPath]) quote(path);
  if (!tmpPath.startsWith(`${worktreePath}/`) || gitPath !== `${worktreePath}/.git`)
    throw new TypeError("jail paths outside the checkout");
  return ["--unshare-user", "--unshare-ipc", "--unshare-pid", "--unshare-net",
    "--unshare-uts", "--unshare-cgroup", "--die-with-parent",
    "--ro-bind", "/usr", "/usr", "--symlink", "usr/bin", "/bin",
    "--symlink", "usr/lib", "/lib", "--symlink", "usr/lib64", "/lib64",
    "--symlink", "usr/sbin", "/sbin", "--ro-bind", "/etc", "/etc",
    "--dev", "/dev", "--tmpfs", "/tmp",
    "--bind", worktreePath, worktreePath, "--ro-bind", gitPath, gitPath,
    // /tmp and the jail's own root (the directories bwrap made for the
    // mounts above) are read-only too, so the checkout is the one writable
    // place. A remount is not recursive: the checkout bind stays writable.
    "--remount-ro", "/tmp", "--remount-ro", "/",
    "--clearenv", "--setenv", "PATH", "/usr/bin:/bin", "--setenv", "LANG", "C.UTF-8",
    "--setenv", "HOME", tmpPath, "--setenv", "TMPDIR", tmpPath];
}

/**
 * The launcher: a bash script that runs `bash "$@"` inside the jail, in the
 * caller's directory when that is inside the checkout and at its root
 * otherwise. Every path in it is fixed when the sidecar writes it; nothing is
 * read from the caller's environment except the values of the names above.
 */
export function amuxV22ShellJailScript(paths) {
  const args = amuxV22ShellJailArgs(paths);
  // The paths were checked above; every argument is a plain word or path.
  const fixed = args.map((arg) => {
    if (!/^[A-Za-z0-9._:/=-]+$/.test(arg)) throw new TypeError("unsafe jail arg");
    return `'${arg}'`;
  });
  return ["#!/usr/bin/bash",
    "# AMUX v22 implement shell jail, written by the sidecar for one run.",
    "set -u",
    `wt=${quote(paths.worktreePath)}`,
    'here=$(pwd -P 2>/dev/null) || here=$wt',
    'case "$here/" in "$wt"/*) ;; *) here=$wt ;; esac',
    "keep=()",
    `for name in ${AMUX_V22_SHELL_ENV_KEEP.join(" ")}; do`,
    '  if [ -n "${!name+x}" ]; then keep+=(--setenv "$name" "${!name}"); fi',
    "done",
    `exec ${BWRAP} ${fixed.join(" ")} "\${keep[@]}" --chdir "$here" -- ${BASH} "$@"`,
    ""].join("\n");
}

/** Claude Code hands the whole Bash invocation to the prefix as "$1". */
export function amuxV22ShellPrefixScript(jailPath) {
  return ["#!/usr/bin/bash",
    "# AMUX v22 Claude Code shell prefix: run the assembled command in the jail.",
    `exec ${quote(jailPath)} -c "$1"`, ""].join("\n");
}

/**
 * Writes the launcher for one run into a fresh directory under the sidecar's
 * home (outside the jail and outside the checkout) and returns the paths the
 * CLI environment names. Null when the checkout has no .git directory to keep
 * read-only, so the run then starts without a shell rather than an open one.
 */
export async function createAmuxV22ShellJail({ worktreePath, tmpPath, homePath },
  fsOps = { mkdtemp, mkdir, writeFile, chmod, rm, exists: existsSync }) {
  if (![worktreePath, tmpPath, homePath].every((path) =>
    typeof path === "string" && isAbsolute(path))) return null;
  const gitPath = join(worktreePath, ".git");
  if (!fsOps.exists(gitPath)) return null;
  const script = amuxV22ShellJailScript({ worktreePath, tmpPath, gitPath });
  await fsOps.mkdir(tmpPath, { recursive: true });
  const root = await fsOps.mkdtemp(join(homePath, "shell-"));
  const cleanup = () => fsOps.rm(root, { recursive: true, force: true });
  try {
    const bin = join(root, "bin");
    await fsOps.mkdir(bin, { mode: 0o700 });
    const jail = join(bin, "bash");
    const prefix = join(root, "claude-shell-prefix");
    await fsOps.writeFile(jail, script, { flag: "wx", mode: 0o500 });
    await fsOps.writeFile(join(bin, "sh"), script, { flag: "wx", mode: 0o500 });
    await fsOps.writeFile(prefix, amuxV22ShellPrefixScript(jail), { flag: "wx", mode: 0o500 });
    await fsOps.chmod(root, 0o500);
    return { binPath: bin, jailPath: jail, prefixPath: prefix,
      cleanup: async () => { await fsOps.chmod(root, 0o700).catch(() => {}); await cleanup(); } };
  } catch (error) { await fsOps.chmod(root, 0o700).catch(() => {}); await cleanup().catch(() => {}); throw error; }
}
