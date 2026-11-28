import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { createManagedWorktree, readGitProject, readManagedWorktree, worktreeBranch } from "../src/host/git-worktree";
import { assertProjectRoot, bindProjectRoot } from "../src/host/project-root";

const git = (root: string, ...args: string[]) => execFileSync("git",
  ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", ...args],
  { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true }).trim();
const gitAvailable = (() => {
  try { return git(tmpdir(), "--version").startsWith("git version"); } catch { return false; }
})();

test("managed Agent worktrees use the selected commit and validate the original checkout on restore", { skip: !gitAvailable }, async (t) => {
  const temp = realpathSync(mkdtempSync(join(tmpdir(), "tomverse-git-worktree-")));
  t.after(() => {
    assert.equal(dirname(temp), realpathSync(tmpdir()));
    rmSync(temp, { recursive: true, force: true });
  });
  const root = join(temp, "repo");
  const nested = join(root, "application");
  const home = join(temp, "managed");
  mkdirSync(nested, { recursive: true });
  git(root, "init", "-b", "main");
  assert.equal(await readGitProject(bindProjectRoot(nested)), "unavailable");
  writeFileSync(join(nested, "tracked.txt"), "main");
  git(root, "add", ".");
  git(root, "commit", "-m", "baseline");
  git(root, "switch", "-c", "candidate");
  writeFileSync(join(nested, "tracked.txt"), "candidate");
  git(root, "commit", "-am", "candidate");
  git(root, "switch", "main");
  writeFileSync(join(nested, "tracked.txt"), "dirty original");
  const hooks = join(temp, "hooks");
  mkdirSync(hooks);
  writeFileSync(join(hooks, "post-checkout"), "#!/bin/sh\nexit 9\n", { mode: 0o700 });
  git(root, "config", "core.hooksPath", hooks);
  const source = bindProjectRoot(nested);
  const repo = await readGitProject(source);
  assert.ok(repo && repo !== "unavailable");
  const base = repo.bases.find(item => item.ref === "refs/heads/candidate");
  assert.ok(base);
  const missingId = randomUUID();
  await assert.rejects(createManagedWorktree(source, repo, home, missingId, base, {
    references: [{ path: "uncommitted.txt", kind: "file" }],
  }), /not|unavailable/);
  assert.equal(existsSync(join(home, missingId)), false);
  assert.equal(git(root, "branch", "--list", worktreeBranch(missingId)), "");

  const cancelledId = randomUUID();
  await assert.rejects(createManagedWorktree(source, repo, home, cancelledId, base, {
    checkReady: () => { throw new Error("cancelled handoff"); },
  }), /cancelled handoff/);
  assert.equal(existsSync(join(home, cancelledId)), false);
  assert.equal(git(root, "branch", "--list", worktreeBranch(cancelledId)), "");

  // What Git does not carry (the composer's attachment copies) is put in before the worktree is recorded; a failed copy
  // is taken out again, so the unchanged checkout and its branch are discarded.
  const carriedId = randomUUID();
  await assert.rejects(createManagedWorktree(source, repo, home, carriedId, base, {
    prepare: async (project) => {
      mkdirSync(join(project.path, ".tomverse-attachments"));
      writeFileSync(join(project.path, ".tomverse-attachments", "half-copied.png"), "partial");
      throw new Error("copy failed");
    },
    unprepare: async (project) => rmSync(join(project.path, ".tomverse-attachments"), { recursive: true, force: true }),
  }), /copy failed/);
  assert.equal(existsSync(join(home, carriedId)), false);
  assert.equal(git(root, "branch", "--list", worktreeBranch(carriedId)), "");

  const changedId = randomUUID();
  await assert.rejects(createManagedWorktree(source, repo, home, changedId, base, {
    checkReady(project) {
      writeFileSync(join(project.path, "outside-edit.txt"), "keep this edit");
      throw new Error("cancelled with changes");
    },
  }), /cancelled with changes/);
  assert.equal(readFileSync(join(home, changedId, "checkout", "application", "outside-edit.txt"), "utf8"), "keep this edit");

  const first = await createManagedWorktree(source, repo, home, randomUUID(), base, {
    references: [{ path: ".", kind: "folder" }, { path: "tracked.txt", kind: "file" }],
  });
  const second = await createManagedWorktree(source, repo, home, randomUUID(), base);
  assert.notEqual(first.info.branch, second.info.branch);
  assert.notEqual(first.info.path, second.info.path);
  assert.equal(git(first.project.path, "rev-parse", "HEAD"), base.commit);
  assert.equal(readFileSync(join(first.project.path, "tracked.txt"), "utf8"), "candidate");
  writeFileSync(join(first.project.path, "tracked.txt"), "edited in first");
  assert.equal(readFileSync(join(second.project.path, "tracked.txt"), "utf8"), "candidate");
  assert.equal(readFileSync(join(source.path, "tracked.txt"), "utf8"), "dirty original");
  assert.equal(git(source.path, "branch", "--show-current"), "main");
  assert.deepEqual(readManagedWorktree(home, first.project.path), first);
  git(first.project.path, "-c", "core.hooksPath=" + join(temp, "no-hooks"), "switch", "--detach");
  assert.throws(() => assertProjectRoot(first.project), /project folder changed/);
  assert.equal(readManagedWorktree(home, first.project.path)?.info.unavailable, true);
  git(root, "branch", "-f", "candidate", "main");
  await assert.rejects(createManagedWorktree(source, repo, home, randomUUID(), base), /starting branch changed/);
  git(root, "config", "filter.external.smudge", "unknown-checkout-program");
  await assert.rejects(createManagedWorktree(source, repo, home, randomUUID(), repo.bases[0]!), /manually prepared worktree/);
});
