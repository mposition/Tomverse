import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  CROSS_REVIEW_VERSION,
  DEFAULT_MAX_REVISIONS,
  authorOutputProblems,
  isActionable,
  parseExecutorJson,
  renderReviewPrompt,
  reviewVerdictProblems,
  runCrossReview,
} from "../lib/crossReviewCore.ts";
import {
  CLI_INVOCATIONS,
  approveCurrent,
  cliAuthor,
  cliReviewer,
  mockAuthor,
  mockReviewer,
  unwrapClaudeResult,
} from "../lib/crossReviewExecutors.ts";

/**
 * The control program decides; the executors only answer. What these tests
 * hold: a pass needs a verdict on the current digest *and* passing checks; a
 * fix is re-reviewed on its new digest; the cap ends the loop on hold rather
 * than retrying; and every way an executor can fail to answer is a named
 * failure, never a pass. The command-line shells are proven never to run in
 * dry-run by handing them a spawner that throws.
 */

const digest = (text) => `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;

const task = {
  taskId: "T-1",
  requirement: "Add a pure helper that sums an array.",
  completionCriteria: ["a test covers the empty array", "no file outside lib/ and tests/ changes"],
  baseCommit: "abc123",
  writableScope: ["lib/", "tests/"],
};

const change = (n, overrides = {}) => ({
  ok: true,
  value: {
    diff: `--- a/lib/sum.ts\n+++ b/lib/sum.ts\n+export const sum = (xs) => xs.reduce((a, b) => a + b, ${n});\n`,
    summary: `round ${n} change`,
    filesChanged: ["lib/sum.ts"],
    selfAssessment: "looks fine to me",
    commit: null,
    ...overrides,
  },
});

const pass = (command = "npm test") => [{ command, passed: true, output: "ok", durationMs: 1 }];
const fail = (command = "npm test") => [{ command, passed: false, output: "1 failing", durationMs: 1 }];

const finding = (overrides = {}) => ({
  location: "lib/sum.ts:1",
  severity: "error",
  basis: "evidence",
  claim: "sum([]) returns the seed, which is wrong for the empty array",
  reproduction: "node -e 'sum([])'",
  ...overrides,
});

const control = (overrides = {}) => ({
  task,
  digest,
  runTests: async () => pass(),
  now: () => new Date("2026-09-09T00:00:00Z"),
  timeoutMs: 1000,
  ...overrides,
});

test("a verdict on the current digest with passing checks is the only pass", async () => {
  const author = mockAuthor("claude", [change(0)]);
  const reviewer = mockReviewer("codex", [approveCurrent("T-1", 0)]);
  const outcome = await runCrossReview(control({ author, reviewer }));
  assert.equal(outcome.status, "passed");
  assert.equal(outcome.failure, null);
  assert.equal(outcome.exchange.version, CROSS_REVIEW_VERSION);
  assert.equal(outcome.exchange.rounds.length, 1);
  assert.equal(outcome.exchange.changeDigest, digest(change(0).value.diff));
  assert.equal(outcome.exchange.reviewConclusion, "approve");
  assert.deepEqual(outcome.exchange.roles, { author: "claude", reviewer: "codex" });
  assert.equal(outcome.exchange.maxRevisions, DEFAULT_MAX_REVISIONS);
  // The reviewer was shown the requirement and the diff, and the author's
  // self-assessment only as a labelled claim.
  const request = reviewer.calls[0];
  assert.equal(request.task.requirement, task.requirement);
  assert.equal(request.changeDigest, outcome.exchange.changeDigest);
  const prompt = renderReviewPrompt(request);
  assert.ok(prompt.indexOf("## Requirement (original)") < prompt.indexOf("## Change under review"));
  assert.ok(prompt.indexOf("## Change under review") < prompt.indexOf("## Author's account"));
  assert.ok(prompt.includes("a claim, not a finding"));
});

test("an evidenced finding sends the change back, and the fix is reviewed on its new digest", async () => {
  const author = mockAuthor("claude", [change(0), change(1)]);
  const reviewer = mockReviewer("codex", [
    { ok: true, value: { taskId: "T-1", round: 0, reviewedDigest: "@current", conclusion: "request_changes", findings: [finding()], nextAction: "fix the seed" } },
    approveCurrent("T-1", 1),
  ]);
  const outcome = await runCrossReview(control({ author, reviewer }));
  assert.equal(outcome.status, "passed");
  assert.equal(outcome.exchange.rounds.length, 2);
  assert.equal(outcome.exchange.rounds[0].findings[0].disposition, "fix_requested");
  assert.notEqual(outcome.exchange.rounds[0].changeDigest, outcome.exchange.rounds[1].changeDigest);
  assert.equal(reviewer.calls[1].changeDigest, outcome.exchange.rounds[1].changeDigest);
  assert.deepEqual(reviewer.calls[1].previousFindings, [finding()]);
  assert.deepEqual(author.calls[1].feedback.findings.map((f) => f.location), ["lib/sum.ts:1"]);
});

test("after the revision cap the change goes on hold with its findings, and is not retried", async () => {
  const author = mockAuthor("claude", [change(0), change(1), change(2), change(3)]);
  const requestChanges = (round) => ({
    ok: true,
    value: { taskId: "T-1", round, reviewedDigest: "@current", conclusion: "request_changes", findings: [finding()], nextAction: "still wrong" },
  });
  const reviewer = mockReviewer("codex", [requestChanges(0), requestChanges(1), requestChanges(2), requestChanges(3)]);
  const outcome = await runCrossReview(control({ author, reviewer, maxRevisions: 2 }));
  assert.equal(outcome.status, "on_hold");
  assert.equal(outcome.holdReason, "revisions_exhausted");
  assert.equal(outcome.exchange.rounds.length, 3, "round 0 plus two revisions");
  assert.equal(author.calls.length, 3);
  assert.equal(outcome.exchange.findings[0].disposition, "unresolved_on_hold");
  assert.equal(outcome.exchange.findings[0].reproduction, "node -e 'sum([])'");
});

test("two executors agreeing is not a pass while a required check fails", async () => {
  const author = mockAuthor("claude", [change(0), change(1)]);
  const reviewer = mockReviewer("codex", [approveCurrent("T-1", 0), approveCurrent("T-1", 1)]);
  const outcome = await runCrossReview(control({ author, reviewer, runTests: async () => fail(), maxRevisions: 1 }));
  assert.equal(outcome.status, "on_hold");
  assert.equal(outcome.holdReason, "approved_but_checks_failed");
  assert.equal(outcome.exchange.rounds.length, 2);
  assert.equal(outcome.exchange.rounds[0].reviewConclusion, "approve");
  assert.deepEqual(author.calls[1].feedback.failedTests.map((t) => t.command), ["npm test"]);
});

test("a guard violation is a failed check even with passing tests and an approval", async () => {
  const author = mockAuthor("claude", [change(0), change(1)]);
  const reviewer = mockReviewer("codex", [approveCurrent("T-1", 0), approveCurrent("T-1", 1)]);
  const outcome = await runCrossReview(
    control({ author, reviewer, guards: async () => ["tests/protected.test.mjs was modified"], maxRevisions: 1 })
  );
  assert.equal(outcome.status, "on_hold");
  assert.equal(outcome.holdReason, "approved_but_checks_failed");
  assert.deepEqual(author.calls[1].feedback.guardViolations, ["tests/protected.test.mjs was modified"]);
});

test("preference and unreproduced judgement never force a revision; the current version stands with them recorded", async () => {
  const author = mockAuthor("claude", [change(0)]);
  const reviewer = mockReviewer("codex", [
    {
      ok: true,
      value: {
        taskId: "T-1",
        round: 0,
        reviewedDigest: "@current",
        conclusion: "request_changes",
        findings: [
          finding({ basis: "preference", severity: "nit", claim: "I would name it total", reproduction: undefined }),
          finding({ basis: "judgement", severity: "warning", claim: "this will be slow", reproduction: undefined }),
        ],
        nextAction: "rename and optimise",
      },
    },
  ]);
  const outcome = await runCrossReview(control({ author, reviewer }));
  assert.equal(outcome.status, "passed");
  assert.equal(author.calls.length, 1);
  assert.deepEqual(
    outcome.exchange.findings.map((f) => f.disposition),
    ["resolved_by_project_rule", "insufficient_evidence_kept_current"]
  );
  assert.equal(isActionable(finding({ basis: "judgement", reproduction: "node -e 1" })), true);
  assert.equal(isActionable(finding({ basis: "judgement", reproduction: undefined })), false);
});

test("a verdict naming another digest, task or round does not apply", async () => {
  for (const [patch, failure] of [
    [{ reviewedDigest: "sha256:0000" }, "digest_mismatch"],
    [{ taskId: "T-9" }, "task_mismatch"],
    [{ round: 4 }, "round_mismatch"],
  ]) {
    const author = mockAuthor("claude", [change(0)]);
    const reviewer = mockReviewer("codex", [
      { ok: true, value: { ...approveCurrent("T-1", 0).value, ...patch } },
    ]);
    const outcome = await runCrossReview(control({ author, reviewer }));
    assert.equal(outcome.status, "failed", failure);
    assert.equal(outcome.failure, failure);
  }
});

test("invalid JSON, a missing result, a timeout and an executor failure are named failures, not passes", async () => {
  const cases = [
    [{ ok: false, failure: "invalid_json", detail: "x" }, "reviewer_invalid_json"],
    [{ ok: false, failure: "missing_result", detail: "x" }, "reviewer_missing_result"],
    [{ ok: false, failure: "execution_failed", detail: "x" }, "reviewer_execution_failed"],
  ];
  for (const [scripted, failure] of cases) {
    const outcome = await runCrossReview(
      control({ author: mockAuthor("claude", [change(0)]), reviewer: mockReviewer("codex", [scripted]) })
    );
    assert.equal(outcome.status, "failed");
    assert.equal(outcome.failure, failure);
  }
  // A reviewer that never answers is a timeout.
  const hanging = { id: "codex", review: () => new Promise(() => {}) };
  const timedOut = await runCrossReview(control({ author: mockAuthor("claude", [change(0)]), reviewer: hanging, timeoutMs: 20 }));
  assert.equal(timedOut.status, "failed");
  assert.equal(timedOut.failure, "reviewer_timeout");
  // An author that throws is an execution failure.
  const throwing = { id: "claude", produce: async () => { throw new Error("boom"); } };
  const crashed = await runCrossReview(control({ author: throwing, reviewer: mockReviewer("codex", []) }));
  assert.equal(crashed.status, "failed");
  assert.equal(crashed.failure, "author_execution_failed");
  // A reviewer with no scripted answer is a missing result.
  const silent = await runCrossReview(control({ author: mockAuthor("claude", [change(0)]), reviewer: mockReviewer("codex", []) }));
  assert.equal(silent.failure, "reviewer_missing_result");
});

test("a reviewer that is blocked puts the change on hold for a person", async () => {
  const outcome = await runCrossReview(
    control({
      author: mockAuthor("claude", [change(0)]),
      reviewer: mockReviewer("codex", [
        { ok: true, value: { taskId: "T-1", round: 0, reviewedDigest: "@current", conclusion: "blocked", findings: [], nextAction: "the diff does not apply to the base" } },
      ]),
    })
  );
  assert.equal(outcome.status, "on_hold");
  assert.equal(outcome.holdReason, "reviewer_blocked");
});

test("a change outside the writable scope is refused before review", async () => {
  const outcome = await runCrossReview(
    control({
      author: mockAuthor("claude", [change(0, { filesChanged: ["lib/sum.ts", "app/api/chat/route.ts"] })]),
      reviewer: mockReviewer("codex", [approveCurrent("T-1", 0)]),
    })
  );
  assert.equal(outcome.status, "failed");
  assert.equal(outcome.failure, "scope_violation");
});

test("the control program digests the diff itself and ignores any digest the author claims", async () => {
  const author = mockAuthor("claude", [change(0, { changeDigest: "sha256:forged" })]);
  const reviewer = mockReviewer("codex", [approveCurrent("T-1", 0)]);
  const outcome = await runCrossReview(control({ author, reviewer }));
  assert.equal(outcome.exchange.changeDigest, digest(change(0).value.diff));
});

test("executor output is parsed strictly: whole document, last line, or last block; anything else is a named failure", () => {
  const verdict = { taskId: "T-1", round: 0, reviewedDigest: "sha256:a", conclusion: "approve", findings: [], nextAction: "ok" };
  assert.equal(parseExecutorJson(JSON.stringify(verdict), reviewVerdictProblems).ok, true);
  assert.equal(parseExecutorJson(`event 1\nevent 2\n${JSON.stringify(verdict)}`, reviewVerdictProblems).ok, true);
  assert.equal(parseExecutorJson(`Here you go:\n${JSON.stringify(verdict)}\nthanks`, reviewVerdictProblems).ok, true);
  assert.equal(parseExecutorJson("", reviewVerdictProblems).failure, "missing_result");
  assert.equal(parseExecutorJson("not json at all", reviewVerdictProblems).failure, "invalid_json");
  assert.equal(parseExecutorJson(JSON.stringify({ ...verdict, conclusion: "yes" }), reviewVerdictProblems).failure, "schema_mismatch");
  assert.equal(
    parseExecutorJson(JSON.stringify({ ...verdict, findings: [{ location: "", severity: "high", basis: "vibes", claim: "" }] }), reviewVerdictProblems).failure,
    "schema_mismatch"
  );
  assert.deepEqual(authorOutputProblems({ diff: "", summary: "s", filesChanged: [] }), []);
  assert.ok(authorOutputProblems({ diff: 1, summary: "", filesChanged: "x" }).length >= 3);
  assert.equal(unwrapClaudeResult(JSON.stringify({ type: "result", result: JSON.stringify(verdict) })), JSON.stringify(verdict));
  assert.equal(unwrapClaudeResult("plain"), "plain");
});

test("in dry-run the command-line executors never spawn, and the run ends as not executed", async () => {
  const spawn = async () => {
    throw new Error("spawn must not be called in dry-run");
  };
  const options = (role, id) => ({
    id,
    invocation: CLI_INVOCATIONS[id][role],
    mode: "dry-run",
    cwd: "/nowhere",
    timeoutMs: 10,
    spawn,
  });
  const outcome = await runCrossReview(
    control({ author: cliAuthor(options("author", "claude")), reviewer: cliReviewer(options("reviewer", "codex")) })
  );
  assert.equal(outcome.status, "failed");
  assert.equal(outcome.failure, "author_not_executed");
  assert.match(outcome.exchange.rounds[0].nextAction, /dry-run: would run `claude --print/);
  // Live mode with a spawner that fails is an execution failure, not a pass.
  const live = await runCrossReview(
    control({
      author: cliAuthor({ ...options("author", "claude"), mode: "live", spawn: async () => ({ status: 1, stdout: "", stderr: "no such tool" }) }),
      reviewer: cliReviewer(options("reviewer", "codex")),
    })
  );
  assert.equal(live.failure, "author_execution_failed");
  // Live mode with no spawner cannot run anything.
  const noSpawn = await runCrossReview(
    control({ author: cliAuthor({ ...options("author", "claude"), mode: "live", spawn: undefined }), reviewer: cliReviewer(options("reviewer", "codex")) })
  );
  assert.equal(noSpawn.failure, "author_execution_failed");
});

test("the reviewer's command-line invocation offers no write tool", () => {
  for (const id of Object.keys(CLI_INVOCATIONS)) {
    const args = CLI_INVOCATIONS[id].reviewer.args.join(" ");
    assert.ok(!/Edit|Write|workspace-write|acceptEdits/.test(args), `${id} reviewer: ${args}`);
  }
});

test("Codex JSONL output is unwrapped to its final agent message; anything else passes through", async () => {
  const { unwrapCodexJsonl } = await import("../lib/crossReviewExecutors.ts");
  const verdict = { taskId: "T-1", round: 0, reviewedDigest: "sha256:a", conclusion: "approve", findings: [], nextAction: "ok" };
  const jsonl = [
    JSON.stringify({ type: "thread.started", thread_id: "x" }),
    JSON.stringify({ type: "item.completed", item: { type: "reasoning", text: "thinking" } }),
    JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify(verdict) } }),
    JSON.stringify({ type: "turn.completed", usage: {} }),
  ].join("\n");
  assert.equal(unwrapCodexJsonl(jsonl), JSON.stringify(verdict));
  assert.equal(parseExecutorJson(unwrapCodexJsonl(jsonl), reviewVerdictProblems).ok, true);
  assert.equal(unwrapCodexJsonl("plain text"), "plain text");
  assert.equal(unwrapCodexJsonl(JSON.stringify(verdict)), JSON.stringify(verdict));
});
