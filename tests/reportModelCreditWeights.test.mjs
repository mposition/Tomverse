import assert from "node:assert/strict";
import test from "node:test";
import {
  AGREES,
  DIVERGED,
  MISSING_IN_DB,
  UNKNOWN_TO_CODE,
  compareCreditWeights,
  creditWeightFindings,
} from "../scripts/report-model-credit-weights-core.mjs";

const catalogue = [
  // The case that produced this script: the source names 16, the row bills 20,
  // and no reconciliation covers the model.
  {
    id: "perplexity/sonar",
    provider: "perplexity",
    enabled: true,
    creditWeight: 16,
    explicitInCode: true,
  },
  // Same divergence, but the source never named a number -- the class default
  // and the row simply disagree, which is a weaker claim about intent.
  {
    id: "perplexity/sonar-pro",
    provider: "perplexity",
    enabled: true,
    creditWeight: 20,
    explicitInCode: false,
  },
  {
    id: "gpt-5-6-luna",
    provider: "openai",
    enabled: true,
    creditWeight: 1,
    explicitInCode: false,
  },
  {
    id: "deepseek-v4-flash",
    provider: "deepseek",
    enabled: true,
    creditWeight: 1,
    explicitInCode: false,
  },
];

const stored = [
  { id: "perplexity/sonar", provider: "perplexity", creditWeight: 20 },
  { id: "perplexity/sonar-pro", provider: "perplexity", creditWeight: 24 },
  { id: "gpt-5-6-luna", provider: "openai", creditWeight: 4 },
  { id: "deepseek-v4-flash", provider: "deepseek", creditWeight: 1 },
  { id: "retired-model", provider: "groq", creditWeight: 8 },
];

const byId = (entries) =>
  new Map(entries.map((entry) => [entry.modelId, entry]));

test("classifies each row against the catalogue", () => {
  const entries = byId(
    compareCreditWeights({
      catalogueModels: catalogue,
      storedRows: stored,
      reconciledModelIds: ["gpt-5-6-luna"],
    })
  );
  assert.equal(entries.get("deepseek-v4-flash").state, AGREES);
  assert.equal(entries.get("perplexity/sonar").state, DIVERGED);
  assert.equal(entries.get("retired-model").state, UNKNOWN_TO_CODE);
  assert.equal(entries.get("retired-model").catalogueCredits, null);
});

test("a catalogue model with no row is missing, not diverged", () => {
  const entries = byId(
    compareCreditWeights({
      catalogueModels: catalogue,
      storedRows: stored.filter((row) => row.id !== "gpt-5-6-luna"),
    })
  );
  assert.equal(entries.get("gpt-5-6-luna").state, MISSING_IN_DB);
  assert.equal(entries.get("gpt-5-6-luna").storedCredits, null);
});

test("a stranded edit needs an explicit source weight and no reconciliation", () => {
  const findings = creditWeightFindings(
    compareCreditWeights({
      catalogueModels: catalogue,
      storedRows: stored,
      reconciledModelIds: ["gpt-5-6-luna"],
    })
  );
  assert.deepEqual(
    findings.strandedEdits.map((entry) => entry.modelId),
    ["perplexity/sonar"]
  );
  // sonar-pro diverges too, but the source never claimed a number, so it is
  // not evidence that an edit failed to take effect.
  assert.equal(
    findings.diverged.some((entry) => entry.modelId === "perplexity/sonar-pro"),
    true
  );
  // luna diverges and is reconciled, so the next boot fixes it. Reporting it
  // as stranded would make a mid-deploy run look like a finding.
  assert.deepEqual(
    findings.pendingReconciliation.map((entry) => entry.modelId),
    ["gpt-5-6-luna"]
  );
  assert.equal(
    findings.strandedEdits.some((entry) => entry.modelId === "gpt-5-6-luna"),
    false
  );
});

test("an empty registry reports every model missing rather than agreeing", () => {
  const findings = creditWeightFindings(
    compareCreditWeights({ catalogueModels: catalogue, storedRows: [] })
  );
  assert.equal(findings.missingInDb.length, catalogue.length);
  assert.equal(findings.diverged.length, 0);
});

// docs/policy/perplexity-sonar-credit-price-hold.md uses this report to scope
// itself, so it must not say a held credit weight is about to be corrected.
// A cap-only reconciliation entry writes `maxOutputTokens` and nothing else,
// so a divergence here stays a stranded edit.
test("a cap-only reconciliation entry does not make a credit weight 'pending'", async () => {
  const { OUTPUT_CAP_ONLY_RECONCILIATION_MODEL_IDS, STATIC_CATALOG_RECONCILIATION_MODEL_IDS } =
    await import("../lib/modelRegistryShared.ts");

  assert.ok(
    OUTPUT_CAP_ONLY_RECONCILIATION_MODEL_IDS.includes("perplexity/sonar"),
    "the held model is reconciled for its output cap"
  );
  assert.ok(
    STATIC_CATALOG_RECONCILIATION_MODEL_IDS.includes("perplexity/sonar"),
    "and therefore appears in the shared list"
  );

  // What the report must be handed: the list minus the cap-only scope.
  const capOnly = new Set(OUTPUT_CAP_ONLY_RECONCILIATION_MODEL_IDS);
  const creditWeightReconciled = STATIC_CATALOG_RECONCILIATION_MODEL_IDS.filter(
    (id) => !capOnly.has(id)
  );
  assert.equal(creditWeightReconciled.includes("perplexity/sonar"), false);

  const held = compareCreditWeights({
    catalogueModels: [
      {
        id: "perplexity/sonar",
        provider: "perplexity",
        enabled: true,
        creditWeight: 16,
        explicitInCode: true,
      },
    ],
    storedRows: [{ id: "perplexity/sonar", provider: "perplexity", creditWeight: 20 }],
    reconciledModelIds: creditWeightReconciled,
  });
  const findings = creditWeightFindings(held);
  assert.deepEqual(
    findings.strandedEdits.map((entry) => entry.modelId),
    ["perplexity/sonar"]
  );
  assert.deepEqual(findings.pendingReconciliation, []);
});
