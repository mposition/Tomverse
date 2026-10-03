import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export class GitError extends Error {
  constructor(code, detail, { clientFault = false } = {}) {
    super(`${code}${detail ? `: ${detail}` : ""}`);
    this.code = code;
    // The request was wrong (bad SHA, unpushed base, mismatched head), not the server.
    this.clientFault = clientFault;
  }
}

export const SHA = /^[0-9a-f]{40}$/;
export const BUNDLE_REF = /^refs\/review-orchestrator\/[0-9a-f]{16}$/;

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
export function importBundle({ mirror, bundlePath, bundleRef, jobId, base, head, trustedBaseRefs, maxChangeBytes }) {
  if (!SHA.test(base) || !SHA.test(head)) throw new GitError("sha_invalid", "", { clientFault: true });
  if (!BUNDLE_REF.test(bundleRef ?? "")) throw new GitError("bundle_ref_invalid", "", { clientFault: true });
  const verify = git(["bundle", "verify", bundlePath], { cwd: mirror, allowFailure: true });
  if (!verify.ok) {
    throw new GitError(
      "bundle_unverifiable",
      "the base commit must already be on the remote; push it or pick a pushed base",
      { clientFault: true },
    );
  }
  const ref = `refs/review/${jobId}`;
  git(["fetch", "--quiet", bundlePath, `+${bundleRef}:${ref}`], { cwd: mirror });
  const actual = git(["rev-parse", ref], { cwd: mirror }).stdout.trim();
  if (actual !== head) {
    git(["update-ref", "-d", ref], { cwd: mirror, allowFailure: true });
    throw new GitError("head_mismatch", `bundle head ${actual} is not ${head}`, { clientFault: true });
  }
  const refuse = (code, detail) => {
    git(["update-ref", "-d", ref], { cwd: mirror, allowFailure: true });
    throw new GitError(code, detail, { clientFault: true });
  };
  const ancestor = git(["merge-base", "--is-ancestor", base, head], { cwd: mirror, allowFailure: true });
  if (!ancestor.ok) refuse("base_not_ancestor");
  // The reviewer's instruction files come from the base, so the base must be
  // history a person merged, not a commit the submitter pushed anywhere.
  const trusted = trustedBaseRefs.some(
    (trustedRef) =>
      git(["rev-parse", "--verify", "--quiet", trustedRef], { cwd: mirror, allowFailure: true }).ok &&
      git(["merge-base", "--is-ancestor", base, trustedRef], { cwd: mirror, allowFailure: true }).ok,
  );
  if (!trusted) {
    refuse("base_not_trusted", `the base must be in the history of ${trustedBaseRefs.join(" or ")}`);
  }
  const size = introducedBytes(mirror, base, head);
  if (size > maxChangeBytes) refuse("change_too_large", `${size} bytes of new objects, limit ${maxChangeBytes}`);
  return ref;
}

/** Uncompressed size of every object `head` adds over `base`. */
export function introducedBytes(mirror, base, head) {
  const objects = git(["rev-list", "--objects", "--no-object-names", `${base}..${head}`], { cwd: mirror }).stdout;
  if (objects.trim() === "") return 0;
  const result = spawnSync("git", ["cat-file", "--batch-check=%(objectsize)"], {
    cwd: mirror,
    input: objects,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) throw new GitError("git_failed", "cat-file --batch-check");
  return result.stdout.split("\n").filter(Boolean).reduce((sum, line) => sum + Number(line), 0);
}

export function deleteReviewRef(mirror, jobId) {
  git(["update-ref", "-d", `refs/review/${jobId}`], { cwd: mirror, allowFailure: true });
}

export function changedFiles(mirror, base, head) {
  return git(["diff", "--no-renames", "--name-only", "-z", base, head], { cwd: mirror })
    .stdout.split("\0")
    .filter(Boolean);
}

export function diffText(mirror, base, head) {
  return git(["diff", "--no-renames", "--no-color", "--no-ext-diff", base, head], { cwd: mirror }).stdout;
}

export function addWorktree(mirror, dir, head) {
  git(["worktree", "add", "--detach", "--quiet", dir, head], { cwd: mirror });
}

/**
 * Files the reviewer CLIs load on their own as instructions. The author must
 * not be able to instruct the reviewer, so the reviewer's checkout carries the
 * base versions of these and nothing else; their edits reach the reviewer only
 * as quoted diff.
 *
 * The checkout is rebuilt from the two trees, not from the diff: a diff hides
 * rename sources, and an instruction directory replaced by a symlink is one
 * path that names no file inside it. Every write goes to a literal path from
 * `ls-tree`, never through a pathspec.
 */
const INSTRUCTION_NAMES = new Set([
  "agents.md", "agents.override.md", "claude.md", "claude.local.md", "gemini.md",
  ".cursorrules", ".windsurfrules", "copilot-instructions.md",
  // Project MCP server configuration: a server it names is a program to run.
  ".mcp.json",
]);
const INSTRUCTION_DIRS = new Set([".claude", ".codex", ".cursor", ".agents", ".devin", ".copilot"]);

/**
 * GitHub Copilot also reads instruction, prompt, agent and chat-mode files,
 * and loads skills, hooks and plugins, from these directories under
 * `.github/` (the directory itself included, in case it is a symlink). A hook
 * is a shell command: one planted in a branch under review would run on the
 * review server. `.github/` as a whole is not an instruction directory:
 * workflows there are reviewed as code.
 */
const COPILOT_INSTRUCTION_DIRS = new Set([
  "instructions", "prompts", "agents", "chatmodes", "skills", "hooks", "plugins", "copilot",
]);

export function isInstructionPath(path) {
  const segments = path.split("/");
  if (INSTRUCTION_NAMES.has(segments[segments.length - 1].toLowerCase())) return true;
  if (segments.length === 2 && segments[0].toLowerCase() === ".vscode" && segments[1].toLowerCase() === "mcp.json") {
    return true;
  }
  if (segments.length >= 2 && segments[0].toLowerCase() === ".github" && COPILOT_INSTRUCTION_DIRS.has(segments[1].toLowerCase())) {
    return true;
  }
  // Any segment, the last included: `.claude` itself may be a symlink.
  return segments.some((segment) => INSTRUCTION_DIRS.has(segment.toLowerCase()));
}

/** The shortest prefix of `path` that is an instruction directory, or the path itself. */
function instructionRoot(path) {
  const segments = path.split("/");
  const at = segments.findIndex((segment) => INSTRUCTION_DIRS.has(segment.toLowerCase()));
  return at === -1 ? path : segments.slice(0, at + 1).join("/");
}

function lsTree(cwd, commit) {
  const out = git(["ls-tree", "-r", "-z", "--full-tree", commit], { cwd }).stdout;
  return out
    .split("\0")
    .filter(Boolean)
    .map((line) => {
      const tab = line.indexOf("\t");
      const [mode, type, sha] = line.slice(0, tab).split(" ");
      return { mode, type, sha, path: line.slice(tab + 1) };
    });
}

function blob(cwd, sha) {
  const result = spawnSync("git", ["cat-file", "blob", sha], { cwd, maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) throw new GitError("git_failed", "cat-file");
  return result.stdout;
}

/** Make every directory on the way to `rel` a real directory inside `root`. */
function realParents(root, rel) {
  const segments = rel.split("/").slice(0, -1);
  let current = root;
  for (const segment of segments) {
    current = join(current, segment);
    let stat = null;
    try {
      stat = lstatSync(current);
    } catch {
      // missing
    }
    if (stat && !stat.isDirectory()) rmSync(current, { force: true });
    if (!stat || !stat.isDirectory()) mkdirSync(current);
  }
}

export function isolateInstructionFiles(worktree, base, head) {
  const roots = new Set(lsTree(worktree, head).filter((e) => isInstructionPath(e.path)).map((e) => instructionRoot(e.path)));
  for (const root of roots) rmSync(join(worktree, root), { recursive: true, force: true });
  for (const entry of lsTree(worktree, base)) {
    if (!isInstructionPath(entry.path)) continue;
    // Regular files only: a base symlink or submodule is not recreated.
    if (entry.type !== "blob" || (entry.mode !== "100644" && entry.mode !== "100755")) continue;
    realParents(worktree, entry.path);
    writeFileSync(join(worktree, entry.path), blob(worktree, entry.sha));
  }
}

/** The diff of instruction paths only, so it can be shown in full and first. */
export function instructionDiff(mirror, base, head, files) {
  const paths = files.filter(isInstructionPath);
  if (paths.length === 0) return { paths, text: "" };
  const text = git(
    ["--literal-pathspecs", "diff", "--no-renames", "--no-color", "--no-ext-diff", base, head, "--", ...paths],
    { cwd: mirror },
  ).stdout;
  return { paths, text };
}

export function removeWorktree(mirror, dir) {
  git(["worktree", "remove", "--force", dir], { cwd: mirror, allowFailure: true });
  git(["worktree", "prune"], { cwd: mirror, allowFailure: true });
}
