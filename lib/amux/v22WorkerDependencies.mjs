import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";

import { removeAmuxV22WorktreeLeftovers } from "./v22PatchCapture.mjs";

const execFileAsync = promisify(execFile);

/**
 * An implement shell runs with no network (Codex's own sandbox, or the jail
 * of v22ShellJail.mjs for Claude and Copilot), and a worker checkout is a
 * fresh clone with no node_modules, so a run could neither install packages
 * nor start a test (AMUX-AUTOFILE-006: npm registry DNS refused, tsx
 * missing). The sidecar, which has network, installs the checkout's locked
 * dependencies before the CLI starts. node_modules is gitignored, so the
 * install never enters the patch or the clean-checkout checks.
 *
 * Nothing from an earlier attempt is trusted here: the sidecar runs this
 * install outside any sandbox, with network and its CLI sign-in in reach,
 * while an earlier attempt's shell or file tools could write any ignored
 * file -- a .env that prisma.config.ts loads, an .npmrc, a changed package
 * under node_modules or an install marker (review r-20261109-014107-dd07b1).
 * So every implement attempt first removes every untracked and ignored file
 * (removeAmuxV22WorktreeLeftovers) and then installs and generates afresh
 * from the synced base's tracked files and the registry. It runs before the
 * CLI, so it never reads a file the model wrote in this attempt. A failure
 * does not stop the attempt; the worker then runs as before and reports
 * what it could not check.
 *
 * No package's install script runs here (--ignore-scripts). The one
 * generated output the tests need, the Prisma client (package.json
 * postinstall), is built by the freshly installed prisma package. esbuild and
 * tsx work without their scripts (measured on the box 2026-11-09: npm 10.9.4
 * install 11 s, generate 5 s).
 */
export const AMUX_V22_DEPENDENCY_INSTALL_TIMEOUT_MS = 10 * 60_000;
/** Codex's sandbox and the shell jail leave /tmp read-only, so tools such as
 * tsx that cache under the temp directory get one inside the checkout; it is
 * ignored with node_modules. */
export const AMUX_V22_WORKTREE_TMP = join("node_modules", ".cache", "amux-tmp");
/** Ubuntu's own npm on the box (9.2.0) refuses this lockfile (measured
 * 2026-11-09: "Missing: @tomverse/mobile-auth@0.1.0 from lock file", the
 * nested apps/mobile/native-auth workspace), so every install failed. The
 * rollout installs npm 10.9.4 at this root-owned path, where it installed the
 * same checkout in 10 s; without it the system npm still runs. */
export const AMUX_V22_PINNED_NPM_CLI = "/opt/tomverse-amux-v22/npm-10.9.4/bin/npm-cli.js";

export async function ensureAmuxV22WorktreeDependencies(worktreePath, homePath,
  options = {}) {
  if (typeof worktreePath !== "string" || !isAbsolute(worktreePath) ||
      typeof homePath !== "string" || !isAbsolute(homePath))
    return { ok: false, reason: "invalid_input" };
  try { await (options.stat ?? stat)(join(worktreePath, "package-lock.json")); }
  catch { return { ok: false, reason: "no_lockfile" }; }
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
    await (options.removeLeftovers ?? removeAmuxV22WorktreeLeftovers)(worktreePath);
  } catch { return { ok: false, reason: "leftovers_not_removed" }; }
  try {
    const ci = ["ci", "--ignore-scripts", "--no-audit", "--no-fund", "--loglevel=error"];
    if ((options.exists ?? existsSync)(AMUX_V22_PINNED_NPM_CLI))
      await step("node", [AMUX_V22_PINNED_NPM_CLI, ...ci]);
    else await step("npm", ci);
    await (options.stat ?? stat)(join(worktreePath, "node_modules", "prisma",
      "build", "index.js"));
    await step("node", ["node_modules/prisma/build/index.js", "generate"]);
    await (options.mkdir ?? mkdir)(join(worktreePath, AMUX_V22_WORKTREE_TMP),
      { recursive: true });
    return { ok: true, installed: true };
  } catch (error) {
    return { ok: false, reason: error?.killed ? "install_timed_out" : "install_failed" };
  }
}
