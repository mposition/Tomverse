import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const verifier = fileURLToPath(new URL("../scripts/verify-amux-wsl-git-transfer.mjs", import.meta.url));
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const safeEnv = Object.fromEntries(Object.entries(process.env)
  .filter(([name]) => !name.startsWith("GIT_")));

function git(...args) {
  return execFileSync("git", args, { env: safeEnv }).toString("utf8").trim();
}

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "amux-git-verify-"));
  t.after(() => {
    assert.ok(resolve(root).startsWith(resolve(tmpdir())));
    rmSync(root, { recursive: true, force: true });
  });
  const source = join(root, "source");
  const mirror = join(root, "mirror.git");
  const recovered = join(root, "recovered");
  const inventoryPath = join(root, "inventory.json");
  git("init", "-q", "-b", "main", source);
  git("-C", source, "config", "user.name", "Migration Test");
  git("-C", source, "config", "user.email", "migration-test@example.invalid");
  writeFileSync(join(source, "tracked.txt"), "committed\n");
  git("-C", source, "add", "tracked.txt");
  git("-C", source, "commit", "-qm", "initial");
  const head = git("-C", source, "rev-parse", "HEAD");
  git("clone", "--mirror", "--quiet", "--no-hardlinks", source, mirror);
  git("--git-dir", mirror, "update-ref", "refs/migration/wsl/worktree-heads/00-source", head);
  git("--git-dir", mirror, "worktree", "add", "--detach", "--quiet", recovered, head);
  writeFileSync(join(source, "local-note.txt"), "untracked state\n");
  copyFileSync(join(source, "local-note.txt"), join(recovered, "local-note.txt"));
  const localNote = readFileSync(join(source, "local-note.txt"));
  const inventory = {
    schema: "tomverse-wsl-git-inventory-v3",
    repositories: [{
      root: source,
      localRefs: [{ name: "refs/heads/main", sha: head }],
      worktrees: [{
        path: source,
        exists: true,
        head,
        status: {
          entries: ["?? local-note.txt"],
          indexEntriesSha256: sha256(execFileSync("git",
            ["-C", source, "ls-files", "--stage", "-z"], { env: safeEnv })),
          unstagedTrackedFiles: [],
        },
        untrackedFiles: [{
          path: "local-note.txt",
          bytes: localNote.length,
          sha256: sha256(localNote),
        }],
      }],
    }],
  };
  const save = () => writeFileSync(inventoryPath, JSON.stringify(inventory));
  save();
  return { root, source, mirror, recovered, inventoryPath, inventory, save, head };
}

function verify(item, overrides = {}) {
  const args = [
    verifier,
    "--inventory", item.inventoryPath,
    "--mirror", item.source + "=" + item.mirror,
    "--recovered", item.source + "=" + (overrides.recovered ?? item.recovered),
  ];
  return spawnSync(process.execPath, args, {
    encoding: "utf8",
    env: { ...safeEnv, ...overrides.env },
  });
}

test("verifies a standalone mirror and ignores inherited Git location overrides", (t) => {
  const item = fixture(t);
  const result = verify(item, {
    env: {
      GIT_DIR: join(item.root, "missing-git-dir"),
      GIT_WORK_TREE: join(item.root, "missing-work-tree"),
      GIT_OBJECT_DIRECTORY: join(item.root, "missing-objects"),
      GIT_ALTERNATE_OBJECT_DIRECTORIES: join(item.root, "missing-alternates"),
    },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).recoveredDirtyWorktrees, 1);
});

test("rejects a recovered worktree backed by another mirror", (t) => {
  const item = fixture(t);
  const other = join(item.root, "other.git");
  const otherWorktree = join(item.root, "other-recovered");
  git("clone", "--mirror", "--quiet", "--no-hardlinks", item.source, other);
  git("--git-dir", other, "worktree", "add", "--detach", "--quiet", otherWorktree, item.head);
  copyFileSync(join(item.source, "local-note.txt"), join(otherWorktree, "local-note.txt"));
  const result = verify(item, { recovered: otherWorktree });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /not isolated in its mapped mirror/);
});

test("rejects ref, status, index, file, and alternate-object mismatches", (t) => {
  const item = fixture(t);
  item.inventory.repositories[0].localRefs[0].sha = "0".repeat(40);
  item.save();
  assert.match(verify(item).stderr, /recovery ref differs/);

  item.inventory.repositories[0].localRefs[0].sha = item.head;
  item.inventory.repositories[0].worktrees[0].status.entries = [" M local-note.txt"];
  item.save();
  assert.match(verify(item).stderr, /recovered worktree status differs/);

  item.inventory.repositories[0].worktrees[0].status.entries = ["?? local-note.txt"];
  item.inventory.repositories[0].worktrees[0].status.indexEntriesSha256 = "0".repeat(64);
  item.save();
  assert.match(verify(item).stderr, /recovered worktree index differs/);

  item.inventory.repositories[0].worktrees[0].status.indexEntriesSha256 =
    sha256(execFileSync("git", ["-C", item.source, "ls-files", "--stage", "-z"], { env: safeEnv }));
  item.save();
  writeFileSync(join(item.recovered, "local-note.txt"), "different state\n");
  assert.match(verify(item).stderr, /recovered file differs/);

  copyFileSync(join(item.source, "local-note.txt"), join(item.recovered, "local-note.txt"));
  mkdirSync(join(item.mirror, "objects", "info"), { recursive: true });
  writeFileSync(join(item.mirror, "objects", "info", "alternates"),
    join(item.source, ".git", "objects") + "\n");
  assert.match(verify(item).stderr, /alternate object store/);
});
