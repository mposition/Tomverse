// CI admission's view of the CI auto-fix (lib/ciAdmissionFixCore.ts): what the
// review server reported, per pull request, and when "Analyse again" helps.
import assert from "node:assert/strict";
import test from "node:test";

import {
  CI_FIX_AGAIN_LABEL,
  ciFixLabelsToClear,
  ciFixRetryable,
  ciFixState,
  ciFixView,
  emptyCiFixView,
} from "../lib/ciAdmissionFixCore.ts";
import { CI_FIX_AGAIN_LABEL as SERVER_LABEL, CI_FIX_RESULT_CODES } from "../tools/review-orchestrator/lib/ci-fix.mjs";
import { CI_FIX_REASONS, REVIEW_ORCHESTRATOR_STALE_AFTER_MS, reviewStatusSnapshotSchema } from "../lib/reviewOrchestratorStatusCore.ts";

const A = "a".repeat(40);
const B = "b".repeat(40);
const RECEIVED = "2026-10-27T03:00:00.000Z";
const NOW = Date.parse(RECEIVED) + 60_000;

const entry = (pr, head, outcome, extra = {}) => ({ pr, head, kind: "ci", outcome, reason: null, retried: false, ageSeconds: 120, ...extra });
const stored = (entries, extra = {}) => ({
  state: "observed",
  receivedAt: RECEIVED,
  snapshot: {
    schemaVersion: 1,
    draining: false,
    pendingJobs: 0,
    providers: [{ id: "claude", vendor: "anthropic", enabled: true, running: 0, maxConcurrent: 1, quota: { state: "available", remaining: 64, unit: "percent" } }],
    last24h: { accept: 0, reject: 0, unknown: 0 },
    ciFix: { queuedLastHour: 2, entries },
    ...extra,
  },
});

test("the view keeps each pull request's newest try, timed by the app's receipt clock", () => {
  const view = ciFixView(stored([entry(7, B, "queued", { ageSeconds: 60 }), entry(7, A, "no_change"), entry(9, A, "started")]), NOW, REVIEW_ORCHESTRATOR_STALE_AFTER_MS);
  assert.equal(view.connected, true);
  assert.equal(view.queuedLastHour, 2);
  assert.deepEqual(view.claude, { state: "available", remainingPercent: 64 });
  assert.equal(view.byPull[7].head, B, "the first entry is the newest");
  assert.equal(view.byPull[7].at, "2026-10-27T02:59:00.000Z");
  assert.equal(view.byPull[9].outcome, "started");

  const late = ciFixView(stored([]), Date.parse(RECEIVED) + REVIEW_ORCHESTRATOR_STALE_AFTER_MS + 1, REVIEW_ORCHESTRATOR_STALE_AFTER_MS);
  assert.equal(late.connected, false);
  const noLedger = ciFixView({ ...stored([]), snapshot: { ...stored([]).snapshot, ciFix: undefined } }, NOW, REVIEW_ORCHESTRATOR_STALE_AFTER_MS);
  assert.equal(noLedger.queuedLastHour, null);
  assert.deepEqual(ciFixView({ state: "unreadable" }, NOW, 1), emptyCiFixView());
  assert.deepEqual(ciFixView(null, NOW, 1), emptyCiFixView());
});

test("a try says something only about the head it was made on, unless it was the fix that moved it", () => {
  const view = ciFixView(
    stored([
      entry(1, A, "started"),
      entry(2, A, "queued"),
      entry(3, A, "no_change", { reason: "transient" }),
      entry(4, A, "model_timeout"),
      entry(5, A, "patch_refused"),
      entry(6, A, "attempts_exhausted"),
    ]),
    NOW,
    REVIEW_ORCHESTRATOR_STALE_AFTER_MS,
  );
  const states = [1, 2, 3, 4, 5, 6].map((pr) => ciFixState(view.byPull[pr], A, NOW));
  assert.deepEqual(states, ["analysing", "sent", "not_fixed", "failed", "refused", "exhausted"]);
  // The head moved: only a fix the server saw become the head is "pushed";
  // a sent fix not settled yet, one something else replaced, and any other
  // try say nothing about the new head.
  const settled = ciFixView(
    stored([entry(1, A, "pushed", { settled: B }), entry(2, A, "superseded"), entry(3, A, "not_published")]),
    NOW,
    REVIEW_ORCHESTRATOR_STALE_AFTER_MS,
  );
  assert.equal(ciFixState(settled.byPull[1], B, NOW), "pushed");
  assert.equal(ciFixState(settled.byPull[1], "c".repeat(40), NOW), null, "a later push is not the fix's result");
  assert.equal(ciFixState(settled.byPull[2], B, NOW), null);
  // Sent and never published: the head stayed, the try ended, another may follow.
  assert.equal(ciFixState(settled.byPull[3], A, NOW), "not_published");
  assert.equal(ciFixRetryable(settled.byPull[3], A, NOW), true);
  assert.equal(ciFixState(view.byPull[2], B, NOW), null);
  assert.equal(ciFixState(view.byPull[3], B, NOW), null);
  assert.equal(ciFixState(undefined, A, NOW), null);
});

test("a try started over an hour ago and never ended reads as failed, and may be tried again", () => {
  const view = ciFixView(stored([entry(1, A, "started", { ageSeconds: 3_601 }), entry(2, A, "started", { ageSeconds: 600 })]), NOW, REVIEW_ORCHESTRATOR_STALE_AFTER_MS);
  assert.equal(ciFixState(view.byPull[1], A, NOW), "failed");
  assert.equal(ciFixRetryable(view.byPull[1], A, NOW), true);
  assert.equal(ciFixState(view.byPull[2], A, NOW), "analysing");
  assert.equal(ciFixRetryable(view.byPull[2], A, NOW), false);
});

test("analysing again helps only a tried, unfixed head not retried yet", () => {
  const view = ciFixView(
    stored([entry(1, A, "no_change"), entry(2, A, "no_change", { retried: true }), entry(3, A, "queued"), entry(4, A, "model_failed"), entry(5, A, "attempts_exhausted")]),
    NOW,
    REVIEW_ORCHESTRATOR_STALE_AFTER_MS,
  );
  assert.deepEqual(
    [1, 2, 3, 4, 5].map((pr) => ciFixRetryable(view.byPull[pr], A, NOW)),
    [true, false, false, true, false],
  );
  assert.equal(ciFixRetryable(view.byPull[1], B, NOW), false, "another head was not tried");
});

test("the round takes the label off only once the report shows the retry on the current head", () => {
  const view = ciFixView(stored([entry(1, A, "started", { retried: true }), entry(2, A, "no_change"), entry(3, A, "no_change")]), NOW, REVIEW_ORCHESTRATOR_STALE_AFTER_MS);
  const pulls = [
    // Retried: done.
    { number: 1, headSha: A, labels: [CI_FIX_AGAIN_LABEL] },
    // Asked for and not started yet: kept.
    { number: 2, headSha: A, labels: [CI_FIX_AGAIN_LABEL] },
    // Another head: the report says nothing about this one.
    { number: 3, headSha: B, labels: [CI_FIX_AGAIN_LABEL] },
    { number: 4, headSha: A, labels: [] },
    // No entry in the report.
    { number: 5, headSha: A, labels: [CI_FIX_AGAIN_LABEL] },
  ];
  assert.deepEqual(ciFixLabelsToClear(pulls, view), [1]);
  // An unread report (an empty view) takes nothing off.
  assert.deepEqual(ciFixLabelsToClear(pulls, emptyCiFixView()), []);
});

test("the app and the review server name the label and the result codes alike", () => {
  assert.equal(CI_FIX_AGAIN_LABEL, SERVER_LABEL);
  assert.deepEqual([...CI_FIX_REASONS], [...CI_FIX_RESULT_CODES]);
  // The app accepts a report with the auto-fix part, and nothing beyond its fields.
  const report = stored([entry(1, A, "no_change", { reason: "not_found" })]).snapshot;
  assert.equal(reviewStatusSnapshotSchema.safeParse(report).success, true);
  for (const extra of [{ answer: "the model said" }, { branch: "x" }, { log: "y" }]) {
    const bad = { ...report, ciFix: { ...report.ciFix, entries: [{ ...report.ciFix.entries[0], ...extra }] } };
    assert.equal(reviewStatusSnapshotSchema.safeParse(bad).success, false, Object.keys(extra)[0]);
  }
  const reason = { ...report, ciFix: { ...report.ciFix, entries: [{ ...report.ciFix.entries[0], reason: "something the model wrote" }] } };
  assert.equal(reviewStatusSnapshotSchema.safeParse(reason).success, false);
});
