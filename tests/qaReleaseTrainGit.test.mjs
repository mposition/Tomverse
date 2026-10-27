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

    const ports = createQaReleaseTrainGitPorts({ token: async () => "unused", remote: repo, autoPredecessors: false });
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

    // #10 rides an open train: never boarded a second time, so #11 waits for it.
    const open = createQaReleaseTrainGitPorts({ token: async () => "unused", remote: repo });
    try {
      const result = await open.assemble("release/train-20261027-1700", [{ number: 11, title: "eleven", mergeCommitSha: eleven, mergedAt: now }], 30, [10]);
      assert.deepEqual(result.picks, [{ number: 11, outcome: "conflict", predecessors: [10] }]);
      assert.equal(result.headSha, mainSha);
    } finally {
      await open.cleanup();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// Review r-20261026-235556-e84578: a predecessor whose change main already has
// (picked there by hand, so not an ancestor) applies nothing and takes no seat.
test("a predecessor main already has takes no seat when a pick boards what it needs", async () => {
  const root = mkdtempSync(join(tmpdir(), "train-git-seat-test-"));
  try {
    const repo = join(root, "origin");
    const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
    const lines = (first, last) => `${[first, "b", "c", "d", "e", "f", last].join(String.fromCharCode(10))}${String.fromCharCode(10)}`;
    execFileSync("git", ["init", "--quiet", "--initial-branch=main", repo]);
    git("config", "user.email", "t@t");
    git("config", "user.name", "t");
    git("config", "core.autocrlf", "false");
    writeFileSync(join(repo, "x.txt"), lines("a", "g"));
    git("add", ".");
    git("commit", "--quiet", "-m", "base");
    git("switch", "--quiet", "-c", "develop");
    const mergePull = (number, text) => {
      git("switch", "--quiet", "-c", `feature-${number}`, "develop");
      writeFileSync(join(repo, "x.txt"), text);
      git("add", ".");
      git("commit", "--quiet", "-m", `change ${number}`);
      git("switch", "--quiet", "develop");
      git("merge", "--quiet", "--no-ff", "-m", `Merge pull request #${number} from mposition/feature-${number}`, `feature-${number}`);
      return git("rev-parse", "HEAD");
    };
    mergePull(40, lines("A", "g"));
    mergePull(41, lines("A", "G"));
    const fortyTwo = mergePull(42, lines("AA", "GG"));
    // main took #41's change by hand.
    git("switch", "--quiet", "main");
    writeFileSync(join(repo, "x.txt"), lines("a", "G"));
    git("commit", "--quiet", "-am", "main takes 41 by hand");

    const ports = createQaReleaseTrainGitPorts({ token: async () => "unused", remote: repo });
    try {
      const result = await ports.assemble("release/train-20261027-2000", [{ number: 42, title: "42", mergeCommitSha: fortyTwo, mergedAt: new Date().toISOString() }], 2);
      assert.deepEqual(result.picks, [
        { number: 40, outcome: "included", boardedFor: 42 },
        { number: 42, outcome: "included" },
      ]);
      await ports.push("release/train-20261027-2000");
      assert.equal(git("show", "release/train-20261027-2000:x.txt"), lines("AA", "GG").trim());
    } finally {
      await ports.cleanup();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// 2026-10-27, #3042: a pick that only adds lines next to lines main has
// differently conflicts in git, and rides with main's lines kept and its own
// added; one whose added lines main already has is already on main. A pick
// that changes such a line still conflicts, and names only the develop pull
// request that wrote the line main lacks, not every one that touched the file.
test("an adjacent-line conflict is settled; a real one names only the pull request that wrote the line main lacks", async () => {
  const root = mkdtempSync(join(tmpdir(), "train-git-settle-test-"));
  try {
    const repo = join(root, "origin");
    const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
    const text = (...rows) => `${rows.join("\n")}\n`;
    const base = ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen"];
    const with_ = (changes) => text(...base.flatMap((row, i) => changes[i] ?? [row]));
    execFileSync("git", ["init", "--quiet", "--initial-branch=main", repo]);
    git("config", "user.email", "t@t");
    git("config", "user.name", "t");
    git("config", "core.autocrlf", "false");
    writeFileSync(join(repo, "x.txt"), with_({}));
    writeFileSync(join(repo, "list.txt"), text("first"));
    writeFileSync(join(repo, "logo.bin"), Buffer.from([0, 1, 2]));
    // Latin-1 "café", then "b": text to git, not UTF-8.
    writeFileSync(join(repo, "latin.txt"), Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a, 0x62, 0x0a]));
    git("add", ".");
    git("commit", "--quiet", "-m", "base");
    git("switch", "--quiet", "-c", "develop");
    const mergePull = (number, files) => {
      git("switch", "--quiet", "-c", `feature-${number}`, "develop");
      for (const [file, content] of Object.entries(files)) writeFileSync(join(repo, file), content);
      git("add", ".");
      git("commit", "--quiet", "-m", `change ${number}`);
      git("switch", "--quiet", "develop");
      git("merge", "--quiet", "--no-ff", "-m", `Merge pull request #${number} from mposition/feature-${number}\n\ntitle ${number}`, `feature-${number}`);
      return git("rev-parse", "HEAD");
    };
    // #19 rewrites row 10 and #20 row 1; main gets neither.
    mergePull(19, { "x.txt": with_({ 9: ["TEN"] }) });
    mergePull(20, { "x.txt": with_({ 0: ["ONE"], 9: ["TEN"] }) });
    // #21 adds a row after row 10 and a line to list.txt, where main appended its own.
    const adds = mergePull(21, { "x.txt": with_({ 0: ["ONE"], 9: ["TEN", "ten and a half"] }), "list.txt": text("first", "develop's") });
    // #22 changes the row #21 added, right after row 10.
    const changes = mergePull(22, { "x.txt": with_({ 0: ["ONE"], 9: ["TEN", "TEN AND A HALF"] }), "list.txt": text("first", "develop's") });
    // #23 adds a row main already has.
    const ported = mergePull(23, { "x.txt": with_({ 0: ["ONE"], 9: ["TEN", "TEN AND A HALF"], 12: ["thirteen", "ported"] }), "list.txt": text("first", "develop's") });
    // #24 changes a binary file main changed too: git marks no hunk, so it is never settled.
    const binary = mergePull(24, { "logo.bin": Buffer.from([0, 1, 2, 24]) });
    // #25 adds a line after the first of a Latin-1 file whose first line main changed: never rewritten as UTF-8.
    const latin = mergePull(25, { "latin.txt": Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a, 0x6e, 0x0a, 0x62, 0x0a]) });
    // #26 applies cleanly; its own merge message carries the trailer's words.
    git("switch", "--quiet", "-c", "feature-26", "develop");
    writeFileSync(join(repo, "new.txt"), text("new"));
    git("add", ".");
    git("commit", "--quiet", "-m", "change 26");
    git("switch", "--quiet", "develop");
    git("merge", "--quiet", "--no-ff", "-m", "Merge pull request #26 from mposition/feature-26\n\nRelease-train-settled: new.txt", "feature-26");
    const forged = git("rev-parse", "HEAD");
    git("switch", "--quiet", "main");
    writeFileSync(join(repo, "x.txt"), with_({ 9: ["ten on main"], 12: ["thirteen on main", "ported"] }));
    writeFileSync(join(repo, "list.txt"), text("first", "main's"));
    writeFileSync(join(repo, "logo.bin"), Buffer.from([0, 1, 2, 99]));
    writeFileSync(join(repo, "latin.txt"), Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x21, 0x0a, 0x62, 0x0a]));
    git("commit", "--quiet", "-am", "main moves");

    const ports = createQaReleaseTrainGitPorts({ token: async () => "unused", remote: repo, autoPredecessors: false });
    try {
      const now = Date.now();
      const result = await ports.assemble("release/train-20261027-2300", [
        { number: 21, title: "21", mergeCommitSha: adds, mergedAt: new Date(now).toISOString() },
        { number: 22, title: "22", mergeCommitSha: changes, mergedAt: new Date(now + 1).toISOString() },
        { number: 23, title: "23", mergeCommitSha: ported, mergedAt: new Date(now + 2).toISOString() },
        { number: 24, title: "24", mergeCommitSha: binary, mergedAt: new Date(now + 3).toISOString() },
        { number: 25, title: "25", mergeCommitSha: latin, mergedAt: new Date(now + 4).toISOString() },
        { number: 26, title: "26", mergeCommitSha: forged, mergedAt: new Date(now + 5).toISOString() },
      ], 30);
      assert.deepEqual(result.picks, [
        { number: 21, outcome: "included" },
        // Row 10 as #19 wrote it is what main lacks; #20 changed only row 1.
        { number: 22, outcome: "conflict", predecessors: [19] },
        { number: 23, outcome: "already_in_main" },
        { number: 24, outcome: "conflict", predecessors: [] },
        { number: 25, outcome: "conflict", predecessors: [] },
        { number: 26, outcome: "included" },
      ]);
      assert.deepEqual(result.settled, [{ number: 21, files: ["list.txt", "x.txt"] }]);
      await ports.push("release/train-20261027-2300");
      assert.equal(git("show", "release/train-20261027-2300:x.txt"), with_({ 9: ["ten on main", "ten and a half"], 12: ["thirteen on main", "ported"] }).trim());
      assert.equal(git("show", "release/train-20261027-2300:list.txt"), text("first", "main's", "develop's").trim());
      assert.match(git("log", "--format=%B", "release/train-20261027-2300"), /^Merge pull request #21 from [\s\S]*^Release-train-settled: list\.txt, x\.txt$/m);
    } finally {
      await ports.cleanup();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// Review r-20261027-021602-f2ce17: a line main has elsewhere in the file is
// no proof main has the change. #30 turns block b on; main has block a on
// but not b, so #31, which changes b's next line, needs #30.
test("a predecessor is named even when main has the same line elsewhere in the file", async () => {
  const root = mkdtempSync(join(tmpdir(), "train-git-repeat-test-"));
  try {
    const repo = join(root, "origin");
    const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
    const config = (a, b, bName) => ["[a]", `enabled: ${a}`, "name: a", "", "[b]", `enabled: ${b}`, `name: ${bName}`, ""].join("\n");
    execFileSync("git", ["init", "--quiet", "--initial-branch=main", repo]);
    git("config", "user.email", "t@t");
    git("config", "user.name", "t");
    git("config", "core.autocrlf", "false");
    writeFileSync(join(repo, "config.txt"), config("false", "false", "b"));
    git("add", ".");
    git("commit", "--quiet", "-m", "base");
    git("switch", "--quiet", "-c", "develop");
    const mergePull = (number, content) => {
      git("switch", "--quiet", "-c", `feature-${number}`, "develop");
      writeFileSync(join(repo, "config.txt"), content);
      git("add", ".");
      git("commit", "--quiet", "-m", `change ${number}`);
      git("switch", "--quiet", "develop");
      git("merge", "--quiet", "--no-ff", "-m", `Merge pull request #${number} from mposition/feature-${number}`, `feature-${number}`);
      return git("rev-parse", "HEAD");
    };
    mergePull(30, config("false", "true", "b"));
    const thirtyOne = mergePull(31, config("false", "true", "bee"));
    git("switch", "--quiet", "main");
    writeFileSync(join(repo, "config.txt"), config("true", "false", "b"));
    git("commit", "--quiet", "-am", "main turns a on");

    const ports = createQaReleaseTrainGitPorts({ token: async () => "unused", remote: repo, autoPredecessors: false });
    try {
      const result = await ports.assemble("release/train-20261027-2330", [{ number: 31, title: "31", mergeCommitSha: thirtyOne, mergedAt: new Date().toISOString() }], 30);
      assert.deepEqual(result.picks, [{ number: 31, outcome: "conflict", predecessors: [30] }]);
    } finally {
      await ports.cleanup();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
