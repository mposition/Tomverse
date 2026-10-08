// The divergence report's own output is the product (scripts/report-back-merge-divergence.mjs).
//
// Several of its git reads are expected to fail: `git show <base>:<path>` for a
// path the base does not have is how it learns the path is new, and
// `git merge-tree` exits non-zero on the conflict it exists to describe. With
// stderr inherited those printed `fatal:` into the job log -- ten lines above
// its own output on 2026-10-08 -- and a log a person cannot read is the one
// thing this report must not produce.
//
// The refs below are permanent commits from that day, chosen because their
// merge base genuinely lacks paths the two sides have. They are pinned on
// purpose: the condition stops reproducing on the branch tips once the
// ancestry is repaired, and a test that only passes before a repair proves
// nothing afterwards.

import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

/** develop and main as they stood on 2026-10-08, with base 621c5cc3a. */
const OURS = "cdcf19c16";
const THEIRS = "c17bad040";

/** Whether this clone still has those commits; a shallow or fresh one may not. */
const hasRefs = () => {
  for (const rev of [OURS, THEIRS]) {
    const probe = spawnSync("git", ["cat-file", "-e", `${rev}^{commit}`], {
      cwd: root,
      stdio: "ignore",
    });
    if (probe.status !== 0) return false;
  }
  return true;
};

const runReport = () =>
  spawnSync(
    process.execPath,
    ["scripts/report-back-merge-divergence.mjs", "--ours", OURS, "--theirs", THEIRS],
    { cwd: root, encoding: "utf8" }
  );

test("the report writes no git noise to stderr", (t) => {
  if (!hasRefs()) {
    t.skip(`${OURS}/${THEIRS} are not in this clone`);
    return;
  }
  const result = runReport();

  // The condition the pin exists for: the base must lack a path, or this run
  // would not exercise the quiet path at all.
  const base = execFileSync("git", ["merge-base", OURS, THEIRS], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  assert.equal(base.startsWith("621c5cc3a"), true, "the pinned base moved; repin the refs");

  assert.doesNotMatch(
    result.stderr ?? "",
    /fatal:/,
    "an expected git failure reached the log; the report's stderr must be captured, " +
      "because a log a person cannot read is what this report exists to avoid"
  );
});

test("capturing stderr did not take the report's own output away", (t) => {
  if (!hasRefs()) {
    t.skip(`${OURS}/${THEIRS} are not in this clone`);
    return;
  }
  const { stdout, status } = runReport();

  assert.equal(status, 0, "it had something to report");

  // The facts a reader needs. The path and the reason are quoted from this
  // pair's own output rather than guessed: an earlier version of this test
  // asserted a path the pair does not conflict on and failed for that reason.
  assert.match(stdout, /26 conflicting path\(s\)/);
  assert.match(stdout, /\.gitleaksignore/, "it still names the conflicting paths");
  assert.match(
    stdout,
    /the merge base does not have this path/,
    "the reason that used to produce the fatal: lines is still reported, in its own words"
  );
  assert.match(stdout, /This is a diagnosis, not a go-ahead/);
});
