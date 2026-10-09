import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import test from "node:test";
import { canonicalBenchmarkJson } from "../lib/routerDevelopmentBenchmark.ts";
import {
  PROMPT_REFINER_VNEXT_ONE_SHOT_MANIFEST_VERSION,
} from "../lib/promptRefinerQualityEvaluationVnextOneShotRoot.ts";
import {
  verifyPromptRefinerVnextOneShotManifestCore,
} from "../lib/promptRefinerQualityEvaluationVnextOneShotManifestCore.ts";

// Public synthetic metadata, never an independent holdout or answer bundle.
const seedHex = "00".repeat(32);
const preregistrationDigest = "a".repeat(64);
const cellCounts = [
  ["general_rewrite", 8],
  ["injection_framing", 4],
  ["quoted_literal", 4],
  ["code_json_literal", 4],
  ["constraint_negation", 4],
  ["range_number", 4],
  ["forbidden_or_safety_addition", 4],
  ["safety_abstain_direct", 4],
  ["safety_abstain_indirect", 4],
];
const challenges = {
  general_rewrite: ["mixed_language", "constrained_format", "constrained_format"],
  injection_framing: ["adversarial_variant"],
  quoted_literal: ["mixed_language", "constrained_format"],
  code_json_literal: ["mixed_language", "constrained_format"],
  constraint_negation: ["boundary_near_miss", "boundary_near_miss"],
  range_number: ["boundary_near_miss", "boundary_near_miss"],
  forbidden_or_safety_addition: ["adversarial_variant", "mixed_language"],
  safety_abstain_direct: ["adversarial_variant"],
  safety_abstain_indirect: ["adversarial_variant"],
};

function syntheticCases() {
  const seed = Buffer.from(seedHex, "hex");
  return ["ko", "en"].flatMap((language) => {
    const items = cellCounts.flatMap(([baseCell, count]) =>
      Array.from({ length: count }, (_, index) => ({
        language,
        ordinal: 0,
        caseId: "",
        baseCell,
        eligibleChallengeTag: challenges[baseCell][index] ?? null,
        expectedDirection: baseCell.startsWith("safety_abstain_")
          ? "abstain_preferred" : "rewrite_expected",
        allowedAbstentionReasons: baseCell.startsWith("safety_abstain_")
          ? ["unsafe_to_rewrite"] : [],
        sourceText: `synthetic ${language} ${baseCell} ${index + 1}`,
      }))
    );
    items.forEach((item, index) => { item.ordinal = index + 1; });
    const ranked = items.map((item) => ({
      item,
      digest: createHmac("sha256", seed)
        .update(`case-id-v1:${language}:${String(item.ordinal).padStart(3, "0")}`)
        .digest(),
    })).sort((a, b) => Buffer.compare(a.digest, b.digest));
    ranked.forEach(({ item }, index) => {
      item.caseId = `prsvnext-${language}-${String(index + 1).padStart(3, "0")}`;
    });
    return items;
  });
}

function fixture(change = (value) => value) {
  const unsigned = change({
    version: PROMPT_REFINER_VNEXT_ONE_SHOT_MANIFEST_VERSION,
    preregistrationDigest,
    seedHex,
    cases: syntheticCases(),
  });
  const rootDigest = createHash("sha256")
    .update(canonicalBenchmarkJson(unsigned), "utf8").digest("hex");
  return {
    text: JSON.stringify({ ...unsigned, rootDigest }),
    rootDigest,
  };
}

const verify = ({ text, rootDigest }) =>
  verifyPromptRefinerVnextOneShotManifestCore(text, rootDigest, preregistrationDigest);

test("synthetic 80-slot root, HMAC allocation, cells and source bounds are checked", () => {
  assert.deepEqual(verify(fixture()), {
    caseCount: 80,
    allocationValidated: true,
    sourceTextValidated: true,
    fullManifestValidated: false,
    dispatchAuthorized: false,
  });
});

test("a valid root alone cannot excuse a wrong seed or cell assignment", () => {
  const wrongSeed = fixture((value) => ({ ...value, seedHex: "01".repeat(32) }));
  assert.throws(() => verify(wrongSeed), /vnext_allocation_case_id_invalid/);
  const wrongCell = fixture((value) => {
    const item = value.cases.find((candidate) =>
      candidate.language === "ko" && candidate.baseCell === "general_rewrite" &&
      candidate.eligibleChallengeTag === null
    );
    item.baseCell = "injection_framing";
    return value;
  });
  assert.throws(() => verify(wrongCell), /vnext_allocation_cell_quota_invalid/);
});

test("invalid text and post-root mutation fail closed", () => {
  const empty = fixture((value) => {
    value.cases[0].sourceText = " ";
    return value;
  });
  assert.throws(() => verify(empty), /vnext_one_shot_manifest_source_invalid/);
  const original = fixture();
  const mutated = JSON.parse(original.text);
  mutated.cases[0].sourceText = "changed after root";
  assert.throws(
    () => verify({ text: JSON.stringify(mutated), rootDigest: original.rootDigest }),
    /vnext_one_shot_manifest_root_mismatch/
  );
});

test("absent witness and rubric remain explicitly outside this primitive", () => {
  const checked = verify(fixture());
  assert.equal(checked.fullManifestValidated, false);
  assert.equal(checked.dispatchAuthorized, false);
  assert.equal(Object.hasOwn(checked, "rootDigest"), false);
});
