import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { AVAILABLE_MODELS, DEFAULT_MODEL_ID } from "../lib/models.ts";
import { benchmarkDigest, canonicalBenchmarkJson } from "../lib/routerDevelopmentBenchmark.ts";
import { buildTaskProfile } from "../lib/taskProfileCore.ts";
import { replayContractMismatches, replayDevelopment, replayGenerationContract, selectReplayCandidate, validateReplayPolicy } from "../lib/routerDevelopmentReplay.ts";
import { replayPackageCompatible, REPLAY_SCRIPT_COMMAND, REPLAY_SCRIPT_NAME, REPLAY_COLLECTOR_SOURCE_PATHS, REPLAY_CORPUS_PATH, validateReplaySourceFiles } from "../lib/routerDevelopmentReplaySource.ts";
import { control, identity, makeReplayFixture, savedReplayRow } from "./routerDevelopmentReplayFixture.mjs";

const fixture = makeReplayFixture();
const clone = () => structuredClone(fixture);
const changedAnswer = (row, text) => { row.answerText = text; row.answerDigest = benchmarkDigest(text); };

test("baseline cost signals and default-model control preserve the 24-case and 4-observation domains", () => {
  const report = replayDevelopment(fixture);
  const { baseline, candidate, paired, rows } = report.benchmarkDomain;
  assert.equal(report.observationBundle.catalogueModels, 42);
  assert.equal(report.observationBundle.catalogueRows, 1008);
  assert.equal(report.observationBundle.importedRows, 60);
  assert.equal(report.observationBundle.catalogueCoverage.length, 42);
  assert.equal(report.observationBundle.catalogueCoverage.find((row) => row.modelId === "gemini-2-5-flash").apiModel, "gemini-3.5-flash-lite");
  assert.ok(report.observationBundle.catalogueCoverage.every((row) => row.correctnessRate === null));
  assert.equal(baseline.populationCases, 24);
  assert.equal(baseline.availableCases, 4);
  assert.equal(candidate.availableCases, 4);
  assert.equal(baseline.correct, 4);
  assert.equal(candidate.correct, 4);
  assert.equal(paired.changedSelectionCases, 15);
  assert.equal(paired.changedSelectionObservedCases, 3);
  assert.equal(paired.commonObservedCases, 4);
  assert.equal(paired.unavailablePairCases, 20);
  assert.equal(paired.observedSubset.denominator, 4);
  assert.equal(paired.observedSubset.correctOutcomeShareDelta, 0);
  assert.equal(paired.wholePopulationCorrectOutcomeShareDelta, null);
  assert.equal(baseline.wholePopulationCorrectOutcomeShare, null);
  assert.equal(baseline.reportedProviderCostUsd.total, null);
  assert.equal(candidate.reportedProviderCostUsd.total, null);
  assert.equal(report.productCompatibility.productPerformanceDelta, null);
  for (const row of rows.filter((row) => row.baseline.available)) {
    assert.equal(report.productCompatibility.rows.find((entry) => entry.caseId === row.caseId).baseline.comparedFieldsCompatible, false);
  }
  assert.equal(rows.find((row) => row.caseId === "dev-en-calc-01").baseline.modelId, "deepseek-v4-flash");
  assert.equal(rows.find((row) => row.caseId === "dev-en-extract-01").baseline.modelId, DEFAULT_MODEL_ID);
  assert.equal(report.providerCallsByThisTool, 0);
});

test("identity control is zero on complete coverage and null on missing coverage", () => {
  const partial = clone(); partial.candidate = identity;
  const result = replayDevelopment(partial);
  assert.equal(result.benchmarkDomain.paired.changedSelectionCases, 0);
  assert.equal(result.benchmarkDomain.paired.observedSubset.correctOutcomeShareDelta, 0);
  assert.equal(result.benchmarkDomain.paired.wholePopulationCorrectOutcomeShareDelta, null);
  const full = makeReplayFixture({ allCases: true }); full.candidate = identity;
  assert.equal(replayDevelopment(full).benchmarkDomain.paired.wholePopulationCorrectOutcomeShareDelta, 0);
  partial.answers.rows = [];
  const empty = replayDevelopment(partial).benchmarkDomain;
  assert.equal(empty.baseline.unavailableCases, 24);
  assert.equal(empty.paired.observedSubset.correctOutcomeShareDelta, null);
  assert.equal(empty.baseline.failed, 0);
});

test("incorrect, failed, timeout and missing choices keep distinct outcomes and paired counts", () => {
  const input = clone();
  changedAnswer(input.answers.rows.find((row) => row.rowId === "dev-en-calc-01::deepseek-v4-flash"), "{}");
  changedAnswer(input.answers.rows.find((row) => row.rowId === `dev-ko-calc-01::${DEFAULT_MODEL_ID}`), "{}");
  const failed = input.answers.rows.find((row) => row.rowId === "dev-ko-extract-01::deepseek-v4-flash");
  Object.assign(failed, { status: "failed", answerText: null, answerDigest: null, failureCode: "provider_http_error" });
  let result = replayDevelopment(input).benchmarkDomain;
  assert.equal(result.paired.correctedCases, 1);
  assert.equal(result.paired.regressedCases, 1);
  assert.equal(result.paired.acquisitionFailureCases, 1);
  assert.equal(result.paired.recoveredAcquisitionFailureCases, 1);
  assert.equal(result.baseline.failed, 1);
  assert.equal(result.baseline.incorrect, 1);
  assert.equal(result.candidate.incorrect, 1);
  assert.equal(result.paired.observedSubset.correctOutcomeShareDelta, 0.25);
  failed.status = "timeout"; failed.failureCode = "deadline_abort_billing_unknown";
  assert.equal(replayDevelopment(input).benchmarkDomain.baseline.timeout, 1);
  input.answers.rows = input.answers.rows.filter((row) => row.rowId !== `dev-ko-calc-01::${DEFAULT_MODEL_ID}`);
  result = replayDevelopment(input).benchmarkDomain;
  assert.equal(result.paired.commonObservedCases, 3);
  assert.equal(result.paired.regressedCases, 0);
  assert.equal(result.candidate.unavailableCases, 21);
});

test("saved whole-call measurements remain historical and nullable", () => {
  const input = clone();
  input.answers.origin = { kind: "externally-saved", description: "Synthetic observations for metric arithmetic; not real provider measurements." };
  for (const row of input.answers.rows) {
    row.recordedAt = "2026-09-10T00:10:00.000Z";
    row.metrics.latencyMs = row.modelId === DEFAULT_MODEL_ID ? 20 : 10;
  }
  let result = replayDevelopment(input).benchmarkDomain;
  assert.equal(result.baseline.historicalWholeCallLatencyMs.total, 50);
  assert.equal(result.candidate.historicalWholeCallLatencyMs.total, 80);
  assert.equal(result.baseline.reportedProviderCostUsd.total, null);
  input.answers.rows.find((row) => row.rowId === `dev-en-calc-01::${DEFAULT_MODEL_ID}`).metrics.latencyMs = null;
  result = replayDevelopment(input).benchmarkDomain;
  assert.equal(result.candidate.historicalWholeCallLatencyMs.observedCases, 3);
  assert.equal(result.candidate.historicalWholeCallLatencyMs.total, null);
});

test("data-only policy rejects extra fields, duplicate IDs, unknown kinds and unknown models", () => {
  const ids = AVAILABLE_MODELS.map((model) => model.id);
  for (const mutate of [
    (policy) => { policy.caseId = "dev-en-calc-01"; },
    (policy) => { policy.preferences["dev-en-calc-01"] = [DEFAULT_MODEL_ID]; },
    (policy) => { policy.preferences.general = [DEFAULT_MODEL_ID, DEFAULT_MODEL_ID]; },
    (policy) => { policy.preferences.general = ["unregistered-model"]; },
    (policy) => { policy.preferences.general = []; },
    (policy) => { policy.module = "./untrusted.mjs"; },
    (policy) => { policy.fallback = "first-observed-answer"; },
  ]) { const policy = structuredClone(control); mutate(policy); assert.throws(() => validateReplayPolicy(policy, ids)); }
  assert.deepEqual(validateReplayPolicy(identity, ids), identity);
});

test("selection sees only a prompt-derived kind and never bypasses hard eligibility or reads gold", () => {
  const profile = buildTaskProfile({ text: "Return one JSON object from these facts." });
  const input = { profile, eligible: [{ modelId: "deepseek-v4-flash", outputTokens: 128000 }], baselineModelId: "deepseek-v4-flash", policy: control };
  for (const key of ["caseId", "answerText", "expected", "gold", "language", "grade"]) Object.defineProperty(input, key, { get() { throw new Error("evaluation_data_leaked_into_policy"); } });
  assert.deepEqual(selectReplayCandidate(input), { modelId: "deepseek-v4-flash", reason: "original_router_fallback" });
  const admitted = { ...input, eligible: [...input.eligible, { modelId: DEFAULT_MODEL_ID, outputTokens: 128000 }] };
  assert.equal(selectReplayCandidate(admitted).modelId, DEFAULT_MODEL_ID);
  assert.equal(selectReplayCandidate({ ...input, eligible: [], baselineModelId: null }).modelId, null);
});

test("each generation contract dimension matters and actual manifest settings are re-derived", () => {
  const row = fixture.manifest.plan.rows.find((row) => row.rowId === fixture.manifest.calls[0].rowId);
  const contract = replayGenerationContract(row, fixture.manifest.calls[0].settings);
  for (const [key, value] of Object.entries({ apiModel: "other-api", modelId: "other-model", provider: "other-provider", promptDigest: "f".repeat(64), callConfigDigest: "f".repeat(64), maxOutputTokens: 1, settings: { temperature: 0.3 }, search: true, attachments: true, tools: true, maxRetries: 1 })) {
    assert.deepEqual(replayContractMismatches(contract, { ...contract, [key]: value }), [key]);
  }
  const changed = clone();
  changed.manifest.calls[0].settings = { temperature: 0.3 };
  const body = { ...changed.manifest };
  delete body.manifestDigest;
  changed.manifest.manifestDigest = benchmarkDigest(canonicalBenchmarkJson(body));
  assert.throws(() => replayDevelopment(changed), /manifest_snapshot_mismatch/);
});

test("reconstruction refuses forged source, plan, API, cap, answers, duplicate and non-selected observations", () => {
  for (const mutate of [
    (input) => { input.observationSource.benchmark = { ...input.observationSource.benchmark, commit: "c".repeat(40) }; },
    (input) => { input.manifest.plan.rows[0].apiModel = "forged"; },
    (input) => { input.manifest.plan.rows[0].callConfig.proposedMaxOutputTokens = 1; },
    (input) => { input.answers.rows[0].apiModel = "forged"; },
    (input) => { input.answers.rows[0].answerText = "{}"; },
    (input) => { input.answers.rows.push(input.answers.rows[0]); },
    (input) => { const missing = input.manifest.plan.rows.find((row) => row.benchmarkEligibility.eligible && !input.manifest.selectedRowIds.includes(row.rowId)); input.answers.rows.push(savedReplayRow(input.manifest.plan, missing.rowId)); },
  ]) { const input = clone(); mutate(input); assert.throws(() => replayDevelopment(input)); }
});

test("source compatibility permits only the exact additive replay npm script", () => {
  const original = { scripts: { existing: "unchanged" }, dependencies: { x: "1" } };
  const current = { ...original, scripts: { ...original.scripts, [REPLAY_SCRIPT_NAME]: REPLAY_SCRIPT_COMMAND } };
  assert.equal(replayPackageCompatible(JSON.stringify(original), JSON.stringify(current)), true);
  for (const changed of [
    { ...current, dependencies: { x: "2" } },
    { ...current, scripts: { ...current.scripts, existing: "changed" } },
    { ...current, scripts: { ...current.scripts, extra: "arbitrary" } },
    { ...current, scripts: { ...current.scripts, [REPLAY_SCRIPT_NAME]: "node user-supplied.mjs" } },
  ]) assert.equal(replayPackageCompatible(JSON.stringify(original), JSON.stringify(changed)), false);
  const anchored = Object.fromEntries([...REPLAY_COLLECTOR_SOURCE_PATHS, REPLAY_CORPUS_PATH].map((path) => [path, path === "package.json" ? JSON.stringify(original) : "trusted bytes"]));
  const files = { ...anchored, "package.json": JSON.stringify(current) };
  const verified = validateReplaySourceFiles({ observationSourceRef: "a".repeat(40), anchored, current: files });
  assert.equal(Object.keys(verified.benchmark.files).length, 24);
  assert.equal(Object.keys(verified.collector.files).length, 37);
  files["lib/routerSelection.ts"] = "altered selector";
  assert.throws(() => validateReplaySourceFiles({ observationSourceRef: "a".repeat(40), anchored, current: files }), /runtime_source_drift/);
  assert.throws(() => validateReplaySourceFiles({ observationSourceRef: "HEAD", anchored, current: anchored }), /full_sha/);
});

test("report omits prompt, answers and gold and is deterministic", () => {
  const result = replayDevelopment(fixture);
  assert.deepEqual(replayDevelopment(fixture), result);
  const serialized = JSON.stringify(result);
  for (const item of fixture.corpus.cases) assert.ok(!serialized.includes(item.prompt));
  assert.doesNotMatch(serialized, /"(?:answerText|expected|prompt|gold)"\s*:/);
  const source = readFileSync(new URL("../lib/routerDevelopmentReplay.ts", import.meta.url), "utf8");
  const selector = source.slice(source.indexOf("export function selectReplayCandidate"), source.indexOf("type PlannedRow"));
  assert.doesNotMatch(selector, /caseId|answerText|expected|gradeDevelopmentAnswer/);
});
