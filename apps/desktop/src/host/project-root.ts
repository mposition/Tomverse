import { lstatSync, mkdirSync, readFileSync, realpathSync, statSync, unlinkSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { normalizeRoot, same, sha256 } from "../../../tomverse-cli/src/runtime.js";
import { claimLock } from "../../../tomverse-cli/src/session.js";

export type ProjectRoot = {
  path: string;
  identity: string;
  worktree?: { checkout: string; gitDirectory: string; branch: string };
};

export function inProjectFolder(root: string, path: string) {
  const subtree = relative(root, path);
  return subtree !== ".." && !subtree.startsWith(".." + sep) && !isAbsolute(subtree);
}

function readGitPointer(path: string) {
  const info = lstatSync(path);
  if (!info.isFile() || info.size > 8192) throw new Error("Invalid worktree link.");
  return readFileSync(path, "utf8").trimEnd();
}

function assertWorktree(project: ProjectRoot, worktree: NonNullable<ProjectRoot["worktree"]>) {
  const { checkout, gitDirectory, branch } = worktree;
  if (!inProjectFolder(checkout, project.path) || !same(realpathSync(checkout), checkout) ||
      !same(realpathSync(gitDirectory), gitDirectory)) throw new Error("Invalid worktree directory.");
  const gitFile = join(checkout, ".git");
  const pointer = readGitPointer(gitFile);
  if (!pointer.startsWith("gitdir: ") || !same(resolve(checkout, pointer.slice(8)), gitDirectory) ||
      !same(resolve(gitDirectory, readGitPointer(join(gitDirectory, "gitdir"))), gitFile) ||
      readGitPointer(join(gitDirectory, "HEAD")) !== "ref: refs/heads/" + branch) {
    throw new Error("The Code worktree branch changed.");
  }
}

export function bindProjectRoot(path: string): ProjectRoot {
  if (process.platform === "win32" && /^[\\/]{2}/.test(path)) throw new Error("Choose a local project folder.");
  const canonical = normalizeRoot(path);
  if (process.platform === "win32" && /^[\\/]{2}/.test(canonical)) throw new Error("Choose a local project folder.");
  const { dev, ino } = statSync(canonical, { bigint: true });
  return { path: canonical, identity: `${dev}:${ino}` };
}

export function assertProjectRoot(project: ProjectRoot) {
  try {
    const current = bindProjectRoot(project.path);
    if (same(current.path, project.path) && current.identity === project.identity) {
      if (project.worktree) assertWorktree(project, project.worktree);
      return;
    }
  } catch { /* Missing or inaccessible projects also require reselection. */ }
  throw new Error("The project folder changed. Open it again before running Code.");
}

export function claimCodeProject(project: ProjectRoot, directory: string, attachedProject = project) {
  // A journal-only operation can take the same lock through its original project.
  assertProjectRoot(attachedProject);
  mkdirSync(dirname(directory), { recursive: true, mode: 0o700 });
  const home = join(realpathSync(dirname(directory)), basename(directory));
  mkdirSync(home, { recursive: true, mode: 0o700 });
  if (!lstatSync(home).isDirectory() || !same(realpathSync(home), home)) throw new Error("The Code workspace lock folder changed.");
  const lock = join(home, sha256(project.identity) + ".lock");
  claimLock(lock, "Code workspace");
  return () => {
    try { unlinkSync(lock); } catch { /* Preserve the lock if the filesystem cannot confirm removal. */ }
  };
}
