import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
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
 * checks, and it survives between attempts: npm ci runs again only when
 * package-lock.json changes.
 *
 * The install reads the lockfile of the base the checkout was just synced to
 * (develop's head or the pinned publication base), never a file the model
 * wrote: it runs before the CLI. A failure does not stop the attempt; the
 * worker then runs as before and reports what it could not check.
 *
 * The sidecar can read its CLI sign-in, so no package's install script runs
 * here (--ignore-scripts). The one generated output the tests need, the
 * Prisma client (package.json postinstall), is built by the locked prisma
 * package itself. esbuild and tsx work without their scripts (measured on the
 * box 2026-11-09: install 13 s, generate 5 s).
 */
export const AMUX_V22_DEPENDENCY_INSTALL_TIMEOUT_MS = 10 * 60_000;
const MARKER = join("node_modules", ".amux-v22-lock-sha256");
/** Codex's sandbox leaves /tmp and $TMPDIR read-only, so tools such as tsx
 * that cache under the temp directory get one inside the checkout; it is
 * ignored with node_modules and removed by the next npm ci. */
export const AMUX_V22_WORKTREE_TMP = join("node_modules", ".cache", "amux-tmp");

export async function ensureAmuxV22WorktreeDependencies(worktreePath, homePath,
  options = {}) {
  if (typeof worktreePath !== "string" || !isAbsolute(worktreePath) ||
      typeof homePath !== "string" || !isAbsolute(homePath))
    return { ok: false, reason: "invalid_input" };
  const read = options.readFile ?? readFile;
  let lockSha;
  try {
    lockSha = createHash("sha256")
      .update(await read(join(worktreePath, "package-lock.json"))).digest("hex");
  } catch { return { ok: false, reason: "no_lockfile" }; }
  const tmp = join(worktreePath, AMUX_V22_WORKTREE_TMP);
  try {
    const marker = (await read(join(worktreePath, MARKER), "utf8")).trim();
    if (marker === lockSha) {
      await (options.mkdir ?? mkdir)(tmp, { recursive: true });
      return { ok: true, installed: false };
    }
  } catch { /* no marker yet: install */ }
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
    await step("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund",
      "--loglevel=error"]);
    await (options.stat ?? stat)(join(worktreePath, "node_modules", "prisma",
      "build", "index.js"));
    await step("node", ["node_modules/prisma/build/index.js", "generate"]);
    await (options.mkdir ?? mkdir)(tmp, { recursive: true });
    await (options.writeFile ?? writeFile)(join(worktreePath, MARKER), `${lockSha}\n`);
    return { ok: true, installed: true };
  } catch (error) {
    return { ok: false, reason: error?.killed ? "install_timed_out" : "install_failed" };
  }
}
