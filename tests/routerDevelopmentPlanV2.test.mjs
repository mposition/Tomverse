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
  //
  // Re-baselined for `task-profile-v4`. The plan records the Router's versions,
  // so bumping the profile version moves the digest on its own. That is the
  // whole of the difference here and it was checked rather than assumed:
  // substituting "task-profile-v4" back to "task-profile-v3" in the plan body
  // and re-deriving reproduces the previous pair exactly
  // ("1465b4ca…639c63" and "0e480ddd…63621a"). No row, selection, price or
  // catalogue value moved, and no v1 corpus case changed profile.
  //
  // Re-baselined again for two version strings: `router-selection-v3`, the
  // tie-break becoming a partition refinement rather than a pairwise
  // comparator, and `router-full-catalog-diagnostic-v4`, which renamed the
  // finding that rewrite made untrue. The plan records both.
  //
  // The counterfactual is run here rather than described. Substituting the two
  // strings back and re-deriving must reproduce the previous pair exactly,
  // which is what says neither change moved a row of this plan -- the old and
  // new rankings agree on everything the v1 corpus produces. A re-baseline
  // asserted only against itself would say nothing at all.
  //
  // Re-baselined again when `gemini-flash-lite-latest` joined the catalogue
  // (2026-09-28). The plan is one row per case per model, so both digests
  // moved. The previous plan digest was 9f948dd5…6946e5. The substitution
  // below is recomputed on this catalogue and still has to match the pair
  // those two older version strings produce.
  //
  // Re-baselined again on 2026-10-12: `gpt-6-luna` and `claude-haiku-5-5`
  // joined the catalogue (two models, so 48 more rows) and DEFAULT_MODEL_ID --
  // the plan's requested model -- moved to `gpt-6-luna`. Every digest below
  // moved for that reason alone; the previous plan digest was 3386b70b…22a1bc.
  // D03 adds separate, offline per-model coverage to the diagnostic report.
  // The development plan records its version but does not consume those new
  // rows. Substituting v4 for v5 in this exact current body must reproduce
  // the previous plan and serialized digests, proving that no plan row,
  // selection, catalogue entry, or price changed in this re-baseline.
  assert.equal(legacy.versions.router.taskProfile, "task-profile-v4");
  assert.equal(legacy.versions.router.selection, "router-selection-v3");
  assert.equal(legacy.versions.diagnostic, "router-full-catalog-diagnostic-v5");
  assert.equal(legacy.planDigest, "bfd36d19fe37ff50b28bda50c76c2602abded1a51aa1cdf8134ae17019db565f");
  assert.equal(benchmarkDigest(JSON.stringify(legacy)), "77b14cc19cd9df747d954117d3bd00b554e0b1a1e162f055c57780e5ef2492dc");

  // The digest covers the body without itself, and it is written last, so
  // dropping it leaves the remaining keys in the order they were built in.
  const body = { ...legacy };
  delete body.planDigest;
  const asV4 = { ...body, versions: { ...body.versions, diagnostic: "router-full-catalog-diagnostic-v4" } };
  const v4Digest = benchmarkDigest(canonicalBenchmarkJson(asV4));
  assert.equal(v4Digest, "1bb44ad1d5802e97413d8376e99c33237e52b1354b936b2dd668ef043293a92c");
  assert.equal(
    benchmarkDigest(JSON.stringify({ ...asV4, planDigest: v4Digest })),
    "e71f9adc8e6f694949046d7854e23b68c4f40d9148d71dbf179f90b2b28f76a6"
  );
  const asBefore = {
    ...body,
    versions: {
      ...body.versions,
      diagnostic: "router-full-catalog-diagnostic-v3",
      router: { ...body.versions.router, selection: "router-selection-v2" },
    },
  };
  const beforePlanDigest = benchmarkDigest(canonicalBenchmarkJson(asBefore));
  assert.equal(beforePlanDigest, "979a4620bc457b15f97e82a48526ab8cbbb201b838b37957df87d2f291c0cc4a");
  assert.equal(
    benchmarkDigest(JSON.stringify({ ...asBefore, planDigest: beforePlanDigest })),
    "4c74f29bdf473c237e1449f955a77fd3d9150ec4f5102bfb0144466aaeef34a7"
  );
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
