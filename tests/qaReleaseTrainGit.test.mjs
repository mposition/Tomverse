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
        { number: 2, outcome: "conflict" },
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
