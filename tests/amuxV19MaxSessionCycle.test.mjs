import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";

import { AMUX_V19_EXCLUDED_PATH_DIGEST_KEY_ID,
  AMUX_V19_MAX_SESSION_CYCLE_ENV, amuxV19SessionAnalysisFailure,
  runAmuxV19MaxSessionCycleOnce } from
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
    "TOMVERSE_AMUX_V19_MAX_LAUNCHER_SECRET"];
  const old = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  process.env[AMUX_V19_MAX_SESSION_CYCLE_ENV] = "enabled";
  process.env.TOMVERSE_AMUX_V19_MAX_LAUNCHER_SECRET = secret;
  try { return await fn(); }
  finally {
    for (const name of names) {
      if (old[name] === undefined) delete process.env[name];
      else process.env[name] = old[name];
    }
  }
}

function steps(overrides = {}) {
  const calls = [];
  const reports = [];
  let released = 0;
  const base = {
    reportUnknown: async (input) => { calls.push("reportUnknown");
      reports.push(input);
      return { kind: "recorded", status: "outcome_unknown",
        settledMicroUsd: null, recovered: false, retryWrite: false }; },
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
    haltFile: () => ({ release: async () => { released += 1; } }),
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
      haltReleased: true, planState: "plan_ready",
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
        cliStarted: true }, unknownReport: "recorded" });
    assert.ok(text.includes("Use your read-only file tools (read, glob, grep, list)"));
    assert.ok(!text.includes("Use the Read, Grep and Glob tools"));
  }));

test("nothing after a claim is retried and only a recorded result releases the halt",
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
      assert.equal(fake.released(), 0, stage);
      assert.equal(fake.calls.filter((call) => call === "claim").length, 1);
      // Only an unverified analysis is held as unknown, and only once.
      assert.equal(fake.reports.length, stage === "analysis" ? 1 : 0, stage);
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
      claimId: identity.claimId, reason: "prompt_hold" });
    assert.equal(fake.released(), 0);
  }));

test("a queue answer without a claim is reported as is", () =>
  withSwitches(async () => {
    for (const kind of ["idle", "halted", "outcome_unknown"]) {
      const fake = steps({ claim: async () => ({ kind }) });
      assert.deepEqual(await runAmuxV19MaxSessionCycleOnce({ origin },
        fake.steps), { kind, stage: "claim" });
      assert.deepEqual(fake.calls, []);
    }
  }));

test("a claim the app refused before writing is reported with its reason, not as halted", () =>
  withSwitches(async () => {
    const fake = steps({ claim: async () => ({ kind: "budget_hold",
      reason: "monthly_shadow_reached", retryWrite: false }) });
    const result = await runAmuxV19MaxSessionCycleOnce({ origin }, fake.steps);
    assert.deepEqual(result, { kind: "budget_hold", stage: "claim",
      reason: "monthly_shadow_reached" });
    assert.deepEqual(fake.calls, []);
    assert.deepEqual(amuxV19MaxSessionCycleStatus(result), { line:
      "AMUX_V19_MAX_SESSION_CYCLE_budget_hold stage=claim reason=monthly_shadow_reached\n",
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
  assert.equal(amuxV19MaxSessionCycleStatus({ kind: "halted",
    reason: "monthly_shadow_reached" }).line, "AMUX_V19_MAX_SESSION_CYCLE_halted\n");
});

test("the status line carries fixed words only", () => {
  assert.deepEqual(amuxV19MaxSessionCycleStatus({ kind: "recorded",
    claimId: identity.claimId, haltReleased: true, planState: "plan_ready",
    registrationState: "committed" }), { line:
    "AMUX_V19_MAX_SESSION_CYCLE_recorded planState=plan_ready registrationState=committed\n",
  exitCode: 0 });
  const unknown = amuxV19MaxSessionCycleStatus({ kind: "outcome_unknown",
    stage: "result", claimId: identity.claimId });
  assert.equal(unknown.exitCode, 1);
  assert.ok(!unknown.line.includes(identity.claimId));
  assert.equal(amuxV19MaxSessionCycleStatus({ kind: "halted" }).exitCode, 1);
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
    assert.equal(fake.released(), 0, "the halt marker stays for the operator");
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
      "exit=1 approved=3 denied=0 unknownReport=recorded\n", exitCode: 1 });
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
      assert.equal(fake.released(), 0);
      assert.ok(!amuxV19MaxSessionCycleStatus(result).line.includes("Bearer"));
    }
  }));

test("an analysis proven to stop before the CLI is not held as unknown", () =>
  withSwitches(async () => {
    const fake = steps({ analyse: async () => ({ kind: "outcome_unknown",
      cliStarted: false, beforeCli: true,
      failureStage: "prepare_unavailable" }) });
    const result = await runAmuxV19MaxSessionCycleOnce({ origin,
      stateDirectory: "/state" }, fake.steps);
    assert.deepEqual(fake.reports, []);
    assert.equal(result.unknownReport, "not_sent_before_cli");
    assert.equal(fake.released(), 0);
    assert.equal(amuxV19MaxSessionCycleStatus(result).line,
      "AMUX_V19_MAX_SESSION_CYCLE_outcome_unknown stage=analysis " +
      "reason=outcome_unknown cliStarted=false beforeCli=true " +
      "failure=prepare_unavailable unknownReport=not_sent_before_cli\n");
    // cliStarted=false alone is not proof: only beforeCli skips the report.
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
