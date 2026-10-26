import assert from "node:assert/strict";
import test from "node:test";

import {
  QA_RELEASE_DIGEST_STALE_MS,
  latestReadableDigest,
  qaReleaseAttentionItems,
  qaReleaseStatusFigures,
} from "../lib/qaReleaseAttentionCore.ts";

const NOW = Date.parse("2026-10-20T12:00:00.000Z");
const sha = (c) => c.repeat(40);

const summary = (over = {}) => ({
  gatesByVerdict: { evidence_present: 9, not_implemented: 2, unmapped: 1 },
  issueCandidates: 4,
  issueBlocked: 1,
  issuesAvailable: true,
  failedChecks: 0,
  failedCiJobs: 0,
  failedCi: [],
  notChecked: [],
  latency: { status: "ok", merges: 6, medianDevDeployedMin: 18, maxDevDeployedMin: 41, medianLastCheckDoneMin: 12, maxLastCheckStartMin: 3 },
  ...over,
});
const row = (id, createdAt, body = "present", s = summary()) => ({
  id,
  digestDate: createdAt.slice(0, 10),
  createdAt,
  sizeBytes: 100,
  payloadSha256: sha("a"),
  body,
  summary: body === "present" ? s : null,
});
const control = (over = {}) => ({
  revision: 4,
  digestEnabled: true,
  mergeLaneEnabled: true,
  developLaneOn: true,
  iacCommit: null,
  createdAt: "2026-10-01T00:00:00.000Z",
  rotatedAt: {},
  ...over,
});
const freeLane = { latched: false, latch: null, latchAttempt: null, openAttempt: null };
const main = (over = {}) => ({
  pullRequests: [],
  production: { environment: "production", servingSha: sha("1"), mainHeadSha: sha("1"), servesMainHead: true },
  ...over,
});
const quiet = () => ({
  console: { control: control(), digests: [row("d1", "2026-10-20T01:00:00.000Z")], mergeLane: freeLane },
  main: main(),
  trains: [],
  nowMs: NOW,
});

test("a quiet day asks nothing of the operator", () => {
  assert.deepEqual(qaReleaseAttentionItems(quiet()), []);
});

test("each recorded problem becomes one item, the irreversible ones first", () => {
  const input = quiet();
  input.console.mergeLane = {
    latched: true,
    latch: { sequence: 3, reason: "deploy_failed", createdAt: "2026-10-20T02:00:00.000Z", attemptId: "a1" },
    latchAttempt: { pullRequestNumber: 2790 },
    openAttempt: null,
  };
  input.console.digests = [row("d1", "2026-10-20T01:00:00.000Z", "present", summary({ failedCiJobs: 2, failedChecks: 1 }))];
  input.main = main({
    pullRequests: [
      { number: 2806, title: "Release", head: "release/x", draft: false, url: "u", allowed: true, reason: "" },
      { number: 2811, title: "Feature", head: "claude/x", draft: false, url: "u", allowed: false, reason: "" },
    ],
    production: { environment: "production", servingSha: sha("1"), mainHeadSha: sha("2"), servesMainHead: false },
  });
  input.trains = [{ slot: "20261020-1400", at: "2026-10-20T04:00:00.000Z", outcome: "failed", failure: "push_refused" }];
  const items = qaReleaseAttentionItems(input);
  assert.deepEqual(
    items.map((item) => item.kind),
    ["lane_latched", "production_behind", "main_refused", "ci_failed", "checks_failed", "train_failed"],
  );
  assert.deepEqual(items[0], { kind: "lane_latched", reason: "deploy_failed", pullRequestNumber: 2790 });
  assert.deepEqual(items[2], { kind: "main_refused", numbers: [2811] });
  assert.deepEqual(items[3], { kind: "ci_failed", count: 2 });
});

test("no control revision, and GitHub unread, are each raised", () => {
  const input = quiet();
  input.console.control = null;
  input.main = main({ pullRequests: null, production: { environment: "production", servingSha: null, mainHeadSha: null, servesMainHead: null } });
  assert.deepEqual(
    qaReleaseAttentionItems(input).map((item) => item.kind),
    ["control_missing", "main_unread"],
  );
  // Why it could not be read reaches the operator.
  input.main = { ...input.main, readFailure: "github_403" };
  assert.deepEqual(qaReleaseAttentionItems(input).find((item) => item.kind === "main_unread"), { kind: "main_unread", failure: "github_403" });
});

test("a digest is late only while the digest is switched on", () => {
  const input = quiet();
  const old = new Date(NOW - QA_RELEASE_DIGEST_STALE_MS - 1).toISOString();
  input.console.digests = [row("d1", old)];
  assert.deepEqual(qaReleaseAttentionItems(input), [{ kind: "digest_stale", lastAt: old }]);
  input.console.digests = [];
  assert.deepEqual(qaReleaseAttentionItems(input), [{ kind: "digest_stale", lastAt: null }]);
  input.console.control = control({ digestEnabled: false });
  assert.deepEqual(qaReleaseAttentionItems(input), []);
});

test("failures are read from the newest digest with a readable body, not an expired one", () => {
  const digests = [
    row("d2", "2026-10-20T01:00:00.000Z", "expired"),
    row("d1", "2026-10-19T01:00:00.000Z", "present", summary({ failedCiJobs: 3 })),
  ];
  assert.equal(latestReadableDigest(digests)?.id, "d1");
  const input = quiet();
  input.console.digests = digests;
  assert.deepEqual(qaReleaseAttentionItems(input), [{ kind: "ci_failed", count: 3 }]);
});

test("the four status figures come from the same loaded data", () => {
  const figures = qaReleaseStatusFigures({
    digests: [row("d1", "2026-10-20T01:00:00.000Z")],
    main: main({
      pullRequests: [
        { number: 1, title: "a", head: "release/a", draft: true, url: "u", allowed: true, reason: "" },
        { number: 2, title: "b", head: "release/b", draft: false, url: "u", allowed: true, reason: "" },
      ],
      production: { environment: "production", servingSha: sha("1"), mainHeadSha: sha("2"), servesMainHead: false },
    }),
  });
  assert.equal(figures.production, "behind");
  assert.deepEqual(figures.mainPulls, { total: 2, drafts: 1 });
  assert.equal(figures.gates?.evidence, 9);
  assert.equal(figures.gates?.total, 12);
  assert.deepEqual(figures.latency, { merges: 6, median: 18, max: 41 });

  const empty = qaReleaseStatusFigures({
    digests: [],
    main: main({ pullRequests: null, production: { environment: "production", servingSha: null, mainHeadSha: null, servesMainHead: null } }),
  });
  assert.equal(empty.production, "unknown");
  assert.equal(empty.mainPulls, null);
  assert.equal(empty.gates, null);
  assert.equal(empty.latency, null);
});
