import { execFile } from "node:child_process";
import { lstatSync, mkdirSync, readFileSync, realpathSync, rmdirSync, writeFileSync } from "node:fs";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { gitEnv, type WorkspaceReference } from "../../../tomverse-cli/src/workspace.js";
import { same } from "../../../tomverse-cli/src/runtime.js";
import { pathIdentity } from "../../../tomverse-cli/src/patch.js";
import { codeWorktreeBase, codeWorktreeCommit, type CodeWorktree, type CodeWorktreeBase } from "../contract";
import { assertProjectRoot, bindProjectRoot, inProjectFolder, type ProjectRoot } from "./project-root";

const exec = promisify(execFile);
const gitOptions = [
  "--no-pager", "-c", "core.fsmonitor=false", "-c", "submodule.recurse=false",
  "-c", "protocol.allow=never", "-c", "core.longpaths=true",
];
const recordSchema = z.object({
  identity: z.string().regex(/^\d+:\d+$/),
  gitDirectory: z.string(),
  base: codeWorktreeBase,
}).strict();

export type GitProject = {
  executable: string;
  root: string;
  commonDirectory: ProjectRoot;
  subdirectory: string;
  bases: CodeWorktreeBase[];
};
export type ManagedWorktree = { project: ProjectRoot; info: CodeWorktree };

function repoFolder(path: string): string | undefined {
  let folder = path;
  for (;;) {
    try {
      lstatSync(join(folder, ".git"));
      return folder;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return folder;
    }
    const parent = dirname(folder);
    if (parent === folder) return undefined;
    folder = parent;
  }
}

function resolveGit(repo: string) {
  const env: NodeJS.ProcessEnv = gitEnv();
  const executable = process.platform === "win32" ? "git.exe" : "git";
  // Use an absolute executable so Windows does not search the selected project.
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() !== "path") continue;
    for (const entry of (env[key] ?? "").split(delimiter)) {
      const folder = entry.replace(/^"(.*)"$/, "$1");
      if (!isAbsolute(folder)) continue;
      try {
        const path = realpathSync(join(folder, executable));
        if (!inProjectFolder(repo, path) && lstatSync(path).isFile()) return path;
      } catch { /* Try the next configured PATH entry. */ }
    }
  }
  throw new Error("Git is unavailable.");
}

async function git(project: Pick<GitProject, "executable" | "root">, args: string[], timeout = 5_000) {
  const { stdout } = await exec(project.executable, [...gitOptions, "-C", project.root, ...args], {
    env: { ...gitEnv(), GIT_NO_REPLACE_OBJECTS: "1", GIT_NO_LAZY_FETCH: "1", GIT_ALLOW_PROTOCOL: "" },
    windowsHide: true, encoding: "utf8", maxBuffer: 256 * 1024, timeout,
  });
  return stdout.trimEnd();
}

export async function readGitProject(project: ProjectRoot): Promise<GitProject | "unavailable" | null> {
  const root = repoFolder(project.path);
  if (!root) return null;
  try {
    const executable = resolveGit(root);
    const context = { root, executable };
    const [actualRoot, head, refs, currentRef, commonDirectory] = await Promise.all([
      git(context, ["rev-parse", "--show-toplevel"]),
      git(context, ["rev-parse", "--verify", "HEAD^{commit}"]),
      git(context, ["for-each-ref", "--sort=-committerdate", "--count=100", "--format=%(refname)%00%(objectname)", "refs/heads/"]),
      git(context, ["symbolic-ref", "--quiet", "HEAD"]).catch(() => ""),
      gitCommonDirectory(context),
    ]);
    if (!same(root, realpathSync.native(actualRoot))) return "unavailable";
    const base = codeWorktreeBase.parse({ ref: currentRef || "HEAD", commit: head });
    const otherBases = refs.split("\n").flatMap(line => {
      const [ref, commit] = line.trimEnd().split("\0");
      if (!ref?.startsWith("refs/heads/") || ref === base.ref) return [];
      const entry = codeWorktreeBase.safeParse({ ref, commit });
      return entry.success ? [entry.data] : [];
    });
    const identity = pathIdentity(commonDirectory, "directory");
    if (!identity) return "unavailable";
    return { ...context, commonDirectory: { path: commonDirectory, identity },
      subdirectory: relative(root, project.path), bases: [base, ...otherBases] };
  } catch { return "unavailable"; }
}

export const worktreeBranch = (id: string) => "tomverse-task-" + id;
export const worktreePath = (home: string, id: string, subdirectory: string) => join(home, id, "checkout", subdirectory);

async function verifyGitRepository(repo: GitProject) {
  const [common, keys] = await Promise.all([gitCommonDirectory(repo), git(repo, ["config", "--local", "--no-includes", "--name-only", "--list", "-z"])]);
  if (!same(common, repo.commonDirectory.path) || pathIdentity(common, "directory") !== repo.commonDirectory.identity) {
    throw new Error("The selected Git repository changed.");
  }
  // Checkout must not trigger repository-defined programs or nested configuration.
  if (keys.split("\0").some(key => /^(?:include(?:if)?\.|filter\.|extensions\.worktreeconfig$)/i.test(key))) {
    throw new Error("This Git configuration requires a manually prepared worktree.");
  }
  return common;
}

async function checkCommittedPaths(repo: GitProject, commit: string, references: readonly WorkspaceReference[]) {
  const expected = new Map(references.filter(item => item.path !== ".")
    .map(item => [join(repo.subdirectory, item.path).split(sep).join("/"), item.kind]));
  if (repo.subdirectory) expected.set(repo.subdirectory.split(sep).join("/"), "folder");
  await Promise.all([...expected].map(async ([path, kind]) => {
    const row = (await git(repo, ["--literal-pathspecs", "ls-tree", "--full-tree", "-z", commit, "--", path])).split("\0", 1)[0]!;
    const separator = row.indexOf("\t");
    const mode = row.slice(0, 6);
    const matchesKind = kind === "folder" ? mode === "040000" : mode === "100644" || mode === "100755";
    if (separator < 0 || row.slice(separator + 1) !== path || !matchesKind) {
      throw new Error("A project folder or selected reference is unavailable in this branch.");
    }
  }));
}

async function discardUnstartedCheckout(repo: GitProject, slot: string, branch: string, base: CodeWorktreeBase) {
  const checkout = join(slot, "checkout");
  if (!same(realpathSync(checkout), checkout)) return;
  const hooks = ["-c", "core.hooksPath=" + join(slot, "disabled-hooks")];
  const linked = { executable: repo.executable, root: checkout };
  const [common, linkedCommon, head, ref] = await Promise.all([
    verifyGitRepository(repo), gitCommonDirectory(linked),
    git(linked, ["rev-parse", "HEAD"]), git(linked, ["symbolic-ref", "HEAD"]),
  ]);
  if (!same(common, linkedCommon) || head !== base.commit || ref !== "refs/heads/" + branch ||
      await git(linked, [...hooks, "status", "--porcelain", "--untracked-files=all", "--ignored"])) return;
  await git(repo, [...hooks, "worktree", "remove", "--", checkout]);
  const upstream = base.ref.startsWith("refs/heads/")
    ? ["-c", "branch." + branch + ".remote=.", "-c", "branch." + branch + ".merge=" + base.ref] : [];
  await git(repo, [...hooks, ...upstream, "branch", "-d", "--", branch]);
}

export async function createManagedWorktree(source: ProjectRoot, repo: GitProject, home: string, id: string, base: CodeWorktreeBase,
  { references = [], checkReady }: { references?: readonly WorkspaceReference[]; checkReady?: (project: ProjectRoot) => void } = {}): Promise<ManagedWorktree> {
  assertProjectRoot(source);
  if (!repo.bases.some(choice => choice.ref === base.ref && choice.commit === base.commit)) throw new Error("Choose a current starting branch.");
  const [commit, commonDirectory] = await Promise.all([
    git(repo, ["rev-parse", "--verify", "--end-of-options", base.ref + "^{commit}"]), verifyGitRepository(repo),
  ]);
  if (codeWorktreeCommit.parse(commit) !== base.commit) throw new Error("The starting branch changed. Review the new starting commit.");
  await checkCommittedPaths(repo, commit, references);
  assertProjectRoot(source);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  if (!same(realpathSync(home), home)) throw new Error("The worktree directory changed.");
  const slot = join(home, id);
  mkdirSync(slot, { mode: 0o700 });
  const checkout = join(slot, "checkout");
  const branch = worktreeBranch(id);
  try {
    await git(repo, ["-c", "core.hooksPath=" + join(slot, "disabled-hooks"),
      "worktree", "add", "-b", branch, "--", checkout, commit], 120_000);
    const project = bindProjectRoot(worktreePath(home, id, repo.subdirectory));
    if (!same(project.path, worktreePath(home, id, repo.subdirectory))) throw new Error("The selected project path has moved in this branch.");
    const gitDirectory = realpathSync(await git({ ...repo, root: checkout }, ["rev-parse", "--absolute-git-dir"]));
    if (!inProjectFolder(join(commonDirectory, "worktrees"), gitDirectory)) throw new Error("The worktree is attached to a different repository.");
    const managed = { ...project, worktree: { checkout, gitDirectory, branch } };
    assertProjectRoot(managed);
    checkReady?.(managed);
    writeFileSync(join(slot, "worktree.json"), JSON.stringify({ identity: project.identity, gitDirectory, base }), { flag: "wx", mode: 0o600 });
    return { project: managed, info: { path: project.path, branch, base } };
  } catch (error) {
    await discardUnstartedCheckout(repo, slot, branch, base).catch(() => {});
    try { rmdirSync(slot); } catch { /* Keep a checkout Git could not confirm as unchanged. */ }
    throw error;
  }
}

async function gitCommonDirectory(repo: Pick<GitProject, "root" | "executable">) {
  return realpathSync.native(resolve(repo.root, await git(repo, ["rev-parse", "--git-common-dir"])));
}

export function readManagedWorktree(home: string, path: string): ManagedWorktree | null {
  const [id, checkoutName] = relative(home, path).split(sep);
  if (!id || !z.uuid().safeParse(id).success || checkoutName !== "checkout") return null;
  const slot = join(home, id);
  const checkout = join(slot, "checkout");
  if (!inProjectFolder(checkout, path) || !isAbsolute(path) || basename(slot) !== id) return null;
  try {
    const marker = join(slot, "worktree.json");
    if (!same(realpathSync(slot), slot) || !lstatSync(marker).isFile() || lstatSync(marker).size > 8192) return null;
    const { identity, gitDirectory, base } = recordSchema.parse(JSON.parse(readFileSync(marker, "utf8")));
    const branch = worktreeBranch(id);
    const project = { path, identity, worktree: { checkout, gitDirectory, branch } };
    const info: CodeWorktree = { path, branch, base };
    try { assertProjectRoot(project); }
    catch { info.unavailable = true; }
    return { project, info };
  } catch { return null; }
}
