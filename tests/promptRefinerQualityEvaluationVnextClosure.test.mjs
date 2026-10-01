import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = "docs/ops/prompt-refiner-quality-evaluation-vnext-candidate-source-closure.json";
const expectedPaths = [
    "docs/ops/prompt-refiner-quality-evaluation-vnext-candidate-development.md",
    "docs/ops/prompt-refiner-quality-evaluation-vnext-execution-contract-approval.md",
    "docs/ops/prompt-refiner-quality-evaluation-vnext-numeric-approval.md",
    "docs/ops/prompt-refiner-quality-evaluation-vnext-numeric-spec-draft.md",
    "docs/policy/prompt-refiner-quality-evaluation-vnext-draft.md",
    "lib/promptRefinerQualityEvaluationVnextAggregate.ts",
    "lib/promptRefinerQualityEvaluationVnextAllocation.ts",
    "lib/promptRefinerQualityEvaluationVnextCandidate.ts",
    "lib/promptRefinerQualityEvaluationVnextCore.ts",
    "lib/promptRefinerQualityEvaluationVnextDevelopment.ts",
    "lib/promptRefinerQualityEvaluationVnextExecutionContract.ts",
    "lib/providerUsageCost.ts",
    "lib/routerDevelopmentBenchmark.ts",
    "tests/promptRefinerQualityEvaluationVnextCandidate.test.mjs",
    "tests/promptRefinerQualityEvaluationVnextDevelopment.test.mjs",
];

test("development candidate closure pins every listed source and its tests", () => {
    const manifest = JSON.parse(readFileSync(resolve(root, manifestPath), "utf8"));
    assert.equal(manifest.version, "prompt-refiner-vnext-development-source-closure-v1");
    assert.equal(manifest.scope, "development_only");
    assert.equal(manifest.providerDispatchAuthorized, false);
    assert.deepEqual(Object.keys(manifest.files).sort(), expectedPaths);
    for (const relativePath of expectedPaths) {
        const bytes = readFileSync(resolve(root, relativePath));
        const observed = createHash("sha256").update(bytes).digest("hex");
        assert.match(manifest.files[relativePath], /^[0-9a-f]{64}$/);
        assert.equal(observed, manifest.files[relativePath], relativePath);
    }
});
