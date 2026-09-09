import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  CROSS_REVIEW_VERSION,
  DEFAULT_MAX_REVISIONS,
  MAX_REVISIONS,
  MAX_SUPERSESSIONS,
  PREFLIGHT_RECORD_VERSION,
  authorOutputProblems,
  escapesRepository,
  filesNamedByDiff,
  inheritedFindings,
  isActionable,
  judgePreflight,
  lineageOf,
  normalizeRepoPath,
  packageExclusionProblems,
  parseExecutorJson,
  preflightGate,
  preflightReportProblems,
  renderPreflightPrompt,
  renderReviewPrompt,
  replayExchange,
  resolveMaxRevisions,
  reviewVerdictProblems,
  runCrossReview,
  supersessionProblems,
  writeRefusalEvidence,
  writeRefusalObservedIn,
} from "../lib/crossReviewCore.ts";
import {
  CLI_INVOCATIONS,
  REVIEWER_CONFIG_OVERRIDE_KEYS,
  approveCurrent,
  cliAuthor,
  cliCommandLine,
  cliReviewer,
  extractUsage,
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
const guardPass = (rule = "npm run lint") => [{ rule, passed: true, detail: "no problems", durationMs: 1 }];
const guardFail = (rule = "protected files", detail = "tests/protected.test.mjs was modified") => [{ rule, passed: false, detail, durationMs: 1 }];

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
  guards: async () => guardPass(),
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
    control({ author, reviewer, guards: async () => guardFail(), maxRevisions: 1 })
  );
  assert.equal(outcome.status, "on_hold");
  assert.equal(outcome.holdReason, "approved_but_checks_failed");
  assert.deepEqual(author.calls[1].feedback.guardViolations, ["protected files: tests/protected.test.mjs was modified"]);
  assert.deepEqual(author.calls[1].feedback.checkFailures, ["guard failed: protected files"]);
});

test("a finding without a reproduction never forces a revision, whatever its basis; the current version stands with it recorded", async () => {
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
          // "evidence" is a label; without the reproduction that would let
          // anyone check it, it is a claim like any other.
          finding({ basis: "evidence", severity: "error", claim: "this is wrong, trust me", reproduction: undefined }),
          finding({ basis: "evidence", severity: "error", claim: "this is wrong, trust me", reproduction: "   " }),
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
    ["resolved_by_project_rule", "insufficient_evidence_kept_current", "insufficient_evidence_kept_current", "insufficient_evidence_kept_current"]
  );
  assert.equal(isActionable(finding({ basis: "judgement", reproduction: "node -e 1" })), true);
  assert.equal(isActionable(finding({ basis: "judgement", reproduction: undefined })), false);
  assert.equal(isActionable(finding({ basis: "evidence", reproduction: "node -e 1" })), true);
  assert.equal(isActionable(finding({ basis: "evidence", reproduction: undefined })), false);
  assert.equal(isActionable(finding({ basis: "preference", reproduction: "node -e 1" })), false);
  // The schema still admits the finding -- a verdict is not thrown away for
  // a missing field -- and the prompt says what the field is for.
  assert.equal(reviewVerdictProblems({ taskId: "T-1", round: 0, reviewedDigest: "d", conclusion: "approve", findings: [finding({ basis: "evidence", reproduction: undefined })], nextAction: "" }).length, 0);
  assert.match(renderReviewPrompt({ task, round: 0, changeDigest: "d", commit: null, diff: "", testResults: [], guardRuns: [], guardViolations: [], authorSummary: "s", authorSelfAssessment: null, previousFindings: [] }), /acted on only with a reproduction/);
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

test("the reviewer's command-line invocation offers no write tool and nothing from the user's configuration", () => {
  for (const id of Object.keys(CLI_INVOCATIONS)) {
    const args = CLI_INVOCATIONS[id].reviewer.args.join(" ");
    assert.ok(!/Edit|Write|workspace-write|acceptEdits|danger-full-access|bypass/.test(args), `${id} reviewer: ${args}`);
  }
  // codex-cli 0.146.0: the sandbox flag, headless `exec`, and the user layer of
  // config.toml -- where MCP servers, plugins and hooks come from -- left out.
  const codex = CLI_INVOCATIONS.codex.reviewer;
  assert.deepEqual(codex.args.slice(0, 3), ["--sandbox", "read-only", "exec"]);
  assert.ok(codex.args.includes("--ignore-user-config"));
  assert.ok(codex.args.includes("--json"));
  assert.equal(codex.promptArg, "-");
  assert.equal(codex.configFlag, "-c");
  // Claude Code 2.1.261: only the read tools are built in, they are pre-approved,
  // and no MCP server is loaded.
  const claude = CLI_INVOCATIONS.claude.reviewer;
  const toolsAt = claude.args.indexOf("--tools");
  assert.ok(toolsAt !== -1);
  assert.deepEqual(claude.args[toolsAt + 1].split(","), ["Read", "Grep", "Glob"]);
  assert.ok(claude.args.includes("--strict-mcp-config"));
  // The user's, project's and local customisations -- hooks above all, which
  // run with the user's full permissions -- do not load. `--safe-mode` keeps
  // the stored login; `--bare` would not, so it is not the flag used.
  assert.ok(claude.args.includes("--safe-mode"));
  assert.ok(!claude.args.includes("--bare"));
  assert.equal(claude.configFlag, undefined);
  // The author keeps its write scope; that is its job.
  assert.ok(CLI_INVOCATIONS.codex.author.args.includes("workspace-write"));
});

test("a reviewer run may only override the keys on the allow list, and overrides go before the stdin marker", async () => {
  const codex = CLI_INVOCATIONS.codex.reviewer;
  const allowed = cliCommandLine(codex, ['model="m"', 'windows.sandbox="elevated"'], REVIEWER_CONFIG_OVERRIDE_KEYS);
  assert.equal(allowed.ok, true);
  assert.deepEqual(allowed.args.slice(-5), ["-c", 'model="m"', "-c", 'windows.sandbox="elevated"', "-"]);
  assert.deepEqual(cliCommandLine(codex).args, [...codex.args, "-"]);
  for (const widening of ['sandbox_mode="danger-full-access"', 'approval_policy="never"', "mcp_servers.x.command=\"y\"", "features.hooks=true", "plugins.x.enabled=true"]) {
    const refused = cliCommandLine(codex, [widening], REVIEWER_CONFIG_OVERRIDE_KEYS);
    assert.equal(refused.ok, false, widening);
    assert.match(refused.detail, /not allowed/);
  }
  assert.equal(cliCommandLine(codex, ["nonsense"], REVIEWER_CONFIG_OVERRIDE_KEYS).ok, false);
  // A tool without a config flag refuses overrides outright.
  assert.equal(cliCommandLine(CLI_INVOCATIONS.claude.reviewer, ['model="m"']).ok, false);
  for (const key of REVIEWER_CONFIG_OVERRIDE_KEYS) {
    assert.ok(!/sandbox_mode|approval|mcp|plugin|feature|shell_environment/.test(key), key);
  }

  // Through the executor: a widening override is refused before anything runs,
  // in dry-run and in live mode alike; an allowed one reaches the spawner in order.
  const request = { task, round: 0, changeDigest: "sha256:a", commit: null, diff: "", testResults: [], guardRuns: [], guardViolations: [], authorSummary: "s", authorSelfAssessment: null, previousFindings: [] };
  const base = { id: "codex", invocation: codex, cwd: "/nowhere", timeoutMs: 10 };
  const throwing = async () => {
    throw new Error("spawn must not be called");
  };
  const refusedDry = await cliReviewer({ ...base, mode: "dry-run", spawn: throwing, configOverrides: ['sandbox_mode="danger-full-access"'] }).review(request);
  assert.equal(refusedDry.failure, "execution_failed");
  const refusedLive = await cliReviewer({ ...base, mode: "live", spawn: throwing, configOverrides: ['sandbox_mode="danger-full-access"'] }).review(request);
  assert.equal(refusedLive.failure, "execution_failed");
  const dry = await cliReviewer({ ...base, mode: "dry-run", spawn: throwing, configOverrides: ['model="m"'] }).review(request);
  assert.equal(dry.failure, "not_executed");
  assert.match(dry.detail, /codex --sandbox read-only exec --ignore-user-config --json -c model="m" -/);
  const seen = [];
  const verdict = { taskId: "T-1", round: 0, reviewedDigest: "sha256:a", conclusion: "approve", findings: [], nextAction: "ok" };
  const live = await cliReviewer({
    ...base,
    mode: "live",
    configOverrides: ['model="m"'],
    env: { OPENAI_API_KEY: undefined },
    spawn: async (command, args, options) => {
      seen.push({ command, args, env: options.env });
      return { status: 0, stdout: JSON.stringify({ type: "item.completed", item: { id: "item_1", type: "agent_message", text: JSON.stringify(verdict) } }), stderr: "" };
    },
  }).review(request);
  assert.equal(live.ok, true);
  assert.equal(seen[0].command, "codex");
  assert.deepEqual(seen[0].args, [...codex.args, "-c", 'model="m"', "-"]);
  assert.deepEqual(seen[0].env, { OPENAI_API_KEY: undefined });
});

test("Codex JSONL output is unwrapped to its final agent message; anything else passes through", async () => {
  const { unwrapCodexJsonl } = await import("../lib/crossReviewExecutors.ts");
  const verdict = { taskId: "T-1", round: 0, reviewedDigest: "sha256:a", conclusion: "approve", findings: [], nextAction: "ok" };
  // The shape `codex exec --json` prints at rust-v0.146.0 (exec_events.rs):
  // events tagged by `type`, items tagged by `type` with an `id`, and the
  // agent's message in `text`.
  const jsonl = [
    JSON.stringify({ type: "thread.started", thread_id: "0199c3b2-1f2e-7d5a-9b1c-3f4e5d6a7b8c" }),
    JSON.stringify({ type: "turn.started" }),
    JSON.stringify({ type: "item.started", item: { id: "item_0", type: "command_execution", command: "git status", aggregated_output: "", status: "in_progress" } }),
    JSON.stringify({ type: "item.completed", item: { id: "item_0", type: "command_execution", command: "git status", aggregated_output: "clean", exit_code: 0, status: "completed" } }),
    JSON.stringify({ type: "item.completed", item: { id: "item_1", type: "reasoning", text: "thinking" } }),
    JSON.stringify({ type: "item.completed", item: { id: "item_2", type: "agent_message", text: "draft" } }),
    JSON.stringify({ type: "item.completed", item: { id: "item_3", type: "agent_message", text: JSON.stringify(verdict) } }),
    JSON.stringify({ type: "turn.completed", usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 } }),
  ].join("\n");
  assert.equal(unwrapCodexJsonl(jsonl), JSON.stringify(verdict));
  assert.equal(parseExecutorJson(unwrapCodexJsonl(jsonl), reviewVerdictProblems).ok, true);
  // The older core-protocol shape.
  const legacy = [JSON.stringify({ id: "1", msg: { type: "agent_message", message: JSON.stringify(verdict) } }), JSON.stringify({ id: "2", msg: { type: "task_complete" } })].join("\n");
  assert.equal(unwrapCodexJsonl(legacy), JSON.stringify(verdict));
  // A failed turn has no agent message: the output passes through and is a named failure downstream.
  const failed = [JSON.stringify({ type: "thread.started", thread_id: "x" }), JSON.stringify({ type: "turn.failed", error: { message: "rate limited" } })].join("\n");
  assert.equal(unwrapCodexJsonl(failed), failed);
  assert.equal(parseExecutorJson(unwrapCodexJsonl(failed), reviewVerdictProblems).failure, "schema_mismatch");
  assert.equal(unwrapCodexJsonl("plain text"), "plain text");
  assert.equal(unwrapCodexJsonl(JSON.stringify(verdict)), JSON.stringify(verdict));
});

test("usage is read from whichever shape the tool prints, and is null when it printed neither", () => {
  const codex = [
    JSON.stringify({ type: "thread.started", thread_id: "x" }),
    JSON.stringify({ type: "item.completed", item: { id: "item_0", type: "agent_message", text: "{}" } }),
    JSON.stringify({ type: "turn.completed", usage: { input_tokens: 81177, cached_input_tokens: 80128, cache_write_input_tokens: 0, output_tokens: 373, reasoning_output_tokens: 105 } }),
  ].join("\n");
  assert.deepEqual(extractUsage(codex), {
    tool: "codex",
    inputTokens: 81177,
    cachedInputTokens: 80128,
    outputTokens: 373,
    reasoningOutputTokens: 105,
    totalCostUsd: null,
    raw: { input_tokens: 81177, cached_input_tokens: 80128, cache_write_input_tokens: 0, output_tokens: 373, reasoning_output_tokens: 105 },
  });
  // Claude Code's --output-format json envelope carries usage and a cost estimate.
  const claude = JSON.stringify({
    type: "result",
    subtype: "success",
    result: "{}",
    session_id: "s",
    total_cost_usd: 0.0123,
    usage: { input_tokens: 10, cache_creation_input_tokens: 2, cache_read_input_tokens: 5, output_tokens: 7 },
  });
  assert.deepEqual(extractUsage(claude), {
    tool: "claude",
    inputTokens: 10,
    cachedInputTokens: 5,
    outputTokens: 7,
    reasoningOutputTokens: null,
    totalCostUsd: 0.0123,
    raw: { input_tokens: 10, cache_creation_input_tokens: 2, cache_read_input_tokens: 5, output_tokens: 7 },
  });
  assert.equal(extractUsage(JSON.stringify({ type: "result", result: "{}" })), null, "an envelope without usage reports none");
  assert.equal(extractUsage("plain text"), null);
  assert.equal(extractUsage(""), null);
  assert.equal(extractUsage(JSON.stringify({ type: "thread.started", thread_id: "x" })), null, "a stream with no completed turn reports none");
});

test("nothing run is a failed check: no test, or no guard, and an approval is not a pass", async () => {
  // No test was run: an empty list is not a passing one.
  const noTests = await runCrossReview(
    control({
      author: mockAuthor("claude", [change(0)]),
      reviewer: mockReviewer("codex", [approveCurrent("T-1", 0)]),
      runTests: async () => [],
    })
  );
  assert.notEqual(noTests.status, "passed");
  assert.deepEqual(noTests.exchange.rounds[0].checkFailures, ["no test was run"]);
  assert.match(noTests.exchange.rounds[0].nextAction, /no test was run/);
  // No guard was run: a guards function that ran nothing is the same as none
  // at all. What counts is a rule that ran and is on record.
  for (const guards of [undefined, async () => []]) {
    const noGuards = await runCrossReview(
      control({
        author: mockAuthor("claude", [change(0)]),
        reviewer: mockReviewer("codex", [approveCurrent("T-1", 0)]),
        guards,
      })
    );
    assert.notEqual(noGuards.status, "passed");
    assert.deepEqual(noGuards.exchange.rounds[0].checkFailures, ["no guard was run"]);
    assert.deepEqual(noGuards.exchange.rounds[0].guardRuns, []);
  }
  // A guard that ran and failed is recorded as such, and the reviewer sees the run.
  const failedGuard = await runCrossReview(
    control({
      author: mockAuthor("claude", [change(0)]),
      reviewer: mockReviewer("codex", [approveCurrent("T-1", 0)]),
      guards: async () => [...guardPass(), ...guardFail("npm run check:x", "1 problem")],
    })
  );
  assert.notEqual(failedGuard.status, "passed");
  assert.deepEqual(failedGuard.exchange.rounds[0].checkFailures, ["guard failed: npm run check:x"]);
  assert.deepEqual(failedGuard.exchange.rounds[0].guardViolations, ["npm run check:x: 1 problem"]);
  assert.equal(failedGuard.exchange.rounds[0].guardRuns.length, 2);
  // The author hears every reason in its feedback, not just failed tests.
  const author = mockAuthor("claude", [change(0), change(1)]);
  const fed = await runCrossReview(
    control({ author, reviewer: mockReviewer("codex", [approveCurrent("T-1", 0), approveCurrent("T-1", 1)]), runTests: async () => [] })
  );
  assert.notEqual(fed.status, "passed");
  assert.deepEqual(author.calls[1].feedback.checkFailures, ["no test was run"]);
  // With one passing test and a guard consulted, the same approval passes.
  const ok = await runCrossReview(
    control({ author: mockAuthor("claude", [change(0)]), reviewer: mockReviewer("codex", [approveCurrent("T-1", 0)]) })
  );
  assert.equal(ok.status, "passed");
  assert.deepEqual(ok.exchange.checkFailures, []);
});

test("the diff is read for the files it names: an unreported file is a failed check, an out-of-scope one is refused before review", async () => {
  const twoFiles =
    "diff --git a/lib/sum.ts b/lib/sum.ts\n--- a/lib/sum.ts\n+++ b/lib/sum.ts\n+1\n" +
    "diff --git a/lib/other.ts b/lib/other.ts\n--- a/lib/other.ts\n+++ b/lib/other.ts\n+2\n";
  assert.deepEqual(filesNamedByDiff(twoFiles), ["lib/sum.ts", "lib/other.ts"]);
  assert.deepEqual(filesNamedByDiff("--- a/x.ts\n+++ b/x.ts\n+1\n--- a/gone.ts\n+++ /dev/null\n-1\n"), ["x.ts", "gone.ts"]);
  assert.deepEqual(filesNamedByDiff(""), []);
  // Reported one file, changed two: the second is a guard violation and the
  // approval does not pass.
  const underReported = await runCrossReview(
    control({
      author: mockAuthor("claude", [change(0, { diff: twoFiles, filesChanged: ["lib/sum.ts"] })]),
      reviewer: mockReviewer("codex", [approveCurrent("T-1", 0)]),
    })
  );
  assert.notEqual(underReported.status, "passed");
  assert.deepEqual(underReported.exchange.rounds[0].guardViolations, ["the diff names lib/other.ts, which filesChanged does not"]);
  // Reported nothing outside the scope, but the diff touches app/: refused.
  const outOfScope = await runCrossReview(
    control({
      author: mockAuthor("claude", [
        change(0, { diff: "diff --git a/app/route.ts b/app/route.ts\n--- a/app/route.ts\n+++ b/app/route.ts\n+1\n", filesChanged: ["lib/sum.ts"] }),
      ]),
      reviewer: mockReviewer("codex", [approveCurrent("T-1", 0)]),
    })
  );
  assert.equal(outOfScope.status, "failed");
  assert.equal(outOfScope.failure, "scope_violation");
  assert.deepEqual(outOfScope.exchange.rounds[0].guardViolations, ["outside writable scope: app/route.ts"]);
});

test("a person-driven exchange replays through the control program: waiting states are where a stand-in had nothing to say, and a concluded exchange takes no further round", async () => {
  const packaged = (round, verdict = null, overrides = {}) => ({
    round,
    diff: change(round).value.diff,
    summary: `round ${round}`,
    filesChanged: ["lib/sum.ts"],
    commit: null,
    testResults: pass(),
    guardRuns: guardPass(),
    verdict,
    ...overrides,
  });
  const verdictOn = (round, conclusion, findings = []) => ({
    taskId: "T-1",
    round,
    reviewedDigest: digest(change(round).value.diff),
    conclusion,
    findings,
    nextAction: "next",
  });
  const replay = (rounds) => replayExchange({ task, digest, rounds, now: () => new Date("2026-09-09T00:00:00Z") });

  // A package with no verdict yet.
  const waiting = await replay([packaged(0)]);
  assert.equal(waiting.status, "awaiting_review");
  assert.equal(waiting.failure, null);
  assert.equal(waiting.concludedAtRound, null);
  assert.equal(waiting.packagedRounds, 1);
  assert.match(waiting.nextAction, new RegExp(digest(change(0).value.diff)));
  assert.equal(waiting.rounds[0].nextAction, "awaiting the reviewer's verdict");

  // A verdict with an actionable finding: the control program asked for a
  // revision nobody has made.
  const revising = await replay([packaged(0, verdictOn(0, "request_changes", [finding()]))]);
  assert.equal(revising.status, "awaiting_revision");
  assert.equal(revising.rounds.length, 1);
  assert.equal(revising.findings[0].disposition, "fix_requested");
  assert.match(revising.nextAction, /package round 1/);

  // The revision, packaged and approved with passing checks: passed, and
  // concluded at round 1.
  const done = await replay([packaged(0, verdictOn(0, "request_changes", [finding()])), packaged(1, verdictOn(1, "approve"))]);
  assert.equal(done.status, "passed");
  assert.equal(done.concludedAtRound, 1);

  // A package after the conclusion is not part of the exchange.
  const extra = await replay([packaged(0, verdictOn(0, "approve"))]);
  assert.equal(extra.status, "passed");
  assert.equal(extra.concludedAtRound, 0);
  const afterPass = await replay([packaged(0, verdictOn(0, "approve")), packaged(1)]);
  assert.equal(afterPass.status, "passed");
  assert.equal(afterPass.concludedAtRound, 0);
  assert.equal(afterPass.rounds.length, 1);

  // An approval with failing checks in the last allowed round: on hold, not awaiting.
  const held = await replay([
    packaged(0, verdictOn(0, "request_changes", [finding()])),
    packaged(1, verdictOn(1, "request_changes", [finding()])),
    packaged(2, verdictOn(2, "approve"), { testResults: fail() }),
  ]);
  assert.equal(held.status, "on_hold");
  assert.equal(held.holdReason, "approved_but_checks_failed");
  assert.equal(held.concludedAtRound, 2);

  // A verdict on the wrong digest is the control program's own failure.
  const wrong = await replay([packaged(0, { ...verdictOn(0, "approve"), reviewedDigest: "sha256:other" })]);
  assert.equal(wrong.status, "failed");
  assert.equal(wrong.failure, "digest_mismatch");
  assert.equal(wrong.concludedAtRound, 0);

  // Rounds must be contiguous from 0.
  await assert.rejects(() => replay([packaged(1)]), /contiguous/);
  await assert.rejects(() => replay([]), /nothing to replay/);
});

test("a reproducible finding named alongside an approval is never passed over: fixed with a revision left, on hold without one", async () => {
  // Last allowed round (cap 0): approve, checks pass, one finding with a
  // reproduction. Not a pass -- the reviewer named an error, and nothing can
  // fix it now.
  const approveWithFinding = (round) => ({
    ok: true,
    value: { taskId: "T-1", round, reviewedDigest: "@current", conclusion: "approve", findings: [finding()], nextAction: "merge anyway" },
  });
  const held = await runCrossReview(control({ author: mockAuthor("claude", [change(0)]), reviewer: mockReviewer("codex", [approveWithFinding(0)]), maxRevisions: 0 }));
  assert.equal(held.status, "on_hold");
  assert.equal(held.holdReason, "revisions_exhausted");
  assert.deepEqual(held.exchange.findings.map((f) => f.disposition), ["unresolved_on_hold"]);
  assert.match(held.exchange.rounds[0].nextAction, /open finding/);
  // With a revision left the same approval sends the finding back, and the
  // fix is reviewed on its own digest.
  const author = mockAuthor("claude", [change(0), change(1)]);
  const fixed = await runCrossReview(
    control({ author, reviewer: mockReviewer("codex", [approveWithFinding(0), approveCurrent("T-1", 1)]), maxRevisions: 1 })
  );
  assert.equal(fixed.status, "passed");
  assert.equal(author.calls.length, 2);
  assert.deepEqual(author.calls[1].feedback.findings.map((f) => f.disposition), ["fix_requested"]);
  // An approval with a preference-only finding in the last round still passes.
  const preference = await runCrossReview(
    control({
      author: mockAuthor("claude", [change(0)]),
      reviewer: mockReviewer("codex", [
        { ok: true, value: { taskId: "T-1", round: 0, reviewedDigest: "@current", conclusion: "approve", findings: [finding({ basis: "preference", reproduction: undefined })], nextAction: "ok" } },
      ]),
      maxRevisions: 0,
    })
  );
  assert.equal(preference.status, "passed");
});

test("the revision cap is fixed at two: a run may lower it and cannot raise it", async () => {
  assert.equal(MAX_REVISIONS, 2);
  assert.equal(DEFAULT_MAX_REVISIONS, MAX_REVISIONS);
  assert.equal(resolveMaxRevisions(undefined), 2);
  assert.equal(resolveMaxRevisions(0), 0);
  assert.equal(resolveMaxRevisions(2), 2);
  for (const bad of [3, 10, -1, 1.5, Number.NaN]) assert.throws(() => resolveMaxRevisions(bad), RangeError);
  const requestChanges = (round) => ({
    ok: true,
    value: { taskId: "T-1", round, reviewedDigest: "@current", conclusion: "request_changes", findings: [finding()], nextAction: "fix" },
  });
  const author = mockAuthor("claude", [change(0), change(1), change(2), change(3)]);
  await assert.rejects(
    () => runCrossReview(control({ author, reviewer: mockReviewer("codex", [0, 1, 2, 3].map(requestChanges)), maxRevisions: 3 })),
    RangeError
  );
  assert.equal(author.calls.length, 0, "nothing ran under a cap above the fixed one");
  const capped = await runCrossReview(control({ author, reviewer: mockReviewer("codex", [0, 1, 2, 3].map(requestChanges)) }));
  assert.equal(capped.status, "on_hold");
  assert.equal(capped.holdReason, "revisions_exhausted");
  assert.equal(author.calls.length, 3, "the first review and two fix rounds, and no more");
  await assert.rejects(
    () => replayExchange({ task, digest, maxRevisions: 3, rounds: [{ round: 0, diff: "d", summary: "s", filesChanged: ["lib/sum.ts"], commit: null, testResults: pass(), guardRuns: guardPass(), verdict: null }] }),
    RangeError
  );
});

test("a package may exclude exactly the task's generated paths and exactly its own directory, never a scoped source, a parent of one, a parent or a child of the package, or a path resolved elsewhere", () => {
  const generatedPaths = ["docs/ops/report/out.md", "docs/ops/report/out.summary.json"];
  const outDir = "docs/ops/cross-review/packages/demo";
  const writableScope = ["lib/sum.ts", "lib/other/", "docs/ops/report/", "docs/ops/cross-review/"];
  const problemsOf = (excluded, overrides = {}) => packageExclusionProblems({ excluded, generatedPaths, outDir, writableScope, ...overrides });
  const ok = (excluded, overrides) => assert.deepEqual(problemsOf(excluded, overrides), [], excluded.join());
  ok([]);
  ok(["docs/ops/report/out.md"]);
  ok(["docs/ops/report/out.md", "docs/ops/report/out.summary.json"]);
  ok([outDir]);
  ok([`${outDir}/`]);
  // Spelling does not matter: the check, the digest and git all see one path.
  ok(["docs\\ops\\cross-review\\packages\\demo\\"]);
  ok(["docs\\ops\\report\\out.md"]);
  ok(["./docs/ops/report/out.md"]);
  ok([`${outDir}/../demo`]);
  ok([`${outDir}/../../../report/out.md`], "resolved, this is a generated path");
  const refused = (excluded, pattern, overrides) => {
    const problems = problemsOf(excluded, overrides);
    assert.equal(problems.length, 1, excluded.join());
    assert.match(problems[0], pattern);
  };
  // A scoped source, or a path that contains one, is never excluded --
  // whether it is named as a generated path, as the package directory, or
  // as anything else.
  refused(["lib/sum.ts"], /writable scope entry lib\/sum\.ts/);
  refused(["lib"], /writable scope entry lib\/sum\.ts, lib\/other/);
  refused(["."], /writable scope entry/);
  refused(["docs/ops/cross-review"], /writable scope entry docs\/ops\/cross-review/);
  refused(["docs/ops/report/"], /writable scope entry docs\/ops\/report/);
  refused(["lib/sum.ts"], /writable scope entry/, { generatedPaths: ["lib/sum.ts"] });
  // `--out=. --diff-exclude=.`, and anything "under" such a package directory.
  refused(["."], /writable scope entry/, { outDir: "." });
  refused(["lib/x.ts"], /is under the package directory \./, { outDir: "." });
  refused(["docs/x"], /is under the package directory docs/, { outDir: "docs" });
  // The allow list is exact: a file under the package directory is refused
  // too -- the directory itself is what may be excluded.
  refused([`${outDir}/verdict-round0.json`], /is under the package directory .*; exclude the package directory itself, not a file under it/);
  // A parent of the package directory that contains no scope entry is still
  // refused for what it would hide beside the package.
  refused(["docs/ops/cross-review/packages"], /contains the package directory/, { writableScope: ["lib/sum.ts"] });
  refused(["docs/ops"], /contains the package directory/, { writableScope: ["lib/sum.ts"] });
  // A source file outside the scope, or generated files not declared as such.
  refused(["lib/z.ts"], /not one of the task's generatedPaths/);
  refused(["docs/ops/report/other.md"], /not one of the task's generatedPaths/);
  // The reviewer's reproduction from round 1: `..` written under the package
  // directory resolves to a file beside it that nothing declared. It is
  // checked as what it resolves to, and refused -- git would otherwise have
  // been handed the traversal and dropped the README from the diff.
  refused(["docs/ops/cross-review/packages/demo/../../README.md"], /not one of the task's generatedPaths/, { generatedPaths: [], writableScope: ["docs/ops/cross-review/"] });
  refused([`${outDir}/../../README.md`], /not one of the task's generatedPaths/);
  refused([`${outDir}/../..`], /writable scope entry docs\/ops\/cross-review/);
  refused([`${outDir}/../../../..`], /writable scope entry/);
  // Above the repository is not a place anything can be excluded from.
  refused(["../elsewhere"], /climbs above the repository/);
  refused([`${outDir}/../../../../../../etc`], /climbs above the repository/);
  refused([".."], /climbs above the repository/);
  // A task with no scope may write anywhere, so its scope is the root.
  refused(["."], /writable scope entry \./, { writableScope: [] });
  ok([outDir], { writableScope: [] });
  // Every offending path is named, not just the first.
  assert.equal(problemsOf(["lib/z.ts", "docs/ops"]).length, 2);
});

test("normalizeRepoPath gives one spelling to a repository path, `..` resolved, and says when a path climbs above the repository", () => {
  assert.equal(normalizeRepoPath("docs\\ops\\x.md"), "docs/ops/x.md");
  assert.equal(normalizeRepoPath("./docs/ops/"), "docs/ops");
  assert.equal(normalizeRepoPath("  docs/ops//  "), "docs/ops");
  assert.equal(normalizeRepoPath("."), ".");
  assert.equal(normalizeRepoPath(""), ".");
  assert.equal(normalizeRepoPath("docs/ops/../x.md"), "docs/x.md");
  assert.equal(normalizeRepoPath("docs/ops/./../ops/x.md"), "docs/ops/x.md");
  assert.equal(normalizeRepoPath("docs/.."), ".");
  assert.equal(normalizeRepoPath("docs/../../x"), "../x");
  assert.equal(normalizeRepoPath(".."), "..");
  assert.equal(normalizeRepoPath("../a/.."), "..");
  assert.equal(normalizeRepoPath("../../a"), "../../a");
  for (const escaped of ["..", "../x", "../../a"]) assert.equal(escapesRepository(normalizeRepoPath(escaped)), true, escaped);
  for (const inside of [".", "docs", "docs/..", "docs/ops/../x.md", "..a", "a.."]) assert.equal(escapesRepository(normalizeRepoPath(inside)), false, inside);
});

test("a task continues only a concluded exchange, inherits what it left open, and the chain is capped", () => {
  const open = (overrides = {}) => ({ ...finding(), disposition: "unresolved_on_hold", ...overrides });
  const prior = {
    taskId: "T-0",
    status: "on_hold",
    findings: [
      open(),
      open({ location: "b", basis: "preference", reproduction: undefined, disposition: "resolved_by_project_rule" }),
      open({ location: "c", disposition: "fix_requested" }),
    ],
  };
  const continuing = { ...task, taskId: "T-1", supersedes: { taskId: "T-0", exchange: "packages/t0/exchange.json" } };
  assert.deepEqual(supersessionProblems(task, prior), [], "a task without supersedes has nothing to check");
  assert.deepEqual(supersessionProblems(continuing, prior), []);
  assert.deepEqual(supersessionProblems(continuing, null), ["packages/t0/exchange.json could not be read"]);
  assert.match(supersessionProblems(continuing, { ...prior, taskId: "T-9" })[0], /is T-9, not T-0/);
  for (const status of ["passed", "awaiting_review", "awaiting_revision"]) {
    assert.match(supersessionProblems(continuing, { ...prior, status })[0], /only an exchange on hold or failed/);
  }
  assert.deepEqual(supersessionProblems(continuing, { ...prior, status: "failed" }), []);
  // The findings it inherits are the open ones, as plain findings the
  // reviewer of round 0 is shown; a preference already settled is not.
  assert.deepEqual(
    inheritedFindings(prior).map((f) => [f.location, "disposition" in f]),
    [["lib/sum.ts:1", false], ["c", false]]
  );
  // Lineage: the prior's, then the prior. Two continuations are the cap.
  assert.deepEqual(lineageOf(prior), ["T-0"]);
  assert.deepEqual(lineageOf({ ...prior, lineage: ["T-a"] }), ["T-a", "T-0"]);
  assert.equal(MAX_SUPERSESSIONS, 2);
  assert.deepEqual(supersessionProblems(continuing, { ...prior, lineage: ["T-a"] }), []);
  assert.match(supersessionProblems(continuing, { ...prior, lineage: ["T-a", "T-b"] })[0], /the cap is 2/);
});

test("the preflight asks for a read and a write, and passes only on the read the control program expects and a write that did not land", () => {
  const prompt = renderPreflightPrompt({ readCommand: "git rev-parse HEAD", probePath: "out/probe.txt" });
  assert.match(prompt, /This is not a review/);
  assert.match(prompt, /git rev-parse HEAD/);
  assert.match(prompt, /out\/probe\.txt/);
  assert.match(prompt, /do not retry/);
  // The write is asked for as one shell command naming the path, so the
  // tool's record of the attempt carries the path; a patch tool's refusal
  // would not.
  assert.match(prompt, /ONE shell command that names that exact path/);
  assert.match(prompt, /Set-Content -LiteralPath 'out\/probe\.txt' -Value probe/);
  assert.match(prompt, /printf probe > 'out\/probe\.txt'/);
  assert.match(prompt, /not a patch or file-editing tool/);
  assert.deepEqual(preflightReportProblems({ readOutput: "abc", writeAttempted: true, writeResult: "denied" }), []);
  assert.ok(preflightReportProblems({ readOutput: 1, writeAttempted: "yes" }).length >= 3);
  assert.ok(preflightReportProblems("nope").length >= 1);
  const report = { readOutput: "abc123\n", writeAttempted: true, writeResult: "EACCES: permission denied" };
  const judge = (overrides = {}) => judgePreflight({ report, expectedReadOutput: "abc123", probeExists: false, writeRefusalObserved: true, ...overrides });
  assert.deepEqual(judge(), { passed: true, problems: [] });
  // The reviewer's own account of the write is not the evidence; the file
  // is, and so is the tool's own output showing the refusal.
  const landed = judge({ report: { ...report, writeResult: "denied" }, probeExists: true });
  assert.equal(landed.passed, false);
  assert.match(landed.problems[0], /write probe landed/);
  const unobserved = judge({ writeRefusalObserved: false });
  assert.equal(unobserved.passed, false);
  assert.match(unobserved.problems[0], /shows no refused write/);
  // A report that says the write was done fails even with no probe: it went
  // somewhere else, or it is not describing what happened.
  for (const claim of ["written", "File created successfully", "wrote 5 bytes", "success"]) {
    const done = judge({ report: { ...report, writeResult: claim } });
    assert.equal(done.passed, false, claim);
    assert.match(done.problems[0], /reports the write as done/);
  }
  // A read that produced something else (an error, a refusal) fails.
  const blind = judge({ report: { ...report, readOutput: "execution error: sandbox refused" } });
  assert.equal(blind.passed, false);
  assert.match(blind.problems[0], /did not produce the expected output/);
  // A write never attempted shows nothing about writes.
  assert.equal(judge({ report: { ...report, writeAttempted: false } }).passed, false);
  assert.equal(judge({ expectedReadOutput: "  " }).passed, false);

  // What counts as the tool's own evidence of a refused write: a refusal
  // the tool reported *at the probe path*, in either spelling. Anything
  // that names no path, or another path, shows something else was refused.
  const probe = "docs/ops/pkg/preflight-write-probe-2026-09-09T10-52-47-175Z.txt";
  const item = (type, fields) => JSON.stringify({ type: "item.completed", item: { id: "i", type, ...fields } });
  const deniedAt = (path) =>
    item("command_execution", {
      command: `"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command 'Set-Content -LiteralPath ''${path}'' -Value probe'`,
      aggregated_output: `Set-Content : Access to the path '${path}' is denied.\nAt line:1 char:1`,
      exit_code: 1,
      status: "failed",
    });
  assert.match(writeRefusalEvidence(deniedAt(probe), "", probe), /^command_execution .*Access to the path .* is denied/);
  assert.equal(writeRefusalObservedIn(deniedAt(probe), "", probe), true);
  assert.equal(writeRefusalObservedIn(deniedAt(`H:\\Project\\repo\\${probe.replace(/\//g, "\\")}`), "", probe), true, "an absolute Windows spelling names the same probe");
  assert.equal(writeRefusalObservedIn(item("command_execution", { command: `printf probe > '${probe}'`, aggregated_output: `sh: ${probe}: Read-only file system`, exit_code: 1, status: "failed" }), "", probe), true);
  // The reviewer's reproduction from round 1: a denial of some other file
  // is not evidence about the probe, and the preflight fails on it.
  const other = item("command_execution", { command: "Set-Content other.txt", aggregated_output: "Access is denied", status: "failed" });
  assert.equal(writeRefusalEvidence(other, "", probe), null);
  const onOther = judgePreflight({
    report: { readOutput: "abc", writeAttempted: true, writeResult: "denied" },
    expectedReadOutput: "abc",
    probeExists: false,
    writeRefusalObserved: writeRefusalObservedIn(other, "", probe),
  });
  assert.equal(onOther.passed, false);
  assert.match(onOther.problems[0], /no refused write at the probe path/);
  // Codex's own "patch rejected" line names no path: something was refused,
  // not shown to be the probe. A stderr line that names the probe counts.
  assert.equal(writeRefusalObservedIn("", "2026-09-09T10:53:04Z ERROR codex_core::tools::router: error=patch rejected: writing is blocked by read-only sandbox", probe), false);
  assert.match(writeRefusalEvidence("", `error: cannot write ${probe}: permission denied`, probe), /^stderr: /);
  assert.equal(writeRefusalObservedIn(item("error", { message: `patch rejected: ${probe}: writing is blocked by read-only sandbox` }), "", probe), true);
  assert.equal(writeRefusalObservedIn(item("error", { message: "patch rejected: writing is blocked by read-only sandbox" }), "", probe), false);
  assert.equal(writeRefusalObservedIn(item("file_change", { status: "failed", changes: [{ path: probe, kind: "add" }] }), "", probe), true);
  assert.equal(writeRefusalObservedIn(item("file_change", { status: "failed", changes: [{ path: "other.txt", kind: "add" }] }), "", probe), false);
  assert.equal(writeRefusalObservedIn(item("file_change", { status: "completed", changes: [{ path: probe, kind: "add" }] }), "", probe), false, "a completed change is a write, not a refusal");
  assert.equal(writeRefusalObservedIn(JSON.stringify({ type: "result", result: "no", permission_denials: [{ tool_name: "Write", tool_input: { file_path: probe } }] }), "", probe), true);
  assert.equal(writeRefusalObservedIn(JSON.stringify({ type: "result", result: "no", permission_denials: [{ tool_name: "Write", tool_input: { file_path: "other.txt" } }] }), "", probe), false);
  assert.equal(writeRefusalObservedIn(item("command_execution", { command: `Set-Content ${probe}`, aggregated_output: "", exit_code: 0, status: "completed" }), "", probe), false, "a command at the probe that was not refused is not a refusal");
  assert.equal(writeRefusalObservedIn(item("agent_message", { text: `the write to ${probe} was denied` }), "", probe), false, "the reviewer's own words do not count");
  assert.equal(writeRefusalObservedIn(deniedAt(probe), "", "."), false, "no probe path, no evidence");
  assert.equal(writeRefusalObservedIn("", "", probe), false);
});

test("a review starts only on the newest preflight for its sandbox, and only when that one passed under the current rule", () => {
  const sig = "codex --sandbox read-only exec --ignore-user-config --json - @ /repo shell:default";
  const record = (name, startedAt, passed, overrides = {}) => ({
    name,
    version: PREFLIGHT_RECORD_VERSION,
    sandboxSignature: sig,
    startedAt,
    passed,
    problems: passed ? [] : ["the write probe landed: the reviewer can write to the working tree"],
    ...overrides,
  });
  const older = record("preflight-a.json", "2026-09-09T10:00:00.000Z", true);
  const newerFailed = record("preflight-b.json", "2026-09-09T11:00:00.000Z", false);
  assert.deepEqual(preflightGate([older], sig), { chosen: older, problems: [] });
  // The reviewer's reproduction from round 1: an older pass is not picked
  // past a newer failure, whatever order the records are read in.
  for (const records of [[older, newerFailed], [newerFailed, older]]) {
    const gate = preflightGate(records, sig);
    assert.equal(gate.chosen, null);
    assert.match(gate.problems[0], /newest preflight for this sandbox, preflight-b\.json \(2026-09-09T11:00:00\.000Z\), FAILED: the write probe landed/);
    assert.match(gate.problems[0], /run --mode=preflight again/);
  }
  const newest = record("preflight-c.json", "2026-09-09T12:00:00.000Z", true);
  assert.equal(preflightGate([older, newerFailed, newest], sig).chosen, newest);
  // A record of another sandbox is not this sandbox's evidence.
  assert.match(preflightGate([record("preflight-d.json", "2026-09-09T13:00:00.000Z", true, { sandboxSignature: "other" })], sig).problems[0], /no preflight is recorded for this sandbox signature/);
  assert.match(preflightGate([], sig).problems[0], /no preflight is recorded/);
  // A pass judged under an earlier rule proved what that rule asked, not
  // what this one does.
  const earlierRule = record("preflight-e.json", "2026-09-09T14:00:00.000Z", true, { version: "cross-review-preflight-v1" });
  const stale = preflightGate([older, newest, earlierRule], sig);
  assert.equal(stale.chosen, null);
  assert.match(stale.problems[0], /preflight-e\.json, was judged under cross-review-preflight-v1, not the current cross-review-preflight-v2/);
  assert.equal(PREFLIGHT_RECORD_VERSION, "cross-review-preflight-v2");
});

// The script's own package and review paths, run in a repository made for
// the purpose. What these hold is what the reviewer of round 1 asked to see
// held end to end: exclusions are an exact allow list after `..` resolves,
// an absent generated file is recorded as absent and noticed when it
// appears, and the newest preflight for the sandbox decides whether a
// review may start.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const runScript = (cwd, args) => {
  const result = spawnSync(process.execPath, ["--import", import.meta.resolve("tsx"), join(repoRoot, "scripts", "cross-review.mjs"), ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, TSX_TSCONFIG_PATH: join(repoRoot, "tsconfig.json") },
    windowsHide: true,
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
};

test("the script's package and review paths hold the rules end to end: exact exclusions, absent snapshots, and the newest preflight", { timeout: 180_000 }, () => {
  const work = mkdtempSync(join(tmpdir(), "cross-review-script-"));
  try {
    const repo = join(work, "repo");
    mkdirSync(join(repo, "src"), { recursive: true });
    mkdirSync(join(repo, "reports"), { recursive: true });
    const git = (...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd: repo, encoding: "utf8" }).trim();
    git("init", "-q");
    git("config", "core.autocrlf", "false");
    writeFileSync(join(repo, "src", "a.txt"), "a\n");
    writeFileSync(join(repo, "reports", "generated.md"), "g\n");
    git("add", "-A");
    git("commit", "-q", "-m", "base");
    const base = git("rev-parse", "HEAD");
    const taskFile = join(work, "task.json");
    writeFileSync(
      taskFile,
      JSON.stringify({
        taskId: "T-script",
        requirement: "r",
        completionCriteria: ["c"],
        baseCommit: base,
        writableScope: ["src/", "reports/", "artifacts/"],
        generatedPaths: ["reports/generated.md", "reports/absent.md"],
      })
    );
    writeFileSync(join(repo, "src", "a.txt"), "b\n");
    writeFileSync(join(repo, "reports", "generated.md"), "g2\n");
    const common = [`--task=${taskFile}`, "--out=artifacts/pkg", "--round=0"];
    const excludes = ["--diff-exclude=reports/generated.md", "--diff-exclude=reports/absent.md", "--diff-exclude=artifacts/pkg"];
    const checks = ["--test-command=true", "--guard-command=true"];
    const pkg = (extra) => runScript(repo, ["--mode=package", ...common, ...checks, ...extra]);
    const packageRecord = join(repo, "artifacts", "pkg", "package-round0.json");

    // Exclusions are an exact allow list, after `..` is resolved.
    const traversal = pkg([...excludes, "--diff-exclude=artifacts/pkg/../../src"]);
    assert.equal(traversal.status, 1, traversal.stderr);
    assert.match(traversal.stderr, /refusing to package: .*writable scope entry src/);
    const above = pkg([...excludes, "--diff-exclude=../elsewhere"]);
    assert.equal(above.status, 1, above.stderr);
    assert.match(above.stderr, /climbs above the repository/);
    const underOut = pkg([...excludes, "--diff-exclude=artifacts/pkg/review-prompt.md"]);
    assert.equal(underOut.status, 1, underOut.stderr);
    assert.match(underOut.stderr, /is under the package directory artifacts\/pkg/);
    assert.equal(existsSync(packageRecord), false, "nothing was packaged");

    // The package records what each excluded generated path is, absence included.
    const packaged = pkg([...excludes, "--summary=round 0"]);
    assert.equal(packaged.status, 0, packaged.stderr);
    const record = JSON.parse(readFileSync(packageRecord, "utf8"));
    assert.match(record.excludedDigests["reports/generated.md"], /^sha256:[0-9a-f]{64}$/);
    assert.equal(record.excludedDigests["reports/absent.md"], "absent");
    assert.deepEqual(record.diffExcluded, ["reports/generated.md", "reports/absent.md", "artifacts/pkg"]);
    assert.match(record.diff, /src\/a\.txt/);
    assert.doesNotMatch(record.diff, /generated\.md/);
    assert.equal(record.testResults[0].passed, true);
    assert.equal(record.guardRuns[0].passed, true);

    // The reviewer's reproduction from round 1: a generated file that did not
    // exist at packaging appears before the review. The review refuses; so
    // does a changed one. With the tree as packaged, both checks pass.
    const review = (extra) => runScript(repo, ["--mode=review", ...common, ...extra]);
    writeFileSync(join(repo, "reports", "absent.md"), "made after packaging\n");
    const appeared = review(["--skip-preflight"]);
    assert.equal(appeared.status, 1, appeared.stderr);
    assert.match(appeared.stderr, /reports\/absent\.md is not what the package recorded \(sha256:[0-9a-f]{64} vs absent\)/);
    rmSync(join(repo, "reports", "absent.md"));
    writeFileSync(join(repo, "reports", "generated.md"), "g3\n");
    const changed = review(["--skip-preflight"]);
    assert.equal(changed.status, 1, changed.stderr);
    assert.match(changed.stderr, /reports\/generated\.md is not what the package recorded \(sha256:[0-9a-f]{64} vs sha256:[0-9a-f]{64}\)/);
    writeFileSync(join(repo, "reports", "generated.md"), "g2\n");

    // The newest preflight for the sandbox decides. With none the review is
    // refused by name; the reviewer's reproduction -- an older pass and a
    // newer failure -- is refused; a pass under an older rule is refused;
    // a newer pass lets the review reach the reviewer, which in dry-run
    // stops there, not executed.
    const none = review([]);
    assert.equal(none.status, 1, none.stderr);
    assert.match(none.stderr, /refusing to review round 0: no preflight is recorded for this sandbox signature/);
    const signature = /^sandbox signature: (.+)$/m.exec(none.stderr)?.[1];
    assert.ok(signature, none.stderr);
    const preflight = (name, startedAt, passed, overrides = {}) =>
      writeFileSync(
        join(repo, "artifacts", "pkg", `${name}.json`),
        JSON.stringify({ version: PREFLIGHT_RECORD_VERSION, sandboxSignature: signature, startedAt, passed, problems: passed ? [] : ["the write probe landed"], ...overrides })
      );
    preflight("preflight-2026-01-01T00-00-00-000Z", "2026-01-01T00:00:00.000Z", true);
    preflight("preflight-2026-01-02T00-00-00-000Z", "2026-01-02T00:00:00.000Z", false);
    const newerFailed = review([]);
    assert.equal(newerFailed.status, 1, newerFailed.stderr);
    assert.match(newerFailed.stderr, /newest preflight for this sandbox, preflight-2026-01-02T00-00-00-000Z\.json \(2026-01-02T00:00:00\.000Z\), FAILED: the write probe landed/);
    preflight("preflight-2026-01-03T00-00-00-000Z", "2026-01-03T00:00:00.000Z", true, { version: "cross-review-preflight-v1" });
    const earlierRule = review([]);
    assert.equal(earlierRule.status, 1, earlierRule.stderr);
    assert.match(earlierRule.stderr, /judged under cross-review-preflight-v1/);
    preflight("preflight-2026-01-04T00-00-00-000Z", "2026-01-04T00:00:00.000Z", true);
    const reached = review([]);
    assert.equal(reached.status, 2, reached.stderr);
    assert.match(reached.stderr, /preflight: preflight-2026-01-04T00-00-00-000Z\.json \(2026-01-04T00:00:00\.000Z\)/);
    assert.match(reached.stdout, /T-script round 0: reviewer not_executed/);
    assert.equal(existsSync(join(repo, "artifacts", "pkg", "verdict-round0.json")), false, "a dry-run leaves no verdict");
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
