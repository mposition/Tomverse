// A real git repository for the issue backlog report to read.
//
// The report's whole job is to say what each release branch's own history and
// files contain, so a fake git would test the wrong thing: what these fixtures
// hold is which commits git was asked about. HEAD is left detached so a test
// can move or delete either branch while the report is being asked about them.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const ISSUE_BACKLOG_CLI = fileURLToPath(
  new URL("../../scripts/report-issue-backlog.mjs", import.meta.url)
);

/**
 * Runs the report CLI with plain `node`.
 *
 * The package script adds `--import tsx` for `lib/modelPricing.ts`; Node 22
 * strips those types on its own, so a test needs no installed dependency.
 */
export const runIssueBacklogCli = (args) =>
  spawnSync(process.execPath, [ISSUE_BACKLOG_CLI, ...args], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });

/**
 * A repository whose `develop` holds a commit referencing `issue.number` and
 * whose `main` is one commit behind it.
 *
 * @param {{ number: number, title: string }} issue
 */
export const makeIssueBacklogFixture = (issue) => {
  const directory = mkdtempSync(join(tmpdir(), "issue-backlog-"));
  const git = (...argv) => {
    const result = spawnSync("git", argv, { cwd: directory, encoding: "utf8" });
    assert.equal(result.status, 0, `git ${argv.join(" ")} failed: ${result.stderr}`);
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
  git("commit", "--quiet", "-m", `fix(billing): refuse fixed amounts (#${issue.number})`);
  const develop = git("rev-parse", "HEAD");

  git("branch", "--force", "main", base);
  git("checkout", "--quiet", "--detach", develop);

  const issuesFile = join(directory, "issues.json");
  writeFileSync(issuesFile, JSON.stringify([issue]));

  return {
    directory,
    git,
    base,
    develop,
    main: base,
    issuesFile,
    /** The pinned invocation these fixtures exist for. */
    pinnedArgs: (overrides = {}) => [
      "--json",
      "--issues-file",
      overrides.issuesFile ?? issuesFile,
      "--repository",
      directory,
      "--branch-sha",
      `develop=${overrides.develop ?? develop}`,
      "--branch-sha",
      `main=${overrides.main ?? base}`,
    ],
    cleanUp: () => rmSync(directory, { recursive: true, force: true }),
  };
};
