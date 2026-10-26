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
  runAmuxV19MaxSessionCycleOnce, writeAmuxV19DiagnosticDetail } from
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
    assert.match(line, / unknownReport=recorded detail=written\n$/);
    assert.equal(line.includes("tengu"), false);
    assert.equal(line.includes("settings.json"), false);
    // The app request is the plain unknown body: no detail in it, nor in
    // anything else the cycle handed to a step that talks to the app.
    assert.deepEqual(fake.reports, [{ origin, fetchImpl: undefined,
      input: unknownBody }]);
    assert.equal(JSON.stringify(fake.reports).includes("tengu"), false);
    assert.equal(JSON.stringify(fake.reports).includes("settings.json"), false);
    assert.equal(fake.released(), 0, "the halt marker still waits for the operator");
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
      assert.equal(fake.released(), 0);
      assert.match(amuxV19MaxSessionCycleStatus(result).line,
        / unknownReport=recorded detail=unwritten\n$/);
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

test("only the newest ten detail files are kept and other files are left alone", () =>
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
    assert.equal(kept.length, 10);
    assert.equal(kept.at(-1), "diagnostic-20261020T012345.678Z.json");
    assert.deepEqual(kept.slice(0, 9), old.slice(3));
    assert.ok(names.includes("analysis-outcome-unknown.halt"));
    assert.ok(names.includes("diagnostic-notes.txt"));
    // A second file in the same millisecond is refused, not overwritten.
    assert.equal(await writeAmuxV19DiagnosticDetail(directory, null,
      rejectedDetail, new Date("2026-10-20T01:23:45.678Z")), "unwritten");
    await mkdir(join(directory, "sub"));
    assert.equal(await writeAmuxV19DiagnosticDetail(join(directory, "sub"), null,
      { events: [], trace: [] }), null);
  }));
