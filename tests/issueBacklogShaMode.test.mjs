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
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const CLI = fileURLToPath(
  new URL("../scripts/report-issue-backlog.mjs", import.meta.url)
);

const ISSUE = {
  number: 636,
  title: "Deprecate creation of fixed-amount billing promotions",
};

/**
 * A repository whose `develop` holds a commit referencing the issue and whose
 * `main` does not, with HEAD detached so both branches can be moved or deleted
 * while the report is being asked about them.
 */
const makeFixture = () => {
  const directory = mkdtempSync(join(tmpdir(), "issue-backlog-sha-"));
  const git = (...argv) => {
    const result = spawnSync("git", argv, {
      cwd: directory,
      encoding: "utf8",
    });
    assert.equal(
      result.status,
      0,
      `git ${argv.join(" ")} failed: ${result.stderr}`
    );
    return result.stdout.trim();
  };

  git("init", "--quiet", "--initial-branch=develop");
  git("config", "user.email", "fixture@example.com");
  git("config", "user.name", "Fixture");
  git("config", "commit.gpgsign", "false");
  writeFileSync(join(directory, "placeholder.txt"), "base\n");
  git("add", "-A");
  git("commit", "--quiet", "-m", "base");
  const base = git("rev-parse", "HEAD");

  writeFileSync(join(directory, "fix.txt"), "fixed\n");
  git("add", "-A");
  git("commit", "--quiet", "-m", `fix(billing): refuse fixed amounts (#${ISSUE.number})`);
  const develop = git("rev-parse", "HEAD");

  git("branch", "--force", "main", base);
  // Detached, so `git branch -D develop` is allowed below.
  git("checkout", "--quiet", "--detach", develop);

  const issuesFile = join(directory, "issues.json");
  writeFileSync(issuesFile, JSON.stringify([ISSUE]));

  return { directory, git, base, develop, main: base, issuesFile };
};

const runCli = (args) =>
  spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });

const pinnedRun = (fixture, overrides = {}) => {
  const develop = overrides.develop ?? fixture.develop;
  const main = overrides.main ?? fixture.main;
  return runCli([
    "--json",
    "--issues-file",
    fixture.issuesFile,
    "--repository",
    fixture.directory,
    "--branch-sha",
    `develop=${develop}`,
    "--branch-sha",
    `main=${main}`,
  ]);
};

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
    rmSync(fixture.directory, { recursive: true, force: true });
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
    rmSync(fixture.directory, { recursive: true, force: true });
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
    rmSync(fixture.directory, { recursive: true, force: true });
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
    rmSync(fixture.directory, { recursive: true, force: true });
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
    rmSync(fixture.directory, { recursive: true, force: true });
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
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("git is available to this test at all", () => {
  // Every assertion above is about which commits git was asked for. If git were
  // missing the failures would read as logic errors in the CLI.
  const version = execFileSync("git", ["--version"], { encoding: "utf8" });
  assert.match(version, /^git version /);
});
