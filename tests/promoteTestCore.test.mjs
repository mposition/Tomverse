import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildInfoServes,
  checkSuitesVerdict,
  classifyMove,
  parseCandidate,
  parseSourceBranch,
  pushArguments,
  refusalReason,
} from "../scripts/promote-test-core.mjs";

const a = "a".repeat(40);
const b = "b".repeat(40);

test("a candidate is a SHA or a prefix of one, and nothing a shell could read", () => {
  assert.equal(parseCandidate("09489EF"), "09489ef");
  assert.equal(parseCandidate(` ${a} `), a);
  for (const rejected of ["", "abc", "develop", "HEAD~1", "09489ef; rm -rf /", undefined, null, "g".repeat(40)]) {
    assert.equal(parseCandidate(rejected), null, String(rejected));
  }
});

test("a move is a create, a no-op, a fast-forward or a rewind", () => {
  assert.equal(classifyMove({ currentSha: null, targetSha: a, currentIsAncestorOfTarget: false }), "create");
  assert.equal(classifyMove({ currentSha: a, targetSha: a, currentIsAncestorOfTarget: true }), "noop");
  assert.equal(classifyMove({ currentSha: a, targetSha: b, currentIsAncestorOfTarget: true }), "forward");
  assert.equal(classifyMove({ currentSha: a, targetSha: b, currentIsAncestorOfTarget: false }), "rewind");
  assert.throws(() => classifyMove({ currentSha: null, targetSha: "abc", currentIsAncestorOfTarget: false }));
});

test("a candidate comes from develop or a release branch, nowhere else", () => {
  assert.equal(parseSourceBranch(undefined), "develop");
  assert.equal(parseSourceBranch("release/2026-10-07-voice"), "release/2026-10-07-voice");
  for (const rejected of ["main", "test", "hotfix/x", "claude/to-develop/x", "release/", "release/../main", "release/a b"]) {
    assert.equal(parseSourceBranch(rejected), null, rejected);
  }
});

test("a candidate off its source, or with a failed suite, is refused; a rewind needs a person to say so", () => {
  const ok = { onSource: true, allowRewind: false, suites: "passed" };
  assert.equal(refusalReason({ ...ok, move: "forward", onSource: false, allowRewind: true }), "not_on_source");
  assert.equal(refusalReason({ ...ok, move: "forward", suites: "failed" }), "checks_failed");
  assert.equal(refusalReason({ ...ok, move: "rewind" }), "rewind_needs_allow_rewind");
  assert.equal(refusalReason({ ...ok, move: "rewind", allowRewind: true }), null);
  for (const move of ["create", "noop", "forward"]) {
    for (const suites of ["passed", "pending", "none"]) {
      assert.equal(refusalReason({ ...ok, move, suites }), null, `${move} ${suites}`);
    }
  }
});

test("check suites are read the way Railway's Wait for CI reads them", () => {
  const actions = (status, conclusion) => ({ app: "github-actions", status, conclusion });
  assert.equal(checkSuitesVerdict([]), "none");
  // Other apps' suites are ignored, as Railway ignores them.
  assert.equal(checkSuitesVerdict([{ app: "claude", status: "completed", conclusion: "failure" }]), "none");
  assert.equal(checkSuitesVerdict([actions("completed", "success"), actions("completed", "skipped")]), "passed");
  assert.equal(checkSuitesVerdict([actions("completed", "success"), actions("in_progress", null)]), "pending");
  // A later develop push cancels the earlier one's runs; Test would skip that commit.
  assert.equal(checkSuitesVerdict([actions("completed", "success"), actions("completed", "cancelled")]), "failed");
  assert.equal(checkSuitesVerdict([actions("in_progress", null), actions("completed", "failure")]), "failed");
});

test("the push is pinned to the test branch that was read", () => {
  assert.deepEqual(pushArguments({ targetSha: b, currentSha: a }), [
    "push",
    `--force-with-lease=refs/heads/test:${a}`,
    "origin",
    `${b}:refs/heads/test`,
  ]);
  // First promotion: the lease says the branch must not exist yet.
  assert.equal(pushArguments({ targetSha: b, currentSha: null })[1], "--force-with-lease=refs/heads/test:");
  assert.throws(() => pushArguments({ targetSha: "main", currentSha: null }));
});

test("Test serves the candidate when its own process says so", () => {
  assert.equal(buildInfoServes({ commitSha: a, deploymentStatus: "unknown" }, a), true);
  assert.equal(buildInfoServes({ commitSha: b, deploymentStatus: "success" }, a), false);
  assert.equal(buildInfoServes({}, a), false);
  assert.equal(buildInfoServes(null, a), false);
});
