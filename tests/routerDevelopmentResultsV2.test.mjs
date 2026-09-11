import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { AVAILABLE_MODELS, DEFAULT_MODEL_ID } from "../lib/models.ts";
import { benchmarkDigest, canonicalBenchmarkJson, validateDevelopmentResults } from "../lib/routerDevelopmentBenchmark.ts";
import { parseDevelopmentCorpusV2, parseDevelopmentPartitionsV2 } from "../lib/routerDevelopmentCorpusV2.ts";
import { buildDevelopmentPlanV2 } from "../lib/routerDevelopmentPlanV2.ts";
import { validateDevelopmentResultsV2, scoreDevelopmentResultsV2 } from "../lib/routerDevelopmentResultsV2.ts";

const read = (name) => readFileSync(new URL(`../docs/ops/router-development-benchmark/${name}`, import.meta.url), "utf8");
const corpus = parseDevelopmentCorpusV2(read("development-v2.json"));
const partitions = parseDevelopmentPartitionsV2(read("development-v2-partitions.json"), corpus);
const source = { commit: "a".repeat(40), dirty: false, files: { fixture: "b".repeat(64) } };
const plan = buildDevelopmentPlanV2({ corpus, partitions, models: AVAILABLE_MODELS, source, plan: "Pro", requestedModelId: DEFAULT_MODEL_ID, createdAt: "2026-09-11T00:00:00.000Z" });
const cases = new Map(corpus.cases.map((item) => [item.id, item]));
const rowResult = (row) => {
  const answerText = JSON.stringify(cases.get(row.caseId).expected);
  return {
    rowId: row.rowId, caseId: row.caseId, modelId: row.modelId, provider: row.provider, apiModel: row.apiModel,
    promptDigest: row.promptDigest, callConfigDigest: row.callConfigDigest,
    status: "succeeded", answerText, answerDigest: benchmarkDigest(answerText), failureCode: null,
    recordedAt: null, providerResponseId: null, modelVersion: null,
    metrics: { inputTokens: null, outputTokens: null, latencyMs: null, providerCostUsd: null },
  };
};
const selected = plan.rows.filter((row) => row.benchmarkEligibility.eligible && [DEFAULT_MODEL_ID, "gpt-5-4-mini"].includes(row.modelId));
const results = {
  schemaVersion: "router-development-results-v2", purpose: "development-only",
  corpusDigest: plan.corpusDigest, partitionDigest: plan.partitionDigest, planDigest: plan.planDigest,
  origin: { kind: "synthetic-fixture", description: "Deterministic test answers only; no provider observations." }, rows: selected.map(rowResult),
};
const score = (value = results) => scoreDevelopmentResultsV2(corpus, partitions, plan, value);
const catalogueRows = corpus.cases.length * AVAILABLE_MODELS.length;

test("v2 scoring keeps all matrix and cell, family, partition, model denominators", () => {
  const report = score();
  assert.equal(report.rows.length, catalogueRows);
  assert.equal(report.summary.catalogueRows, catalogueRows);
  assert.equal(report.summary.submitted, 96);
  assert.equal(report.summary.passed, 96);
  assert.equal(report.summary.correctnessRate, null);
  assert.equal(report.summary.notRun, report.summary.planned - 96);
  assert.equal(report.byCell.length, 8);
  assert.equal(report.byFamily.length, 12);
  assert.equal(report.byPartition.length, 2);
  assert.equal(report.byModel.length, AVAILABLE_MODELS.length);
  for (const groups of [report.byCell, report.byFamily, report.byPartition, report.byModel]) {
    assert.equal(groups.reduce((sum, group) => sum + group.catalogueRows, 0), catalogueRows);
    assert.equal(groups.reduce((sum, group) => sum + group.submitted, 0), 96);
    for (const group of groups) {
      if (!group.planned || group.submitted !== group.planned) assert.equal(group.correctnessRate, null);
    }
  }
  for (const group of report.byCell) { assert.equal(group.catalogueRows, 6 * AVAILABLE_MODELS.length); assert.equal(group.submitted, 12); }
  for (const group of report.byPartition) { assert.equal(group.catalogueRows, 24 * AVAILABLE_MODELS.length); assert.equal(group.submitted, 48); }
  for (const group of report.byFamily) { assert.equal(group.catalogueRows, 4 * AVAILABLE_MODELS.length); assert.equal(group.submitted, 8); }
  assert.equal(report.byModel.find((row) => row.modelId === DEFAULT_MODEL_ID).correctnessRate, 1);
  assert.equal(report.evidenceStatus, "fixture_validation_only");
  assert.equal(report.modelQualityMeasured, false);
  assert.equal(report.decisionEvidence, false);
  for (const metric of Object.values(report.reportedMetrics)) assert.equal(metric.total, null);
});

test("missing, incorrect, failed and timeout rows remain distinct with unchanged denominators", () => {
  const changed = structuredClone(results);
  changed.rows.pop();
  changed.rows[0].answerText = "{}";
  changed.rows[0].answerDigest = benchmarkDigest("{}");
  for (const [index, status] of [[1, "failed"], [2, "timeout"]]) Object.assign(changed.rows[index], { status, answerText: null, answerDigest: null, failureCode: "mock_failure" });
  const report = score(changed);
  assert.equal(report.summary.submitted, 95);
  assert.equal(report.summary.incorrect, 1);
  assert.equal(report.summary.failed, 1);
  assert.equal(report.summary.timeout, 1);
  assert.equal(report.summary.passed, 92);
  assert.equal(report.summary.correctnessRate, null);
  assert.equal(report.summary.catalogueRows, catalogueRows);
  const empty = score({ ...results, rows: [] });
  assert.equal(empty.summary.correctShareOfPlanned, null);
  assert.equal(empty.summary.correctnessRate, null);
});

test("v2 results refuse unknown or duplicate rows, stale bindings and any real measurement claims", () => {
  assert.deepEqual(validateDevelopmentResultsV2(results, plan), results);
  for (const change of [
    (value) => { value.rows.push(value.rows[0]); },
    (value) => { value.rows[0].rowId = "unknown"; },
    (value) => { value.rows[0].modelId = "wrong"; },
    (value) => { value.rows[0].callConfigDigest = "c".repeat(64); },
    (value) => { value.rows[0].metrics.inputTokens = 0; },
    (value) => { value.rows[0].metrics.latencyMs = 0; },
    (value) => { value.rows[0].metrics.providerCostUsd = 0; },
    (value) => { value.rows[0].recordedAt = "2026-09-11T00:00:00.000Z"; },
    (value) => { value.rows[0].providerResponseId = "synthetic"; },
    (value) => { value.origin.kind = "externally-saved"; },
    (value) => { value.partitionDigest = "d".repeat(64); },
    (value) => { value.schemaVersion = "router-development-results-v1"; },
    (value) => { value.rows.push(rowResult(plan.rows.find((row) => !row.benchmarkEligibility.eligible))); },
  ]) {
    const changed = structuredClone(results);
    change(changed);
    assert.throws(() => validateDevelopmentResultsV2(changed, plan));
  }
  assert.throws(() => validateDevelopmentResults(results, plan));
  const extra = { ...results, expected: {} };
  assert.throws(() => validateDevelopmentResultsV2(extra, plan));
});

test("scoring refuses changed plan digests, partition provenance and dropped matrix rows", () => {
  const altered = structuredClone(plan);
  altered.rows.pop();
  assert.throws(() => scoreDevelopmentResultsV2(corpus, partitions, altered, results), /plan_digest_mismatch/);
  const body = { ...altered };
  delete body.planDigest;
  altered.planDigest = benchmarkDigest(canonicalBenchmarkJson(body));
  assert.throws(() => scoreDevelopmentResultsV2(corpus, partitions, altered, { ...results, planDigest: altered.planDigest }), /matrix_coverage/);
  const changedPartition = structuredClone(partitions);
  changedPartition.corpusDigest = "f".repeat(64);
  assert.throws(() => scoreDevelopmentResultsV2(corpus, changedPartition, plan, results), /partition_corpus_digest/);
  for (const change of [
    (value) => { value.rows[0].partition = value.rows[0].partition === "tuning" ? "development-validation" : "tuning"; },
    (value) => { value.rows[0] = structuredClone(value.rows[1]); },
  ]) {
    const changed = structuredClone(plan);
    change(changed);
    const changedBody = { ...changed };
    delete changedBody.planDigest;
    changed.planDigest = benchmarkDigest(canonicalBenchmarkJson(changedBody));
    assert.throws(() => scoreDevelopmentResultsV2(corpus, partitions, changed, { ...results, planDigest: changed.planDigest }), /matrix_identity/);
  }
});
