import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const closurePath =
  "docs/ops/prompt-refiner-quality-evaluation-vnext-one-shot-manifest-rubrics-closure.json";
const expectedPaths = [
  "lib/promptRefinerQualityEvaluationVnextOneShotRubric.ts",
  "lib/promptRefinerQualityEvaluationVnextOneShotManifestRubrics.ts",
  "tests/promptRefinerQualityEvaluationVnextOneShotRubric.test.mjs",
  "tests/promptRefinerQualityEvaluationVnextOneShotManifestRubrics.test.mjs",
  "tests/promptRefinerQualityEvaluationVnextOneShotManifestRubricsClosure.test.mjs",
];

test("synthetic one-shot rubric structure is byte-pinned and cannot admit a run", () => {
  const closure = JSON.parse(readFileSync(resolve(root, closurePath), "utf8"));
  assert.equal(closure.version, "prompt-refiner-vnext-one-shot-manifest-rubrics-closure-v1");
  assert.equal(closure.scope, "development_only");
  assert.equal(closure.providerDispatchAuthorized, false);
  assert.equal(closure.fullManifestValidated, false);
  assert.equal(closure.semanticTruthVerified, false);
  assert.deepEqual(Object.keys(closure.files).sort(), [...expectedPaths].sort());
  for (const path of expectedPaths) {
    assert.match(closure.files[path], /^[0-9a-f]{64}$/);
    assert.equal(createHash("sha256").update(readFileSync(resolve(root, path))).digest("hex"),
      closure.files[path], path);
  }
});
