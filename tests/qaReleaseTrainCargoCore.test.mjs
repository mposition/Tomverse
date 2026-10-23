import assert from "node:assert/strict";
import test from "node:test";

import {
  QA_RELEASE_TRAIN_CARGO_MAX,
  parseQaReleaseTrainCargoPick,
  qaReleaseTrainCargoCandidates,
  qaReleaseTrainCargoPickable,
  qaReleaseTrainReferencedNumbers,
  qaReleaseTrainSelectionFrom,
} from "../lib/qaReleaseTrainCargoCore.ts";

const NOW = Date.parse("2026-10-23T00:00:00Z");
const develop = (number, mergedAt = "2026-10-22T00:00:00Z", overrides = {}) => ({
  number,
  title: `PR ${number}`,
  user: { login: "codex" },
  base: { ref: "develop" },
  merged_at: mergedAt,
  ...overrides,
});
const release = (number, body, merged = true) => ({ number, title: `release: ${number}`, body, merged_at: merged ? "2026-10-22T05:00:00Z" : null });

test("a release pull request names the develop pull requests it carries", () => {
  assert.deepEqual(qaReleaseTrainReferencedNumbers({ title: "release: two (#2873)", body: "Brings #2862 and #2873.\nSee #2873." }), [2873, 2862]);
  assert.deepEqual(qaReleaseTrainReferencedNumbers({ title: null, body: null }), []);
});

test("candidates: merged develop pull requests in the window, newest first, each with whether it can ride", () => {
  const candidates = qaReleaseTrainCargoCandidates({
    mergedDevelopJson: [
      develop(1, "2026-10-22T01:00:00Z"),
      develop(2, "2026-10-22T02:00:00Z"),
      develop(3, "2026-10-22T03:00:00Z"),
      develop(4, "2026-10-22T04:00:00Z"),
      develop(5, "2026-10-22T05:00:00Z"),
      develop(6, "2026-10-01T00:00:00Z"),
      develop(7, null),
      develop(8, "2026-10-22T06:00:00Z", { base: { ref: "main" } }),
    ],
    // #2 is on main; a closed-unmerged release naming #3 does not count.
    mergedMainJson: [release(900, "Brings #2"), release(901, "Brings #3", false)],
    openMainJson: [release(902, "Brings #3", false)],
    files: new Map([
      [1, ["lib/a.ts"]],
      [3, ["lib/c.ts"]],
      [4, [".github/workflows/ci.yml", "lib/d.ts"]],
    ]),
    nowMs: NOW,
  });
  assert.deepEqual(
    candidates.map((c) => [c.number, c.status, c.mainPullRequest]),
    [
      [5, "unchecked", null],
      [4, "changes_workflows", null],
      [3, "in_main_pull_request", 902],
      [2, "on_main", 900],
      [1, "available", null],
    ],
  );
  assert.equal(candidates[0].author, "codex");
  assert.deepEqual(
    candidates.filter((c) => qaReleaseTrainCargoPickable(c.status)).map((c) => c.number),
    [5, 1],
  );
});

test("a hotfix cut from the same branch name is on main, and a back-merge never rides", () => {
  const candidates = qaReleaseTrainCargoCandidates({
    mergedDevelopJson: [
      develop(10, "2026-10-22T01:00:00Z", { head: { ref: "claude/to-develop/ci-admission-fast-webhook" } }),
      develop(11, "2026-10-22T02:00:00Z", { head: { ref: "claude/to-develop/back-merge-main-20261022" } }),
      develop(12, "2026-10-22T03:00:00Z", { head: { ref: "main" } }),
      develop(13, "2026-10-22T04:00:00Z", { head: { ref: "codex/to-develop/x" }, title: "Back-merge main into develop" }),
      develop(14, "2026-10-22T05:00:00Z", { head: { ref: "claude/to-develop/train-picker" } }),
      develop(15, "2026-10-22T06:00:00Z", { head: { ref: "claude/to-develop/fast-webhook" } }),
    ],
    // A hotfix whose body names no number; an open release cut from #14's branch name.
    mergedMainJson: [{ ...release(865, "Answer webhooks at once."), head: { ref: "hotfix/2026-10-21-ci-admission-fast-webhook" } }],
    openMainJson: [{ ...release(902, "No numbers.", false), head: { ref: "release/2026-10-23-train-picker" } }],
    files: new Map([[15, ["lib/a.ts"]]]),
    nowMs: NOW,
  });
  assert.deepEqual(
    candidates.map((c) => [c.number, c.status, c.mainPullRequest]),
    [
      // Only the whole last segment matches: "fast-webhook" is not "ci-admission-fast-webhook".
      [15, "available", null],
      [14, "in_main_pull_request", 902],
      [13, "back_merge", null],
      [12, "back_merge", null],
      [11, "back_merge", null],
      [10, "on_main", 865],
    ],
  );
  assert.deepEqual(candidates.filter((c) => qaReleaseTrainCargoPickable(c.status)).map((c) => c.number), [15]);
});

test("a pick is distinct positive numbers, at most the train's capacity", () => {
  assert.deepEqual(parseQaReleaseTrainCargoPick([3, 1]), [3, 1]);
  assert.deepEqual(parseQaReleaseTrainCargoPick([]), []);
  for (const bad of [null, "1", [1, 1], [0], [1.5], Array.from({ length: QA_RELEASE_TRAIN_CARGO_MAX + 1 }, (_, i) => i + 1)]) {
    assert.equal(parseQaReleaseTrainCargoPick(bad), null, JSON.stringify(bad));
  }
});

test("the newest pick is the next train's cargo until a train is admitted after it", () => {
  const pickAt = new Date("2026-10-22T10:00:00Z");
  assert.deepEqual(qaReleaseTrainSelectionFrom({ pick: null, admission: null }), { numbers: [], savedAt: null, savedBy: null, departedWith: null });
  const waiting = qaReleaseTrainSelectionFrom({
    pick: { numbers: [2, 1], at: pickAt, by: "owner@example.com" },
    admission: { slot: "20261022-0800", at: new Date("2026-10-22T09:00:00Z") },
  });
  assert.deepEqual(waiting, { numbers: [2, 1], savedAt: pickAt.toISOString(), savedBy: "owner@example.com", departedWith: null });
  const spent = qaReleaseTrainSelectionFrom({
    pick: { numbers: [2, 1], at: pickAt, by: "owner@example.com" },
    admission: { slot: "20261022-1100", at: new Date("2026-10-22T11:00:00Z") },
  });
  assert.deepEqual(spent.numbers, []);
  assert.equal(spent.departedWith, "20261022-1100");
  // A stored row that does not parse carries nothing.
  assert.deepEqual(qaReleaseTrainSelectionFrom({ pick: { numbers: "x", at: pickAt, by: null }, admission: null }).numbers, []);
});
