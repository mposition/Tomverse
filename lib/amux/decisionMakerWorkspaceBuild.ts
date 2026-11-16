import { spawn } from "node:child_process";
import { chmodSync, lchownSync, lstatSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { isSnapshotTargetSha } from "./decisionMakerCore.ts";
import { dmRequestPaths } from "./decisionMakerLauncherCore.ts";
import { dmHostPath, type DmLauncherHost } from "./decisionMakerLauncherFs.ts";
import type { DmInstanceScope } from "./decisionMakerSwitchCore.ts";
import {
  DM_WORKSPACE_API_ORIGIN,
  DM_WORKSPACE_BUILD_MAX_MS,
  DM_WORKSPACE_CLONE_URL,
  DM_WORKSPACE_DISK_MAX_BYTES,
  DM_WORKSPACE_FETCH_TIMEOUT_MS,
  DM_WORKSPACE_GIT_STEP_TIMEOUT_MS,
  DM_WORKSPACE_HISTORY_DEPTH,
  DM_WORKSPACE_LOOKUP_TIMEOUT_MS,
  DM_WORKSPACE_PATCH_NAME,
  DM_WORKSPACE_REPOSITORY,
  DM_WORKSPACE_TARGET_BRANCH,
  dmWorkspaceAcceptFiles,
  dmWorkspaceGuide,
  dmWorkspaceHasPatch,
  type DmLaunchWorkspace,
  type DmWorkspace,
  type DmWorkspaceExclusion,
  type DmWorkspaceNoneReason,
  type DmWorkspaceRequest,
} from "./decisionMakerWorkspaceCore.ts";

/**
 * The broker's half of the Decision Maker workspace
 * (lib/amux/decisionMakerWorkspaceCore.ts): before the transmission intent it
 * confirms the commit on GitHub's public API and accepts the evidence; after
 * the intent, inside the request directory it made, it fetches that commit
 * with git -- no credential, no config, no hook -- writes the evidence and
 * the guide, and hands the tree to the vendor's group read-only.
 *
 * The broker holds no credential (docs/policy/amux-decision-maker.md §5), so
 * nothing here can authenticate: git runs with no system or global config, an
 * empty credential helper, no prompt and only the https protocol, and the
 * public API is read with a bare `fetch`. The fetched objects are checked by
 * git itself (an object's id is the hash of its bytes), and the checkout's
 * HEAD must be the commit asked for, so the files are exactly that public
 * commit's. Symbolic links are checked out as plain files (`core.symlinks`
 * false) and none may remain, so nothing in the tree points outside it.
 */

/** How the broker reads the public API. Every call is an unauthenticated GET. */
export type DmWorkspaceHttp = (url: string) => Promise<{ status: number; body: Uint8Array } | null>;

const json = (bytes: Uint8Array): unknown => {
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
};

const commitSha = async (http: DmWorkspaceHttp, ref: string): Promise<{ status: number | null; sha: string | null }> => {
  const answer = await http(`${DM_WORKSPACE_API_ORIGIN}/repos/${DM_WORKSPACE_REPOSITORY}/commits/${ref}`).catch(() => null);
  if (answer === null) return { status: null, sha: null };
  const sha = answer.status === 200 ? (json(answer.body) as { sha?: unknown } | null)?.sha : null;
  return { status: answer.status, sha: typeof sha === "string" && isSnapshotTargetSha(sha) ? sha : null };
};

/**
 * §5's target order, kept: the commit the app named when the public API
 * confirms it (`worker_head`); on 404 or 422 for it, or when none was named,
 * develop's public head, confirmed the same way (`develop`); anything else is
 * no commit (`none`: the evidence still goes, without a checkout).
 */
export async function resolveDmWorkspaceTarget(
  named: string | null,
  http: DmWorkspaceHttp,
): Promise<{ state: DmWorkspace["state"]; targetSha: string | null }> {
  if (named !== null) {
    const found = await commitSha(http, named);
    if (found.sha === named) return { state: "worker_head", targetSha: named };
    if (found.status !== 404 && found.status !== 422) return { state: "none", targetSha: null };
  }
  const head = await commitSha(http, DM_WORKSPACE_TARGET_BRANCH);
  if (head.sha === null) return { state: "none", targetSha: null };
  const again = await commitSha(http, head.sha);
  return again.sha === head.sha ? { state: "develop", targetSha: head.sha } : { state: "none", targetSha: null };
}

/** The broker's answer to a `workspace` request: the target and the accepted files. Never throws. */
export async function prepareDmWorkspace(
  request: DmWorkspaceRequest,
  http: DmWorkspaceHttp,
): Promise<{ workspace: DmWorkspace; excluded: Partial<Record<DmWorkspaceExclusion, number>>; reason: DmWorkspaceNoneReason | null }> {
  const accepted = dmWorkspaceAcceptFiles(request.files);
  const target = await resolveDmWorkspaceTarget(request.targetSha, http).catch(() => ({ state: "none" as const, targetSha: null }));
  return {
    workspace: { state: target.state, targetSha: target.targetSha, files: accepted.files },
    excluded: accepted.excluded,
    reason: target.targetSha === null ? "target_unavailable" : null,
  };
}

/**
 * The credential-free client: a bare `fetch` with no cookie, no auth header
 * and no proxy credential, to the public API only, following no redirect,
 * with a deadline and a size cap. Nothing from the environment is read.
 */
export const dmWorkspaceHttpClient: DmWorkspaceHttp = async (url) => {
  const target = new URL(url);
  if (target.protocol !== "https:" || target.origin !== DM_WORKSPACE_API_ORIGIN) return null;
  const response = await fetch(target, {
    method: "GET",
    redirect: "error",
    credentials: "omit",
    headers: { accept: "application/vnd.github+json", "user-agent": "tomverse-amux-dm-broker" },
    signal: AbortSignal.timeout(DM_WORKSPACE_LOOKUP_TIMEOUT_MS),
  });
  // A commit answer is a few KiB; a larger one is not what was asked for.
  const body = new Uint8Array(await response.arrayBuffer());
  if (body.length > 1024 * 1024) return { status: 413, body: new Uint8Array() };
  return { status: response.status, body };
};

// ---------------------------------------------------------------------------
// git, as the broker runs it
// ---------------------------------------------------------------------------

/** One git command: its arguments after `git`, a working directory, a deadline and a way to stop it. */
export type DmGitRunner = (args: string[], options: { cwd: string; timeoutMs: number; signal?: AbortSignal }) =>
  Promise<{ ok: boolean; stdout: string }>;

/** The system's git, by its fixed path. */
export const DM_GIT_EXECUTABLE = "/usr/bin/git";

/**
 * Every git command's configuration: nothing read from a config file, an
 * empty credential helper, no askpass, no prompt, https only, no redirect, no
 * hook, symbolic links as plain files.
 */
export const DM_WORKSPACE_GIT_FLAGS = [
  "-c", "credential.helper=",
  "-c", "core.askPass=",
  "-c", "protocol.allow=never",
  "-c", "protocol.https.allow=always",
  "-c", "http.followRedirects=false",
  "-c", "core.symlinks=false",
  "-c", "core.hooksPath=/dev/null",
  "-c", "advice.detachedHead=false",
  "-c", "init.defaultBranch=dm",
];

/** The fixed environment of the system's git: no variable of the broker's own. */
export const dmWorkspaceSystemGitEnvironment = (home: string): Record<string, string> => ({
  PATH: "/usr/bin:/bin",
  HOME: home,
  LANG: "C.UTF-8",
  LC_ALL: "C.UTF-8",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
});

/**
 * One git command in a process group of its own: a deadline or the stop
 * signal kills the whole group (git's fetch runs git-remote-https and
 * index-pack under it, which a kill of git alone would leave writing), and the
 * step resolves only once git has exited. Off POSIX (the test host on
 * Windows) only git itself is killed.
 */
const runGit = (executable: string, env: Record<string, string | undefined>, extraFlags: string[]): DmGitRunner =>
  (args, options) =>
    new Promise((resolve) => {
      const posix = process.platform !== "win32";
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(executable, [...DM_WORKSPACE_GIT_FLAGS, ...extraFlags, ...args],
          { cwd: options.cwd, env: env as NodeJS.ProcessEnv, detached: posix, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
      } catch {
        resolve({ ok: false, stdout: "" });
        return;
      }
      let stdout = "";
      let killed = false;
      child.stdout?.on("data", (chunk: Buffer) => {
        if (stdout.length < 1024 * 1024) stdout += chunk.toString("utf8");
      });
      const kill = () => {
        killed = true;
        try {
          if (posix && child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
          else child.kill("SIGKILL");
        } catch {
          // Already gone.
        }
      };
      const timer = setTimeout(kill, options.timeoutMs);
      if (options.signal?.aborted) kill();
      options.signal?.addEventListener("abort", kill, { once: true });
      const finish = (ok: boolean) => {
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", kill);
        resolve({ ok: ok && !killed, stdout });
      };
      child.once("error", () => finish(false));
      child.once("close", (code) => finish(code === 0));
    });

export type DmWorkspaceBuildOptions = {
  /** Test host only: another git (a test's `git` from PATH) and a local repository instead of GitHub. */
  git?: { executable: string; cloneUrl: string };
};

export type DmWorkspaceBuild =
  | { ok: true; patch: "applied" | "not_applied" | "none"; bytes: number }
  | { ok: false; reason: "git_failed"; step: string }
  | { ok: false; reason: "head_mismatch" | "write_failed" | "tree_unsafe" | "too_large" };

/** How often the build measures the request directory while git writes into it. */
export const DM_WORKSPACE_DISK_CHECK_MS = 1_000;

/** The bytes of the regular files under `root` (links and others count nothing); never throws. */
export const dmWorkspaceBytes = (root: string): number => {
  let bytes = 0;
  const directories = [root];
  while (directories.length > 0) {
    const directory = directories.pop()!;
    let names: string[];
    try {
      names = readdirSync(directory);
    } catch {
      continue;
    }
    for (const name of names) {
      try {
        const stats = lstatSync(join(directory, name));
        if (stats.isDirectory()) directories.push(join(directory, name));
        else if (stats.isFile()) bytes += stats.size;
      } catch {
        // Gone between the listing and the stat: git renames as it writes.
      }
    }
  }
  return bytes;
};

/** Everything under `root` handed to the vendor's group read-only; any link refused; sizes summed. */
const handOver = (root: string, groupId: number | null, owners: boolean): { ok: true; bytes: number } | { ok: false; reason: "tree_unsafe" | "too_large" } => {
  let bytes = 0;
  const directories = [root];
  while (directories.length > 0) {
    const directory = directories.pop()!;
    for (const name of readdirSync(directory)) {
      const path = join(directory, name);
      const stats = lstatSync(path);
      if (stats.isSymbolicLink()) return { ok: false, reason: "tree_unsafe" };
      if (stats.isDirectory()) {
        if (owners) {
          lchownSync(path, -1, groupId ?? -1);
          chmodSync(path, 0o750);
        }
        directories.push(path);
        continue;
      }
      if (!stats.isFile()) return { ok: false, reason: "tree_unsafe" };
      bytes += stats.size;
      if (bytes > DM_WORKSPACE_DISK_MAX_BYTES) return { ok: false, reason: "too_large" };
      if (owners) {
        lchownSync(path, -1, groupId ?? -1);
        chmodSync(path, (stats.mode & 0o100) !== 0 ? 0o750 : 0o640);
      }
    }
  }
  return { ok: true, bytes };
};

/**
 * Build the workspace inside the request directory the broker just made
 * (`dmCreateRequestDirectory`), for the workspace the launch line carries and
 * the intent recorded. The caller deletes the directory afterwards whatever
 * this returns (`dmCleanupRequestDirectory`), so a failure leaves nothing.
 */
export async function buildDmWorkspace(
  host: DmLauncherHost,
  input: { instance: DmInstanceScope; requestId: string; workspace: DmLaunchWorkspace; groupId: number | null },
  options: DmWorkspaceBuildOptions = {},
): Promise<DmWorkspaceBuild> {
  if (host.root === null && options.git !== undefined) {
    throw new Error("AMUX Decision Maker workspace git and repository are fixed on the system host");
  }
  const directory = dmHostPath(host, dmRequestPaths(input.instance, input.requestId).requestDirectory);
  const repo = join(directory, "repo");
  const patched = join(directory, "repo-patched");
  const evidence = join(directory, "evidence");
  const { workspace } = input;
  const git =
    options.git === undefined
      ? runGit(DM_GIT_EXECUTABLE, dmWorkspaceSystemGitEnvironment(directory), [])
      : runGit(options.git.executable, { ...process.env, ...dmWorkspaceSystemGitEnvironment(directory) }, [
          "-c",
          "protocol.file.allow=always",
        ]);
  const cloneUrl = options.git?.cloneUrl ?? DM_WORKSPACE_CLONE_URL;
  // One budget for every step (DM_WORKSPACE_BUILD_MAX_MS): a step that would
  // run past it is not started, and the one running is cut at it.
  const buildDeadline = Date.now() + DM_WORKSPACE_BUILD_MAX_MS;
  // The disk cap holds while git writes, not only after: the directory is
  // measured every second, and the running git is stopped once it passes
  // DM_WORKSPACE_DISK_MAX_BYTES (it can overshoot by what it writes in that
  // second; a size-limited filesystem under the request root is the box's
  // own bound, docs/policy/amux-decision-maker.md §0b).
  const stop = new AbortController();
  let overDisk = false;
  const watchdog = setInterval(() => {
    if (!overDisk && dmWorkspaceBytes(directory) > DM_WORKSPACE_DISK_MAX_BYTES) {
      overDisk = true;
      stop.abort();
    }
  }, DM_WORKSPACE_DISK_CHECK_MS);
  watchdog.unref?.();
  const unbounded = git;
  const bounded: DmGitRunner = async (args, step) => {
    const left = buildDeadline - Date.now();
    if (left <= 0 || overDisk) return { ok: false, stdout: "" };
    return unbounded(args, { ...step, timeoutMs: Math.min(step.timeoutMs, left), signal: stop.signal });
  };
  try {
    const built = await buildWithin(bounded);
    return overDisk ? { ok: false, reason: "too_large" } : built;
  } finally {
    clearInterval(watchdog);
  }
  async function buildWithin(bounded: DmGitRunner): Promise<DmWorkspaceBuild> {
  try {
    mkdirSync(evidence, { mode: 0o750 });
    for (const file of workspace.files) writeFileSync(join(evidence, file.name), file.text, { encoding: "utf8", flag: "wx", mode: 0o640 });
  } catch {
    return { ok: false, reason: "write_failed" };
  }
  let patch: "applied" | "not_applied" | "none" = dmWorkspaceHasPatch(workspace) ? "not_applied" : "none";
  if (workspace.targetSha !== null) {
    const sha = workspace.targetSha;
    const step = { cwd: directory, timeoutMs: DM_WORKSPACE_GIT_STEP_TIMEOUT_MS };
    if (!(await bounded(["init", "-q", repo], step)).ok) return { ok: false, reason: "git_failed", step: "init" };
    const inRepo = { cwd: repo, timeoutMs: DM_WORKSPACE_GIT_STEP_TIMEOUT_MS };
    // Kept in the repository's own config, so the worktree below and the DM's
    // own git reads see the same: links as plain files, and a stat check on
    // mtime and size only, since the hand-over below changes every mode (and
    // so every ctime) and the DM can write no refreshed index.
    for (const [key, value] of [["core.symlinks", "false"], ["core.trustctime", "false"], ["core.checkStat", "minimal"]]) {
      if (!(await bounded(["config", key!, value!], inRepo)).ok) return { ok: false, reason: "git_failed", step: "config" };
    }
    const fetched = await bounded(
      ["fetch", "-q", "--no-tags", "--no-recurse-submodules", `--depth=${DM_WORKSPACE_HISTORY_DEPTH}`, cloneUrl, sha],
      { cwd: repo, timeoutMs: DM_WORKSPACE_FETCH_TIMEOUT_MS },
    );
    if (!fetched.ok) return { ok: false, reason: "git_failed", step: "fetch" };
    if (!(await bounded(["checkout", "-q", "--detach", sha], inRepo)).ok) return { ok: false, reason: "git_failed", step: "checkout" };
    const head = await bounded(["rev-parse", "HEAD"], inRepo);
    if (!head.ok || head.stdout.trim() !== sha) return { ok: false, reason: "head_mismatch" };
    if (patch === "not_applied") {
      const added = await bounded(["worktree", "add", "-q", "--detach", patched, sha], inRepo);
      if (!added.ok) return { ok: false, reason: "git_failed", step: "worktree" };
      // `git apply` is all or nothing: a patch that does not apply leaves the tree as it was.
      const applied = await bounded(["apply", "--whitespace=nowarn", join(evidence, DM_WORKSPACE_PATCH_NAME)], { cwd: patched, timeoutMs: DM_WORKSPACE_GIT_STEP_TIMEOUT_MS });
      if (applied.ok) patch = "applied";
      else if (!(await bounded(["worktree", "remove", "--force", patched], inRepo)).ok) return { ok: false, reason: "git_failed", step: "worktree_remove" };
    }
  }
  try {
    writeFileSync(
      join(directory, "WORKSPACE.md"),
      dmWorkspaceGuide({ targetSha: workspace.targetSha, state: workspace.state, patch, files: workspace.files.map((file) => file.name) }),
      { encoding: "utf8", flag: "wx", mode: 0o640 },
    );
  } catch {
    return { ok: false, reason: "write_failed" };
  }
  let handed: ReturnType<typeof handOver>;
  try {
    handed = handOver(directory, input.groupId, host.owners !== null);
  } catch {
    return { ok: false, reason: "write_failed" };
  }
  if (!handed.ok) return handed;
  return { ok: true, patch, bytes: handed.bytes };
  }
}
