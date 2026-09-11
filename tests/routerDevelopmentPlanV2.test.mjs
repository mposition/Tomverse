import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { AVAILABLE_MODELS, DEFAULT_MODEL_ID } from "../lib/models.ts";
import { benchmarkDigest, canonicalBenchmarkJson, DEVELOPMENT_LIMITS, parseBenchmarkJson, parseDevelopmentCorpus } from "../lib/routerDevelopmentBenchmark.ts";
import { buildDevelopmentPlan, validateDevelopmentPlan } from "../lib/routerDevelopmentBenchmarkPlan.ts";
import { parseDevelopmentCorpusV2, parseDevelopmentPartitionsV2 } from "../lib/routerDevelopmentCorpusV2.ts";
import { buildDevelopmentPlanV2, validateDevelopmentPlanV2 } from "../lib/routerDevelopmentPlanV2.ts";
import { buildCollectionManifest } from "../lib/routerDevelopmentCollector.ts";

const read = (name) => readFileSync(new URL(`../docs/ops/router-development-benchmark/${name}`, import.meta.url), "utf8");
const corpus = parseDevelopmentCorpusV2(read("development-v2.json"));
const partitions = parseDevelopmentPartitionsV2(read("development-v2-partitions.json"), corpus);
const source = { commit: "a".repeat(40), dirty: false, files: { fixture: "b".repeat(64) } };
const common = { corpus, partitions, models: AVAILABLE_MODELS, source };
const options = { plan: "Pro", requestedModelId: DEFAULT_MODEL_ID, createdAt: "2026-09-11T00:00:00.000Z" };
const plan = buildDevelopmentPlanV2({ ...common, ...options });
const hash = (value) => benchmarkDigest(canonicalBenchmarkJson(value));
const nodes = (value) => 1 + (value && typeof value === "object" ? Object.values(value).reduce((sum, item) => sum + nodes(item), 0) : 0);

test("shared calculation preserves the exact fixed-input v1 plan bytes and digest", () => {
  const oldCorpus = parseDevelopmentCorpus(read("development-v1.json"));
  const legacy = buildDevelopmentPlan({ ...common, corpus: oldCorpus, ...options });
  // Snapshot-specific regression captured before extraction at base 8646fcb50f868268bc90bf47fe0032c171251b45.
  // A reviewed catalogue/pricing change needs a new baseline; this is not a generic catalogue capacity claim.
  assert.equal(legacy.planDigest, "1465b4ca171c55ddb2b535da5bf3e952fa37dbf03258fd36db495dffba639c63");
  assert.equal(benchmarkDigest(JSON.stringify(legacy)), "0e480ddd0fd50daa52cf9e48ee67d4e86a7163db3ed903b2b4cb5f6e2763621a");
  assert.deepEqual(validateDevelopmentPlan(legacy, { ...common, corpus: oldCorpus }), legacy);
  assert.throws(() => buildDevelopmentPlan({ ...common, ...options }), /corpus_version_or_purpose/);
  assert.throws(() => validateDevelopmentPlan(plan, { ...common, corpus: oldCorpus }), /plan:unexpected_or_missing_fields/);
  assert.throws(() => validateDevelopmentPlanV2(legacy, common), /plan_v2:unexpected_or_missing_fields/);
});

test("v2 retains all 48 cases by the complete current catalogue and their frozen family partitions", () => {
  const expectedRows = corpus.cases.length * AVAILABLE_MODELS.length;
  assert.equal(plan.schemaVersion, "router-development-plan-v2");
  assert.equal(plan.corpusDigest, hash(corpus));
  assert.equal(plan.partitionDigest, hash(partitions));
  assert.equal(plan.rows.length, expectedRows);
  assert.equal(new Set(plan.rows.map((row) => row.rowId)).size, expectedRows);
  assert.equal(plan.summary.cases, 48);
  assert.equal(plan.byCase.length, 48);
  const byFamily = new Map(partitions.families.map((item) => [item.familyId, item.partition]));
  for (const item of corpus.cases) {
    const rows = plan.rows.filter((row) => row.caseId === item.id);
    assert.equal(rows.length, AVAILABLE_MODELS.length);
    for (const row of rows) {
      assert.equal(row.difficulty, item.difficulty);
      assert.equal(row.familyId, item.familyId);
      assert.equal(row.partition, byFamily.get(item.familyId));
      assert.deepEqual(row.input, { prompt: item.prompt });
      assert.equal(row.promptDigest, benchmarkDigest(item.prompt));
      assert.equal(row.benchmarkEligibility.basis, "declared_fixture_requirements_not_router_inference");
      assert.equal(row.benchmarkEligibility.runtimeEligibility, "unverified");
      assert.equal(Object.hasOwn(row, "expected"), false);
      assert.equal(Object.hasOwn(row, "grading"), false);
    }
  }
  assert.equal(plan.summary.completedActualGenerations, 0);
  assert.equal(plan.summary.incurredProviderSpendUsd, 0);
});

test("v2 reconstructs strict snapshots and refuses rehashed tampering or version confusion", () => {
  assert.deepEqual(validateDevelopmentPlanV2(parseBenchmarkJson(canonicalBenchmarkJson(plan)), common), plan);
  const changes = [
    (value) => { value.rows[0].difficulty = "impossible"; },
    (value) => { value.rows[0].partition = value.rows[0].partition === "tuning" ? "development-validation" : "tuning"; },
    (value) => { value.rows[0].familyId = "invented-family"; },
    (value) => { value.rows.pop(); },
    (value) => { value.rows[0].router.selected = !value.rows[0].router.selected; },
    (value) => { value.rows[0].callConfig.proposedMaxOutputTokens = 1; },
    (value) => { value.partitionDigest = "f".repeat(64); },
    (value) => { value.rows[0].input.expected = {}; },
  ];
  for (const change of changes) {
    const changed = structuredClone(plan);
    change(changed);
    const body = { ...changed };
    delete body.planDigest;
    changed.planDigest = hash(body);
    assert.throws(() => validateDevelopmentPlanV2(changed, common), /plan_v2_snapshot_mismatch/);
  }
  assert.throws(() => validateDevelopmentPlanV2(plan, { ...common, source: { ...source, commit: "c".repeat(40) } }), /source_snapshot_mismatch/);
  const moved = structuredClone(partitions);
  [moved.families[0].partition, moved.families[3].partition] = [moved.families[3].partition, moved.families[0].partition];
  assert.throws(() => buildDevelopmentPlanV2({ ...common, partitions: moved, ...options }), /partition_frozen_assignment/);
});

test("full v2 plan and a separate 96-selection manifest fit inherited parser limits", () => {
  const selectedRowIds = plan.rows.filter((row) => row.benchmarkEligibility.eligible && [DEFAULT_MODEL_ID, "gpt-5-4-mini"].includes(row.modelId)).map((row) => row.rowId);
  assert.equal(selectedRowIds.length, 96);
  const manifest = buildCollectionManifest({
    plan, models: AVAILABLE_MODELS, collectorSource: source, selectedRowIds,
    limits: { maxTotalMicroUsd: 900_000_000_000, maxRequestMicroUsd: 900_000_000_000, maxCalls: 1008, requestTimeoutMs: 60000, runTimeoutMs: 60000, expiresAt: "2026-09-12T00:00:00.000Z" },
  });
  assert.equal(manifest.calls.length, 96);
  assert.equal(manifest.plan.rows.length, corpus.cases.length * AVAILABLE_MODELS.length);
  for (const value of [plan, manifest]) {
    const text = canonicalBenchmarkJson(value);
    assert.ok(nodes(value) <= DEVELOPMENT_LIMITS.nodes);
    assert.ok(Buffer.byteLength(text) <= DEVELOPMENT_LIMITS.documentBytes);
    assert.deepEqual(parseBenchmarkJson(text), value);
  }
  assert.throws(() => canonicalBenchmarkJson({ values: Array(DEVELOPMENT_LIMITS.nodes).fill(0) }), /json_complexity_limit/);
  assert.throws(() => buildCollectionManifest({ ...manifest, plan, models: AVAILABLE_MODELS, collectorSource: source, selectedRowIds: Array.from({ length: 1009 }, (_, index) => `invalid-${index}`), limits: manifest.limits }), /selected_rows/);
});
