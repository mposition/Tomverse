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
/** The Prisma client depends on the schema and config as well as the
 * lockfile, and the checkout keeps node_modules across bases, so the client
 * is regenerated whenever any of them changed, even with the same lockfile. */
const GENERATED_MARKER = join("node_modules", ".amux-v22-prisma-sha256");
const GENERATE_INPUTS = ["package-lock.json", join("prisma", "schema.prisma"),
  "prisma.config.ts"];
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
  const generateHash = createHash("sha256");
  for (const input of GENERATE_INPUTS) {
    let bytes = null;
    try { bytes = await read(join(worktreePath, input)); } catch { /* absent */ }
    // Length-prefixed, so an absent file and an empty one differ.
    generateHash.update(`${input}\0${bytes === null ? -1 : bytes.length}\0`);
    if (bytes !== null) generateHash.update(bytes);
  }
  const generateSha = generateHash.digest("hex");
  const tmp = join(worktreePath, AMUX_V22_WORKTREE_TMP);
  const marker = async (path) => {
    try { return (await read(join(worktreePath, path), "utf8")).trim(); } catch { return null; }
  };
  const needInstall = await marker(MARKER) !== lockSha;
  if (!needInstall && await marker(GENERATED_MARKER) === generateSha) {
    await (options.mkdir ?? mkdir)(tmp, { recursive: true });
    return { ok: true, installed: false };
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
  const write = options.writeFile ?? writeFile;
  try {
    if (needInstall) {
      await step("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund",
        "--loglevel=error"]);
      // npm ci replaced node_modules, so neither marker survives; record the
      // install before the client, which may still fail and be retried alone.
      await write(join(worktreePath, MARKER), `${lockSha}\n`);
    }
    await (options.stat ?? stat)(join(worktreePath, "node_modules", "prisma",
      "build", "index.js"));
    await step("node", ["node_modules/prisma/build/index.js", "generate"]);
    await (options.mkdir ?? mkdir)(tmp, { recursive: true });
    await write(join(worktreePath, GENERATED_MARKER), `${generateSha}\n`);
    return { ok: true, installed: true };
  } catch (error) {
    return { ok: false, reason: error?.killed ? "install_timed_out" : "install_failed" };
  }
}
