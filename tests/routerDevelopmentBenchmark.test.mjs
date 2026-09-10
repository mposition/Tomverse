import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { AVAILABLE_MODELS, DEFAULT_MODEL_ID } from "../lib/models.ts";
import { resolveCallLimit } from "../lib/routerCallLimits.ts";
import { diagnoseFullCatalog } from "../lib/routerFullCatalogDiagnostic.ts";
import { NO_WEB_SEARCH_BACKENDS } from "../lib/webSearchBackends.ts";
import {
  benchmarkDigest, canonicalBenchmarkJson, DEVELOPMENT_LIMITS, gradeDevelopmentAnswer,
  modelInputForCase, parseBenchmarkJson, parseDevelopmentCorpus, scoreDevelopmentResults,
  strictBenchmarkObject, validateDevelopmentCorpus, validateDevelopmentResults,
} from "../lib/routerDevelopmentBenchmark.ts";
import { buildDevelopmentPlan, validateDevelopmentPlan } from "../lib/routerDevelopmentBenchmarkPlan.ts";

const corpus = parseDevelopmentCorpus(readFileSync(new URL("../docs/ops/router-development-benchmark/development-v1.json", import.meta.url), "utf8"));
const source = { commit: "a".repeat(40), dirty: true, files: { fixture: "b".repeat(64) } };
const models = AVAILABLE_MODELS.filter((model) => [DEFAULT_MODEL_ID, "gpt-5-4-mini", "claude-fable-5", "kimi-k3"].includes(model.id));
const input = { corpus, models, source, requestedModelId: DEFAULT_MODEL_ID, plan: "Pro", createdAt: "2026-09-10T00:00:00.000Z" };
const plan = buildDevelopmentPlan(input);
const eligible = plan.rows.filter((row) => row.benchmarkEligibility.eligible);
const emptyResults = () => ({ schemaVersion: "router-development-results-v1", purpose: "development-only", planDigest: plan.planDigest, corpusDigest: plan.corpusDigest, origin: { kind: "synthetic-fixture", description: "Unit-test answers; no provider was called." }, rows: [] });
const savedRow = (row = eligible[0], overrides = {}) => {
  const answerText = JSON.stringify(corpus.cases.find((item) => item.id === row.caseId).expected);
  return { rowId: row.rowId, caseId: row.caseId, modelId: row.modelId, provider: row.provider, apiModel: row.apiModel, promptDigest: row.promptDigest, callConfigDigest: row.callConfigDigest, status: "succeeded", answerText, answerDigest: benchmarkDigest(answerText), failureCode: null, recordedAt: null, providerResponseId: null, modelVersion: null, metrics: { inputTokens: null, outputTokens: null, latencyMs: null, providerCostUsd: null }, ...overrides };
};

test("semantic grading accepts whitespace and object order, including equivalent numeric syntax", () => {
  const item = { expected: { a: 2, b: { k: [true, null, "한국"] } } };
  assert.deepEqual(gradeDevelopmentAnswer(item, ' { "b": {"k":[true,null,"한국"]}, "a": 2.0 } '), { pass: true, reason: "exact_match" });
});

test("wrong values, omission, extra keys, array order, types and unicode remain wrong", () => {
  const item = { expected: { value: [1, 2], label: "é", missing: null } };
  for (const answer of [
    { value: [1, 9], label: "é", missing: null }, { value: [1, 2], label: "é" },
    { ...item.expected, extra: true }, { value: [2, 1], label: "é", missing: null },
    { value: ["1", 2], label: "é", missing: null }, { ...item.expected, label: "e\u0301" },
    { ...item.expected, label: " é " }, { ...item.expected, missing: false },
  ]) assert.equal(gradeDevelopmentAnswer(item, JSON.stringify(answer)).reason, "value_mismatch");
});

test("blank, prose, fenced JSON and duplicate keys never pass", () => {
  const item = { expected: { a: 1 } };
  for (const answer of ["", " \t\r\n"]) assert.equal(gradeDevelopmentAnswer(item, answer).reason, "blank_answer");
  for (const answer of ['```json\n{"a":1}\n```', 'Answer: {"a":1}', '{"a":9,"a":1}', '{"a":9,"\\u0061":1}', '{"nested":{"a":1,"a":1}}', '{"a":1e999}', '{"a":NaN}', '{"a":01}', '{"a":1,}', '{"a":1}{}']) assert.equal(gradeDevelopmentAnswer(item, answer).reason, "invalid_json");
});

test("parser bounds input bytes, depth and numeric precision without executing input", () => {
  assert.throws(() => parseBenchmarkJson('"' + "x".repeat(100) + '"', 10), /byte_limit/);
  assert.throws(() => parseBenchmarkJson("[".repeat(34) + "0" + "]".repeat(34)), /complexity_limit/);
  assert.throws(() => parseBenchmarkJson("9007199254740993"), /number_out_of_range/);
  assert.throws(() => parseBenchmarkJson('process.exit(7)'), /syntax/);
  assert.equal(gradeDevelopmentAnswer({ expected: { a: 1 } }, '"' + "x".repeat(DEVELOPMENT_LIMITS.answerBytes) + '"').reason, "invalid_json");
  assert.equal(canonicalBenchmarkJson(parseBenchmarkJson('{"__proto__":{"polluted":true}}')), '{"__proto__":{"polluted":true}}');
  assert.equal({}.polluted, undefined);
});

test("decimal precision loss and underflow are invalid instead of a rounded exact match", () => {
  const item = { expected: { available: 14, removedFromUsable: 11 } };
  assert.equal(gradeDevelopmentAnswer(item, '{"available":14.0000000000000001,"removedFromUsable":11}').reason, "invalid_json");
  assert.equal(gradeDevelopmentAnswer(item, '{"available":1.4e1,"removedFromUsable":11.0}').reason, "exact_match");
  assert.equal(gradeDevelopmentAnswer({ expected: { n: 0 } }, '{"n":1e-999}').reason, "invalid_json");
  assert.equal(gradeDevelopmentAnswer({ expected: { n: 0.1 } }, '{"n":0.10000000000000001}').reason, "invalid_json");
  assert.equal(gradeDevelopmentAnswer({ expected: { n: 0.1 } }, '{"n":1e-1}').reason, "exact_match");
});

test("strict schema cannot collide through a NUL-containing key", () => {
  assert.throws(() => strictBenchmarkObject({ "a\0b": 1 }, ["a", "b"], "test"), /unexpected_or_missing/);
});

test("corpus rejects duplicates, unsupported requirements, unknown fields and malformed expectations", () => {
  const mutations = [
    (copy) => copy.cases.pop(), (copy) => { copy.cases[1].id = copy.cases[0].id; },
    (copy) => { copy.cases[1].prompt = copy.cases[0].prompt; },
    (copy) => { copy.cases[0].requirements.needsSearch = true; },
    (copy) => { copy.cases[0].requirements.attachments.push({ mediaType: "image/png" }); },
    (copy) => { copy.cases[0].requirements.tools.push("calculator"); },
    (copy) => { copy.cases[0].grading.arrayOrder = "unordered"; },
    (copy) => { copy.cases[0].grading.stringNormalization = "trim"; },
    (copy) => { copy.cases[0].expected = []; }, (copy) => { copy.cases[0].expected = { x: Infinity }; },
    (copy) => { copy.cases[0].extra = true; }, (copy) => { copy.purpose = "decision"; },
  ];
  for (const mutate of mutations) { const copy = structuredClone(corpus); mutate(copy); assert.throws(() => validateDevelopmentCorpus(copy)); }
});

test("full catalogue matrix keeps disabled, missing context and intrinsic search rows", () => {
  const full = buildDevelopmentPlan({ ...input, models: AVAILABLE_MODELS });
  assert.equal(full.rows.length, 24 * AVAILABLE_MODELS.length);
  for (const item of corpus.cases) assert.deepEqual(full.rows.filter((row) => row.caseId === item.id).map((row) => row.modelId), AVAILABLE_MODELS.map((model) => model.id).sort());
  assert.ok(full.rows.some((row) => row.router.rejectionReason === "disabled"));
  assert.ok(full.rows.some((row) => row.benchmarkEligibility.reasons.includes("benchmark:context_window_undeclared")));
  assert.ok(full.rows.some((row) => row.benchmarkEligibility.reasons.includes("benchmark:intrinsic_search_model_unsupported_v1")));
  assert.equal(full.summary.completedActualGenerations, 0);
  assert.equal(full.summary.incurredProviderSpendUsd, 0);
  assert.equal(full.summary.plannedCalls + full.summary.refusedRows, full.summary.catalogueRows);
});

test("plan is deterministic, binds exact corpus, and exports only prompt as model input", () => {
  assert.deepEqual(plan, buildDevelopmentPlan({ ...input, models: [...models].reverse() }));
  assert.deepEqual(validateDevelopmentPlan(plan, { corpus, models, source }), plan);
  for (const row of plan.rows) {
    assert.deepEqual(Object.keys(row.input), ["prompt"]);
    assert.deepEqual(row.input, modelInputForCase(corpus.cases.find((item) => item.id === row.caseId)));
  }
  assert.ok(!JSON.stringify(plan).includes('"expected":'));
  const changed = structuredClone(corpus); changed.cases[0].expected.extra = "oracle-change";
  assert.notEqual(buildDevelopmentPlan({ ...input, corpus: changed }).corpusDigest, plan.corpusDigest);
  assert.throws(() => validateDevelopmentPlan(plan, { corpus: changed, models, source }), /snapshot_mismatch/);
});

test("fixture requirements govern benchmark admission while original search-inference refusals remain visible", () => {
  const full = buildDevelopmentPlan({ ...input, models: AVAILABLE_MODELS });
  const disagreements = full.rows.filter((row) => row.router.needsCurrentInformation && !row.router.eligible && row.benchmarkEligibility.eligible);
  assert.ok(disagreements.length > 0);
  assert.ok(disagreements.every((row) => row.benchmarkEligibility.basis === "declared_fixture_requirements_not_router_inference"));
  assert.ok(full.summary.routerInferenceMismatchCases.length > 0);
  assert.ok(full.byCase.every((item) => item.plannedCalls > 0));
});

test("per-model answer cap preserves product provenance and original router fit separately", () => {
  const diagnostic = diagnoseFullCatalog({ items: corpus.cases.map((item) => ({ id: item.id, prompt: item.prompt })), models, requestedModelId: DEFAULT_MODEL_ID, plan: "Pro", searchBackendReadiness: NO_WEB_SEARCH_BACKENDS, now: () => Date.parse(input.createdAt) });
  for (const row of plan.rows) {
    const original = diagnostic.items.find((item) => item.itemId === row.caseId);
    assert.equal(row.router.originalRequestOutputCapTokens, original.caps.routerRequestOutputCapTokens);
    assert.equal(row.router.originalReservedInputTokens, original.caps.routerReservedInputTokens);
    assert.equal(row.router.rejectionReason, original.models.find((model) => model.modelId === row.modelId).rejectionReason);
    assert.deepEqual(row.callConfig.callLimit, resolveCallLimit(models.find((model) => model.id === row.modelId), "answer"));
    assert.equal(row.callConfigDigest, benchmarkDigest(canonicalBenchmarkJson(row.callConfig)));
  }
  assert.ok(new Set(plan.models.map((model) => model.callLimit.requestedMaxOutputTokens)).size > 1);
});

test("unknown and duplicate catalogue IDs, forged plans, changed source and unknown plan tiers fail", () => {
  assert.throws(() => buildDevelopmentPlan({ ...input, models: [models[0], models[0]] }), /duplicate/);
  assert.throws(() => buildDevelopmentPlan({ ...input, requestedModelId: "missing" }), /unknown_requested_model/);
  assert.throws(() => buildDevelopmentPlan({ ...input, plan: "Unlimited" }), /tier_invalid/);
  for (const mutate of [
    (copy) => { copy.rows[0].benchmarkEligibility.eligible = !copy.rows[0].benchmarkEligibility.eligible; },
    (copy) => { copy.rows[1] = copy.rows[0]; }, (copy) => { copy.rows[0].modelId = "forged"; },
    (copy) => { copy.summary.plannedCalls = 1; }, (copy) => { copy.planDigest = "c".repeat(64); },
    (copy) => { copy.rows[0].callConfig.proposedMaxOutputTokens = 2048; },
  ]) { const copy = structuredClone(plan); mutate(copy); assert.throws(() => validateDevelopmentPlan(copy, { corpus, models, source }), /snapshot_mismatch/); }
  assert.throws(() => validateDevelopmentPlan(plan, { corpus, models, source: { ...source, commit: "c".repeat(40) } }), /source_snapshot_mismatch/);
});

test("no results means not_run and null correctness/metrics, never pass or tie", () => {
  const score = scoreDevelopmentResults(corpus, plan, emptyResults());
  assert.equal(score.summary.notRun, eligible.length);
  assert.equal(score.summary.passed, 0);
  assert.equal(score.summary.failed, 0);
  assert.equal(score.summary.correctnessRate, null);
  assert.equal(score.summary.correctShareOfPlanned, null);
  assert.equal(score.summary.coverage, 0);
  assert.equal(score.reportedMetrics.providerCostUsd.total, null);
});

test("partial and complete scoring keep failures/invalid/blank in the planned denominator", () => {
  const results = emptyResults(); results.rows = [savedRow()];
  const partial = scoreDevelopmentResults(corpus, plan, results);
  assert.equal(partial.summary.correctnessRate, null);
  assert.equal(partial.summary.notRun, eligible.length - 1);
  assert.equal(partial.summary.correctShareOfPlanned, 1 / eligible.length);
  results.rows = eligible.map((row) => savedRow(row));
  const complete = scoreDevelopmentResults(corpus, plan, results);
  assert.equal(complete.summary.correctnessRate, 1);
  assert.equal(complete.verifiedActualGenerations, 0);
  const texts = ["", "not JSON", "{}"]; texts.forEach((answerText, i) => { results.rows[i] = savedRow(eligible[i], { answerText, answerDigest: benchmarkDigest(answerText) }); });
  results.rows[3] = savedRow(eligible[3], { status: "failed", answerText: null, answerDigest: null, failureCode: "provider_error" });
  results.rows[4] = savedRow(eligible[4], { status: "timeout", answerText: null, answerDigest: null, failureCode: "timeout" });
  const score = scoreDevelopmentResults(corpus, plan, results);
  for (const field of ["blank", "invalidJson", "incorrect", "failed", "timeout"]) assert.equal(score.summary[field], 1);
  assert.equal(score.summary.planned, eligible.length);
  assert.equal(score.summary.correctnessRate, (eligible.length - 5) / eligible.length);
});

test("saved result rows reject unknown, duplicate, forged and extra fields", () => {
  for (const mutate of [
    (results) => results.rows.push(results.rows[0]),
    (results) => { results.rows[0].rowId = "unknown::model"; },
    ...["caseId", "modelId", "provider", "apiModel", "promptDigest", "callConfigDigest", "answerDigest"].map((key) => (results) => { results.rows[0][key] = "forged"; }),
    (results) => { delete results.rows[0].metrics.latencyMs; },
    (results) => { results.rows[0].metrics.providerCostUsd = -1; },
    (results) => { results.rows[0].extra = true; },
    (results) => { results.planDigest = "d".repeat(64); },
    (results) => { results.rows[0].status = "not_run"; },
    (results) => { results.rows[0].failureCode = "failed"; },
    (results) => { results.rows[0].metrics.inputTokens = 100; },
  ]) { const results = emptyResults(); results.rows = [savedRow()]; mutate(results); assert.throws(() => validateDevelopmentResults(results, plan)); }
});

test("external saved records remain self-reported, missing metrics remain null and rescore is deterministic", () => {
  const results = emptyResults(); results.origin = { kind: "externally-saved", description: "Imported from a separately authorized run; not authenticated here." };
  results.rows = [savedRow(eligible[0], { recordedAt: "2026-09-10T00:01:00.000Z", metrics: { inputTokens: 50, outputTokens: 20, latencyMs: 120, providerCostUsd: 0.01 } }), savedRow(eligible[1], { recordedAt: "2026-09-10T00:01:02.000Z" })];
  const score = scoreDevelopmentResults(corpus, plan, results);
  assert.equal(score.evidenceStatus, "self_reported_saved_answers_unverified");
  assert.equal(score.verifiedActualGenerations, 0);
  assert.equal(score.reportedMetrics.providerCostUsd.observedRows, 1);
  assert.equal(score.reportedMetrics.providerCostUsd.total, null);
  assert.deepEqual(scoreDevelopmentResults(corpus, plan, structuredClone(results)), score);
});

test("the benchmark's transitive production import graph has no provider dispatch or I/O modules", () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const pending = ["lib/routerDevelopmentBenchmark.ts", "lib/routerDevelopmentBenchmarkPlan.ts"];
  const seen = new Set();
  while (pending.length) {
    const path = pending.pop(); if (seen.has(path)) continue; seen.add(path);
    const text = readFileSync(resolve(root, path), "utf8");
    const code = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/^import\s+type\b[\s\S]*?;/gm, "");
    for (const match of code.matchAll(/(?:from\s*|import\s*)["']([^"']+)["']/g)) {
      const specifier = match[1];
      if (specifier === "node:crypto") continue;
      assert.ok(specifier.startsWith("./") || specifier.startsWith("@/lib/"), `${path} imports non-pure ${specifier}`);
      const target = specifier.startsWith("@/") ? specifier.slice(2) : resolve(dirname(resolve(root, path)), specifier).slice(root.length + 1).replaceAll("\\", "/");
      pending.push(target.endsWith(".ts") ? target : `${target}.ts`);
    }
    assert.doesNotMatch(code, /\b(?:fetch|generateText|streamText|getActiveAiModel|eval)\s*\(/, path);
  }
});
