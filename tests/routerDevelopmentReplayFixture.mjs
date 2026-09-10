import { readFileSync } from "node:fs";
import { AVAILABLE_MODELS, DEFAULT_MODEL_ID } from "../lib/models.ts";
import { benchmarkDigest, canonicalBenchmarkJson, parseDevelopmentCorpus } from "../lib/routerDevelopmentBenchmark.ts";
import { buildDevelopmentPlan } from "../lib/routerDevelopmentBenchmarkPlan.ts";
import { buildCollectionManifest } from "../lib/routerDevelopmentCollector.ts";

export const corpus = parseDevelopmentCorpus(readFileSync(new URL("../docs/ops/router-development-benchmark/development-v1.json", import.meta.url), "utf8"));
export const fixtureSource = { commit: "a".repeat(40), dirty: false, files: { fixture: "b".repeat(64) } };
export const control = { schemaVersion: "router-development-replay-policy-v1", purpose: "development-only", policyId: "default-model-control-v1", preferences: { general: [DEFAULT_MODEL_ID] }, fallback: "original-router" };
export const identity = { ...control, policyId: "identity-control-v1", preferences: {} };
export const observedCaseIds = ["dev-en-calc-01", "dev-en-extract-01", "dev-ko-calc-01", "dev-ko-extract-01"];

export function savedReplayRow(plan, rowId, overrides = {}) {
  const row = plan.rows.find((candidate) => candidate.rowId === rowId);
  const answerText = JSON.stringify(corpus.cases.find((item) => item.id === row.caseId).expected);
  return {
    rowId, caseId: row.caseId, modelId: row.modelId, provider: row.provider, apiModel: row.apiModel,
    promptDigest: row.promptDigest, callConfigDigest: row.callConfigDigest, status: "succeeded",
    answerText, answerDigest: benchmarkDigest(answerText), failureCode: null,
    recordedAt: null, providerResponseId: null, modelVersion: null,
    metrics: { inputTokens: null, outputTokens: null, latencyMs: null, providerCostUsd: null }, ...overrides,
  };
}

export function makeReplayFixture({ source = fixtureSource, collectorSource = source, allCases = false, models = AVAILABLE_MODELS } = {}) {
  const plan = buildDevelopmentPlan({ corpus, models, source, plan: "Pro", requestedModelId: DEFAULT_MODEL_ID, createdAt: "2026-09-10T00:00:00.000Z" });
  const selected = plan.rows.filter((row) => row.benchmarkEligibility.eligible && (allCases || observedCaseIds.includes(row.caseId)));
  const manifest = buildCollectionManifest({
    plan, models, collectorSource, selectedRowIds: selected.map((row) => row.rowId),
    limits: { maxTotalMicroUsd: 900_000_000_000, maxRequestMicroUsd: 900_000_000_000, maxCalls: 1008, requestTimeoutMs: 60000, runTimeoutMs: 60000, expiresAt: "2026-09-11T00:00:00.000Z" },
  });
  const answers = {
    schemaVersion: "router-development-results-v1", purpose: "development-only", corpusDigest: plan.corpusDigest, planDigest: plan.planDigest,
    origin: { kind: "synthetic-fixture", description: "Offline replay test only; no provider observations or calls." },
    rows: selected.map((row) => savedReplayRow(plan, row.rowId)),
  };
  return {
    corpus, models, manifest, answers, candidate: structuredClone(control),
    observationSource: { benchmark: source, collector: collectorSource, corpusFileDigest: benchmarkDigest(canonicalBenchmarkJson(corpus)) },
    replaySource: fixtureSource,
  };
}
