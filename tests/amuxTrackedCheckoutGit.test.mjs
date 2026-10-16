import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { deflateSync } from "node:zlib";

import { readAmuxPinnedTrackedTree } from "../lib/amux/ideaTrackedCheckoutGit.ts";

const git = (directory, ...args) => execFileSync("git", ["-C", directory, ...args], {
  encoding: "utf8", windowsHide: true,
});

test("local Git enumerates the pinned commit, omitting untracked and secret paths", async () => {
  const directory = await mkdtemp(join(tmpdir(), "amux-tracked-tree-"));
  try {
    git(directory, "init", "--quiet");
    git(directory, "config", "core.autocrlf", "false");
    git(directory, "config", "user.name", "AMUX Test");
    git(directory, "config", "user.email", "amux-test@example.invalid");
    await mkdir(join(directory, "docs"));
    await mkdir(join(directory, "mirror"));
    await writeFile(join(directory, "docs", "guide.md"), "pinned content\n");
    await writeFile(join(directory, "mirror", "guide.md"), "other pinned content\n");
    await writeFile(join(directory, ".env"), "excluded\n");
    git(directory, "add", "--", "docs/guide.md", "mirror/guide.md", ".env");
    git(directory, "commit", "--quiet", "-m", "pinned");
    const pinned = git(directory, "rev-parse", "HEAD").trim();
    assert.notEqual(git(directory, "rev-parse", `${pinned}:docs`).trim(),
      git(directory, "rev-parse", `${pinned}:mirror`).trim());
    await writeFile(join(directory, "docs", "guide.md"), "new content\n");
    await writeFile(join(directory, "untracked.txt"), "never in the tree\n");
    git(directory, "add", "--", "docs/guide.md");
    git(directory, "commit", "--quiet", "-m", "later");
    const laterBlob = git(directory, "rev-parse", "HEAD:docs/guide.md").trim();
    const laterCommit = git(directory, "rev-parse", "HEAD").trim();
    // A local replace ref must not silently substitute a newer tree for the
    // commit SHA that the app recorded at intake.
    git(directory, "replace", pinned, laterCommit);

    const result = await readAmuxPinnedTrackedTree(directory, pinned);
    assert.deepEqual(result.files.map((file) => file.path),
      ["docs/guide.md", "mirror/guide.md"]);
    assert.deepEqual(result.excluded, [{ path: ".env", reason: "secret_path" }]);
    assert.notEqual(result.files[0].objectId, laterBlob);
    await assert.rejects(() => readAmuxPinnedTrackedTree(directory, "HEAD"), /invalid_tree/);
    await assert.rejects(() => readAmuxPinnedTrackedTree(join(directory, "docs"), pinned),
      /invalid_tree/);

    // A loose object may be replaced on disk without changing its filename.
    // The fixed SHA must authenticate the commit bytes before tree traversal.
    const otherCommit = git(directory, "cat-file", "commit", laterCommit);
    const loosePath = join(directory, ".git", "objects", pinned.slice(0, 2), pinned.slice(2));
    await chmod(loosePath, 0o600);
    const forgedBody = Buffer.from(otherCommit, "utf8");
    const forgedObject = Buffer.concat([
      Buffer.from(`commit ${forgedBody.length}\0`, "utf8"), forgedBody,
    ]);
    await writeFile(loosePath, deflateSync(forgedObject));
    const acceptedForgedBody = execFileSync("git", ["-C", directory, "cat-file", "commit", pinned], {
      encoding: "utf8", windowsHide: true,
      env: { ...process.env, GIT_NO_REPLACE_OBJECTS: "1" },
    });
    assert.equal(acceptedForgedBody, otherCommit);
    await assert.rejects(() => readAmuxPinnedTrackedTree(directory, pinned), /invalid_tree/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a repeated child tree object preserves both tracked paths", async () => {
  const directory = await mkdtemp(join(tmpdir(), "amux-tree-alias-"));
  try {
    git(directory, "init", "--quiet");
    git(directory, "config", "core.autocrlf", "false");
    git(directory, "config", "user.name", "AMUX Test");
    git(directory, "config", "user.email", "amux-test@example.invalid");
    await mkdir(join(directory, "one"));
    await mkdir(join(directory, "two"));
    await writeFile(join(directory, "one", "same.txt"), "same pinned bytes\n");
    await writeFile(join(directory, "two", "same.txt"), "same pinned bytes\n");
    git(directory, "add", "--", "one", "two");
    git(directory, "commit", "--quiet", "-m", "aliased trees");
    const pinned = git(directory, "rev-parse", "HEAD").trim();
    assert.equal(git(directory, "rev-parse", `${pinned}:one`).trim(),
      git(directory, "rev-parse", `${pinned}:two`).trim());
    const result = await readAmuxPinnedTrackedTree(directory, pinned);
    assert.deepEqual(result.files.map((file) => file.path),
      ["one/same.txt", "two/same.txt"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
