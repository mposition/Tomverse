// `report:issue-backlog` pinned to commits instead of to branch names.
//
// The report is read when picking the next task, and until now it named the
// release branches: every `git log`, `git ls-tree` and `git show` resolved
// `origin/develop` again, so a fetch landing mid-run moved what the report
// described, and the report could not say which commits it had read. SHA mode
// resolves nothing -- these tests hold that a ref moving or being deleted
// after the pin changes the output not at all, and that a half-given pin is
// refused before any report is printed.
//
// The CLI is spawned with plain `node`: the package script adds `--import tsx`
// for `lib/modelPricing.ts`, and Node 22 strips those types on its own, so the
// test needs no installed dependency. The fixture repository is a real git
// repository in a temporary directory, because what is being tested is which
// commits git is asked about.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  makeIssueBacklogFixture,
  runIssueBacklogCli,
} from "./support/issueBacklogFixtureRepo.mjs";

const ISSUE = {
  number: 636,
  title: "Deprecate creation of fixed-amount billing promotions",
};

const makeFixture = () => makeIssueBacklogFixture(ISSUE);
const runCli = runIssueBacklogCli;

const pinnedRun = (fixture, overrides = {}) =>
  runCli(fixture.pinnedArgs(overrides));

test("a pinned run reports the commits it was given, not the branch names", () => {
  const fixture = makeFixture();
  try {
    const result = pinnedRun(fixture);
    assert.equal(result.status, 0, result.stderr);

    const report = JSON.parse(result.stdout);
    assert.equal(report.classified.length, 1);
    const [issue] = report.classified;
    assert.equal(issue.number, ISSUE.number);
    // The referencing commit is only on the pinned develop commit's history.
    assert.deepEqual(issue.commitBranches, ["develop"]);
  } finally {
    fixture.cleanUp();
  }
});

test("moving and deleting both refs after the pin changes nothing", () => {
  const fixture = makeFixture();
  try {
    const before = pinnedRun(fixture);
    assert.equal(before.status, 0, before.stderr);

    // What a fetch during the run would do, and then some: develop moves to a
    // commit the report never saw, and both names stop existing.
    writeFileSync(join(fixture.directory, "later.txt"), "later\n");
    fixture.git("add", "-A");
    fixture.git("commit", "--quiet", "-m", `chore: unrelated (#${ISSUE.number})`);
    const moved = fixture.git("rev-parse", "HEAD");
    fixture.git("branch", "--force", "develop", moved);
    fixture.git("branch", "--delete", "--force", "main");
    fixture.git("branch", "--delete", "--force", "develop");

    const after = pinnedRun(fixture);
    assert.equal(after.status, 0, after.stderr);
    assert.equal(after.stdout, before.stdout);
  } finally {
    fixture.cleanUp();
  }
});

test("a pin that does not name both branches exactly once is refused", () => {
  const fixture = makeFixture();
  try {
    const cases = [
      {
        name: "only develop",
        args: ["--branch-sha", `develop=${fixture.develop}`],
        expected: /main=<sha> is missing/,
      },
      {
        name: "develop twice",
        args: [
          "--branch-sha",
          `develop=${fixture.develop}`,
          "--branch-sha",
          `develop=${fixture.base}`,
          "--branch-sha",
          `main=${fixture.main}`,
        ],
        expected: /given more than once/,
      },
      {
        name: "a branch that is not a release branch",
        args: [
          "--branch-sha",
          `release=${fixture.develop}`,
          "--branch-sha",
          `develop=${fixture.develop}`,
          "--branch-sha",
          `main=${fixture.main}`,
        ],
        expected: /names no release branch/,
      },
      {
        name: "an abbreviated sha",
        args: [
          "--branch-sha",
          `develop=${fixture.develop.slice(0, 12)}`,
          "--branch-sha",
          `main=${fixture.main}`,
        ],
        expected: /full 40-character commit sha/,
      },
      {
        name: "a sha that is not a commit here",
        args: [
          "--branch-sha",
          `develop=${"f".repeat(40)}`,
          "--branch-sha",
          `main=${fixture.main}`,
        ],
        expected: /is not a commit here/,
      },
      {
        name: "a branch name with no sha",
        args: ["--branch-sha", "develop", "--branch-sha", `main=${fixture.main}`],
        expected: /is not <branch>=<sha>/,
      },
      {
        name: "--branch-sha with no value at all",
        args: ["--branch-sha"],
        expected: /needs <branch>=<sha>/,
      },
    ];

    for (const { name, args, expected } of cases) {
      const result = runCli([
        "--json",
        "--issues-file",
        fixture.issuesFile,
        "--repository",
        fixture.directory,
        ...args,
      ]);
      assert.equal(result.status, 1, `${name} should be refused`);
      assert.match(result.stderr, expected, name);
      // Refused before a report exists: a printed report would be read as the
      // answer to a question the caller did not ask.
      assert.equal(result.stdout.trim(), "", `${name} printed a report`);
    }
  } finally {
    fixture.cleanUp();
  }
});

test("another checkout may only be read with both commits pinned", () => {
  const fixture = makeFixture();
  try {
    const result = runCli([
      "--json",
      "--issues-file",
      fixture.issuesFile,
      "--repository",
      fixture.directory,
    ]);
    assert.equal(result.status, 1);
    // Resolving `develop` by name inside someone else's clone reports on
    // whatever that clone calls `develop`, which is not this repository's.
    assert.match(result.stderr, /--repository needs --branch-sha/);
    assert.equal(result.stdout.trim(), "");
  } finally {
    fixture.cleanUp();
  }
});

test("--repository and --branch-sha both need their values", () => {
  const fixture = makeFixture();
  try {
    const missingPath = runCli([
      "--issues-file",
      fixture.issuesFile,
      "--repository",
    ]);
    assert.equal(missingPath.status, 1);
    assert.match(missingPath.stderr, /--repository needs a path/);
  } finally {
    fixture.cleanUp();
  }
});

test("the pricing parser check still reads this checkout, not the pinned one", () => {
  // The fixture has no lib/modelPricing.ts. The check that keeps the parser
  // honest compares it against the module this process imported, so it has to
  // read the running checkout; if it followed --repository it would silently
  // pass on a repository that has no pricing module at all.
  const fixture = makeFixture();
  try {
    const result = pinnedRun(fixture);
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    // The pinned commits carry no pricing module, so no pricing signal can be
    // produced for the issue -- and the run still succeeded, which is what says
    // the check read this checkout instead.
    const [issue] = report.classified;
    assert.equal(
      issue.signals.some((signal) => signal.kind === "pricing"),
      false
    );
  } finally {
    fixture.cleanUp();
  }
});

test("git is available to this test at all", () => {
  // Every assertion above is about which commits git was asked for. If git were
  // missing the failures would read as logic errors in the CLI.
  const version = execFileSync("git", ["--version"], { encoding: "utf8" });
  assert.match(version, /^git version /);
});
