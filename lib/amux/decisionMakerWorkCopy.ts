import { execFile, execFileSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, rmSync, statfsSync, writeFileSync } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";

import type { DmExecutionPlan } from "./decisionMakerLauncherCore.ts";
import { dmHostPath, type DmLauncherHost } from "./decisionMakerLauncherFs.ts";
import { amuxShellJailArgs, amuxShellJailScriptFor, amuxShellPrefixScriptFor } from "./v22ShellJail.mjs";

/**
 * The Decision Maker's work directory and its command jail
 * (docs/policy/amux-decision-maker.md §0f, §5, §5a; owner direction
 * 2026-11-22: "DM은 접근권한 막지 마세요").
 *
 * The broker hands the vendor account the request's workspace read-only, and
 * the account cannot delete what it would write there. So the launcher, as
 * the vendor account, copies the request directory into the request's
 * temporary directory (`<home>/dm-scratch/<request id>/work`), which the
 * launcher's cleanup deletes and checks on every exit path. The CLI works in
 * that copy and may write anywhere in it.
 *
 * Commands run in the v22 worker's jail (lib/amux/v22ShellJail.mjs): no
 * network, the work directory the one writable place, the account's home
 * with its login not in it at all, a fixed environment. claude's Bash reaches
 * it through `CLAUDE_CODE_SHELL_PREFIX`; codex's commands run in codex's own
 * sandbox (the `dm` permissions profile), and the jail installs the
 * dependencies for both.
 *
 * The dependencies: the vendor account has no registry network (§5: its
 * egress is its vendor's API), so `npm ci --offline` installs each tree's
 * lockfile from a root-owned cache the box fills from develop's public head
 * (scripts/amux-dm-dependency-cache.sh), read-only in the jail, with no
 * package script; then the Prisma client is generated from Prisma's engine
 * cache, copied into the jail's home because Prisma touches the engine file.
 * Both run inside the jail because they run the tree's own code
 * (`prisma.config.ts`). Measured on the box 2026-11-23 in this jail: install
 * 11 s, generate 5 s, `node --import tsx --test` and `tsc` run, 1.7 GB per
 * tree. A failure does not stop the request: `DEPENDENCIES.md` says what is
 * installed and the DM judges with that, as the v22 worker does
 * (lib/amux/v22WorkerDependencies.mjs).
 *
 * `/proc`: Next's type generation (SWC) reads `/proc/self/maps` and fails
 * without it. The jail mounts a fresh proc of its own pid namespace, which
 * shows only the jail's processes, when the unit allows it; the launcher tries
 * once per request and otherwise runs the jail without `/proc`, as the v22
 * worker's does, and says so in `DEPENDENCIES.md`.
 */

/** Installation (not in the policy text): the box's offline dependency cache, root's, read-only to the DM. */
export const DM_DEPENDENCY_CACHE_ROOT = "/var/cache/tomverse-amux-dm";
export const DM_NPM_CACHE = `${DM_DEPENDENCY_CACHE_ROOT}/npm`;
/** `XDG_CACHE_HOME/prisma` of the cache refresh: Prisma's engine downloads. */
export const DM_PRISMA_ENGINE_CACHE = `${DM_DEPENDENCY_CACHE_ROOT}/prisma`;
/**
 * The npm the v22 rollout installs (lib/amux/v22WorkerDependencies.mjs
 * `AMUX_V22_PINNED_NPM_CLI`): Ubuntu's own npm refuses this lockfile.
 */
export const DM_PINNED_NPM_DIRECTORY = "/opt/tomverse-amux-v22/npm-10.9.4";
export const DM_PINNED_NPM_CLI = `${DM_PINNED_NPM_DIRECTORY}/bin/npm-cli.js`;

/** The workspace's two trees (lib/amux/decisionMakerWorkspaceBuild.ts), in install order. */
export const DM_WORK_TREES = ["repo", "repo-patched"] as const;
export type DmWorkTree = (typeof DM_WORK_TREES)[number];

export const DM_DEPENDENCIES_FILE_NAME = "DEPENDENCIES.md";

/** The install's one budget for both trees, out of the request's hard timeout (the v22 local CLI flow's). */
export const DM_DEPENDENCY_INSTALL_MAX_MS = 30 * 60_000;
/** The jail's `/proc` trial: one `true` in the jail. */
export const DM_JAIL_PROBE_TIMEOUT_MS = 15_000;

/** What a jailed step inherits from the launcher: the jail rebuilds its own environment from a fixed list. */
// Next augments ProcessEnv to require NODE_ENV; the launcher passes only PATH, so only the type is widened.
const JAILED_STEP_ENVIRONMENT = { PATH: "/usr/bin:/bin" } as unknown as NodeJS.ProcessEnv;

const JAIL_TITLE = "AMUX Decision Maker command jail, written by the launcher for one request.";
const PREFIX_TITLE = "AMUX Decision Maker Claude Code shell prefix: run the assembled command in the jail.";

/** Fixed variables of every jailed command: no telemetry, npm offline from the cache. */
const jailEnvironment = (host: DmLauncherHost): Array<[string, string]> => [
  ["NEXT_TELEMETRY_DISABLED", "1"],
  ["CHECKPOINT_DISABLE", "1"],
  ["PRISMA_HIDE_UPDATE_MESSAGE", "1"],
  ["NPM_CONFIG_CACHE", dmHostPath(host, DM_NPM_CACHE)],
  ["NPM_CONFIG_OFFLINE", "true"],
  ["NPM_CONFIG_UPDATE_NOTIFIER", "false"],
  ["NPM_CONFIG_AUDIT", "false"],
  ["NPM_CONFIG_FUND", "false"],
  ["NPM_CONFIG_LOGS_MAX", "0"],
];

/** The jail's bwrap arguments for a request's work directory. */
export const dmWorkJailArgs = (host: DmLauncherHost, plan: DmExecutionPlan, proc: boolean): string[] =>
  amuxShellJailArgs({
    writablePath: dmHostPath(host, plan.paths.workDirectory),
    tmpPath: dmHostPath(host, plan.paths.workTemporaryDirectory),
    readOnlyBeside: [dmHostPath(host, DM_PINNED_NPM_DIRECTORY), dmHostPath(host, DM_DEPENDENCY_CACHE_ROOT)],
    environment: jailEnvironment(host),
    proc,
  });

export type DmWorkPreparation = { ok: true; jail: string; proc: boolean } | { ok: false; reason: "unusable" | "disk" };

export type DmWorkOptions = {
  /**
   * Whether the jail starts. A test host only; the system host runs `true` in
   * it. A test host without one assumes it starts and has no `/proc`.
   */
  jailStarts?: (jail: string, proc: boolean) => boolean;
  /** Test host only: another way to run a jailed step. */
  runJailed?: DmJailedRunner;
  /** Test host only: other disk limits and check interval. */
  disk?: Partial<DmDiskLimits>;
};

// ---------------------------------------------------------------------------
// The disk (review r-20261123-105620-63d64b)
// ---------------------------------------------------------------------------

/**
 * The work directory is in the vendor account's home, outside the request
 * root's size-limited filesystem, and the DM's commands write to it. Two
 * bounds keep it from filling the host: the copy's own size cap -- the
 * workspace's 4 GiB (DM_WORKSPACE_DISK_MAX_BYTES), both trees' dependencies
 * (1.7 GB each, measured on the box 2026-11-23) and room for what the DM's
 * checks write -- and a floor of free space on the home's filesystem, so the
 * box's other services keep theirs. Before the copy both are checked against
 * the request directory's size; from then until the CLI ends the launcher
 * measures (free space every 2 s, the copy's size every 30 s) and stops the
 * running step or the CLI's process group when either is passed: a refusal
 * (`disk_space_low`) before anything ran, `disk_limit` after.
 */
export type DmDiskLimits = {
  maxBytes: number;
  freeFloorBytes: number;
  /** Free inodes the home's filesystem keeps, as a share of its inodes (review r-20261123-111521-e19df9). */
  freeInodeFloorRatio: number;
  checkMs: number;
  sizeEveryChecks: number;
};
export const DM_WORK_DISK_LIMITS: DmDiskLimits = Object.freeze({
  maxBytes: 16 * 1024 ** 3,
  freeFloorBytes: 20 * 1024 ** 3,
  freeInodeFloorRatio: 0.05,
  checkMs: 2_000,
  sizeEveryChecks: 15,
});

const limitsFor = (host: DmLauncherHost, options: DmWorkOptions): DmDiskLimits => {
  if (options.disk !== undefined && host.root === null) throw new Error("AMUX Decision Maker disk limits are fixed on the system host");
  // A test host's disk is the test machine's, whose free space is not the box's: no floor unless the test sets one.
  return { ...DM_WORK_DISK_LIMITS, ...(host.root === null ? {} : { freeFloorBytes: 0, freeInodeFloorRatio: 0 }), ...options.disk };
};

/** Free bytes for an unprivileged account on the filesystem holding `path`; null when it cannot be read. */
export const dmFreeBytes = (path: string): number | null => {
  try {
    const stats = statfsSync(path);
    return Number(stats.bavail) * Number(stats.bsize);
  } catch {
    return null;
  }
};

/**
 * Whether the filesystem holding `path` keeps its free-inode floor: a
 * command can exhaust inodes with empty files while bytes stay free. A
 * filesystem that reports no inode count (btrfs, for one) has no inode limit
 * to keep. False when it cannot be read.
 */
export const dmInodesKept = (path: string, floorRatio: number, toUse = 0): boolean => {
  try {
    const stats = statfsSync(path);
    const total = Number(stats.files);
    return total === 0 || Number(stats.ffree) - toUse >= total * floorRatio;
  } catch {
    return false;
  }
};

/** Every entry costs at least a block: empty files and directories still take an inode and space. */
const ENTRY_MIN_BYTES = 4096;

const entryCost = (stats: { blocks?: number; size: number }) =>
  Math.max(typeof stats.blocks === "number" && stats.blocks > 0 ? stats.blocks * 512 : stats.size, ENTRY_MIN_BYTES);

/** A tree nobody writes while it is read (the broker's request directory): its charged bytes and its entries; null when unreadable. */
export const dmTreeCost = (root: string): { bytes: number; entries: number } | null => {
  let bytes = 0;
  let entries = 0;
  const directories = [root];
  while (directories.length > 0) {
    const directory = directories.pop()!;
    let names: string[];
    try {
      names = readdirSync(directory);
    } catch {
      return null;
    }
    for (const name of names) {
      let stats;
      try {
        stats = lstatSync(join(directory, name));
      } catch {
        return null;
      }
      if (stats.isDirectory()) directories.push(join(directory, name));
      bytes += entryCost(stats);
      entries += 1;
    }
  }
  return { bytes, entries };
};

/**
 * The disk the work tree holds, measured without blocking the launcher (the
 * watch's kill path must stay responsive): every entry -- file, directory,
 * link -- counts its allocated blocks where the platform reports them, else
 * its size, and never less than ENTRY_MIN_BYTES, so a tree of empty files
 * reaches the cap too (16 GiB is then 4 Mi entries); every hard link counted
 * again (counting more is the safe side). It stops as soon as the sum passes
 * `stopAbove`.
 *
 * It runs while the DM's commands run in the same tree, so it changes nothing
 * (review r-20261123-112531-1a6c9d: a chmod could follow a directory a command
 * swapped for a link): a directory it cannot read -- a command may `chmod 000`
 * one -- is `unmeasurable`, which the watch takes as over the cap (review
 * r-20261123-110507-a9b409: never as empty). A swapped link can at most make it
 * read and count names outside the tree: more, never less, and only a number
 * leaves it. The cleanup, which does make directories `0700`, runs after the
 * CLI's process group is gone.
 */
export async function dmWorkTreeBytes(root: string, stopAbove: number): Promise<number | "unmeasurable"> {
  let bytes = 0;
  const directories = [root];
  while (directories.length > 0) {
    const directory = directories.pop()!;
    let names: string[];
    try {
      names = await readdir(directory);
    } catch {
      return "unmeasurable";
    }
    for (const name of names) {
      const path = join(directory, name);
      let stats;
      try {
        stats = await lstat(path);
      } catch {
        continue; // Gone between the listing and the stat.
      }
      if (stats.isDirectory()) directories.push(path);
      bytes += entryCost(stats);
      if (bytes > stopAbove) return bytes;
    }
  }
  return bytes;
}

/**
 * Watch the work directory until `stop()`: calls `exceeded` once, when the
 * host's free space drops under the floor (or cannot be read) or the copy
 * passes its cap (or cannot be measured).
 */
export const dmWatchWorkDisk = (
  host: DmLauncherHost,
  plan: DmExecutionPlan,
  exceeded: () => void,
  options: DmWorkOptions = {},
): { stop: () => void; exceeded: () => boolean } => {
  const limits = limitsFor(host, options);
  const work = dmHostPath(host, plan.paths.workDirectory);
  let fired = false;
  let stopped = false;
  let measuring = false;
  let checks = 0;
  const fire = () => {
    if (fired || stopped) return;
    fired = true;
    exceeded();
  };
  const timer = setInterval(() => {
    if (fired) return;
    checks += 1;
    const free = dmFreeBytes(work);
    if (free === null || free < limits.freeFloorBytes || !dmInodesKept(work, limits.freeInodeFloorRatio)) return fire();
    if (measuring || checks % limits.sizeEveryChecks !== 0) return;
    measuring = true;
    void dmWorkTreeBytes(work, limits.maxBytes)
      .then((bytes) => {
        if (bytes === "unmeasurable" || bytes > limits.maxBytes) fire();
      }, fire)
      .finally(() => {
        measuring = false;
      });
  }, limits.checkMs);
  timer.unref?.();
  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
    exceeded: () => fired,
  };
};

const runJailProbe = (jail: string) => {
  try {
    execFileSync(jail, ["-c", "true"], {
      env: JAILED_STEP_ENVIRONMENT,
      stdio: "ignore",
      timeout: DM_JAIL_PROBE_TIMEOUT_MS,
      killSignal: "SIGKILL",
      windowsHide: true,
    });
    return true;
  } catch {
    return false;
  }
};

/**
 * Copy the request directory into the work directory, make its temporary
 * directory, and write the jail beside it. Run as the vendor account, after
 * the preflight and `dmCreateTemporaryDirectory`. Not ok when any step fails:
 * the launcher then starts nothing (a DM without its workspace would judge
 * from the card alone, §0b-6, and claude's Bash would have no jail).
 */
export const dmPrepareWorkDirectory = (
  host: DmLauncherHost,
  plan: DmExecutionPlan,
  options: DmWorkOptions = {},
): DmWorkPreparation => {
  if (options.jailStarts !== undefined && host.root === null) {
    throw new Error("AMUX Decision Maker jail check is fixed on the system host");
  }
  const at = (path: string) => dmHostPath(host, path);
  const { paths } = plan;
  const limits = limitsFor(host, options);
  // The broker's tree, which no DM command can write: what the copy will take, in bytes and in inodes
  // (review r-20261123-112531-1a6c9d), against both floors before the synchronous copy starts.
  const needed = dmTreeCost(at(paths.requestDirectory));
  const free = dmFreeBytes(at(paths.temporaryDirectory));
  if (needed === null || needed.bytes > limits.maxBytes || free === null || free - needed.bytes < limits.freeFloorBytes ||
      !dmInodesKept(at(paths.temporaryDirectory), limits.freeInodeFloorRatio, needed.entries)) return { ok: false, reason: "disk" };
  try {
    // The broker's tree holds no link (it refuses one at hand-over); none is followed here either.
    cpSync(at(paths.requestDirectory), at(paths.workDirectory), {
      recursive: true,
      dereference: false,
      errorOnExist: true,
      force: false,
      // git compares mtime and size (core.checkStat minimal): kept, `git status` in the copy is clean.
      preserveTimestamps: true,
    });
  } catch (error) {
    // The disk filling during the copy is the disk, not an unusable directory.
    const code = (error as NodeJS.ErrnoException).code;
    return { ok: false, reason: code === "ENOSPC" || code === "EDQUOT" ? "disk" : "unusable" };
  }
  return dmWriteWorkJail(host, plan, options);
};

/**
 * The work directory's temporary directory and the jail beside it, with the
 * `/proc` trial. The work directory must exist. Not ok when either cannot be
 * written or the jail does not start.
 */
export const dmWriteWorkJail = (
  host: DmLauncherHost,
  plan: DmExecutionPlan,
  options: DmWorkOptions = {},
): DmWorkPreparation => {
  if (options.jailStarts !== undefined && host.root === null) {
    throw new Error("AMUX Decision Maker jail check is fixed on the system host");
  }
  const at = (path: string) => dmHostPath(host, path);
  const { paths } = plan;
  try {
    mkdirSync(at(paths.workTemporaryDirectory), { mode: 0o700 });
    mkdirSync(at(paths.shellDirectory), { mode: 0o700 });
  } catch {
    return { ok: false, reason: "unusable" };
  }
  const jail = at(paths.shellJail);
  // Written new each time: the script is the owner's read-and-execute only, so it is replaced, never written through.
  const write = (proc: boolean) => {
    rmSync(jail, { force: true });
    writeFileSync(jail, amuxShellJailScriptFor(dmWorkJailArgs(host, plan, proc), at(paths.workDirectory), JAIL_TITLE), {
      flag: "wx",
      mode: 0o500,
    });
  };
  const starts =
    options.jailStarts ?? (host.root === null ? runJailProbe : (_jail: string, proc: boolean) => !proc);
  try {
    write(true);
    writeFileSync(at(paths.shellPrefix), amuxShellPrefixScriptFor(jail, PREFIX_TITLE), { flag: "wx", mode: 0o500 });
    if (starts(jail, true)) return { ok: true, jail, proc: true };
    write(false);
    return starts(jail, false) ? { ok: true, jail, proc: false } : { ok: false, reason: "unusable" };
  } catch {
    return { ok: false, reason: "unusable" };
  }
};

// ---------------------------------------------------------------------------
// The dependencies
// ---------------------------------------------------------------------------

export const DM_DEPENDENCY_OUTCOMES = [
  "installed",
  "no_lockfile",
  "install_failed",
  "install_timed_out",
  "generate_failed",
] as const;
export type DmDependencyOutcome = (typeof DM_DEPENDENCY_OUTCOMES)[number];

/** For the launcher's log and `DEPENDENCIES.md`: codes only. */
export type DmDependencySummary = { proc: boolean; trees: Partial<Record<DmWorkTree, DmDependencyOutcome>> };

/** One step in the jail: `bash -c <script>` in `cwd`; resolves to how it ended. */
export type DmJailedRunner = (
  jail: string,
  script: string,
  options: { cwd: string; timeoutMs: number; signal?: AbortSignal },
) => Promise<"ok" | "failed" | "timed_out">;

const runJailedStep: DmJailedRunner = (jail, script, options) =>
  new Promise((resolve) => {
    execFile(
      jail,
      ["-c", script],
      {
        cwd: options.cwd,
        env: JAILED_STEP_ENVIRONMENT,
        timeout: Math.max(1, options.timeoutMs),
        killSignal: "SIGKILL",
        maxBuffer: 16 * 1024 * 1024,
        // The disk watch stops the step (killSignal) as it stops the CLI.
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        windowsHide: true,
      },
      (error) => resolve(error === null ? "ok" : (error as { killed?: boolean }).killed ? "timed_out" : "failed"),
    );
  });

const SAFE_PATH = /^\/[A-Za-z0-9._/-]+$/;
const quoted = (path: string) => {
  if (!SAFE_PATH.test(path)) throw new TypeError("unsafe dependency path");
  return `'${path}'`;
};

const isFile = (path: string) => {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
};

/**
 * Install each tree's locked dependencies in the jail, then write
 * `DEPENDENCIES.md` in the work directory. Never throws; a tree that fails is
 * named, and the request goes on.
 */
export async function dmInstallWorkDependencies(
  host: DmLauncherHost,
  plan: DmExecutionPlan,
  work: { jail: string; proc: boolean },
  input: { deadlineAt: number; signal?: AbortSignal },
  options: DmWorkOptions = {},
): Promise<DmDependencySummary> {
  if (options.runJailed !== undefined && host.root === null) {
    throw new Error("AMUX Decision Maker jailed steps are fixed on the system host");
  }
  const run = options.runJailed ?? runJailedStep;
  const at = (path: string) => dmHostPath(host, path);
  const summary: DmDependencySummary = { proc: work.proc, trees: {} };
  const budgetEnd = Math.min(input.deadlineAt, Date.now() + DM_DEPENDENCY_INSTALL_MAX_MS);
  try {
    const npm = existsSync(at(DM_PINNED_NPM_CLI)) ? `node ${quoted(at(DM_PINNED_NPM_CLI))}` : "npm";
    const engines = quoted(at(DM_PRISMA_ENGINE_CACHE));
    for (const tree of DM_WORK_TREES) {
      const cwd = join(at(plan.paths.workDirectory), tree);
      if (!existsSync(cwd)) continue;
      if (!isFile(join(cwd, "package-lock.json"))) {
        summary.trees[tree] = "no_lockfile";
        continue;
      }
      const left = () => budgetEnd - Date.now();
      if (left() <= 0 || input.signal?.aborted) {
        summary.trees[tree] = "install_timed_out";
        continue;
      }
      const ci = await run(work.jail, `exec ${npm} ci --offline --ignore-scripts --loglevel=error`, { cwd, timeoutMs: left(), signal: input.signal });
      if (ci !== "ok") {
        summary.trees[tree] = ci === "timed_out" ? "install_timed_out" : "install_failed";
        continue;
      }
      if (!isFile(join(cwd, "node_modules", "prisma", "build", "index.js"))) {
        summary.trees[tree] = "installed";
        continue;
      }
      const generate = await run(
        work.jail,
        `if [ -d ${engines} ]; then rm -rf "$HOME/.cache/prisma" && mkdir -p "$HOME/.cache" && ` +
          `cp -RH ${engines} "$HOME/.cache/prisma" && chmod -R u+w "$HOME/.cache/prisma" || exit 1; fi; ` +
          "exec node node_modules/prisma/build/index.js generate",
        { cwd, timeoutMs: Math.max(1, left()), signal: input.signal },
      );
      summary.trees[tree] = generate === "ok" ? "installed" : generate === "timed_out" ? "install_timed_out" : "generate_failed";
    }
  } catch {
    // A tree not reached is named as not installed below.
  }
  try {
    writeFileSync(join(at(plan.paths.workDirectory), DM_DEPENDENCIES_FILE_NAME), dmDependenciesGuide(summary), {
      encoding: "utf8",
      flag: "wx",
      mode: 0o640,
    });
  } catch {
    // The guide is advice; WORKSPACE.md still says where everything is.
  }
  return summary;
}

const OUTCOME_WORDS: Readonly<Record<DmDependencyOutcome, string>> = Object.freeze({
  installed: "installed (npm ci from the lockfile, and the Prisma client generated)",
  no_lockfile: "no package-lock.json, nothing installed",
  install_failed: "not installed: npm ci failed offline (most likely a locked package is not in the box's cache yet)",
  install_timed_out: "not installed: the install ran out of time",
  generate_failed: "installed, but the Prisma client could not be generated",
});

/** `DEPENDENCIES.md`: what the launcher installed, and how to run checks. */
export const dmDependenciesGuide = (summary: DmDependencySummary): string =>
  [
    "# Dependencies",
    "",
    "Before you started, the launcher installed each tree's locked dependencies, offline, from the box's npm cache,",
    "inside the same jail your commands run in.",
    "",
    ...DM_WORK_TREES.filter((tree) => summary.trees[tree] !== undefined).map(
      (tree) => `- ${tree}/: ${OUTCOME_WORDS[summary.trees[tree]!]}`,
    ),
    ...(Object.keys(summary.trees).length === 0 ? ["- no tree to install (there is no repo/ in this workspace)"] : []),
    "",
    "In a tree that has them you can run the tests (`node --import tsx --test tests/<file>`) and the type check",
    summary.proc
      ? "(`npm run typecheck`, or `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json`)."
      : "(`node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json`; there is no /proc here, so `next typegen` and " +
        "`npm run typecheck` cannot run and tsc reports Next's route types such as PageProps as missing).",
    "There is no network. Nothing installs from the registry; `npm` reads the box's cache only.",
    "",
  ].join("\n");
