import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

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
    await writeFile(join(directory, "docs", "guide.md"), "pinned content\n");
    await writeFile(join(directory, ".env"), "excluded\n");
    git(directory, "add", "--", "docs/guide.md", ".env");
    git(directory, "commit", "--quiet", "-m", "pinned");
    const pinned = git(directory, "rev-parse", "HEAD").trim();
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
    assert.deepEqual(result.files.map((file) => file.path), ["docs/guide.md"]);
    assert.deepEqual(result.excluded, [{ path: ".env", reason: "secret_path" }]);
    assert.notEqual(result.files[0].objectId, laterBlob);
    await assert.rejects(() => readAmuxPinnedTrackedTree(directory, "HEAD"), /invalid_tree/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
