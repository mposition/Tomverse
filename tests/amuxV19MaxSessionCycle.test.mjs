import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from
  "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AMUX_V19_DIAGNOSTIC_DETAIL_ENV, AMUX_V19_EXCLUDED_PATH_DIGEST_KEY_ID,
  AMUX_V19_MAX_SESSION_CYCLE_ENV, amuxV19SessionAnalysisFailure,
  AMUX_V19_ABSENT_CLAIM_FINAL_MS, runAmuxV19MaxSessionCycleOnce, writeAmuxV19DiagnosticDetail } from
  "../lib/amux/ideaLocalMaxSessionCycle.mjs";
import { observeAmuxTrackedCheckoutChild } from
  "../lib/amux/ideaTrackedCheckoutProcessResult.mjs";
import { amuxV19MaxSessionCycleStatus } from
  "../scripts/amux-v19-max-session-cycle.mjs";
import { buildAmuxIdeaAnalysisPrompt } from
  "../lib/amux/ideaAnalysisPromptCore.ts";

const origin = "https://amux.example.test/";
const secret = "syntheticMaxLauncherSecret_0123456789abcdefgh";
const identity = Object.freeze({ claimId: "9942fb52-4b78-4af6-931a-9eec8f66d394",
  requestId: "44c72436-c011-4cfc-b52f-e3345c22fc80",
  reservationId: "bf72ad14-585c-41bd-b25e-aab4c17a6d3c",
  ideaId: "53d6918e-b05d-4531-a1ab-704dd756cc40",
  invocationOrdinal: 0, priceVersionId: "price-1", provider: "anthropic",
  modelId: "claude-opus-5-5", reasoningEffort: "high" });
const claim = { kind: "claimed", recovered: false, retryWrite: false,
  claimId: identity.claimId, requestId: identity.requestId,
  reservationId: identity.reservationId };
const pagePrompt = (previewId) => buildAmuxIdeaAnalysisPrompt({ previewId,
  chunkIndex: 0, revisionChunkIndex: 0, continuation: null,
  sourceTexts: [{ refId: "operator_idea", kind: "operator_idea",
    text: "Add a session plan writer." }], permittedTargetRefs: [] }).prompt;
const references = [{ referenceOrdinal: 0, commitSha: "a".repeat(40) },
  { referenceOrdinal: 1, commitSha: "b".repeat(40) }];

async function withSwitches(fn) {
  const names = [AMUX_V19_MAX_SESSION_CYCLE_ENV,
    "TOMVERSE_AMUX_V19_MAX_LAUNCHER_SECRET", AMUX_V19_DIAGNOSTIC_DETAIL_ENV];
  const old = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  process.env[AMUX_V19_MAX_SESSION_CYCLE_ENV] = "enabled";
  process.env.TOMVERSE_AMUX_V19_MAX_LAUNCHER_SECRET = secret;
  // The detail switch is off unless a test turns it on.
  delete process.env[AMUX_V19_DIAGNOSTIC_DETAIL_ENV];
  try { return await fn(); }
  finally {
    for (const name of names) {
      if (old[name] === undefined) delete process.env[name];
      else process.env[name] = old[name];
    }
  }
}

function steps(overrides = {}, pendingMarker = null) {
  const calls = [];
  const reports = [];
  let released = 0;
  const base = {
    reportUnknown: async (input) => { calls.push("reportUnknown");
      reports.push(input);
      return { kind: "recorded", status: "owner_consumed",
        settledMicroUsd: "0", recovered: false, retryWrite: false }; },
    claim: async () => { calls.push("claim");
      return { kind: "claimed", identity, claim, retryWrite: false }; },
    readIdea: async ({ selection }) => { calls.push("readIdea");
      assert.equal(selection.identity, identity);
      return { kind: "ready", prompt: pagePrompt(identity.claimId) }; },
    analyse: async (input) => { calls.push("analyse");
      const prompt = input.prompt(references.length);
      assert.ok(Buffer.isBuffer(prompt));
      const text = prompt.toString("utf8");
      assert.ok(text.includes(identity.claimId), "the claim is the preview id");
      assert.ok(text.includes("reference-0, reference-1"));
      assert.ok(text.includes("BEGIN_SHARED_CONTRACT_PATHS_JSON"));
      assert.ok(text.includes("Use the Read, Grep and Glob tools"));
      assert.equal(input.provider, identity.provider);
      assert.equal(input.modelId, identity.modelId);
      assert.match(input.digestSecret, /^[a-f0-9]{64}$/);
      assert.equal(input.diagnostic, true, "the cycle always asks why");
      return { kind: "verified_success", cliStarted: true,
        references: references.map((reference) => ({ ...reference })),
        preparedReferences: references, rawModelOutput: "{}",
        inputTokens: 10, outputTokens: 2, readFiles: [] }; },
    finalize: async (input, observed) => { calls.push("finalize");
      assert.deepEqual(input.references, references);
      assert.equal(input.excludedPathDigestKeyId,
        AMUX_V19_EXCLUDED_PATH_DIGEST_KEY_ID);
      assert.equal(observed.kind, "verified_success");
      assert.equal(input.provider, identity.provider);
      assert.deepEqual(Object.keys(input.identity).sort(), ["claimId",
        "ideaId", "invocationOrdinal", "requestId", "reservationId"]);
      return { kind: "recorded", recovered: false, retryWrite: false,
        planState: "plan_ready", registrationState: "write_disabled" }; },
    marker: () => ({ read: async () => pendingMarker,
      release: async () => { released += 1; } }),
  };
  return { steps: { ...base, ...overrides }, calls, reports,
    released: () => released };
}

const unknownBody = { claimId: identity.claimId,
  requestId: identity.requestId, reservationId: identity.reservationId,
  ideaId: identity.ideaId, invocationOrdinal: identity.invocationOrdinal,
  outcome: "outcome_unknown", inputTokens: null, outputTokens: null };
const blankAnalysis = { cliStarted: null, beforeCli: false, failure: null,
  parser: null, trace: null, stderr: null, cliError: null, terminal: null,
  apiStatus: null, exit: null, approved: null, denied: null };

test("the cycle does nothing while its switch is off", async () => {
  const fake = steps();
  const old = process.env[AMUX_V19_MAX_SESSION_CYCLE_ENV];
  delete process.env[AMUX_V19_MAX_SESSION_CYCLE_ENV];
  try {
    assert.deepEqual(await runAmuxV19MaxSessionCycleOnce({ origin },
      fake.steps), { kind: "disabled" });
  } finally {
    if (old !== undefined) process.env[AMUX_V19_MAX_SESSION_CYCLE_ENV] = old;
  }
  assert.deepEqual(fake.calls, []);
});

test("one recorded cycle runs every step once and releases the halt", () =>
  withSwitches(async () => {
    const fake = steps();
    const result = await runAmuxV19MaxSessionCycleOnce({ origin,
      stateDirectory: "/state" }, fake.steps);
    assert.deepEqual(result, { kind: "recorded", claimId: identity.claimId,
      haltReleased: true, planState: "plan_ready", planReason: null,
      registrationState: "write_disabled" });
    assert.deepEqual(fake.calls, ["claim", "readIdea", "analyse", "finalize"]);
    assert.equal(fake.released(), 1);
  }));

test("a Cursor claim's prompt names that CLI's read tools", () =>
  withSwitches(async () => {
    const cursorIdentity = { ...identity, provider: "cursor", modelId: "auto" };
    let text;
    const fake = steps({
      claim: async () => ({ kind: "claimed", identity: cursorIdentity, claim,
        retryWrite: false }),
      readIdea: async () => ({ kind: "ready", prompt: pagePrompt(identity.claimId) }),
      analyse: async (input) => {
        assert.equal(input.provider, "cursor");
        text = input.prompt(1).toString("utf8");
        return { kind: "outcome_unknown", cliStarted: true };
      },
    });
    assert.deepEqual(await runAmuxV19MaxSessionCycleOnce({ origin,
      stateDirectory: "/state" }, fake.steps), { kind: "outcome_unknown",
      stage: "analysis", claimId: identity.claimId,
      analysis: { ...blankAnalysis, reason: "outcome_unknown",
        cliStarted: true }, unknownReport: "recorded", haltReleased: true });
    assert.ok(text.includes("Use your read-only file tools (read, glob, grep, list)"));
    assert.ok(!text.includes("Use the Read, Grep and Glob tools"));
  }));

// Operator, 2026-11-16: no stop waits for a person.
test("every stop after a claim reports it unknown once and releases the marker once confirmed",
  () => withSwitches(async () => {
    const cases = [
      ["idea_read", { readIdea: async () => ({ kind: "unavailable" }) }],
      ["analysis", { analyse: async () => ({ kind: "outcome_unknown",
        cliStarted: true }) }],
      ["analysis", { analyse: async () => { throw new Error("lost"); } }],
      ["result", { finalize: async () => ({ kind: "outcome_unknown",
        retryWrite: false }) }],
    ];
    for (const [stage, override] of cases) {
      const fake = steps(override);
      const result = await runAmuxV19MaxSessionCycleOnce({ origin,
        stateDirectory: "/state" }, fake.steps);
      assert.deepEqual({ kind: result.kind, stage: result.stage,
        claimId: result.claimId }, { kind: "outcome_unknown", stage,
        claimId: identity.claimId });
      assert.equal(fake.released(), 1, stage);
      assert.equal(fake.calls.filter((call) => call === "claim").length, 1);
      // Every stop reports the exact claim once; nothing is sent again.
      assert.deepEqual(fake.reports, [{ origin, fetchImpl: undefined,
        input: unknownBody }], stage);
      assert.equal(result.unknownReport, "recorded");
      assert.equal(result.haltReleased, true);
    }
  }));

test("a page prompt for another claim stops before the CLI", () =>
  withSwitches(async () => {
    const fake = steps({
      readIdea: async () => ({ kind: "ready",
        prompt: pagePrompt("aaaaaaaa-4b78-4af6-931a-9eec8f66d394") }),
      analyse: async (input) => {
        const prompt = input.prompt(1);
        return prompt === null ? { kind: "outcome_unknown", cliStarted: false }
          : { kind: "verified_success" };
      },
    });
    const result = await runAmuxV19MaxSessionCycleOnce({ origin,
      stateDirectory: "/state" }, fake.steps);
    assert.deepEqual(result, { kind: "outcome_unknown", stage: "prompt",
      claimId: identity.claimId, reason: "prompt_hold",
      unknownReport: "recorded", haltReleased: true });
    assert.equal(fake.released(), 1);
  }));

test("a queue answer without a claim is reported as is", () =>
  withSwitches(async () => {
    for (const kind of ["idle", "halt_unavailable", "outcome_unknown"]) {
      const fake = steps({ claim: async () => ({ kind }) });
      assert.deepEqual(await runAmuxV19MaxSessionCycleOnce({ origin },
        fake.steps), { kind, stage: "claim" });
      assert.deepEqual(fake.calls, []);
    }
  }));

test("a claim the app refused before writing is reported with its reason, not as halted", () =>
  withSwitches(async () => {
    const fake = steps({ claim: async () => ({ kind: "budget_hold",
      reason: "non_token_cost_unbounded", retryWrite: false }) });
    const result = await runAmuxV19MaxSessionCycleOnce({ origin }, fake.steps);
    assert.deepEqual(result, { kind: "budget_hold", stage: "claim",
      reason: "non_token_cost_unbounded" });
    assert.deepEqual(fake.calls, []);
    assert.deepEqual(amuxV19MaxSessionCycleStatus(result), { line:
      "AMUX_V19_MAX_SESSION_CYCLE_budget_hold stage=claim reason=non_token_cost_unbounded\n",
    exitCode: 0 });
    const noisy = await runAmuxV19MaxSessionCycleOnce({ origin }, steps({
      claim: async () => ({ kind: "budget_hold", reason: "Bearer x-1" }) }).steps);
    assert.deepEqual(noisy, { kind: "budget_hold", stage: "claim" });
  }));

test("pre-write refusals are quiet except the two that need the operator", () => {
  for (const kind of ["budget_hold", "not_ready", "claim_disabled"]) {
    assert.deepEqual(amuxV19MaxSessionCycleStatus({ kind, stage: "claim" }),
      { line: `AMUX_V19_MAX_SESSION_CYCLE_${kind} stage=claim\n`, exitCode: 0 });
  }
  for (const kind of ["budget_unavailable", "integrity_unavailable"]) {
    assert.deepEqual(amuxV19MaxSessionCycleStatus({ kind, stage: "claim" }),
      { line: `AMUX_V19_MAX_SESSION_CYCLE_${kind} stage=claim\n`, exitCode: 1 });
  }
  // A reason is printed only for a refusal or a stopped step, and only as a
  // fixed word.
  assert.equal(amuxV19MaxSessionCycleStatus({ kind: "not_ready", stage: "claim",
    reason: "Bearer x-1" }).line, "AMUX_V19_MAX_SESSION_CYCLE_not_ready stage=claim\n");
  assert.equal(amuxV19MaxSessionCycleStatus({ kind: "refused",
    reason: "non_token_cost_unbounded" }).line, "AMUX_V19_MAX_SESSION_CYCLE_refused\n");
  // A marker the cycle no longer writes is not a kind it prints.
  assert.equal(amuxV19MaxSessionCycleStatus({ kind: "halted" }).line,
    "AMUX_V19_MAX_SESSION_CYCLE_unavailable\n");
});

test("the status line carries fixed words only", () => {
  assert.deepEqual(amuxV19MaxSessionCycleStatus({ kind: "recorded",
    claimId: identity.claimId, haltReleased: true, planState: "plan_ready",
    registrationState: "committed" }), { line:
    "AMUX_V19_MAX_SESSION_CYCLE_recorded planState=plan_ready registrationState=committed\n",
  exitCode: 0 });
  // Failed tool calls the analysis recovered from print as counts by tool.
  assert.equal(amuxV19MaxSessionCycleStatus({ kind: "recorded",
    haltReleased: true, planState: "plan_ready", registrationState: "committed",
    toolErrors: { Read: 2, Grep: 0, Glob: 1 } }).line,
  "AMUX_V19_MAX_SESSION_CYCLE_recorded planState=plan_ready registrationState=committed readErrors=2 globErrors=1\n");
  assert.equal(amuxV19MaxSessionCycleStatus({ kind: "recorded",
    haltReleased: true, planState: "plan_ready", registrationState: "committed",
    toolErrors: { Read: "two", Grep: -1, Glob: 1.5 } }).line,
  "AMUX_V19_MAX_SESSION_CYCLE_recorded planState=plan_ready registrationState=committed\n",
  "only small whole counts are printed");
  // A refused plan names the app's closed refusal word.
  assert.equal(amuxV19MaxSessionCycleStatus({ kind: "recorded",
    haltReleased: true, planState: "plan_refused", planReason: "invalid_result",
    registrationState: "not_planned" }).line,
  "AMUX_V19_MAX_SESSION_CYCLE_recorded planState=plan_refused planReason=invalid_result registrationState=not_planned\n");
  const unknown = amuxV19MaxSessionCycleStatus({ kind: "outcome_unknown",
    stage: "result", claimId: identity.claimId });
  assert.equal(unknown.exitCode, 1);
  assert.ok(!unknown.line.includes(identity.claimId));
  assert.equal(amuxV19MaxSessionCycleStatus({ kind: "halt_unavailable" }).exitCode, 1);
  assert.equal(amuxV19MaxSessionCycleStatus({ kind: "made-up" }).line,
    "AMUX_V19_MAX_SESSION_CYCLE_unavailable\n");
});

test("an unverified analysis is held as outcome_unknown once with its exact claim",
  () => withSwitches(async () => {
    const fake = steps({ analyse: async () => ({ kind: "outcome_unknown",
      cliStarted: true, failureStage: "child_nonzero", childExitCode: 1,
      approvedConnects: 3, deniedConnects: 0, stderrClass: "authentication",
      cliError: { assistantError: "authentication_failed",
        resultIsError: true, apiErrorStatus: 401, terminalReason: "api_error",
        permissionDenials: 0, turns: 1,
        toolUses: { Read: 0, Grep: 0, Glob: 0 } },
      preparedReferences: references }) });
    const result = await runAmuxV19MaxSessionCycleOnce({ origin,
      stateDirectory: "/state" }, fake.steps);
    assert.deepEqual(fake.reports, [{ origin, fetchImpl: undefined,
      input: unknownBody }]);
    // The overriding analyse does not log itself; no finalize follows.
    assert.deepEqual(fake.calls, ["claim", "readIdea", "reportUnknown"]);
    assert.equal(fake.released(), 1, "the confirmed report removes the marker");
    assert.deepEqual(result.analysis, { ...blankAnalysis,
      reason: "outcome_unknown", cliStarted: true, failure: "child_nonzero",
      stderr: "authentication", cliError: "authentication_failed",
      terminal: "api_error", apiStatus: 401, exit: 1, approved: 3,
      denied: 0 });
    assert.deepEqual(amuxV19MaxSessionCycleStatus(result), { line:
      "AMUX_V19_MAX_SESSION_CYCLE_outcome_unknown stage=analysis " +
      "reason=outcome_unknown cliStarted=true beforeCli=false " +
      "failure=child_nonzero stderr=authentication " +
      "cliError=authentication_failed terminal=api_error apiStatus=401 " +
      "exit=1 approved=3 denied=0 unknownReport=recorded haltReleased=true\n",
    exitCode: 1 });
  }));

test("a thrown analysis and a lost report stay unknown without a second write",
  () => withSwitches(async () => {
    for (const [reportUnknown, expected, receipt] of [
      [async () => ({ kind: "outcome_unknown", receiptStatus: "in_flight",
        retryWrite: false }), "unconfirmed", "in_flight"],
      [async () => ({ kind: "recorded", status: "outcome_unknown",
        settledMicroUsd: null, recovered: true, retryWrite: false }),
      "read_back", undefined],
      [async () => ({ kind: "refused" }), "refused", undefined],
      [async () => { throw new Error("lost"); }, "unconfirmed", undefined],
      // A receipt status that is not a fixed word is dropped, not printed.
      [async () => ({ kind: "outcome_unknown", receiptStatus: "Bearer x-1",
        retryWrite: false }), "unconfirmed", undefined],
    ]) {
      let writes = 0;
      const fake = steps({
        analyse: async () => { throw new Error("host lost"); },
        reportUnknown: async (input) => { writes += 1;
          return reportUnknown(input); },
      });
      const result = await runAmuxV19MaxSessionCycleOnce({ origin,
        stateDirectory: "/state" }, fake.steps);
      assert.equal(writes, 1);
      assert.equal(result.stage, "analysis");
      assert.equal(result.analysis.reason, "analysis_threw");
      assert.equal(result.analysis.cliStarted, null);
      assert.equal(result.unknownReport, expected);
      assert.equal(result.receipt, receipt);
      // Only a confirmed report removes the marker; the next tick reads the
      // rest back.
      assert.equal(fake.released(), expected === "read_back" ? 1 : 0);
      assert.equal(result.haltReleased, expected === "read_back");
      assert.ok(!amuxV19MaxSessionCycleStatus(result).line.includes("Bearer"));
    }
  }));

// The claim of an analysis that stopped before its CLI is closed too, so
// the idea is queued again instead of waiting (operator, 2026-11-16).
test("an analysis that stopped before the CLI is reported too", () =>
  withSwitches(async () => {
    const fake = steps({ analyse: async () => ({ kind: "outcome_unknown",
      cliStarted: false, beforeCli: true,
      failureStage: "prepare_unavailable" }) });
    const result = await runAmuxV19MaxSessionCycleOnce({ origin,
      stateDirectory: "/state" }, fake.steps);
    assert.deepEqual(fake.reports, [{ origin, fetchImpl: undefined,
      input: unknownBody }]);
    assert.equal(result.unknownReport, "recorded");
    assert.equal(fake.released(), 1);
    assert.equal(amuxV19MaxSessionCycleStatus(result).line,
      "AMUX_V19_MAX_SESSION_CYCLE_outcome_unknown stage=analysis " +
      "reason=outcome_unknown cliStarted=false beforeCli=true " +
      "failure=prepare_unavailable unknownReport=recorded haltReleased=true\n");
    const unproven = steps({ analyse: async () => ({ kind: "outcome_unknown",
      cliStarted: false, failureStage: "host_error" }) });
    await runAmuxV19MaxSessionCycleOnce({ origin, stateDirectory: "/state" },
      unproven.steps);
    assert.deepEqual(unproven.reports, [{ origin, fetchImpl: undefined,
      input: unknownBody }]);
  }));

test("analysis reasons print fixed words and bounded counts only", () => {
  const secret = "sk-ant-oat01-SyntheticSecret_0123456789";
  const line = amuxV19MaxSessionCycleStatus({ kind: "outcome_unknown",
    stage: "analysis", claimId: identity.claimId, analysis: {
      reason: "outcome_unknown", cliStarted: "yes", beforeCli: 1,
      failure: "/home/runner/.claude/.credentials.json", parser: identity.modelId,
      trace: "Trace Reason", stderr: secret, cliError: `Bearer ${secret}`,
      terminal: { toString: () => "api_error" }, apiStatus: 4010, exit: 256,
      approved: -1, denied: 1.5 },
    unknownReport: identity.requestId, receipt: "price_5000" }).line;
  assert.equal(line,
    "AMUX_V19_MAX_SESSION_CYCLE_outcome_unknown stage=analysis reason=outcome_unknown\n");
  // The cycle's own summary already keeps only those shapes.
  const summary = amuxV19SessionAnalysisFailure({ kind: "outcome_unknown",
    cliStarted: true, failureStage: "parser_rejected", childExitCode: 0,
    stderrClass: secret, parserReason: { code: "usage_model_mismatch",
      also: ["result_text_missing"], usageModels: [identity.modelId, secret],
      traceReason: null }, rawModelOutput: secret });
  assert.equal(JSON.stringify(summary).includes(secret), false);
  assert.equal(JSON.stringify(summary).includes(identity.modelId), false);
  assert.equal(summary.parser, "usage_model_mismatch");
});

test("a real diagnostic observation reaches the status line without its stderr or stream text",
  async () => {
    const secret = "sk-ant-oat01-SyntheticSecret_0123456789";
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(), stderr: new PassThrough() });
    const observer = observeAmuxTrackedCheckoutChild(child, {
      directory: "/tmp/amux-v19-checkout-abcdef", files: ["src/a.ts"],
      modelId: identity.modelId, diagnostic: true });
    child.stderr.end(`authentication_error token=${secret} ` +
      "file=/home/runner/.claude/.credentials.json\n");
    await new Promise((resolve) => child.stderr.once("end", resolve));
    child.stdout.end(Buffer.from([
      { type: "assistant", error: "authentication_failed", message: {
        role: "assistant", content: [{ type: "text", text: secret }] } },
      { type: "result", subtype: "success", is_error: true, num_turns: 1,
        api_error_status: 401, terminal_reason: "api_error",
        result: secret },
    ].map((event) => JSON.stringify(event)).join("\n")));
    await new Promise((resolve) => child.stdout.once("end", resolve));
    const observed = observer.finish({ code: 1, signal: null });
    assert.equal(JSON.stringify(observed).includes(secret), false);
    assert.equal(JSON.stringify(observed).includes(".credentials"), false);
    const { line } = amuxV19MaxSessionCycleStatus({ kind: "outcome_unknown",
      stage: "analysis", claimId: identity.claimId,
      analysis: amuxV19SessionAnalysisFailure({ ...observed,
        cliStarted: true }), unknownReport: "recorded" });
    assert.equal(line,
      "AMUX_V19_MAX_SESSION_CYCLE_outcome_unknown stage=analysis " +
      "reason=outcome_unknown cliStarted=true beforeCli=false " +
      "failure=child_nonzero stderr=authentication " +
      "cliError=authentication_failed terminal=api_error apiStatus=401 " +
      "exit=1 unknownReport=recorded\n");
  });

// Diagnostic detail (TOMVERSE_AMUX_V19_DIAGNOSTIC_DETAIL): local file only.
const detailSecret = "sk-ant-oat01-SyntheticSecret_0123456789";
const rejectedDetail = Object.freeze({
  events: [{ code: "system_event_other", subtype: "tengu.private_event",
    keys: ["type", "subtype", "session_id"],
    // Fields the observers never produce: the writer must drop them.
    message: `prompt ${detailSecret}`, body: { token: detailSecret } }],
  trace: [{ code: "unlisted_open", path: ".claude/settings.json",
    flags: ["O_RDONLY", "O_CLOEXEC", "not a flag"], content: detailSecret },
  { code: "escaped_checkout", path: "<outside>", flags: ["O_RDONLY"] },
  { code: "Bad Code", path: "x" }] });
const parserRejected = (extra = {}) => ({ kind: "outcome_unknown",
  cliStarted: true, failureStage: "parser_rejected", childExitCode: 0,
  approvedConnects: 3, deniedConnects: 0,
  parserReason: { code: "system_event_other", also: [], usageModels: null,
    traceReason: "unlisted_open" },
  preparedReferences: references, ...extra });

async function withDetail(fn) {
  const directory = await mkdtemp(join(tmpdir(), "amux-v19-detail-"));
  process.env[AMUX_V19_DIAGNOSTIC_DETAIL_ENV] = "enabled";
  try { return await fn(directory); }
  finally {
    delete process.env[AMUX_V19_DIAGNOSTIC_DETAIL_ENV];
    await rm(directory, { recursive: true, force: true });
  }
}

test("with the detail switch off nothing is asked for and no file is written", () =>
  withSwitches(async () => {
    const directory = await mkdtemp(join(tmpdir(), "amux-v19-detail-"));
    try {
      let asked;
      const fake = steps({ analyse: async (input) => { asked = input;
        return parserRejected({ diagnosticDetail: rejectedDetail }); } });
      const result = await runAmuxV19MaxSessionCycleOnce({ origin,
        stateDirectory: directory }, fake.steps);
      assert.equal("diagnosticDetail" in asked, false);
      assert.equal("detail" in result, false);
      assert.deepEqual(await readdir(directory), []);
      assert.doesNotMatch(amuxV19MaxSessionCycleStatus(result).line, /detail=/);
      // Any value but "enabled" is off.
      process.env[AMUX_V19_DIAGNOSTIC_DETAIL_ENV] = "true";
      await runAmuxV19MaxSessionCycleOnce({ origin, stateDirectory: directory },
        steps({ analyse: async () => parserRejected({
          diagnosticDetail: rejectedDetail }) }).steps);
      assert.deepEqual(await readdir(directory), []);
    } finally {
      delete process.env[AMUX_V19_DIAGNOSTIC_DETAIL_ENV];
      await rm(directory, { recursive: true, force: true });
    }
  }));

test("with the detail switch on a rejected analysis writes one private file of names only", () =>
  withSwitches(() => withDetail(async (directory) => {
    let asked;
    const fake = steps({ analyse: async (input) => { asked = input;
      return parserRejected({ diagnosticDetail: rejectedDetail }); } });
    const result = await runAmuxV19MaxSessionCycleOnce({ origin,
      stateDirectory: directory }, fake.steps);
    assert.equal(asked.diagnostic, true);
    assert.equal(asked.diagnosticDetail, true);
    assert.equal(result.detail, "written");
    assert.equal(result.unknownReport, "recorded");
    const files = await readdir(directory);
    assert.equal(files.length, 1);
    assert.match(files[0], /^diagnostic-\d{8}T\d{6}\.\d{3}Z\.json$/);
    if (process.platform !== "win32") {
      assert.equal((await stat(join(directory, files[0]))).mode & 0o777, 0o600);
    }
    const text = await readFile(join(directory, files[0]), "utf8");
    const written = JSON.parse(text);
    assert.deepEqual(written.events, [{ code: "system_event_other",
      subtype: "tengu.private_event", keys: ["type", "subtype", "session_id"] }]);
    assert.deepEqual(written.trace, [
      { code: "unlisted_open", path: ".claude/settings.json",
        flags: ["O_RDONLY", "O_CLOEXEC"] },
      { code: "escaped_checkout", path: "<outside>", flags: ["O_RDONLY"] }]);
    assert.equal(written.analysis.parser, "system_event_other");
    assert.equal(written.analysis.trace, "unlisted_open");
    assert.equal(written.version, 1);
    assert.match(written.recordedAt, /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
    assert.equal(text.includes(detailSecret), false);
    assert.equal(text.includes("prompt"), false);
    // Split, not includes: the origin is a value to find, not a URL to vet.
    assert.equal(text.split(origin).length, 1);
    assert.equal(text.includes(identity.claimId), false);
    // The status line only says whether the file was written.
    const { line } = amuxV19MaxSessionCycleStatus(result);
    assert.match(line, / unknownReport=recorded detail=written haltReleased=true\n$/);
    assert.equal(line.includes("tengu"), false);
    assert.equal(line.includes("settings.json"), false);
    // The app request is the plain unknown body: no detail in it, nor in
    // anything else the cycle handed to a step that talks to the app.
    assert.deepEqual(fake.reports, [{ origin, fetchImpl: undefined,
      input: unknownBody }]);
    assert.equal(JSON.stringify(fake.reports).includes("tengu"), false);
    assert.equal(JSON.stringify(fake.reports).includes("settings.json"), false);
    assert.equal(fake.released(), 1, "the confirmed report removes the marker");
  })));

test("the real unknown report carries the claim identity only, never the detail", () =>
  withSwitches(() => withDetail(async (directory) => {
    const keep = [process.env.TOMVERSE_AMUX_V19_SESSION_ANALYSIS_APP_ORIGIN];
    process.env.TOMVERSE_AMUX_V19_SESSION_ANALYSIS_APP_ORIGIN = origin;
    const sent = [];
    try {
      const { settleAmuxV19MaxShadowResultOnce } = await import(
        "../lib/amux/ideaLocalMaxShadowResultOnce.mjs");
      const fake = steps({
        analyse: async () => parserRejected({ diagnosticDetail: rejectedDetail }),
        reportUnknown: settleAmuxV19MaxShadowResultOnce });
      const result = await runAmuxV19MaxSessionCycleOnce({ origin,
        stateDirectory: directory, fetchImpl: async (url, options) => {
          sent.push(`${url}\n${JSON.stringify(options.headers)}\n${options.body ?? ""}`);
          return Response.json({ claimId: identity.claimId,
            status: "outcome_unknown", settledMicroUsd: null,
            auditId: "clsyntheticaudit123" });
        } }, fake.steps);
      assert.equal(result.unknownReport, "recorded");
      assert.equal(result.detail, "written");
      assert.equal(sent.length, 1);
      assert.match(sent[0], /analysis-budget\/unknown/);
      assert.deepEqual(JSON.parse(sent[0].split("\n")[2]), unknownBody);
      assert.doesNotMatch(sent[0], /tengu|settings\.json|diagnosticDetail|O_RDONLY|session_id/);
    } finally {
      if (keep[0] === undefined) delete process.env.TOMVERSE_AMUX_V19_SESSION_ANALYSIS_APP_ORIGIN;
      else process.env.TOMVERSE_AMUX_V19_SESSION_ANALYSIS_APP_ORIGIN = keep[0];
    }
  })));

test("an unwritable state directory is only noted, and changes nothing else", () =>
  withSwitches(() => withDetail(async (directory) => {
    const missing = join(directory, "not-created");
    for (const stateDirectory of [missing, "relative/state", undefined]) {
      const fake = steps({ analyse: async () => parserRejected({
        diagnosticDetail: rejectedDetail }) });
      const result = await runAmuxV19MaxSessionCycleOnce({ origin,
        stateDirectory }, fake.steps);
      assert.equal(result.detail, "unwritten");
      assert.equal(result.unknownReport, "recorded", "the report still goes out");
      assert.equal(fake.reports.length, 1);
      assert.equal(fake.released(), 1);
      assert.match(amuxV19MaxSessionCycleStatus(result).line,
        / unknownReport=recorded detail=unwritten haltReleased=true\n$/);
    }
    // A regular file in place of the directory, and a directory that is a
    // symbolic link, are not state directories.
    const file = join(directory, "file");
    await writeFile(file, "x");
    assert.equal(await writeAmuxV19DiagnosticDetail(file, null, rejectedDetail),
      "unwritten");
    assert.deepEqual(await readdir(directory), ["file"]);
  })));

test("a failure with no names to record writes nothing and says nothing", () =>
  withSwitches(() => withDetail(async (directory) => {
    for (const diagnosticDetail of [undefined, { events: [], trace: [] },
      { events: [{ code: "Bad Code" }], trace: "x" }]) {
      const result = await runAmuxV19MaxSessionCycleOnce({ origin,
        stateDirectory: directory }, steps({ analyse: async () => parserRejected({
        diagnosticDetail }) }).steps);
      assert.equal("detail" in result, false);
    }
    // Proven to stop before the CLI: nothing to explain, nothing written.
    const before = await runAmuxV19MaxSessionCycleOnce({ origin,
      stateDirectory: directory }, steps({ analyse: async () => ({
      kind: "outcome_unknown", cliStarted: false, beforeCli: true,
      failureStage: "prepare_unavailable", diagnosticDetail: rejectedDetail }) }).steps);
    assert.equal("detail" in before, false);
    assert.deepEqual(await readdir(directory), []);
  })));

test("a verified analysis writes no detail file and sends none", () =>
  withSwitches(() => withDetail(async (directory) => {
    let finalized;
    const fake = steps({ finalize: async (input, observed) => {
      finalized = { input, observed };
      return { kind: "recorded", recovered: false, retryWrite: false,
        planState: "plan_ready", registrationState: "write_disabled" }; } });
    const result = await runAmuxV19MaxSessionCycleOnce({ origin,
      stateDirectory: directory }, fake.steps);
    assert.equal(result.kind, "recorded");
    assert.equal(JSON.stringify(finalized.input).includes("diagnosticDetail"), false);
    assert.deepEqual(await readdir(directory), []);
  })));

// Operator, 2026-11-16: no count caps; the operator prunes the directory.
test("every detail file is kept and other files are left alone", () =>
  withDetail(async (directory) => {
    const old = [];
    for (let index = 0; index < 12; index += 1) {
      const name = `diagnostic-20260101T0000${String(index).padStart(2, "0")}.000Z.json`;
      old.push(name);
      await writeFile(join(directory, name), "{}\n");
    }
    await writeFile(join(directory, "analysis-outcome-unknown.halt"), "marker\n");
    await writeFile(join(directory, "diagnostic-notes.txt"), "mine\n");
    assert.equal(await writeAmuxV19DiagnosticDetail(directory, null,
      rejectedDetail, new Date("2026-10-20T01:23:45.678Z")), "written");
    const names = (await readdir(directory)).sort();
    const kept = names.filter((name) => /^diagnostic-\d{8}T\d{6}\.\d{3}Z\.json$/.test(name));
    assert.equal(kept.length, 13);
    assert.equal(kept.at(-1), "diagnostic-20261020T012345.678Z.json");
    assert.deepEqual(kept.slice(0, 12), old);
    assert.ok(names.includes("analysis-outcome-unknown.halt"));
    assert.ok(names.includes("diagnostic-notes.txt"));
    // A second file in the same millisecond is refused, not overwritten.
    assert.equal(await writeAmuxV19DiagnosticDetail(directory, null,
      rejectedDetail, new Date("2026-10-20T01:23:45.678Z")), "unwritten");
    await mkdir(join(directory, "sub"));
    assert.equal(await writeAmuxV19DiagnosticDetail(join(directory, "sub"), null,
      { events: [], trace: [] }), null);
  }));

test("a marker an earlier tick left is reconciled before any new claim", () =>
  withSwitches(async () => {
    const named = { claimId: identity.claimId, requestId: identity.requestId,
      reservationId: identity.reservationId, ideaId: identity.ideaId,
      invocationOrdinal: identity.invocationOrdinal };
    const fake = steps({ claim: async () => ({ kind: "recover", identity: named }) });
    const result = await runAmuxV19MaxSessionCycleOnce({ origin,
      stateDirectory: "/state" }, fake.steps);
    assert.deepEqual(result, { kind: "recovered", stage: "recover",
      claimId: identity.claimId, unknownReport: "recorded", haltReleased: true });
    assert.deepEqual(fake.reports, [{ origin, fetchImpl: undefined,
      input: unknownBody }]);
    assert.deepEqual(fake.calls, ["reportUnknown"]);
    assert.equal(fake.released(), 1);
    assert.deepEqual(amuxV19MaxSessionCycleStatus(result), { line:
      "AMUX_V19_MAX_SESSION_CYCLE_recovered stage=recover unknownReport=recorded haltReleased=true\n",
    exitCode: 0 });
    // An unconfirmed report keeps the marker for the next tick.
    const lost = steps({ claim: async () => ({ kind: "recover", identity: named }),
      reportUnknown: async () => ({ kind: "outcome_unknown", retryWrite: false,
        reason: "readback_unreachable" }) });
    const kept = await runAmuxV19MaxSessionCycleOnce({ origin,
      stateDirectory: "/state" }, lost.steps);
    assert.equal(kept.kind, "outcome_unknown");
    assert.equal(kept.haltReleased, false);
    assert.equal(lost.released(), 0);
  }));

// A marker the old runner wrote longer ago than one commit deadline: every
// claim it could have left exists by now.
const legacyTime = () => Date.now() - AMUX_V19_ABSENT_CLAIM_FINAL_MS - 60_000;

const inFlight = (ordinal) => ({ claimId: identity.claimId,
  requestId: identity.requestId, reservationId: identity.reservationId,
  ideaId: identity.ideaId, invocationOrdinal: ordinal });

// A runner from before 2026-11-16 could stop with its claim still in flight on
// the app and leave a marker that names none (review r-20261116-185015-9d7a60).
test("a marker naming no claim reports every in-flight claim written before it, then is removed", () =>
  withSwitches(async () => {
    const written = legacyTime();
    const listings = [];
    const fake = steps({
      listInFlight: async (input) => { listings.push(input);
        return { kind: "listed", claims: [inFlight(0), inFlight(1)] }; },
    }, { identity: null, writtenAtMs: written });
    const result = await runAmuxV19MaxSessionCycleOnce({ origin,
      stateDirectory: "/state" }, fake.steps);
    assert.deepEqual(result, { kind: "recovered", stage: "recover",
      reason: "unnamed_marker", haltReleased: true, claims: 2 });
    assert.deepEqual(listings, [{ origin, fetchImpl: undefined,
      beforeMs: written + AMUX_V19_ABSENT_CLAIM_FINAL_MS }]);
    assert.deepEqual(fake.reports.map((report) => report.input),
      [0, 1].map((ordinal) => ({ ...unknownBody, invocationOrdinal: ordinal })));
    assert.deepEqual(fake.calls, ["reportUnknown", "reportUnknown"]);
    assert.equal(fake.released(), 1);
    assert.equal(amuxV19MaxSessionCycleStatus(result).line,
      "AMUX_V19_MAX_SESSION_CYCLE_recovered stage=recover reason=unnamed_marker claims=2 haltReleased=true\n");
    // A report the app answered by reading the claim back counts too.
    const readBack = steps({
      listInFlight: async () => ({ kind: "listed", claims: [inFlight(0)] }),
      reportUnknown: async () => ({ kind: "recorded", status: "owner_consumed",
        settledMicroUsd: null, recovered: true, retryWrite: false }),
    }, { identity: null, writtenAtMs: written });
    assert.equal((await runAmuxV19MaxSessionCycleOnce({ origin,
      stateDirectory: "/state" }, readBack.steps)).kind, "recovered");
    assert.equal(readBack.released(), 1);
  }));

test("a marker naming no claim is removed when the app holds none in flight before it", () =>
  withSwitches(async () => {
    const fake = steps({ listInFlight: async () => ({ kind: "listed", claims: [] }) },
      { identity: null, writtenAtMs: legacyTime() });
    assert.deepEqual(await runAmuxV19MaxSessionCycleOnce({ origin,
      stateDirectory: "/state" }, fake.steps), { kind: "recovered",
      stage: "recover", reason: "unnamed_marker", haltReleased: true, claims: 0 });
    assert.deepEqual(fake.calls, []);
    assert.equal(fake.released(), 1);
    // The claim step's own recover answer carries the same time.
    const viaClaim = steps({ listInFlight: async () => ({ kind: "listed", claims: [] }),
      claim: async () => ({ kind: "recover", identity: null,
        writtenAtMs: legacyTime() }) });
    assert.equal((await runAmuxV19MaxSessionCycleOnce({ origin,
      stateDirectory: "/state" }, viaClaim.steps)).kind, "recovered");
    assert.equal(viaClaim.released(), 1);
  }));

test("a marker naming no claim stays while any in-flight claim is unconfirmed, and the others are still reported", () =>
  withSwitches(async () => {
    const answers = [{ kind: "outcome_unknown", receiptStatus: "in_flight",
      retryWrite: false, reason: "write_unconfirmed" },
    { kind: "recorded", status: "owner_consumed", settledMicroUsd: "0",
      recovered: false, retryWrite: false }];
    const fake = steps({
      listInFlight: async () => ({ kind: "listed",
        claims: [inFlight(0), inFlight(1)] }),
      reportUnknown: async () => answers.shift(),
    }, { identity: null, writtenAtMs: legacyTime() });
    const result = await runAmuxV19MaxSessionCycleOnce({ origin,
      stateDirectory: "/state" }, fake.steps);
    assert.deepEqual(result, { kind: "outcome_unknown", stage: "recover",
      reason: "unnamed_marker", haltReleased: false,
      reportReason: "write_unconfirmed", claims: 2,
      unknownReport: "unconfirmed", receipt: "in_flight" });
    assert.equal(answers.length, 0, "the second claim was reported too");
    assert.equal(fake.released(), 0);
    assert.equal(amuxV19MaxSessionCycleStatus(result).exitCode, 1);
    // A report that throws is unconfirmed too.
    const thrown = steps({
      listInFlight: async () => ({ kind: "listed", claims: [inFlight(0)] }),
      reportUnknown: async () => { throw new Error("lost"); },
    }, { identity: null, writtenAtMs: legacyTime() });
    const kept = await runAmuxV19MaxSessionCycleOnce({ origin,
      stateDirectory: "/state" }, thrown.steps);
    assert.equal(kept.kind, "outcome_unknown");
    assert.equal(kept.reportReason, "report_threw");
    assert.equal(thrown.released(), 0);
  }));

test("a marker naming no claim stays when the in-flight list cannot be read or its time is unknown", () =>
  withSwitches(async () => {
    const written = legacyTime();
    for (const [listInFlight, reportReason] of [
      [async () => ({ kind: "unavailable", reason: "readback_unreachable" }),
        "readback_unreachable"],
      [async () => ({ kind: "unavailable", reason: "response_invalid" }),
        "response_invalid"],
      [async () => ({ kind: "refused" }), "list_refused"],
      [async () => { throw new Error("lost"); }, "list_unavailable"],
    ]) {
      const fake = steps({ listInFlight },
        { identity: null, writtenAtMs: written });
      assert.deepEqual(await runAmuxV19MaxSessionCycleOnce({ origin,
        stateDirectory: "/state" }, fake.steps), { kind: "outcome_unknown",
        stage: "recover", reason: "unnamed_marker", haltReleased: false,
        reportReason }, reportReason);
      assert.deepEqual(fake.calls, [], "nothing is reported without a list");
      assert.equal(fake.released(), 0, reportReason);
    }
    // No time to ask by, or no way to ask: the marker is never dropped on a guess.
    for (const [overrides, pending] of [
      [{ listInFlight: async () => { throw new Error("must not ask"); } },
        { identity: null }],
      [{ listInFlight: undefined }, { identity: null, writtenAtMs: written }],
    ]) {
      const fake = steps(overrides, pending);
      const result = await runAmuxV19MaxSessionCycleOnce({ origin,
        stateDirectory: "/state" }, fake.steps);
      assert.equal(result.kind, "outcome_unknown");
      assert.equal(result.reportReason, "marker_time_unreadable");
      assert.equal(fake.released(), 0);
    }
  }));

test("a marker that cannot be removed after its claims were settled halts the next tick", () =>
  withSwitches(async () => {
    const fake = steps({
      listInFlight: async () => ({ kind: "listed", claims: [] }),
      marker: () => ({ read: async () => ({ identity: null,
        writtenAtMs: legacyTime() }),
      release: async () => { throw new Error("local_state_unavailable"); } }),
    });
    assert.deepEqual(await runAmuxV19MaxSessionCycleOnce({ origin,
      stateDirectory: "/state" }, fake.steps),
    { kind: "halt_unavailable", stage: "recover" });
  }));

test("a marker naming no claim waits out the commit deadline before the in-flight list is read", () =>
  withSwitches(async () => {
    // The old runner wrote its marker right before its claim's write, so that
    // claim is newer than the marker; until the deadline passes it may land.
    const fake = steps({ listInFlight: async () => { throw new Error("must not ask yet"); } },
      { identity: null, writtenAtMs: Date.now() - 1_000 });
    const result = await runAmuxV19MaxSessionCycleOnce({ origin,
      stateDirectory: "/state" }, fake.steps);
    assert.equal(result.kind, "outcome_unknown");
    assert.equal(result.reportReason, "legacy_window_open");
    assert.equal(fake.released(), 0);
  }));

test("a pending marker is reconciled before the queue is read, even with no other candidate", () =>
  withSwitches(async () => {
    const named = { claimId: identity.claimId, requestId: identity.requestId,
      reservationId: identity.reservationId, ideaId: identity.ideaId,
      invocationOrdinal: identity.invocationOrdinal };
    // The queue would answer idle: the in-flight claim is not in it.
    const fake = steps({ claim: async () => { throw new Error("the queue must not be read"); } },
      { identity: named });
    const result = await runAmuxV19MaxSessionCycleOnce({ origin,
      stateDirectory: "/state" }, fake.steps);
    assert.deepEqual(result, { kind: "recovered", stage: "recover",
      claimId: identity.claimId, unknownReport: "recorded", haltReleased: true });
    assert.deepEqual(fake.calls, ["reportUnknown"]);
    assert.equal(fake.released(), 1);
  }));

test("a marker whose claim never reached the app is removed, not asked about forever", () =>
  withSwitches(async () => {
    const named = { claimId: identity.claimId, requestId: identity.requestId,
      reservationId: identity.reservationId, ideaId: identity.ideaId,
      invocationOrdinal: identity.invocationOrdinal };
    // As the real report answers it: an unconfirmed report, receipt absent.
    const old = Date.now() - AMUX_V19_ABSENT_CLAIM_FINAL_MS - 1;
    const absent = steps({ reportUnknown: async () => ({ kind: "outcome_unknown",
      receiptStatus: "absent", retryWrite: false, reason: "readback_absent" }) },
      { identity: named, writtenAtMs: old });
    const result = await runAmuxV19MaxSessionCycleOnce({ origin,
      stateDirectory: "/state" }, absent.steps);
    assert.equal(result.kind, "recovered");
    assert.equal(result.neverClaimed, true);
    assert.equal(absent.released(), 1);
    // A partial receipt is not proof of absence, and an absent receipt inside
    // the window may still commit: the marker stays in both.
    for (const [receiptStatus, writtenAtMs] of [["partial", old], ["absent", Date.now()]]) {
      const held = steps({ reportUnknown: async () => ({ kind: "outcome_unknown",
        receiptStatus, retryWrite: false, reason: "readback_absent" }) },
        { identity: named, writtenAtMs });
      const kept = await runAmuxV19MaxSessionCycleOnce({ origin,
        stateDirectory: "/state" }, held.steps);
      assert.equal(kept.kind, "outcome_unknown", receiptStatus);
      assert.equal(held.released(), 0, receiptStatus);
    }
  }));
