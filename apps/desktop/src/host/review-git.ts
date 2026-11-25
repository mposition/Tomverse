import { execFile } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { gitEnv, isSecretPath } from "../../../tomverse-cli/src/workspace.js";
import type { ReviewDiff, ReviewFile, ReviewUnavailable } from "../review-contract";
import { MAX_REVIEW_FILES, diffTexts, omittedFile, parseUnifiedDiff } from "./review-diff";
import { readGitProject } from "./git-worktree";
import { inProjectFolder, type ProjectRoot } from "./project-root";

const exec = promisify(execFile);
/** The same restrictions the worktree code runs git with: no repository-defined programs, no nested configuration. */
const gitOptions = [
  "--no-pager", "-c", "core.fsmonitor=false", "-c", "submodule.recurse=false",
  "-c", "protocol.allow=never", "-c", "core.longpaths=true", "-c", "core.quotepath=false",
];
const UNTRACKED_FILE_BYTES = 200_000;
const MAX_UNTRACKED = 200;

export type ScopeDiffResult = { status: "ok"; diff: ReviewDiff } | { status: "unavailable"; reason: ReviewUnavailable };
export type ScopeDiffOptions = {
  /** The branch the person chose, checked against the repository's own branch list. */
  base?: string;
  /** Where a Code worktree was started from; the branch scope compares with it when nothing else is chosen. */
  worktreeBase?: { ref: string; commit: string };
};

async function git(executable: string, cwd: string, args: string[], maxBuffer = 16 * 1024 * 1024) {
  const { stdout } = await exec(executable, [...gitOptions, "-C", cwd, ...args], {
    env: { ...gitEnv(), GIT_NO_REPLACE_OBJECTS: "1", GIT_NO_LAZY_FETCH: "1", GIT_ALLOW_PROTOCOL: "" },
    windowsHide: true, encoding: "utf8", maxBuffer, timeout: 20_000,
  });
  return stdout;
}

const label = (ref: string) => ref.replace(/^refs\/heads\//, "");

/** What the branch scope is compared with: the person's choice, the worktree's starting commit, then the repository's default branch. */
async function chooseBase(executable: string, cwd: string, bases: readonly { ref: string }[], options: ScopeDiffOptions) {
  if (options.base) return bases.some(({ ref }) => ref === options.base) ? { ref: options.base, target: options.base } : null;
  if (options.worktreeBase) return { ref: options.worktreeBase.ref, target: options.worktreeBase.commit };
  const remote = (await git(executable, cwd, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"]).catch(() => "")).trim();
  if (remote) return { ref: remote, target: remote };
  const named = ["refs/heads/main", "refs/heads/master"].find((ref) => bases.some((base) => base.ref === ref));
  return named ? { ref: named, target: named } : null;
}

async function untrackedFiles(executable: string, cwd: string): Promise<{ files: ReviewFile[]; truncated: boolean }> {
  const names = (await git(executable, cwd, ["ls-files", "--others", "--exclude-standard", "-z"])).split("\0").filter(Boolean);
  const files: ReviewFile[] = [];
  for (const path of names.slice(0, MAX_UNTRACKED)) {
    if (isSecretPath(path)) { files.push(omittedFile(path, "secret", "added")); continue; }
    const absolute = join(cwd, path);
    try {
      const info = lstatSync(absolute);
      if (!info.isFile() || !inProjectFolder(cwd, absolute)) continue;
      if (info.size > UNTRACKED_FILE_BYTES) { files.push(omittedFile(path, "large", "added")); continue; }
      const bytes = readFileSync(absolute);
      const text = bytes.toString("utf8");
      if (bytes.subarray(0, 8192).includes(0) || !Buffer.from(text, "utf8").equals(bytes)) files.push(omittedFile(path, "binary", "added"));
      else files.push(diffTexts(path, null, text));
    } catch { files.push(omittedFile(path, "unreadable", "added")); }
  }
  return { files, truncated: names.length > MAX_UNTRACKED };
}

/**
 * The working tree of a Code project against HEAD (uncommitted) or against the point where it left a base branch (branch),
 * plus the files git does not track yet. Renames are shown as a delete and an add so every hunk has one path.
 */
export async function readScopeDiff(project: ProjectRoot, scope: "uncommitted" | "branch", options: ScopeDiffOptions = {}): Promise<ScopeDiffResult> {
  const repo = await readGitProject(project);
  if (repo === null) return { status: "unavailable", reason: "not-git" };
  if (repo === "unavailable") return { status: "unavailable", reason: "git-unavailable" };
  const { executable } = repo;
  const cwd = project.path;
  try {
    let from = "HEAD";
    let base: ReviewDiff["base"];
    const bases = repo.bases.filter(({ ref }) => ref.startsWith("refs/heads/")).map(({ ref }) => ({ ref, label: label(ref) }));
    if (scope === "branch") {
      const chosen = await chooseBase(executable, cwd, repo.bases, options);
      if (!chosen) return { status: "unavailable", reason: "no-base" };
      from = (await git(executable, cwd, ["merge-base", chosen.target, "HEAD"]).catch(() => "")).trim();
      if (!/^[0-9a-f]{40,64}$/.test(from)) return { status: "unavailable", reason: "no-base" };
      base = { ref: chosen.ref, label: label(chosen.ref) };
    }
    const common = ["--no-color", "--no-ext-diff", "--no-textconv", "--no-renames", "--relative"];
    const names = (await git(executable, cwd, ["diff", ...common, "--name-only", "-z", from, "--"])).split("\0").filter(Boolean);
    const known = names.slice(0, MAX_REVIEW_FILES);
    const text = known.length ? await git(executable, cwd, ["diff", ...common, "--src-prefix=a/", "--dst-prefix=b/", "-U3", from, "--"]) : "";
    const tracked = parseUnifiedDiff(text, known).map((file) => (isSecretPath(file.path) ? omittedFile(file.path, "secret", file.status) : file));
    const untracked = await untrackedFiles(executable, cwd);
    const all = [...tracked, ...untracked.files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    const files = all.slice(0, MAX_REVIEW_FILES);
    return { status: "ok", diff: {
      scope, files, ...(names.length > known.length || untracked.truncated || all.length > files.length ? { truncated: true as const } : {}),
      ...(base ? { base } : {}), ...(scope === "branch" ? { bases } : {}),
    } };
  } catch { return { status: "unavailable", reason: "failed" }; }
}
