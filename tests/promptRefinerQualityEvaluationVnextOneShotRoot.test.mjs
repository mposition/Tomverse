import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  PROMPT_REFINER_VNEXT_ONE_SHOT_MANIFEST_VERSION,
  verifyPromptRefinerVnextOneShotManifestRoot,
} from "../lib/promptRefinerQualityEvaluationVnextOneShotRoot.ts";
import { canonicalBenchmarkJson } from "../lib/routerDevelopmentBenchmark.ts";

const preregistrationDigest = "a".repeat(64);
const cases = () => ["ko", "en"].flatMap((language) =>
  Array.from({ length: 40 }, (_, index) => ({
    caseId: `prsvnext-${language}-${String(index + 1).padStart(3, "0")}`,
    sourceText: `synthetic ${language} ${index + 1}`,
    expectedDirection: "rewrite_expected",
  }))
);
const makeManifest = (change = (value) => value) => {
  const rootInput = change({
    version: PROMPT_REFINER_VNEXT_ONE_SHOT_MANIFEST_VERSION,
    preregistrationDigest,
    cases: cases(),
    syntheticOnly: true,
  });
  const rootDigest = createHash("sha256")
    .update(canonicalBenchmarkJson(rootInput), "utf8")
    .digest("hex");
  return { text: JSON.stringify({ ...rootInput, rootDigest }), rootDigest };
};
const verify = (text, rootDigest) =>
  verifyPromptRefinerVnextOneShotManifestRoot(text, rootDigest, preregistrationDigest);

test("owner-runner rehashes all 80 synthetic slots without granting dispatch", () => {
  const { text, rootDigest } = makeManifest();
  assert.deepEqual(verify(text, rootDigest), {
    caseCount: 80,
    koCount: 40,
    enCount: 40,
    fullManifestValidated: false,
    dispatchAuthorized: false,
  });
});

test("any post-seal case content change is rejected before dispatch", () => {
  const { text, rootDigest } = makeManifest();
  const mutated = JSON.parse(text);
  mutated.cases[79].sourceText = "changed synthetic case";
  assert.throws(
    () => verify(JSON.stringify(mutated), rootDigest),
    /vnext_one_shot_manifest_root_mismatch/
  );
});

test("root field cannot authenticate itself or a different precommit", () => {
  const { text, rootDigest } = makeManifest();
  const mutated = JSON.parse(text);
  mutated.rootDigest = "b".repeat(64);
  assert.throws(() => verify(JSON.stringify(mutated), rootDigest), /binding_invalid/);
  assert.throws(
    () => verifyPromptRefinerVnextOneShotManifestRoot(text, rootDigest, "b".repeat(64)),
    /binding_invalid/
  );
});

test("root-only proof never masquerades as full corpus validation", () => {
  const onlyIds = makeManifest((value) => ({
    ...value,
    cases: value.cases.map(({ caseId }) => ({ caseId })),
  }));
  const result = verify(onlyIds.text, onlyIds.rootDigest);
  assert.equal(result.fullManifestValidated, false);
  assert.equal(result.dispatchAuthorized, false);
});

test("missing, duplicate and invalid IDs fail closed", () => {
  const { rootDigest } = makeManifest();
  const missing = makeManifest((value) => ({ ...value, cases: value.cases.slice(1) }));
  assert.throws(() => verify(missing.text, missing.rootDigest), /binding_invalid/);
  const duplicate = makeManifest((value) => {
    value.cases[79].caseId = value.cases[0].caseId;
    return value;
  });
  assert.throws(() => verify(duplicate.text, duplicate.rootDigest), /case_id_invalid/);
  const badId = makeManifest((value) => {
    value.cases[79].caseId = "prsvnext-en-041";
    return value;
  });
  assert.throws(() => verify(badId.text, badId.rootDigest), /case_id_invalid/);
  assert.throws(() => verify(makeManifest().text, rootDigest.toUpperCase()), /input_invalid/);
});

test("non-object manifests and malformed case entries are rejected", () => {
  assert.throws(
    () => verify("[]", "a".repeat(64)),
    /vnext_one_shot_manifest_shape_invalid/
  );
  const malformed = makeManifest((value) => {
    value.cases[0] = null;
    return value;
  });
  assert.throws(() => verify(malformed.text, malformed.rootDigest), /manifest_case_invalid/);
});

test("duplicate JSON keys, malformed JSON and unbounded documents are refused", () => {
  const { text, rootDigest } = makeManifest();
  assert.throws(
    () => verify(text.replace('"syntheticOnly":true', '"syntheticOnly":true,"syntheticOnly":true'), rootDigest),
    /json_invalid/
  );
  assert.throws(() => verify("{", rootDigest), /json_invalid/);
  assert.throws(() => verify("x".repeat(16 * 1024 * 1024 + 1), rootDigest), /input_invalid/);
});
