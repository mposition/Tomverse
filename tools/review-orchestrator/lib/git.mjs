import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export class GitError extends Error {
  constructor(code, detail, { clientFault = false } = {}) {
    super(`${code}${detail ? `: ${detail}` : ""}`);
    this.code = code;
    // The request was wrong (bad SHA, unpushed base, mismatched head), not the server.
    this.clientFault = clientFault;
  }
}

export const SHA = /^[0-9a-f]{40}$/;

export function git(args, { cwd, allowFailure = false, maxBuffer = 64 * 1024 * 1024 } = {}) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  if (result.error) throw new GitError("git_unavailable", result.error.message);
  if (result.status !== 0 && !allowFailure) {
    throw new GitError("git_failed", `${args[0]}: ${(result.stderr || "").trim().slice(0, 500)}`);
  }
  return { ok: result.status === 0, stdout: result.stdout, stderr: result.stderr };
}

/** A bare clone with no prune, so `refs/review/*` survive every fetch. */
export function ensureMirror(repo) {
  if (!existsSync(repo.mirror)) {
    mkdirSync(dirname(repo.mirror), { recursive: true });
    git(["clone", "--bare", repo.url, repo.mirror]);
    git(["config", "remote.origin.fetch", "+refs/heads/*:refs/heads/*"], { cwd: repo.mirror });
  }
  git(["fetch", "--quiet", "origin"], { cwd: repo.mirror });
}

/**
 * Import a client bundle as `refs/review/<jobId>` and prove it is what the
 * client said: the bundle's prerequisites exist here, its head is `head`, and
 * `base` is an ancestor of it.
 */
export function importBundle({ mirror, bundlePath, jobId, base, head }) {
  if (!SHA.test(base) || !SHA.test(head)) throw new GitError("sha_invalid", "", { clientFault: true });
  const verify = git(["bundle", "verify", bundlePath], { cwd: mirror, allowFailure: true });
  if (!verify.ok) {
    throw new GitError(
      "bundle_unverifiable",
      "the base commit must already be on the remote; push it or pick a pushed base",
      { clientFault: true },
    );
  }
  const ref = `refs/review/${jobId}`;
  git(["fetch", "--quiet", bundlePath, `+refs/review-orchestrator/head:${ref}`], { cwd: mirror });
  const actual = git(["rev-parse", ref], { cwd: mirror }).stdout.trim();
  if (actual !== head) {
    git(["update-ref", "-d", ref], { cwd: mirror, allowFailure: true });
    throw new GitError("head_mismatch", `bundle head ${actual} is not ${head}`, { clientFault: true });
  }
  const ancestor = git(["merge-base", "--is-ancestor", base, head], { cwd: mirror, allowFailure: true });
  if (!ancestor.ok) {
    git(["update-ref", "-d", ref], { cwd: mirror, allowFailure: true });
    throw new GitError("base_not_ancestor", "", { clientFault: true });
  }
  return ref;
}

export function changedFiles(mirror, base, head) {
  return git(["diff", "--name-only", "-z", base, head], { cwd: mirror })
    .stdout.split("\0")
    .filter(Boolean);
}

export function diffText(mirror, base, head) {
  return git(["diff", "--no-color", "--no-ext-diff", base, head], { cwd: mirror }).stdout;
}

export function addWorktree(mirror, dir, head) {
  git(["worktree", "add", "--detach", "--quiet", dir, head], { cwd: mirror });
}

export function removeWorktree(mirror, dir) {
  git(["worktree", "remove", "--force", dir], { cwd: mirror, allowFailure: true });
  git(["worktree", "prune"], { cwd: mirror, allowFailure: true });
}
