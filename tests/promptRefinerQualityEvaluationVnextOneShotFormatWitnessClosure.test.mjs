import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const closurePath = "docs/ops/prompt-refiner-quality-evaluation-vnext-one-shot-format-witness-closure.json";
const expectedPaths = [
  "lib/promptRefinerQualityEvaluationVnextOneShotFormatWitness.ts",
  "tests/promptRefinerQualityEvaluationVnextOneShotFormatWitness.test.mjs",
  "tests/promptRefinerQualityEvaluationVnextOneShotFormatWitnessClosure.test.mjs",
];

test("synthetic format witness helper and tests are byte-pinned as development-only", () => {
  const closure = JSON.parse(readFileSync(resolve(root, closurePath), "utf8"));
  assert.equal(closure.version, "prompt-refiner-vnext-one-shot-format-witness-closure-v1");
  assert.equal(closure.scope, "development_only");
  assert.equal(closure.providerDispatchAuthorized, false);
  assert.equal(closure.fullManifestValidated, false);
  assert.deepEqual(Object.keys(closure.files).sort(), [...expectedPaths].sort());
  for (const path of expectedPaths) {
    assert.match(closure.files[path], /^[0-9a-f]{64}$/);
    assert.equal(
      createHash("sha256").update(readFileSync(resolve(root, path))).digest("hex"),
      closure.files[path],
      path
    );
  }
});
