import { execFile } from "node:child_process";
import { chmodSync, lchownSync, lstatSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { isSnapshotTargetSha } from "./decisionMakerCore.ts";
import { dmRequestPaths } from "./decisionMakerLauncherCore.ts";
import { dmHostPath, type DmLauncherHost } from "./decisionMakerLauncherFs.ts";
import type { DmInstanceScope } from "./decisionMakerSwitchCore.ts";
import {
  DM_WORKSPACE_API_ORIGIN,
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

/** One git command: its arguments after `git`, a working directory and a deadline. */
export type DmGitRunner = (args: string[], options: { cwd: string; timeoutMs: number }) => Promise<{ ok: boolean; stdout: string }>;

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
export const dmWorkspaceSystemGitEnvironment = (home: string): NodeJS.ProcessEnv => ({
  PATH: "/usr/bin:/bin",
  HOME: home,
  LANG: "C.UTF-8",
  LC_ALL: "C.UTF-8",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
});

const runGit = (executable: string, env: NodeJS.ProcessEnv, extraFlags: string[]): DmGitRunner =>
  (args, options) =>
    new Promise((resolve) => {
      execFile(
        executable,
        [...DM_WORKSPACE_GIT_FLAGS, ...extraFlags, ...args],
        { cwd: options.cwd, env, timeout: options.timeoutMs, killSignal: "SIGKILL", maxBuffer: 1024 * 1024, windowsHide: true },
        (error, stdout) => resolve({ ok: error === null, stdout: String(stdout ?? "") }),
      );
    });

export type DmWorkspaceBuildOptions = {
  /** Test host only: another git (a test's `git` from PATH) and a local repository instead of GitHub. */
  git?: { executable: string; cloneUrl: string };
};

export type DmWorkspaceBuild =
  | { ok: true; patch: "applied" | "not_applied" | "none"; bytes: number }
  | { ok: false; reason: "git_failed"; step: string }
  | { ok: false; reason: "head_mismatch" | "write_failed" | "tree_unsafe" | "too_large" };

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
      : runGit(options.git.executable, { ...process.env, ...dmWorkspaceSystemGitEnvironment(directory), PATH: process.env.PATH }, [
          "-c",
          "protocol.file.allow=always",
        ]);
  const cloneUrl = options.git?.cloneUrl ?? DM_WORKSPACE_CLONE_URL;
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
    if (!(await git(["init", "-q", repo], step)).ok) return { ok: false, reason: "git_failed", step: "init" };
    const inRepo = { cwd: repo, timeoutMs: DM_WORKSPACE_GIT_STEP_TIMEOUT_MS };
    // Kept in the repository's own config, so the worktree below and the DM's
    // own git reads see the same: links as plain files, and a stat check on
    // mtime and size only, since the hand-over below changes every mode (and
    // so every ctime) and the DM can write no refreshed index.
    for (const [key, value] of [["core.symlinks", "false"], ["core.trustctime", "false"], ["core.checkStat", "minimal"]]) {
      if (!(await git(["config", key!, value!], inRepo)).ok) return { ok: false, reason: "git_failed", step: "config" };
    }
    const fetched = await git(
      ["fetch", "-q", "--no-tags", "--no-recurse-submodules", `--depth=${DM_WORKSPACE_HISTORY_DEPTH}`, cloneUrl, sha],
      { cwd: repo, timeoutMs: DM_WORKSPACE_FETCH_TIMEOUT_MS },
    );
    if (!fetched.ok) return { ok: false, reason: "git_failed", step: "fetch" };
    if (!(await git(["checkout", "-q", "--detach", sha], inRepo)).ok) return { ok: false, reason: "git_failed", step: "checkout" };
    const head = await git(["rev-parse", "HEAD"], inRepo);
    if (!head.ok || head.stdout.trim() !== sha) return { ok: false, reason: "head_mismatch" };
    if (patch === "not_applied") {
      const added = await git(["worktree", "add", "-q", "--detach", patched, sha], inRepo);
      if (!added.ok) return { ok: false, reason: "git_failed", step: "worktree" };
      // `git apply` is all or nothing: a patch that does not apply leaves the tree as it was.
      const applied = await git(["apply", "--whitespace=nowarn", join(evidence, DM_WORKSPACE_PATCH_NAME)], { cwd: patched, timeoutMs: DM_WORKSPACE_GIT_STEP_TIMEOUT_MS });
      if (applied.ok) patch = "applied";
      else if (!(await git(["worktree", "remove", "--force", patched], inRepo)).ok) return { ok: false, reason: "git_failed", step: "worktree_remove" };
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
