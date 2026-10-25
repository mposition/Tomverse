import assert from "node:assert/strict";
import test from "node:test";

import { QA_RELEASE_TRAIN_BOARD_RUNNING_MS, qaReleaseTrainBoardRows, qaReleaseTrainOpenTrains, qaReleaseTrainPullStates } from "../lib/qaReleaseTrainBoardCore.ts";

test("the open trains come from GitHub's open list, whatever the board's history holds", () => {
  assert.deepEqual(
    qaReleaseTrainOpenTrains([
      { number: 2998, head: { ref: "release/train-20261025-1400", repo: { full_name: "mposition/Tomverse" } } },
      { number: 2987, head: { ref: "claude/to-develop/back-merge-main-20261025", repo: { full_name: "mposition/Tomverse" } } },
      { number: 3010, head: { ref: "release/train-20261025-1237", repo: { full_name: "mposition/Tomverse" } } },
      // A fork's branch of the same name is not a train.
      { number: 3011, head: { ref: "release/train-20261025-1238", repo: { full_name: "someone/Tomverse" } } },
      { number: 2990, head: { ref: "hotfix/x", repo: { full_name: "mposition/Tomverse" } } },
      { head: { ref: "release/train-x", repo: { full_name: "mposition/Tomverse" } } },
    ]),
    [3010, 2998],
  );
  assert.deepEqual(qaReleaseTrainOpenTrains([]), []);
});

const NOW = Date.parse("2026-10-25T05:00:00Z");
const ago = (minutes) => new Date(NOW - minutes * 60_000);
const report = (slot, minutes, body) => ({ slot, at: ago(minutes), report: { rcSha: "f".repeat(40), failure: null, ...body } });

test("GitHub's list of main pull requests gives each train pull request open, merged or closed", () => {
  const states = qaReleaseTrainPullStates([
    { number: 1, state: "open", merged_at: null, closed_at: null },
    { number: 2, state: "closed", merged_at: "2026-10-25T01:00:00Z", closed_at: "2026-10-25T01:00:00Z" },
    { number: 3, state: "closed", merged_at: null, closed_at: "2026-10-25T02:00:00Z" },
    { title: "no number" },
  ]);
  assert.deepEqual([...states], [
    [1, { state: "open", settledAt: null }],
    [2, { state: "merged", settledAt: "2026-10-25T01:00:00Z" }],
    [3, { state: "closed", settledAt: "2026-10-25T02:00:00Z" }],
  ]);
  assert.equal(qaReleaseTrainPullStates(null).size, 0);
});

test("each admitted train is a row: what rode, what was left out and why, and where its pull request stands", () => {
  const rows = qaReleaseTrainBoardRows({
    admissions: [
      { slot: "20261025-1400", at: ago(5), emergency: false },
      { slot: "20261025-1237", at: ago(90), emergency: true },
      { slot: "20261025-1100", at: ago(180), emergency: false },
      { slot: "20261025-0800", at: ago(360), emergency: false },
      { slot: "20261024-2000", at: ago(600), emergency: false },
      { slot: "20261024-1700", at: ago(780), emergency: false },
    ],
    reports: [
      report("20261025-1237", 88, { outcome: "opened", pullRequestNumber: 2990, picks: [{ number: 2988, outcome: "included" }] }),
      report("20261025-1100", 178, {
        outcome: "opened",
        pullRequestNumber: 2986,
        picks: [
          { number: 2978, outcome: "included" },
          { number: 2913, outcome: "conflict", predecessors: [2726] },
          { number: 2950, outcome: "conflict" },
          { number: 2900, outcome: "changes_workflows" },
          { number: 2824, outcome: "already_in_main" },
        ],
      }),
      report("20261025-0800", 358, { outcome: "empty", pullRequestNumber: null, picks: [{ number: 2913, outcome: "conflict", predecessors: [] }] }),
      report("20261024-2000", 598, { outcome: "failed", pullRequestNumber: null, failure: "push_failed", picks: [] }),
    ],
    pullStates: new Map([
      [2990, { state: "open", settledAt: null }],
      [2986, { state: "merged", settledAt: "2026-10-25T03:00:00Z" }],
    ]),
    titles: new Map([[2978, "ci admission stop fast"]]),
    nowMs: NOW,
  });
  assert.deepEqual(
    rows.map((r) => [r.slot, r.status, r.emergency]),
    [
      ["20261025-1400", "running", false],
      ["20261025-1237", "boarding", true],
      ["20261025-1100", "arrived", false],
      ["20261025-0800", "empty", false],
      ["20261024-2000", "failed", false],
      ["20261024-1700", "unreported", false],
    ],
  );
  const arrived = rows[2];
  assert.equal(arrived.settledAt, "2026-10-25T03:00:00Z");
  assert.deepEqual(arrived.included, [{ number: 2978, title: "ci admission stop fast" }]);
  // A train that never named predecessors is unknown, not "none".
  assert.deepEqual(
    arrived.leftOut.map((p) => [p.number, p.outcome, p.predecessors]),
    [
      [2913, "conflict", [2726]],
      [2950, "conflict", null],
      [2900, "changes_workflows", null],
    ],
  );
  assert.deepEqual(arrived.alreadyOnMain, [2824]);
  assert.deepEqual(rows[3].leftOut[0].predecessors, []);
  assert.equal(rows[4].failure, "push_failed");
});

test("a train whose state GitHub did not give is unknown, never boarding; a closed one is cancelled", () => {
  const rows = qaReleaseTrainBoardRows({
    admissions: [
      { slot: "a", at: ago(10), emergency: false },
      { slot: "b", at: ago(20), emergency: false },
    ],
    reports: [
      report("a", 9, { outcome: "opened", pullRequestNumber: 1, picks: [] }),
      report("b", 19, { outcome: "opened", pullRequestNumber: 2, picks: [] }),
    ],
    pullStates: new Map([[2, { state: "closed", settledAt: "2026-10-25T04:50:00Z" }]]),
    titles: new Map(),
    nowMs: NOW,
  });
  assert.deepEqual(rows.map((r) => r.status), ["unknown", "cancelled"]);
  assert.equal(QA_RELEASE_TRAIN_BOARD_RUNNING_MS, 30 * 60 * 1000);
});
