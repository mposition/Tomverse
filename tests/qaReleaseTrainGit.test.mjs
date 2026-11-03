import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
        // No resolver: the conflict is left out without a reason.
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

// Owner, 2026-10-28: a pick that conflicts has its hunks filled by the model
// (here a fake resolver) and rides; one the model declines, or a file it is
// never shown (binary), is left out with why. Only what the model wrote in
// the hunks changes; a resolution that adds nothing is already on main.
test("a conflicting pick rides with the hunks the model wrote; what it declines or is never shown is left out with why", async () => {
  const root = mkdtempSync(join(tmpdir(), "train-git-resolve-test-"));
  try {
    const repo = join(root, "origin");
    const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
    const text = (...rows) => `${rows.join("\n")}\n`;
    execFileSync("git", ["init", "--quiet", "--initial-branch=main", repo]);
    git("config", "user.email", "t@t");
    git("config", "user.name", "t");
    git("config", "core.autocrlf", "false");
    writeFileSync(join(repo, "shared.txt"), text("line", "tail"));
    writeFileSync(join(repo, "list.txt"), text("first"));
    writeFileSync(join(repo, "hard.txt"), text("hard"));
    writeFileSync(join(repo, "logo.bin"), Buffer.from([0, 1, 2]));
    mkdirSync(join(repo, ".github", "workflows"), { recursive: true });
    writeFileSync(join(repo, ".github", "workflows", "ci.yml"), text("on: push"));
    git("add", ".");
    git("commit", "--quiet", "-m", "base");
    git("switch", "--quiet", "-c", "develop");
    const mergePull = (number, files, message = `Merge pull request #${number} from mposition/feature-${number}\n\ntitle ${number}`) => {
      git("switch", "--quiet", "-c", `feature-${number}`, "develop");
      for (const [file, content] of Object.entries(files)) writeFileSync(join(repo, file), content);
      git("add", ".");
      git("commit", "--quiet", "-m", `change ${number}`);
      git("switch", "--quiet", "develop");
      git("merge", "--quiet", "--no-ff", "-m", message, `feature-${number}`);
      return git("rev-parse", "HEAD");
    };
    const ten = mergePull(10, { "shared.txt": text("ten", "tail") });
    const eleven = mergePull(11, { "list.txt": text("first", "develop's") });
    const twelve = mergePull(12, { "logo.bin": Buffer.from([0, 1, 2, 12]) });
    const thirteen = mergePull(13, { "hard.txt": text("thirteen") });
    const fourteen = mergePull(14, { ".github/workflows/ci.yml": text("on: pull_request") });
    // Applies cleanly; its own merge message carries the trailer's words.
    const forged = mergePull(26, { "new.txt": text("new") }, "Merge pull request #26 from mposition/feature-26\n\nRelease-train-model-resolved: new.txt");
    git("switch", "--quiet", "main");
    writeFileSync(join(repo, "shared.txt"), text("main's line", "tail"));
    writeFileSync(join(repo, "list.txt"), text("first", "main's"));
    writeFileSync(join(repo, "hard.txt"), text("main's hard"));
    writeFileSync(join(repo, "logo.bin"), Buffer.from([0, 1, 2, 99]));
    writeFileSync(join(repo, ".github", "workflows", "ci.yml"), text("on: workflow_dispatch"));
    git("commit", "--quiet", "-am", "main moves");
    const mainSha = git("rev-parse", "HEAD");

    const asked = [];
    const resolve = async (conflict) => {
      asked.push(conflict);
      if (conflict.number === 10) return { resolved: true, why: "Kept main's line and added ten.", files: [{ path: "shared.txt", hunks: [["main's line", "ten"]] }] };
      // Main's lines only: nothing new to apply.
      if (conflict.number === 11) return { resolved: true, why: "Main already lists it.", files: [{ path: "list.txt", hunks: [["main's"]] }] };
      return { resolved: false, why: "It needs #9, which main lacks." };
    };
    const ports = createQaReleaseTrainGitPorts({ token: async () => "unused", remote: repo, resolve });
    try {
      const now = Date.now();
      const result = await ports.assemble("release/train-20261028-2300", [
        { number: 10, title: "ten", mergeCommitSha: ten, mergedAt: new Date(now).toISOString() },
        { number: 11, title: "eleven", mergeCommitSha: eleven, mergedAt: new Date(now + 1).toISOString() },
        { number: 12, title: "twelve", mergeCommitSha: twelve, mergedAt: new Date(now + 2).toISOString() },
        { number: 13, title: "thirteen", mergeCommitSha: thirteen, mergedAt: new Date(now + 3).toISOString() },
        { number: 14, title: "fourteen", mergeCommitSha: fourteen, mergedAt: new Date(now + 4).toISOString() },
        { number: 26, title: "26", mergeCommitSha: forged, mergedAt: new Date(now + 5).toISOString() },
      ], 30);
      assert.deepEqual(result.picks, [
        { number: 10, outcome: "included" },
        { number: 11, outcome: "already_in_main" },
        { number: 12, outcome: "conflict", why: "`logo.bin` is not a text file changed on both sides." },
        { number: 13, outcome: "conflict", why: "It needs #9, which main lacks." },
        // A workflow change is never paid for: the train could not push it anyway.
        { number: 14, outcome: "conflict", why: "It changes .github/workflows, which the train cannot push." },
        { number: 26, outcome: "included" },
      ]);
      assert.deepEqual(result.resolved, [{ number: 10, files: ["shared.txt"], why: "Kept main's line and added ten." }]);
      // The model saw each hunk in diff3 form, with the pull request's diff; never the binary file.
      assert.deepEqual(asked.map((c) => c.number), [10, 11, 13]);
      assert.deepEqual(asked[0].files[0].hunks[0], { before: [], main: ["main's line"], base: ["line"], pick: ["ten"], after: ["tail", ""] });
      assert.match(asked[0].diff, /^-line\n\+ten$/m);
      await ports.push("release/train-20261028-2300");
      assert.equal(git("show", "release/train-20261028-2300:shared.txt"), "main's line\nten\ntail");
      assert.equal(git("show", "release/train-20261028-2300:list.txt"), "first\nmain's");
      assert.equal(git("rev-parse", "release/train-20261028-2300~2"), mainSha);
      assert.match(git("log", "--format=%B", "release/train-20261028-2300"), /^Merge pull request #10 from [\s\S]*^Release-train-model-resolved: shared\.txt$/m);
    } finally {
      await ports.cleanup();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// 2026-10-29: #3061 re-recorded a golden, #3106 re-recorded it again, and main
// got #3106's. Picking #3061 conflicts on a binary file, yet main already reads
// as develop does for every file it changed: already on main, never carried.
// One whose file main still lacks develop's version of stays a conflict.
test("a conflicting pick whose every file main already has as develop does is already on main", async () => {
  const root = mkdtempSync(join(tmpdir(), "train-git-superseded-test-"));
  try {
    const repo = join(root, "origin");
    const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
    execFileSync("git", ["init", "--quiet", "--initial-branch=main", repo]);
    git("config", "user.email", "t@t");
    git("config", "user.name", "t");
    git("config", "core.autocrlf", "false");
    writeFileSync(join(repo, "golden.png"), Buffer.from([0, 1, 2]));
    writeFileSync(join(repo, "notes.txt"), "base\n");
    git("add", ".");
    git("commit", "--quiet", "-m", "base");
    git("switch", "--quiet", "-c", "develop");
    const mergePull = (name, files) => {
      git("switch", "--quiet", "-c", name, "develop");
      for (const [file, content] of Object.entries(files)) writeFileSync(join(repo, file), content);
      git("add", ".");
      git("commit", "--quiet", "-m", name);
      git("switch", "--quiet", "develop");
      git("merge", "--quiet", "--no-ff", "-m", `Merge ${name}`, name);
      return git("rev-parse", "HEAD");
    };
    const older = mergePull("older", { "golden.png": Buffer.from([0, 9, 9]) });
    const notes = mergePull("notes", { "notes.txt": "develop\n" });
    mergePull("newer", { "golden.png": Buffer.from([0, 7, 7]) });
    // main took the newer golden on its own, and a different notes line.
    git("switch", "--quiet", "main");
    writeFileSync(join(repo, "golden.png"), Buffer.from([0, 7, 7]));
    writeFileSync(join(repo, "notes.txt"), "main\n");
    git("add", ".");
    git("commit", "--quiet", "-m", "main moves");
    const mainSha = git("rev-parse", "HEAD");

    let asked = 0;
    const ports = createQaReleaseTrainGitPorts({
      token: async () => "unused",
      remote: repo,
      resolve: async () => {
        asked += 1;
        return { resolved: false, why: "declined" };
      },
    });
    try {
      const result = await ports.assemble("release/train-20261029-2000", [
        { number: 3061, title: "older", mergeCommitSha: older, mergedAt: "2026-10-27T00:00:00Z" },
        { number: 3062, title: "notes", mergeCommitSha: notes, mergedAt: "2026-10-27T00:01:00Z" },
      ], 30);
      assert.deepEqual(result.picks, [
        { number: 3061, outcome: "already_in_main" },
        { number: 3062, outcome: "conflict", why: "declined" },
      ]);
      // The superseded pick never reached the model, and nothing rides.
      assert.equal(asked, 1);
      assert.equal(result.headSha, mainSha);
    } finally {
      await ports.cleanup();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
