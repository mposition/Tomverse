import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createQaReleaseTrainGitPorts } from "../lib/qaReleaseTrainPorts.ts";

// A real git run against a local repository standing in for GitHub: develop
// merge commits are cherry-picked onto main with -m 1, a conflict is aborted
// and left out, and one main already carries is skipped.
test("assemble picks in order, leaves a conflict out, skips what main has, and pushes the branch", async () => {
  const root = mkdtempSync(join(tmpdir(), "train-git-test-"));
  try {
    const repo = join(root, "origin");
    const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
    execFileSync("git", ["init", "--quiet", "--initial-branch=main", repo]);
    git("config", "user.email", "t@t");
    git("config", "user.name", "t");
    git("config", "core.autocrlf", "false");
    writeFileSync(join(repo, "a.txt"), "base\n");
    writeFileSync(join(repo, "shared.txt"), "line\n");
    git("add", ".");
    git("commit", "--quiet", "-m", "base");
    git("switch", "--quiet", "-c", "develop");
    const mergeFeature = (name, file, text) => {
      git("switch", "--quiet", "-c", name, "develop");
      writeFileSync(join(repo, file), text);
      git("add", ".");
      git("commit", "--quiet", "-m", name);
      git("switch", "--quiet", "develop");
      git("merge", "--quiet", "--no-ff", "-m", `Merge ${name}`, name);
      return git("rev-parse", "HEAD");
    };
    const one = mergeFeature("one", "one.txt", "one\n");
    const conflict = mergeFeature("two", "shared.txt", "develop's line\n");
    const already = mergeFeature("three", "three.txt", "three\n");
    // main changes shared.txt differently (so #2 conflicts) and already has #3's change.
    git("switch", "--quiet", "main");
    writeFileSync(join(repo, "shared.txt"), "main's line\n");
    writeFileSync(join(repo, "three.txt"), "three\n");
    git("add", ".");
    git("commit", "--quiet", "-m", "main moves");
    const mainSha = git("rev-parse", "HEAD");

    const ports = createQaReleaseTrainGitPorts({ token: async () => "unused", remote: repo });
    try {
      const result = await ports.assemble("release/train-20261020-1100", [
        { number: 1, title: "one", mergeCommitSha: one, mergedAt: "2026-10-20T00:00:00Z" },
        { number: 2, title: "two", mergeCommitSha: conflict, mergedAt: "2026-10-20T00:01:00Z" },
        { number: 3, title: "three", mergeCommitSha: already, mergedAt: "2026-10-20T00:02:00Z" },
      ], 30);
      assert.equal(result.mainSha, mainSha);
      assert.deepEqual(result.picks, [
        { number: 1, outcome: "included" },
        // Merge subjects here are not GitHub's, so no predecessor is named.
        { number: 2, outcome: "conflict", predecessors: [] },
        { number: 3, outcome: "already_in_main" },
      ]);
      assert.notEqual(result.headSha, mainSha);
      await ports.push("release/train-20261020-1100");
      assert.equal(git("rev-parse", "release/train-20261020-1100"), result.headSha);
      // The pushed branch is main plus #1 only.
      assert.equal(git("rev-parse", "release/train-20261020-1100^"), mainSha);
      assert.equal(git("show", "release/train-20261020-1100:shared.txt"), "main's line");
    } finally {
      await ports.cleanup();
    }

    // Capacity counts riders: a pull request main already has does not take a
    // seat, so the one after it rides and only the next is over capacity.
    const second = createQaReleaseTrainGitPorts({ token: async () => "unused", remote: repo });
    try {
      const full = await second.assemble("release/train-20261020-1400", [
        { number: 3, title: "three", mergeCommitSha: already, mergedAt: "2026-10-20T00:00:00Z" },
        { number: 1, title: "one", mergeCommitSha: one, mergedAt: "2026-10-20T00:01:00Z" },
        { number: 2, title: "two", mergeCommitSha: conflict, mergedAt: "2026-10-20T00:02:00Z" },
      ], 1);
      assert.deepEqual(full.picks, [
        { number: 3, outcome: "already_in_main" },
        { number: 1, outcome: "included" },
        { number: 2, outcome: "over_capacity" },
      ]);
    } finally {
      await second.cleanup();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// A conflict names the develop pull requests merged before it that changed a
// conflicted file, newest first, read from GitHub's merge commit subjects:
// here #11 needs #10, which main never got; #12 touched another file.
test("a conflict names the earlier develop pull requests that changed its conflicted files", async () => {
  const root = mkdtempSync(join(tmpdir(), "train-git-pred-test-"));
  try {
    const repo = join(root, "origin");
    const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
    execFileSync("git", ["init", "--quiet", "--initial-branch=main", repo]);
    git("config", "user.email", "t@t");
    git("config", "user.name", "t");
    git("config", "core.autocrlf", "false");
    writeFileSync(join(repo, "shared.txt"), "line\n");
    writeFileSync(join(repo, "other.txt"), "other\n");
    git("add", ".");
    git("commit", "--quiet", "-m", "base");
    git("switch", "--quiet", "-c", "develop");
    const mergePull = (number, file, text) => {
      git("switch", "--quiet", "-c", `feature-${number}`, "develop");
      writeFileSync(join(repo, file), text);
      git("add", ".");
      git("commit", "--quiet", "-m", `change ${number}`);
      git("switch", "--quiet", "develop");
      git("merge", "--quiet", "--no-ff", "-m", `Merge pull request #${number} from mposition/feature-${number}`, `feature-${number}`);
      return git("rev-parse", "HEAD");
    };
    mergePull(10, "shared.txt", "ten\n");
    mergePull(12, "other.txt", "twelve\n");
    const eleven = mergePull(11, "shared.txt", "eleven\n");
    git("switch", "--quiet", "main");

    const ports = createQaReleaseTrainGitPorts({ token: async () => "unused", remote: repo });
    try {
      const result = await ports.assemble("release/train-20261024-1100", [
        { number: 11, title: "eleven", mergeCommitSha: eleven, mergedAt: new Date().toISOString() },
      ], 30);
      assert.deepEqual(result.picks, [{ number: 11, outcome: "conflict", predecessors: [10] }]);
    } finally {
      await ports.cleanup();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// Owner, 2026-10-27: a pick that conflicts boards the develop pull requests it
// needs first and rides; what it could not ride with is undone, not half-kept.
test("a conflicting pick boards the develop pull requests it needs and rides; otherwise nothing is kept", async () => {
  const root = mkdtempSync(join(tmpdir(), "train-git-board-test-"));
  try {
    const repo = join(root, "origin");
    const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
    execFileSync("git", ["init", "--quiet", "--initial-branch=main", repo]);
    git("config", "user.email", "t@t");
    git("config", "user.name", "t");
    git("config", "core.autocrlf", "false");
    writeFileSync(join(repo, "shared.txt"), "line\n");
    writeFileSync(join(repo, "lone.txt"), "line\n");
    git("add", ".");
    git("commit", "--quiet", "-m", "base");
    git("switch", "--quiet", "-c", "develop");
    const mergePull = (number, file, text) => {
      git("switch", "--quiet", "-c", `feature-${number}`, "develop");
      writeFileSync(join(repo, file), text);
      git("add", ".");
      git("commit", "--quiet", "-m", `change ${number}`);
      git("switch", "--quiet", "develop");
      git("merge", "--quiet", "--no-ff", "-m", `Merge pull request #${number} from mposition/feature-${number}`, "-m", `title ${number}`, `feature-${number}`);
      return git("rev-parse", "HEAD");
    };
    // #11 needs #10 (same lines); #21 changes lone.txt, which main changed its own way.
    mergePull(10, "shared.txt", "ten\n");
    const eleven = mergePull(11, "shared.txt", "eleven\n");
    const twentyOne = mergePull(21, "lone.txt", "twenty-one\n");
    git("switch", "--quiet", "main");
    writeFileSync(join(repo, "lone.txt"), "main's own\n");
    git("add", ".");
    git("commit", "--quiet", "-m", "main moves");
    const mainSha = git("rev-parse", "HEAD");
    const now = new Date().toISOString();

    const ports = createQaReleaseTrainGitPorts({ token: async () => "unused", remote: repo, autoPredecessors: true });
    try {
      const result = await ports.assemble("release/train-20261027-1100", [
        { number: 11, title: "eleven", mergeCommitSha: eleven, mergedAt: now },
        { number: 21, title: "twenty-one", mergeCommitSha: twentyOne, mergedAt: now },
      ], 30);
      assert.deepEqual(result.picks, [
        { number: 10, outcome: "included", boardedFor: 11 },
        { number: 11, outcome: "included" },
        // No develop pull request explains #21's conflict: left out as before.
        { number: 21, outcome: "conflict", predecessors: [] },
      ]);
      assert.deepEqual(result.boarded.map((b) => [b.number, b.title]), [[10, "title 10"]]);
      await ports.push("release/train-20261027-1100");
      assert.equal(git("show", "release/train-20261027-1100:shared.txt"), "eleven");
      assert.equal(git("show", "release/train-20261027-1100:lone.txt"), "main's own");
      assert.equal(git("rev-parse", "release/train-20261027-1100~2"), mainSha);
    } finally {
      await ports.cleanup();
    }

    // One seat: #11 cannot ride with #10, so neither boards and the branch is main.
    const full = createQaReleaseTrainGitPorts({ token: async () => "unused", remote: repo, autoPredecessors: true });
    try {
      const result = await full.assemble("release/train-20261027-1400", [{ number: 11, title: "eleven", mergeCommitSha: eleven, mergedAt: now }], 1);
      assert.deepEqual(result.picks, [{ number: 11, outcome: "conflict", predecessors: [10] }]);
      assert.deepEqual(result.boarded, []);
      assert.equal(result.headSha, mainSha);
    } finally {
      await full.cleanup();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
