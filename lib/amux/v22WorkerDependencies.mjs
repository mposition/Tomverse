import { execFile } from "node:child_process";
import { mkdir, rm, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Codex's implement shell runs with no network (v22ChannelRun.mjs), and a
 * worker checkout is a fresh clone with no node_modules, so a run could
 * neither install packages nor start a test (AMUX-AUTOFILE-006: npm registry
 * DNS refused, tsx missing). The sidecar, which has network, installs the
 * checkout's locked dependencies before the CLI starts. node_modules is
 * gitignored, so the install never enters the patch or the clean-checkout
 * checks.
 *
 * Trust: the sidecar can read its CLI sign-in and has network, while an
 * earlier Codex run could write anything under node_modules (it is inside the
 * checkout). So nothing left there is ever reused or executed: every attempt
 * removes node_modules and runs `npm ci`, which extracts the packages of the
 * lockfile at the base the checkout was just synced to, checked against the
 * lockfile's integrity hashes, from the npm cache in the sidecar's own home
 * (outside the Codex sandbox). No package install script runs
 * (--ignore-scripts); the one generated output the tests need, the Prisma
 * client (package.json postinstall), is built by that freshly installed,
 * locked prisma package. esbuild and tsx work without their scripts.
 * Measured on the box 2026-11-09: install 13 s, generate 5 s, 1.6 GB.
 *
 * A failure does not stop the attempt; the worker then runs as before and
 * reports what it could not check.
 */
export const AMUX_V22_DEPENDENCY_INSTALL_TIMEOUT_MS = 10 * 60_000;
/** Codex's sandbox leaves /tmp and $TMPDIR read-only, so tools such as tsx
 * that cache under the temp directory get one inside the checkout; it is
 * ignored with node_modules and removed before the next install. */
export const AMUX_V22_WORKTREE_TMP = join("node_modules", ".cache", "amux-tmp");

export async function ensureAmuxV22WorktreeDependencies(worktreePath, homePath,
  options = {}) {
  if (typeof worktreePath !== "string" || !isAbsolute(worktreePath) ||
      typeof homePath !== "string" || !isAbsolute(homePath))
    return { ok: false, reason: "invalid_input" };
  const exists = options.stat ?? stat;
  try { await exists(join(worktreePath, "package-lock.json")); } catch {
    return { ok: false, reason: "no_lockfile" };
  }
  const run = options.run ?? execFileAsync;
  const started = Date.now();
  const step = (binary, args) => run(binary, args, {
    cwd: worktreePath,
    env: { HOME: homePath, PATH: "/usr/bin:/bin", LANG: "C.UTF-8" },
    timeout: Math.max(1, (options.timeoutMs ?? AMUX_V22_DEPENDENCY_INSTALL_TIMEOUT_MS) -
      (Date.now() - started)),
    killSignal: "SIGKILL", maxBuffer: 4 * 1024 * 1024, windowsHide: true,
  });
  try {
    // rm removes a symlink itself, never its target.
    await (options.rm ?? rm)(join(worktreePath, "node_modules"),
      { recursive: true, force: true });
    await step("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund",
      "--loglevel=error"]);
    await exists(join(worktreePath, "node_modules", "prisma", "build", "index.js"));
    await step("node", ["node_modules/prisma/build/index.js", "generate"]);
    await (options.mkdir ?? mkdir)(join(worktreePath, AMUX_V22_WORKTREE_TMP),
      { recursive: true });
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: error?.killed ? "install_timed_out" : "install_failed" };
  }
}
