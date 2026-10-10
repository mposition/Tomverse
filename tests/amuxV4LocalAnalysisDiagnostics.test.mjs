import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { amuxV4AnalysisCliDiagnostic, amuxV4AnalysisWithCliDiagnostic,
  amuxV4AnalysisDiagnosticLog, amuxV4UnexpectedEventDiagnostic } from
  "../lib/amux/ideaLocalAnalysisDiagnostics.mjs";
import { inspectAmuxV4AnalysisCliResult, planAmuxV4AnalysisCliInvocation } from
  "../lib/amux/ideaLocalCliContract.mjs";
import { amuxV4CliUnknownResult } from
  "../lib/amux/ideaLocalIsolatedCliRunner.mjs";
import { runAmuxV4LocalAnalysisTrigger } from
  "../lib/amux/ideaLocalAnalysisTrigger.mjs";

const failure = { kind: "outcome_unknown", failureStage: "parser_rejected",
  parserReason: "output_contract_mismatch", rejectionPoint: "assistant_shape" };
const codes = { failureStage: "parser_rejected",
  parserReason: "output_contract_mismatch", rejectionPoint: "assistant_shape" };

test("CLI diagnostic projection preserves fixed rejection codes only", () => {
  assert.deepEqual(amuxV4AnalysisCliDiagnostic({ ...failure,
    rawModelOutput: "private response", stderr: "secret", prompt: "private input",
    unexpectedEventType: "private event", approvedConnects: 9,
    usageObservation: { inputTokens: 10 } }), codes);
  for (const kind of ["verified_success", "model_unverified", "refused", "idle"]) {
    assert.equal(amuxV4AnalysisCliDiagnostic({ ...failure, kind }), null);
  }
  assert.equal(amuxV4AnalysisCliDiagnostic(null), null);
  assert.equal(amuxV4AnalysisCliDiagnostic({ ...failure,
    failureStage: "secret\nraw response" }), null);
});

test("unknown codes and incompatible parser fields never reach logs", () => {
  assert.deepEqual(amuxV4AnalysisCliDiagnostic({ ...failure,
    parserReason: "secret", rejectionPoint: "raw output" }), {
    failureStage: "parser_rejected", parserReason: null, rejectionPoint: null,
  });
  assert.deepEqual(amuxV4AnalysisCliDiagnostic({ ...failure,
    parserReason: "served_model_mismatch" }), {
    failureStage: "parser_rejected", parserReason: "served_model_mismatch",
    rejectionPoint: null,
  });
  for (const failureStage of ["deadline", "stdout_limit", "child_nonzero",
    "child_io_error", "setup_or_spawn_error"]) {
    assert.deepEqual(amuxV4AnalysisCliDiagnostic({ ...failure, failureStage }), {
      failureStage, parserReason: null, rejectionPoint: null,
    });
  }
});

test("logging revalidates codes and ignores arbitrary result fields", () => {
  assert.equal(amuxV4AnalysisDiagnosticLog({ kind: "outcome_unknown",
    rawModelOutput: "secret", diagnostic: { ...codes, prompt: "secret" } }),
  `AMUX_V4_LOCAL_ANALYSIS_DIAGNOSTIC ${JSON.stringify(codes)}\n`);
  assert.equal(amuxV4AnalysisDiagnosticLog({ kind: "result_unknown",
    diagnostic: { ...codes, rejectionPoint: "secret\nresponse" } }),
  'AMUX_V4_LOCAL_ANALYSIS_DIAGNOSTIC {"failureStage":"parser_rejected",' +
    '"parserReason":"output_contract_mismatch","rejectionPoint":null}\n');
  for (const diagnostic of [null, {}, { failureStage: "private input" }]) {
    assert.equal(amuxV4AnalysisDiagnosticLog({ kind: "outcome_unknown", diagnostic }), "");
  }
});

test("diagnostics cannot promote outcomes or release an unknown halt", async () => {
  for (const kind of ["draft_ready", "provider_failed", "idle", "disabled",
    "catalog_unapproved", "claim_unknown", "claim_committed_unexecuted"]) {
    const result = { kind };
    assert.equal(amuxV4AnalysisWithCliDiagnostic(result, failure), result);
    assert.equal(amuxV4AnalysisDiagnosticLog({ ...result, diagnostic: codes }), "");
  }
  for (const kind of ["outcome_unknown", "result_unknown"]) {
    let released = false;
    const result = await runAmuxV4LocalAnalysisTrigger(async () =>
      amuxV4AnalysisWithCliDiagnostic({ kind }, failure), {
      claim: async () => true, release: async () => { released = true; },
    });
    assert.deepEqual(result, { kind, diagnostic: codes });
    assert.equal(released, false);
  }
});

test("live wrapper captures diagnostics before discarding unverified output", () => {
  const source = readFileSync(new URL(
    "../lib/amux/ideaLocalAnalysisAgentOnce.mjs", import.meta.url), "utf8");
  assert.match(source, /invoke: async \(\) => \{[\s\S]*?cliDiagnostic = amuxV4AnalysisCliDiagnostic\(cliResult\);/);
  assert.match(source, /return amuxV4VerifiedCliOutputOrNull\(wrapped.result\);/);
  assert.match(source, /return amuxV4AnalysisWithCliDiagnostic\(result,/);
  const script = readFileSync(new URL(
    "../scripts/amux-v4-analysis-agent-once.mjs", import.meta.url), "utf8");
  assert.match(script, /process.stdout.write\(amuxV4AnalysisDiagnosticLog\(result\)\);/);
  assert.doesNotMatch(script, /JSON.stringify\(result\)|console\.(?:log|error)/);
});

test("live unexpected events retain only fixed type and phase through logging", async () => {
  const plan = planAmuxV4AnalysisCliInvocation({ provider: "anthropic",
    modelId: "frontier-anthropic", reasoningEffort: "high" });
  const init = { type: "system", subtype: "init", tools: [] };
  const assistant = { type: "assistant", message: { role: "assistant",
    content: [{ type: "text", text: "PRIVATE_SENTINEL" }] } };
  const phases = [
    ["before_init", []], ["after_init", [init]],
    ["after_assistant", [init, assistant]],
    ["after_result", [init, assistant, { type: "result" }]],
  ];
  for (const [phase, preceding] of phases) {
    const type = phase === "after_assistant" ? "control_request" : "rate_limit_event";
    const stdout = Buffer.from([...preceding, { type, message: "PRIVATE_SENTINEL",
      session_id: "PRIVATE_SENTINEL", secret: "PRIVATE_SENTINEL" }]
      .map((event) => JSON.stringify(event)).join("\n"));
    const inspected = inspectAmuxV4AnalysisCliResult(plan, stdout, 0,
      { diagnostic: true });
    assert.equal(inspected.kind, "outcome_unknown");
    assert.equal(inspected.rejectionPoint, "unexpected_event");
    assert.equal(Object.hasOwn(inspected, "syntheticTrace"), false);
    const cliResult = amuxV4CliUnknownResult("parser_rejected", 0,
      { approved: 1, denied: 0 }, inspected.failureReason,
      inspected.rejectionPoint, inspected);
    const diagnostic = amuxV4AnalysisCliDiagnostic(cliResult);
    assert.deepEqual(diagnostic, { failureStage: "parser_rejected",
      parserReason: "output_contract_mismatch", rejectionPoint: "unexpected_event",
      unexpectedEventType: type, unexpectedEventPhase: phase });
    let released = false;
    const result = await runAmuxV4LocalAnalysisTrigger(async () =>
      amuxV4AnalysisWithCliDiagnostic({ kind: "outcome_unknown" }, cliResult), {
      claim: async () => true, release: async () => { released = true; },
    });
    assert.equal(released, false);
    assert.equal(result.kind, "outcome_unknown");
    const log = amuxV4AnalysisDiagnosticLog(result);
    assert.doesNotMatch(log, /PRIVATE_SENTINEL|syntheticTrace|session_id|secret/);
    assert.deepEqual(JSON.parse(log.slice(log.indexOf(" ") + 1)), diagnostic);
    assert.deepEqual(inspectAmuxV4AnalysisCliResult(plan, stdout, 0),
      { kind: "outcome_unknown" });
  }
});

test("unknown event labels collapse to other and incompatible phases are omitted", () => {
  assert.deepEqual(amuxV4UnexpectedEventDiagnostic("PRIVATE_SENTINEL", "after_init"),
    { unexpectedEventType: "other", unexpectedEventPhase: "after_init" });
  assert.equal(amuxV4UnexpectedEventDiagnostic("system", "PRIVATE_SENTINEL"), null);
  const base = { ...failure, rejectionPoint: "unexpected_event" };
  assert.deepEqual(amuxV4AnalysisCliDiagnostic({ ...base,
    unexpectedEventType: "PRIVATE_SENTINEL", unexpectedEventPhase: "before_init",
    unexpectedSystemSubtype: "PRIVATE_SENTINEL", syntheticTrace: ["PRIVATE_SENTINEL"] }), {
    ...codes, rejectionPoint: "unexpected_event",
    unexpectedEventType: "other", unexpectedEventPhase: "before_init",
  });
  assert.deepEqual(amuxV4AnalysisCliDiagnostic({ ...failure,
    unexpectedEventType: "system", unexpectedEventPhase: "before_init" }), codes);
  assert.deepEqual(amuxV4AnalysisCliDiagnostic({ ...base,
    unexpectedEventType: "system", unexpectedEventPhase: "PRIVATE_SENTINEL" }), {
    ...codes, rejectionPoint: "unexpected_event",
  });
  const unknown = amuxV4CliUnknownResult("deadline", null,
    { approved: 0, denied: 0 }, "output_contract_mismatch", "unexpected_event",
    { unexpectedEventType: "system", unexpectedEventPhase: "before_init" });
  assert.equal(Object.hasOwn(unknown, "unexpectedEventType"), false);
});
