import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const closurePath = "docs/ops/prompt-refiner-quality-evaluation-vnext-one-shot-primitives-closure.json";
const expectedPaths = [
  "docs/ops/prompt-refiner-quality-evaluation-vnext-one-shot-v2-approval.md",
  "lib/promptRefinerQualityEvaluationVnextOneShotRoot.ts",
  "lib/promptRefinerQualityEvaluationVnextOneShotSource.ts",
  "tests/promptRefinerQualityEvaluationVnextOneShotRoot.test.mjs",
  "tests/promptRefinerQualityEvaluationVnextOneShotSource.test.mjs",
  "tests/promptRefinerQualityEvaluationVnextOneShotClosure.test.mjs",
];

test("one-shot primitives are byte-pinned as development-only, not operational authority", () => {
  const closure = JSON.parse(readFileSync(resolve(root, closurePath), "utf8"));
  assert.equal(closure.version, "prompt-refiner-vnext-one-shot-primitives-closure-v1");
  assert.equal(closure.scope, "development_only");
  assert.equal(closure.providerDispatchAuthorized, false);
  assert.equal(closure.operationalSuccessorClosure, false);
  assert.deepEqual(Object.keys(closure.files).sort(), [...expectedPaths].sort());
  for (const path of expectedPaths) {
    assert.match(closure.files[path], /^[0-9a-f]{64}$/);
    const bytes = readFileSync(resolve(root, path));
    assert.equal(createHash("sha256").update(bytes).digest("hex"), closure.files[path], path);
  }
});
