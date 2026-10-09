import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { amuxV4AnalysisCliDiagnostic, amuxV4AnalysisWithCliDiagnostic,
  amuxV4AnalysisDiagnosticLog } from
  "../lib/amux/ideaLocalAnalysisDiagnostics.mjs";
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
