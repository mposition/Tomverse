import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { gitEnv, isSecretPath } from "../../../tomverse-cli/src/workspace.js";

const exec = promisify(execFile);
/** The review panel's git restrictions (review-git.ts): no repository-defined programs, no nested configuration. */
const gitOptions = [
  "--no-pager", "-c", "core.fsmonitor=false", "-c", "submodule.recurse=false",
  "-c", "protocol.allow=never", "-c", "core.longpaths=true", "-c", "core.quotepath=false",
];

export type GitContext = { root: string; executable: string };
export type SnapshotBundle = { bytes: Buffer; sha256: string; baseCommit: string; files: number; omitted: number };
export type SnapshotFailure = "noCommit" | "tooLarge" | "snapshotFailed";

async function git(context: GitContext, args: string[], env: Record<string, string> = {}, maxBuffer = 16 * 1024 * 1024) {
  const { stdout } = await exec(context.executable, [...gitOptions, "-C", context.root, ...args], {
    env: { ...gitEnv(), GIT_NO_REPLACE_OBJECTS: "1", GIT_NO_LAZY_FETCH: "1", GIT_ALLOW_PROTOCOL: "", ...env },
    windowsHide: true, encoding: "utf8", maxBuffer, timeout: 120_000,
  });
  return stdout;
}

/**
 * A git bundle of the project's tracked files as they are now: HEAD's tree with the working copy's changes to tracked
 * files staged into a temporary index, without files that look like credentials (the CLI's own refusal list), as one
 * commit with no parent and no history. Untracked and ignored files are not in it.
 *
 * Nothing in the person's repository changes: the index, the new objects and the ref the bundle needs live in a
 * temporary folder (an object directory with the repository's objects as alternates), which is removed afterwards.
 */
export async function createSnapshotBundle(context: GitContext, maxBytes: number): Promise<SnapshotBundle | { failure: SnapshotFailure }> {
  const temp = await mkdtemp(join(tmpdir(), "tomverse-cloud-snapshot-"));
  try {
    let head: string;
    try { head = (await git(context, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"])).trim(); } catch { return { failure: "noCommit" }; }
    if (!/^[a-f0-9]{40}([a-f0-9]{24})?$/.test(head)) return { failure: "noCommit" };
    const objects = (await git(context, ["rev-parse", "--path-format=absolute", "--git-path", "objects"])).trim();
    const scratch = join(temp, "objects");
    // git refuses an object directory that does not exist.
    await mkdir(join(scratch, "pack"), { recursive: true });
    await mkdir(join(scratch, "info"), { recursive: true });
    const env = { GIT_INDEX_FILE: join(temp, "index"), GIT_OBJECT_DIRECTORY: scratch, GIT_ALTERNATE_OBJECT_DIRECTORIES: objects };
    await git(context, ["read-tree", head], env);
    await git(context, ["add", "--update", "--", "."], env);
    const names = (await git(context, ["ls-files", "-z"], env, 128 * 1024 * 1024)).split("\0").filter(Boolean);
    const secrets = names.filter((name) => isSecretPath(name));
    for (let at = 0; at < secrets.length; at += 200) await git(context, ["rm", "--cached", "--quiet", "--", ...secrets.slice(at, at + 200)], env);
    const tree = (await git(context, ["write-tree"], env)).trim();
    const identity = { GIT_AUTHOR_NAME: "Tomverse Desktop", GIT_AUTHOR_EMAIL: "desktop@tomverse.invalid", GIT_COMMITTER_NAME: "Tomverse Desktop", GIT_COMMITTER_EMAIL: "desktop@tomverse.invalid" };
    const commit = (await git(context, ["commit-tree", tree, "-m", "Tomverse cloud snapshot"], { ...env, ...identity })).trim();
    // A bare repository that sees both object folders holds the one ref git bundle needs.
    const bare = join(temp, "snapshot.git");
    await exec(context.executable, [...gitOptions, "init", "--quiet", "--bare", bare], { env: gitEnv(), windowsHide: true });
    await writeFile(join(bare, "objects", "info", "alternates"), `${scratch}\n${objects}\n`);
    const inBare = { root: bare, executable: context.executable };
    await git(inBare, ["update-ref", "refs/heads/snapshot", commit]);
    const out = join(temp, "snapshot.bundle");
    await git(inBare, ["bundle", "create", "--quiet", out, "refs/heads/snapshot"]);
    if ((await stat(out)).size > maxBytes) return { failure: "tooLarge" };
    const bytes = await readFile(out);
    return { bytes, sha256: createHash("sha256").update(bytes).digest("hex"), baseCommit: commit, files: names.length - secrets.length, omitted: secrets.length };
  } catch {
    return { failure: "snapshotFailed" };
  } finally {
    await rm(temp, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
  }
}

/** Whether the patch applies to the folder as it is now, without changing anything. */
export async function patchApplies(context: GitContext, patch: Buffer) {
  const temp = await mkdtemp(join(tmpdir(), "tomverse-cloud-patch-"));
  try {
    const file = join(temp, "result.patch");
    await writeFile(file, patch);
    await git(context, ["apply", "--check", "--whitespace=nowarn", file]);
    return true;
  } catch {
    return false;
  } finally {
    await rm(temp, { recursive: true, force: true }).catch(() => {});
  }
}

/** Applies the whole patch to the working copy, or nothing: `git apply` writes no file unless every hunk fits. */
export async function applyPatch(context: GitContext, patch: Buffer): Promise<"applied" | "conflict" | "failed"> {
  if (!(await patchApplies(context, patch))) return "conflict";
  const temp = await mkdtemp(join(tmpdir(), "tomverse-cloud-patch-"));
  try {
    const file = join(temp, "result.patch");
    await writeFile(file, patch);
    await git(context, ["apply", "--whitespace=nowarn", file]);
    return "applied";
  } catch {
    return "failed";
  } finally {
    await rm(temp, { recursive: true, force: true }).catch(() => {});
  }
}
