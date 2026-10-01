import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { validatePromptRefinerVnextAllocationProjection } from "../lib/promptRefinerQualityEvaluationVnextAllocation.ts";

// Synthetic metadata only: this is not a holdout, manifest, or run fixture.
const seedHex = "00".repeat(32);
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
const assignments = {
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

function projection(selectedSeedHex = seedHex) {
    const seed = Buffer.from(selectedSeedHex, "hex");
    const cases = ["ko", "en"].flatMap((language) => {
        const items = cellCounts.flatMap(([baseCell, count]) =>
            Array.from({ length: count }, (_, index) => ({
                language,
                ordinal: 0,
                caseId: "",
                baseCell,
                eligibleChallengeTag: assignments[baseCell][index] ?? null,
                expectedDirection: baseCell.startsWith("safety_abstain_")
                    ? "abstain_preferred"
                    : "rewrite_expected",
                allowedAbstentionReasons: baseCell.startsWith("safety_abstain_")
                    ? ["unsafe_to_rewrite"]
                    : [],
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
    return { version: "allocation-projection-v1", seedHex: selectedSeedHex, cases };
}

const validate = (value) => validatePromptRefinerVnextAllocationProjection(JSON.stringify(value));

test("80 synthetic metadata slots satisfy exact language, cell, challenge and HMAC allocation", () => {
    const input = projection();
    assert.equal(input.cases.length, 80);
    assert.equal(validate(input), undefined);
    assert.equal(validate({ ...input, cases: [...input.cases].reverse() }), undefined);
    assert.equal(new Set(input.cases.map((item) => item.caseId)).size, 80);
    assert.equal(input.cases.find((item) => item.language === "ko" && item.ordinal === 30).caseId, "prsvnext-ko-001");
    assert.equal(input.cases.find((item) => item.language === "en" && item.ordinal === 12).caseId, "prsvnext-en-001");
    assert.equal(validate(projection("9f".repeat(32))), undefined);
});

test("wrong seed, rank, duplicate ordinal or incomplete universe is rejected", () => {
    const input = projection();
    assert.throws(() => validate({ ...input, seedHex: "01".repeat(32) }), /vnext_allocation_case_id_invalid/);
    assert.throws(() => validate({ ...input, seedHex: "f".repeat(63) }), /vnext_allocation_header_invalid/);
    assert.throws(() => validate({ ...input, version: "allocation-projection-v2" }), /vnext_allocation_header_invalid/);
    const wrongRank = structuredClone(input);
    wrongRank.cases[0].caseId = "prsvnext-ko-040";
    assert.throws(() => validate(wrongRank), /vnext_allocation_case_id_invalid/);
    const duplicate = structuredClone(input);
    duplicate.cases[1].ordinal = duplicate.cases[0].ordinal;
    assert.throws(() => validate(duplicate), /vnext_allocation_duplicate_ordinal/);
    assert.throws(() => validate({ ...input, cases: input.cases.slice(1) }), /vnext_allocation_case_count_invalid/);
    const sequential = structuredClone(input);
    sequential.cases.forEach((item) => {
        item.caseId = `prsvnext-${item.language}-${String(item.ordinal).padStart(3, "0")}`;
    });
    assert.throws(() => validate(sequential), /vnext_allocation_case_id_invalid/);
});

test("cell, challenge, direction and allowed-reason quotas fail closed", () => {
    const input = projection();
    const wrongCell = structuredClone(input);
    wrongCell.cases[0].baseCell = "injection_framing";
    assert.throws(() => validate(wrongCell), /vnext_allocation_challenge_cell_invalid/);
    const wrongCellQuota = structuredClone(input);
    const untaggedGeneral = wrongCellQuota.cases.find((item) =>
        item.language === "ko" && item.baseCell === "general_rewrite" && item.eligibleChallengeTag === null
    );
    untaggedGeneral.baseCell = "injection_framing";
    assert.throws(() => validate(wrongCellQuota), /vnext_allocation_cell_quota_invalid/);
    for (const badCell of ["unknown_cell", "constructor"]) {
        const invalid = structuredClone(input);
        invalid.cases[0].baseCell = badCell;
        assert.throws(() => validate(invalid), /vnext_allocation_cell_invalid/);
    }
    const missingChallenge = structuredClone(input);
    missingChallenge.cases[0].eligibleChallengeTag = null;
    assert.throws(() => validate(missingChallenge), /vnext_allocation_challenge_quota_invalid/);
    const wrongTagCell = structuredClone(input);
    wrongTagCell.cases[0].eligibleChallengeTag = "boundary_near_miss";
    assert.throws(() => validate(wrongTagCell), /vnext_allocation_challenge_cell_invalid/);
    for (const badTag of ["unknown_tag", 5]) {
        const invalid = structuredClone(input);
        invalid.cases[0].eligibleChallengeTag = badTag;
        assert.throws(() => validate(invalid), /vnext_allocation_challenge_invalid/);
    }
    const wrongDirection = structuredClone(input);
    wrongDirection.cases[0].expectedDirection = "abstain_preferred";
    assert.throws(() => validate(wrongDirection), /vnext_case_reasons_invalid/);
    const safetyAsRewrite = structuredClone(input);
    const safetyCase = safetyAsRewrite.cases.find((item) => item.baseCell === "safety_abstain_direct");
    safetyCase.expectedDirection = "rewrite_expected";
    safetyCase.allowedAbstentionReasons = [];
    assert.throws(() => validate(safetyAsRewrite), /vnext_allocation_direction_invalid/);
    const wrongSafetyReason = structuredClone(input);
    const safety = wrongSafetyReason.cases.find((item) => item.baseCell === "safety_abstain_direct");
    safety.allowedAbstentionReasons = [];
    assert.throws(() => validate(wrongSafetyReason), /vnext_case_reasons_invalid/);
    for (const badOrdinal of [0, 41]) {
        const invalid = structuredClone(input);
        invalid.cases[0].ordinal = badOrdinal;
        assert.throws(() => validate(invalid), /vnext_allocation_ordinal_invalid/);
    }
    const wrongLanguage = structuredClone(input);
    wrongLanguage.cases[0].language = "ja";
    assert.throws(() => validate(wrongLanguage), /vnext_allocation_language_invalid/);
});

test("strict JSON projection rejects content, duplicate fields and non-JSON text", () => {
    const input = projection();
    const contentLeak = structuredClone(input);
    contentLeak.cases[0].prompt = "not allowed in content-free projection";
    assert.throws(() => validate(contentLeak), /vnext_allocation_case:unexpected_or_missing_fields/);
    assert.throws(() => validatePromptRefinerVnextAllocationProjection('{"version":1,"version":2}'), /vnext_allocation_json_invalid/);
    assert.throws(() => validatePromptRefinerVnextAllocationProjection('```json\n{}\n```'), /vnext_allocation_json_invalid/);
    assert.throws(() => validatePromptRefinerVnextAllocationProjection(`\ufeff${JSON.stringify(input)}`), /vnext_allocation_json_invalid/);
});
