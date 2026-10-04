import assert from "node:assert/strict";
import test from "node:test";

import { qaReleaseMergeAttemptTransitionAllowed } from "../lib/qaReleaseMergeAttemptCore.ts";
import { QA_RELEASE_MERGE_LANE_LATCH_REASONS } from "../lib/qaReleaseMergeLaneLatchCore.ts";
import {
  qaReleaseDeployObservation,
  qaReleaseReportEffect,
  qaReleaseReportEffectUnderRevision,
} from "../lib/qaReleaseMergeLaneReportCore.ts";

const SHA = "c".repeat(40);
const REPORTS = [
  { kind: "merge", result: "merged", mergeCommitSha: SHA },
  { kind: "merge", result: "refused" },
  { kind: "merge", result: "unknown" },
  ...["succeeded", "failed", "unknown", "wait_exceeded", "unreadable"].map((outcome) => ({ kind: "deploy", outcome, observation: [] })),
  { kind: "unreported" },
  { kind: "reread", result: "not_merged" },
  { kind: "reread", result: "merged_off_develop" },
  { kind: "reread", result: "merged_on_develop", mergeCommitSha: SHA },
  { kind: "reread", result: "merge_commit_off_develop" },
];

test("every report's move is a transition the attempt lifecycle allows, from each state it names", () => {
  for (const report of REPORTS) {
    const effect = qaReleaseReportEffect(report);
    assert.ok(effect.from.length > 0, JSON.stringify(report));
    if (effect.move === null) continue;
    for (const from of effect.from) {
      assert.ok(qaReleaseMergeAttemptTransitionAllowed(from, effect.move.to, effect.move.outcome), `${JSON.stringify(report)} from ${from}`);
    }
  }
});

test("every report either moves the attempt or latches, and every latch reason is listed", () => {
  for (const report of REPORTS) {
    const effect = qaReleaseReportEffect(report);
    assert.ok(effect.move !== null || effect.latch !== null, JSON.stringify(report));
    if (effect.latch !== null) assert.ok(QA_RELEASE_MERGE_LANE_LATCH_REASONS.includes(effect.latch));
  }
});

test("only a bad or unknown outcome latches; a clean merge, refusal, deploy or unmerged pull request does not", () => {
  const latching = REPORTS.filter((report) => qaReleaseReportEffect(report).latch !== null).map((r) => `${r.kind}:${r.result ?? r.outcome ?? ""}`);
  assert.deepEqual(latching, [
    "merge:unknown",
    "deploy:failed",
    "deploy:unknown",
    "deploy:wait_exceeded",
    "deploy:unreadable",
    "unreported:",
    "reread:merged_off_develop",
    "reread:merge_commit_off_develop",
  ]);
});

test("a latch keeps the attempt open, except where the attempt is decided closed", () => {
  // A latch never closes an attempt by itself: only a decided outcome does.
  for (const report of REPORTS) {
    const effect = qaReleaseReportEffect(report);
    if (effect.latch !== null && effect.move !== null) assert.equal(effect.move.to, "closed", JSON.stringify(report));
  }
});

test("a report under another revision is recorded and latches, and never closes a deploy as a success", () => {
  const success = qaReleaseReportEffectUnderRevision(qaReleaseReportEffect({ kind: "deploy", outcome: "succeeded", observation: [] }), false);
  assert.deepEqual(success, { from: ["awaiting_deploy"], move: null, latch: "revision_mismatch" });
  const merged = qaReleaseReportEffectUnderRevision(qaReleaseReportEffect({ kind: "merge", result: "merged", mergeCommitSha: SHA }), false);
  assert.deepEqual(merged.move, { to: "awaiting_deploy", outcome: null, mergeCommitSha: SHA });
  assert.equal(merged.latch, "revision_mismatch");
  // A report that latches for its own reason keeps that reason.
  const failed = qaReleaseReportEffectUnderRevision(qaReleaseReportEffect({ kind: "deploy", outcome: "failed", observation: [] }), false);
  assert.deepEqual(failed, { from: ["awaiting_deploy"], move: { to: "closed", outcome: "deploy_failed" }, latch: "deploy_failed" });
  // Under the newest revision nothing changes.
  for (const report of REPORTS) {
    const effect = qaReleaseReportEffect(report);
    assert.deepEqual(qaReleaseReportEffectUnderRevision(effect, true), effect);
  }
});

test("a merge commit must be a full SHA", () => {
  assert.throws(() => qaReleaseReportEffect({ kind: "merge", result: "merged", mergeCommitSha: "abc" }), RangeError);
  assert.throws(() => qaReleaseReportEffect({ kind: "reread", result: "merged_on_develop", mergeCommitSha: SHA.toUpperCase() }), RangeError);
});

test("a deployment observation is a closed list: service names, Railway statuses and SHAs only", () => {
  assert.deepEqual(qaReleaseDeployObservation([]), []);
  const ok = [{ service: "tomverse-web staging", status: "SUCCESS", commitSha: SHA }, { service: "cron_1", status: "SKIPPED", commitSha: null }];
  assert.deepEqual(qaReleaseDeployObservation(ok), ok);
  for (const bad of [
    null,
    "SUCCESS",
    Array.from({ length: 21 }, () => ok[0]),
    [{ service: "web", status: "ON FIRE", commitSha: null }],
    [{ service: "web", status: "SUCCESS", commitSha: "abc" }],
    [{ service: "", status: "SUCCESS", commitSha: null }],
    [{ service: "web; DROP", status: "SUCCESS", commitSha: null }],
    [{ service: "web", status: "SUCCESS", commitSha: null, note: "from a log" }],
  ]) {
    assert.equal(qaReleaseDeployObservation(bad), null, JSON.stringify(bad)?.slice(0, 60));
  }
  assert.throws(() => qaReleaseReportEffect({ kind: "deploy", outcome: "failed", observation: [{ service: "web", status: "nope", commitSha: null }] }), RangeError);
});
