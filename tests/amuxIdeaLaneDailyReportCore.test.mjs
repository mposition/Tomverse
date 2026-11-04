import assert from "node:assert/strict";
import test from "node:test";

import { amuxIdeaLaneDailyReport, amuxIdeaLaneIdeaHref } from "../lib/amux/ideaLaneDailyReportCore.ts";
import { qaReleaseTrainCargoCandidates } from "../lib/qaReleaseTrainCargoCore.ts";

const NOW = Date.parse("2026-11-04T00:00:00Z");
const IDEA_A = "0b6f1d2e-3c4a-4b5c-8d6e-7f8091a2b3c4";
const IDEA_B = "1c7a2e3f-4d5b-4c6d-9e7f-8091a2b3c4d5";
const candidate = (number, mergedAt, overrides = {}) => ({
  number,
  title: `PR ${number}`,
  author: "codex",
  mergedAt,
  status: "available",
  mainPullRequest: null,
  ...overrides,
});
const ok = (candidates, extra = {}) => ({ status: "ok", readAt: "2026-11-03T23:55:00Z", candidates, ...extra });

test("lists only lane pull requests merged into develop in the last 24 hours, newest first", () => {
  const report = amuxIdeaLaneDailyReport({
    attempts: [
      { prNumber: 3280, ideaRequestId: IDEA_A },
      { prNumber: 3290, ideaRequestId: IDEA_B },
      { prNumber: 3100, ideaRequestId: IDEA_A },
    ],
    read: ok([
      candidate(3290, "2026-11-03T20:00:00Z"),
      candidate(3285, "2026-11-03T21:00:00Z"), // not a lane pull request
      candidate(3280, "2026-11-03T01:00:00Z"),
      candidate(3100, "2026-11-02T23:59:59Z"), // a lane pull request, but merged before the window
    ]),
    nowMs: NOW,
  });
  assert.equal(report.status, "ok");
  assert.deepEqual(report.rows.map((row) => row.number), [3290, 3280]);
  assert.equal(report.windowStart, "2026-11-03T00:00:00.000Z");
  assert.equal(report.windowEnd, "2026-11-04T00:00:00.000Z");
  assert.equal(report.rows[0].ideaHref, `/admin/amux-backlog?tab=ideas&idea=${IDEA_B}`);
  assert.equal(report.rows[1].ideaHref, amuxIdeaLaneIdeaHref(IDEA_A));
  assert.equal(report.stale, false);
});

test("a day with no lane merge is an ok report with no rows, never unread", () => {
  const report = amuxIdeaLaneDailyReport({ attempts: [{ prNumber: 3280, ideaRequestId: IDEA_A }], read: ok([candidate(3285, "2026-11-03T21:00:00Z")]), nowMs: NOW });
  assert.equal(report.status, "ok");
  assert.deepEqual(report.rows, []);
  assert.deepEqual(amuxIdeaLaneDailyReport({ attempts: [], read: ok([]), nowMs: NOW }).rows, []);
});

test("an unread GitHub list is unread with its failure, not none", () => {
  assert.deepEqual(
    amuxIdeaLaneDailyReport({ attempts: [{ prNumber: 3280, ideaRequestId: IDEA_A }], read: { status: "unread", failure: "develop:github_403" }, nowMs: NOW }),
    { status: "unread", failure: "develop:github_403" },
  );
});

test("a stale cargo read is marked stale", () => {
  const report = amuxIdeaLaneDailyReport({ attempts: [], read: ok([], { stale: { failure: "timeout", failedAt: "2026-11-03T23:59:00Z" } }), nowMs: NOW });
  assert.equal(report.stale, true);
});

test("main status follows the cargo: on main, waiting in a main pull request, or not yet", () => {
  const report = amuxIdeaLaneDailyReport({
    attempts: [3001, 3002, 3003, 3004, 3005].map((prNumber) => ({ prNumber, ideaRequestId: IDEA_A })),
    read: ok([
      candidate(3001, "2026-11-03T05:00:00Z", { status: "on_main", mainPullRequest: 3282 }),
      candidate(3002, "2026-11-03T04:00:00Z", { status: "in_main_pull_request", mainPullRequest: 3283 }),
      candidate(3003, "2026-11-03T03:00:00Z", { status: "mentioned", mainPullRequest: 3284 }),
      candidate(3004, "2026-11-03T02:00:00Z", { status: "on_main", mainPullRequest: null, foundByTrain: "#3270" }),
      candidate(3005, "2026-11-03T01:00:00Z", { status: "unchecked" }),
    ]),
    nowMs: NOW,
  });
  assert.deepEqual(
    report.rows.map(({ number, main, mainPullRequest }) => ({ number, main, mainPullRequest })),
    [
      { number: 3001, main: "on_main", mainPullRequest: 3282 },
      { number: 3002, main: "in_main_pull_request", mainPullRequest: 3283 },
      // Only a body mentions it: not proven on main.
      { number: 3003, main: "not_on_main", mainPullRequest: null },
      { number: 3004, main: "on_main", mainPullRequest: null },
      { number: 3005, main: "not_on_main", mainPullRequest: null },
    ],
  );
});

test("a main release whose commits keep `Merge pull request #N` marks the lane pull request on main", () => {
  const pull = (number, base, mergedAt, extra = {}) => ({
    number,
    title: `PR ${number}`,
    user: { login: "tomverse-release-train[bot]" },
    base: { ref: base },
    head: { ref: `amux-idea/attempt-${number}`, repo: { full_name: "mposition/Tomverse" } },
    merged_at: mergedAt,
    ...extra,
  });
  const candidates = qaReleaseTrainCargoCandidates({
    mergedDevelopJson: [pull(3280, "develop", "2026-11-03T10:00:00Z"), pull(3281, "develop", "2026-11-03T11:00:00Z")],
    mergedMainJson: [pull(3290, "main", "2026-11-03T20:00:00Z", { title: "release: train 2026-11-03 20:00", head: { ref: "release/train-x" } })],
    openMainJson: [],
    files: new Map([[3281, ["lib/x.ts"]]]),
    mainCommits: new Map([[3290, [{ sha: "a".repeat(40), message: "Merge pull request #3280 from mposition/amux-idea/attempt-3280" }]]]),
    nowMs: NOW,
  });
  const report = amuxIdeaLaneDailyReport({
    attempts: [
      { prNumber: 3280, ideaRequestId: IDEA_A },
      { prNumber: 3281, ideaRequestId: IDEA_B },
    ],
    read: ok(candidates),
    nowMs: NOW,
  });
  assert.deepEqual(
    report.rows.map(({ number, main, mainPullRequest }) => ({ number, main, mainPullRequest })),
    [
      { number: 3281, main: "not_on_main", mainPullRequest: null },
      { number: 3280, main: "on_main", mainPullRequest: 3290 },
    ],
  );
});

test("the idea link encodes its request id", () => {
  assert.equal(amuxIdeaLaneIdeaHref("a b"), "/admin/amux-backlog?tab=ideas&idea=a%20b");
});
