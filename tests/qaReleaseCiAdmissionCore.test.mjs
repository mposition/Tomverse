import assert from "node:assert/strict";
import test from "node:test";

import {
  QA_RELEASE_CI_ADMISSION_CONFIG as CONFIG,
  classifyQaReleaseCiPullRequest,
  decideQaReleaseCiAdmission,
  parseQaReleaseCiAdmissionMode,
  qaReleaseCiLine,
} from "../lib/qaReleaseCiAdmissionCore.ts";

const sha = (n) => String(n % 10).repeat(40);
const T0 = Date.parse("2026-10-20T01:00:00Z");
const at = (minutes) => new Date(T0 + minutes * 60_000).toISOString();
const pr = (number, overrides = {}) => ({
  number,
  nodeId: `PR_${number}`,
  draft: true,
  labels: ["ci:queued"],
  base: "develop",
  head: `claude/to-develop/x${number}`,
  headSha: sha(number),
  queuedAt: at(0),
  ...overrides,
});
const jobs = (count, headSha = "f".repeat(40)) => Array.from({ length: count }, () => ({ headSha }));

test("mode: undeclared or empty is off; only off, shadow and on are accepted", () => {
  assert.equal(parseQaReleaseCiAdmissionMode(undefined), "off");
  assert.equal(parseQaReleaseCiAdmissionMode(" "), "off");
  assert.equal(parseQaReleaseCiAdmissionMode("shadow"), "shadow");
  assert.equal(parseQaReleaseCiAdmissionMode("on"), "on");
  for (const value of ["ON", "true", "1"]) assert.equal(parseQaReleaseCiAdmissionMode(value), null, value);
});

test("classes: hotfix, owner priority, main release, develop; stacked pull requests wait", () => {
  assert.equal(classifyQaReleaseCiPullRequest({ base: "main", head: "hotfix/x", labels: [] }), "hotfix");
  assert.equal(classifyQaReleaseCiPullRequest({ base: "develop", head: "a", labels: ["ci:priority"] }), "priority");
  assert.equal(classifyQaReleaseCiPullRequest({ base: "main", head: "release/train-20261020-1100", labels: [] }), "release");
  assert.equal(classifyQaReleaseCiPullRequest({ base: "develop", head: "a", labels: [] }), "develop");
  assert.equal(classifyQaReleaseCiPullRequest({ base: "claude/to-develop/a", head: "b", labels: ["ci:priority"] }), null);
});

test("the line holds labelled drafts only, by class and then by when the label was added", () => {
  const line = qaReleaseCiLine([
    pr(1, { queuedAt: at(5) }),
    pr(2, { queuedAt: at(1) }),
    pr(3, { draft: false }),
    pr(4, { labels: [] }),
    pr(5, { base: "main", head: "release/train-x", queuedAt: at(9) }),
    pr(6, { labels: ["ci:queued", "ci:priority"], queuedAt: at(20) }),
    pr(7, { base: "main", head: "hotfix/y", queuedAt: at(30) }),
    pr(8, { base: "claude/to-develop/a" }),
    pr(9, { queuedAt: "not a date" }),
  ]);
  assert.deepEqual(line.map((e) => e.number), [7, 6, 5, 2, 1]);
  assert.deepEqual(line.map((e) => e.estimate), [45, 30, 45, 30, 30]);
});

test("admits the head of the line only when its estimate fits inside capacity minus the reserve", () => {
  const line = qaReleaseCiLine([pr(1), pr(2, { queuedAt: at(1) })]);
  // 40 - 12 = 28 admissible: a 30-job pull request counts as 28, so it fits an
  // idle repository alone, and a single running job keeps it waiting.
  assert.deepEqual(decideQaReleaseCiAdmission({ line, activeJobs: [], recent: [], nowMs: T0 }).admit.map((e) => e.number), [1]);
  assert.deepEqual(decideQaReleaseCiAdmission({ line, activeJobs: jobs(1), recent: [], nowMs: T0 }).admit, []);
  const roomy = { ...CONFIG, reserve: 0 };
  const decision = decideQaReleaseCiAdmission({ line, activeJobs: jobs(5), recent: [], nowMs: T0, config: roomy });
  assert.equal(decision.committed, 5);
  assert.deepEqual(decision.admit.map((e) => e.number), [1]); // 35 free, then 5: the second does not fit
  assert.equal(decision.blocked.number, 2);
});

test("running and queued jobs count against the room; nothing is admitted when full", () => {
  const line = qaReleaseCiLine([pr(1)]);
  const decision = decideQaReleaseCiAdmission({ line, activeJobs: jobs(38), recent: [], nowMs: T0 });
  assert.equal(decision.free, -10);
  assert.deepEqual(decision.admit, []);
  assert.equal(decision.waiting, 1);
});

test("a recent admission counts its not-yet-visible jobs until it settles", () => {
  const config = { ...CONFIG, reserve: 0 };
  const line = qaReleaseCiLine([pr(2)]);
  const recent = [{ number: 1, headSha: sha(1), estimate: 30, atMs: T0 }];
  // 12 of its 30 jobs are visible: 18 more are still expected.
  const early = decideQaReleaseCiAdmission({ line, activeJobs: jobs(12, sha(1)), recent, nowMs: T0 + 60_000, config });
  assert.equal(early.committed, 30);
  assert.deepEqual(early.admit, []);
  // After settleMs only the visible jobs count.
  const late = decideQaReleaseCiAdmission({ line, activeJobs: jobs(10, sha(1)), recent, nowMs: T0 + CONFIG.settleMs, config });
  assert.equal(late.committed, 10);
  assert.deepEqual(late.admit.map((e) => e.number), [2]);
  // A pull request already admitted this round is not admitted again.
  const again = decideQaReleaseCiAdmission({ line: qaReleaseCiLine([pr(1)]), activeJobs: [], recent, nowMs: T0 + CONFIG.settleMs, config });
  assert.deepEqual(again.admit, []);
});

test("a smaller pull request uses room the head does not fit, until the head has waited past the limit", () => {
  const config = { ...CONFIG, reserve: 0, estimate: { ...CONFIG.estimate, release: 45, develop: 10 } };
  const line = qaReleaseCiLine([pr(1, { base: "main", head: "release/train-a" }), pr(2, { queuedAt: at(1) })], config);
  const fresh = decideQaReleaseCiAdmission({ line, activeJobs: jobs(10), recent: [], nowMs: T0 + 5 * 60_000, config });
  assert.deepEqual(fresh.admit.map((e) => e.number), [2]);
  assert.equal(fresh.blocked.number, 1);
  assert.equal(fresh.blocked.starving, false);
  const starving = decideQaReleaseCiAdmission({ line, activeJobs: jobs(10), recent: [], nowMs: T0 + CONFIG.starvationMs, config });
  assert.deepEqual(starving.admit, []);
  assert.equal(starving.blocked.starving, true);
});

test("at most maxPerPoll pull requests are admitted in one poll", () => {
  const config = { ...CONFIG, capacity: 500, reserve: 0 };
  const line = qaReleaseCiLine([pr(1), pr(2), pr(3)], config);
  const decision = decideQaReleaseCiAdmission({ line, activeJobs: [], recent: [], nowMs: T0, config });
  assert.deepEqual(decision.admit.map((e) => e.number), [1, 2]);
  assert.equal(decision.waiting, 1);
});
