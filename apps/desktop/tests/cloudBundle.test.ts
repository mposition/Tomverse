import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { applyPatch, createSnapshotBundle, patchApplies } from "../src/host/cloud-bundle";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "core.autocrlf=false", ...args], { cwd }).toString();

function repository() {
  const root = mkdtempSync(join(tmpdir(), "cloud-bundle-"));
  git(root, "init", "--quiet");
  writeFileSync(join(root, "app.txt"), "one\ntwo\n");
  writeFileSync(join(root, "keep.txt"), "keep\n");
  writeFileSync(join(root, ".env"), "TOKEN=secret-value\n");
  git(root, "add", ".");
  git(root, "commit", "--quiet", "-m", "base");
  return { root, executable: "git" };
}

function readBundle(bytes: Buffer) {
  const dir = mkdtempSync(join(tmpdir(), "cloud-bundle-read-"));
  const file = join(dir, "x.bundle");
  writeFileSync(file, bytes);
  git(dir, "init", "--quiet", "clone");
  const clone = join(dir, "clone");
  git(clone, "fetch", "--quiet", file, "refs/heads/snapshot:refs/heads/snapshot");
  git(clone, "checkout", "--quiet", "snapshot");
  return { dir, clone };
}

test("the snapshot holds tracked files as they are now, without credentials, untracked files or history", async () => {
  const project = repository();
  writeFileSync(join(project.root, "app.txt"), "one\ntwo\nthree\n");
  writeFileSync(join(project.root, "untracked.txt"), "not uploaded\n");
  const refsBefore = git(project.root, "for-each-ref");
  const statusBefore = git(project.root, "status", "--porcelain");
  const objectsBefore = git(project.root, "count-objects", "-v");
  const snapshot = await createSnapshotBundle(project, 32 * 1024 * 1024);
  assert.ok(!("failure" in snapshot), JSON.stringify(snapshot));
  assert.equal(snapshot.omitted, 1);
  assert.equal(snapshot.files, 2);
  assert.match(snapshot.bytes.subarray(0, 16).toString("utf8"), /^# v[23] git bundle\n/);
  const { dir, clone } = readBundle(snapshot.bytes);
  try {
    assert.equal(readFileSync(join(clone, "app.txt"), "utf8"), "one\ntwo\nthree\n");
    assert.equal(git(clone, "ls-files").split("\n").filter(Boolean).sort().join(","), "app.txt,keep.txt");
    assert.equal(git(clone, "rev-parse", "HEAD").trim(), snapshot.baseCommit);
    // One commit, no parent: no history leaves the computer.
    assert.equal(git(clone, "rev-list", "--count", "HEAD").trim(), "1");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  // Nothing in the person's repository changed: refs, staging and objects are as they were.
  assert.equal(git(project.root, "for-each-ref"), refsBefore);
  assert.equal(git(project.root, "status", "--porcelain"), statusBefore);
  assert.equal(git(project.root, "count-objects", "-v"), objectsBefore);
  rmSync(project.root, { recursive: true, force: true });
});

test("a snapshot over the size limit is refused, and a repository without a commit has nothing to send", async () => {
  const project = repository();
  assert.deepEqual(await createSnapshotBundle(project, 10), { failure: "tooLarge" });
  const empty = mkdtempSync(join(tmpdir(), "cloud-bundle-empty-"));
  git(empty, "init", "--quiet");
  assert.deepEqual(await createSnapshotBundle({ root: empty, executable: "git" }, 1024 * 1024), { failure: "noCommit" });
  rmSync(project.root, { recursive: true, force: true });
  rmSync(empty, { recursive: true, force: true });
});

test("a patch made against the snapshot applies whole to the folder, and one that no longer fits changes nothing", async () => {
  const project = repository();
  writeFileSync(join(project.root, "app.txt"), "one\ntwo\nthree\n");
  const snapshot = await createSnapshotBundle(project, 32 * 1024 * 1024);
  assert.ok(!("failure" in snapshot));
  // Stand in for the runner: change the snapshot and diff it against its own commit.
  const { dir, clone } = readBundle(snapshot.bytes);
  writeFileSync(join(clone, "app.txt"), "one\n2\nthree\n");
  writeFileSync(join(clone, "new.txt"), "added\n");
  git(clone, "add", "--all");
  const patch = Buffer.from(git(clone, "diff", "--cached", "--binary", "--no-renames", snapshot.baseCommit));
  rmSync(dir, { recursive: true, force: true });
  assert.equal(await patchApplies(project, patch), true);
  writeFileSync(join(project.root, "app.txt"), "changed meanwhile\n");
  assert.equal(await applyPatch(project, patch), "conflict");
  assert.equal(readFileSync(join(project.root, "app.txt"), "utf8"), "changed meanwhile\n");
  assert.throws(() => readFileSync(join(project.root, "new.txt")));
  writeFileSync(join(project.root, "app.txt"), "one\ntwo\nthree\n");
  assert.equal(await applyPatch(project, patch), "applied");
  assert.equal(readFileSync(join(project.root, "app.txt"), "utf8"), "one\n2\nthree\n");
  assert.equal(readFileSync(join(project.root, "new.txt"), "utf8"), "added\n");
  rmSync(project.root, { recursive: true, force: true });
});
