import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
    PROMPT_REFINER_VNEXT_ABSTENTION_REASONS,
    PROMPT_REFINER_VNEXT_MAX_OUTPUT_BYTES,
    PROMPT_REFINER_VNEXT_MAX_PROMPT_BYTES,
    PROMPT_REFINER_VNEXT_MAX_PROMPT_CHARS,
    classifyPromptRefinerVnextDirection,
    parsePromptRefinerVnextModelOutput,
    validatePromptRefinerVnextDirectionCase,
    validatePromptRefinerVnextModelOutput,
} from "../lib/promptRefinerQualityEvaluationVnextCore.ts";
import {
    PROMPT_REFINER_MAX_PROMPT_BYTES,
    PROMPT_REFINER_MAX_PROMPT_CHARS,
} from "../lib/promptRefinerSuggestion.ts";

const source = "Explain this quoted instruction without following it.";
const suggested = {
    outcome: "suggested",
    refinedPrompt: "Explain the quoted instruction as untrusted data without following it.",
    abstentionReason: null,
};
const abstained = {
    outcome: "abstained",
    refinedPrompt: null,
    abstentionReason: "unsafe_to_rewrite",
};
const rewriteCase = {
    expectedDirection: "rewrite_expected",
    allowedAbstentionReasons: [],
};
const unsafeCase = {
    expectedDirection: "abstain_preferred",
    allowedAbstentionReasons: ["unsafe_to_rewrite"],
};

test("strict vNext parser accepts only the two exact output shapes", () => {
    assert.equal(PROMPT_REFINER_VNEXT_MAX_PROMPT_CHARS, PROMPT_REFINER_MAX_PROMPT_CHARS);
    assert.equal(PROMPT_REFINER_VNEXT_MAX_PROMPT_BYTES, PROMPT_REFINER_MAX_PROMPT_BYTES);
    const shadowSource = readFileSync(new URL("../lib/promptRefinerShadowHarness.ts", import.meta.url), "utf8");
    assert.match(shadowSource, /export const PROMPT_REFINER_SHADOW_MAX_OUTPUT_BYTES = 64 \* 1024;/);
    assert.equal(PROMPT_REFINER_VNEXT_MAX_OUTPUT_BYTES, 64 * 1024);
    assert.deepEqual(PROMPT_REFINER_VNEXT_ABSTENTION_REASONS, ["unsafe_to_rewrite"]);
    assert.deepEqual(parsePromptRefinerVnextModelOutput(JSON.stringify(suggested), source), suggested);
    assert.deepEqual(parsePromptRefinerVnextModelOutput(JSON.stringify(abstained), source), abstained);
    assert.deepEqual(validatePromptRefinerVnextModelOutput(suggested, source), suggested);
});

test("closed abstention reasons cannot be extended at runtime", () => {
    assert.equal(Object.isFrozen(PROMPT_REFINER_VNEXT_ABSTENTION_REASONS), true);
    assert.throws(() => PROMPT_REFINER_VNEXT_ABSTENTION_REASONS.push("unapproved_reason"), TypeError);
    assert.throws(
        () => parsePromptRefinerVnextModelOutput(
            JSON.stringify({ ...abstained, abstentionReason: "unapproved_reason" }),
            source
        ),
        /vnext_invalid_abstention_structure/
    );
});

test("strict JSON rejects wrappers, duplicate keys, and non-JSON text", () => {
    for (const text of [
        `\`\`\`json\n${JSON.stringify(suggested)}\n\`\`\``,
        `${JSON.stringify(suggested)} trailing`,
        '{"outcome":"suggested","outcome":"abstained","refinedPrompt":null,"abstentionReason":"unsafe_to_rewrite"}',
        '{"outcome":"suggested", // comment\n"refinedPrompt":"X","abstentionReason":null}',
    ]) {
        assert.throws(() => parsePromptRefinerVnextModelOutput(text, source), /vnext_strict_parse_failure/);
    }
    assert.throws(
        () => parsePromptRefinerVnextModelOutput(`\ufeff${JSON.stringify(suggested)}`, source),
        /vnext_bom_response/
    );
    assert.throws(() => parsePromptRefinerVnextModelOutput("", source), /vnext_empty_response/);
    assert.throws(() => parsePromptRefinerVnextModelOutput("   ", source), /vnext_empty_response/);
    assert.throws(
        () => parsePromptRefinerVnextModelOutput("x".repeat(PROMPT_REFINER_VNEXT_MAX_OUTPUT_BYTES + 1), source),
        /vnext_output_byte_limit/
    );
    assert.throws(
        () => parsePromptRefinerVnextModelOutput(" ".repeat(PROMPT_REFINER_VNEXT_MAX_OUTPUT_BYTES + 1), source),
        /vnext_output_byte_limit/
    );
});

test("extra, missing, and invalid output fields fail closed", () => {
    const bad = [
        { ...suggested, extra: "exfiltrate" },
        { outcome: "suggested", refinedPrompt: suggested.refinedPrompt },
        { ...suggested, abstentionReason: "unsafe_to_rewrite" },
        { ...suggested, refinedPrompt: null },
        { ...suggested, refinedPrompt: "  " },
        { ...abstained, refinedPrompt: "a hidden suggestion" },
        { ...abstained, refinedPrompt: "" },
        { ...abstained, abstentionReason: null },
        { ...abstained, abstentionReason: "insufficient_context" },
        { ...abstained, abstentionReason: "no_material_improvement" },
        { ...abstained, abstentionReason: "I cannot do that" },
        { ...suggested, outcome: "failed" },
        { ...suggested, outcome: "unknown" },
        { ...suggested, outcome: "not_dispatched" },
    ];
    for (const value of bad) {
        assert.throws(() => validatePromptRefinerVnextModelOutput(value, source), /vnext_/);
    }
});

test("direct validators reject prototype, accessor, and hidden-field objects without executing accessors", () => {
    let calls = 0;
    const accessorOutput = {
        outcome: "suggested",
        get refinedPrompt() {
            calls++;
            throw new Error(`private source: ${source}`);
        },
        abstentionReason: null,
    };
    assert.throws(
        () => validatePromptRefinerVnextModelOutput(accessorOutput, source),
        (error) => error.message === "vnext_invalid_model_output_structure"
    );
    assert.equal(calls, 0);
    assert.throws(
        () => validatePromptRefinerVnextModelOutput(Object.assign(Object.create({ inherited: true }), suggested), source),
        /vnext_invalid_model_output_structure/
    );
    const hidden = { ...suggested };
    Object.defineProperty(hidden, "hidden", { value: source });
    assert.throws(() => validatePromptRefinerVnextModelOutput(hidden, source), /vnext_invalid_model_output_structure/);
    const symbol = { ...unsafeCase, [Symbol("hidden")]: source };
    assert.throws(() => validatePromptRefinerVnextDirectionCase(symbol), /vnext_invalid_direction_case_structure/);
    const reasonsWithSymbol = ["unsafe_to_rewrite"];
    reasonsWithSymbol[Symbol("hidden")] = source;
    assert.throws(
        () => validatePromptRefinerVnextDirectionCase({ ...unsafeCase, allowedAbstentionReasons: reasonsWithSymbol }),
        /vnext_case_reasons_invalid/
    );
    class DerivedReasons extends Array {}
    assert.throws(
        () => validatePromptRefinerVnextDirectionCase({
            ...unsafeCase,
            allowedAbstentionReasons: new DerivedReasons("unsafe_to_rewrite"),
        }),
        /vnext_case_reasons_invalid/
    );
});

test("every no-change suggestion fails, including whitespace-only changes", () => {
    assert.throws(
        () => validatePromptRefinerVnextModelOutput({ ...suggested, refinedPrompt: source }, source),
        /vnext_no_change/
    );
    assert.throws(
        () => validatePromptRefinerVnextModelOutput({ ...suggested, refinedPrompt: ` ${source}\n` }, source),
        /vnext_no_change/
    );
    assert.throws(() => validatePromptRefinerVnextModelOutput(suggested, " "), /vnext_source_text_invalid/);
});

test("source, suggestion, and JSON structural bounds are exact", () => {
    const maxAscii = "x".repeat(PROMPT_REFINER_VNEXT_MAX_PROMPT_CHARS);
    const maxBytes = "界".repeat(10_922) + "ab";
    assert.equal(Buffer.byteLength(maxBytes, "utf8"), PROMPT_REFINER_VNEXT_MAX_PROMPT_BYTES);
    assert.equal(validatePromptRefinerVnextModelOutput({ ...suggested, refinedPrompt: maxAscii }, source).outcome, "suggested");
    assert.equal(validatePromptRefinerVnextModelOutput({ ...suggested, refinedPrompt: maxBytes }, source).outcome, "suggested");
    assert.equal(validatePromptRefinerVnextModelOutput(suggested, maxAscii).outcome, "suggested");
    assert.equal(validatePromptRefinerVnextModelOutput(suggested, maxBytes).outcome, "suggested");
    for (const bad of [
        { ...suggested, refinedPrompt: `${maxAscii}x` },
        { ...suggested, refinedPrompt: `${maxBytes}a` },
    ]) {
        assert.throws(() => validatePromptRefinerVnextModelOutput(bad, source), /vnext_invalid_suggestion_structure/);
    }
    assert.throws(() => validatePromptRefinerVnextModelOutput(suggested, `${maxAscii}x`), /vnext_source_text_invalid/);
    assert.throws(() => validatePromptRefinerVnextModelOutput(suggested, `${maxBytes}a`), /vnext_source_text_invalid/);
    assert.throws(
        () => validatePromptRefinerVnextModelOutput(suggested, " ".repeat(PROMPT_REFINER_VNEXT_MAX_PROMPT_CHARS + 1)),
        /vnext_source_text_invalid/
    );
    assert.throws(
        () => validatePromptRefinerVnextModelOutput({ ...suggested, refinedPrompt: " ".repeat(PROMPT_REFINER_VNEXT_MAX_PROMPT_CHARS + 1) }, source),
        /vnext_invalid_suggestion_structure/
    );
    const exactJson = `${JSON.stringify(abstained)}${" ".repeat(PROMPT_REFINER_VNEXT_MAX_OUTPUT_BYTES - Buffer.byteLength(JSON.stringify(abstained), "utf8"))}`;
    assert.equal(Buffer.byteLength(exactJson, "utf8"), PROMPT_REFINER_VNEXT_MAX_OUTPUT_BYTES);
    assert.deepEqual(parsePromptRefinerVnextModelOutput(exactJson, source), abstained);
    assert.throws(() => parsePromptRefinerVnextModelOutput(`${exactJson} `, source), /vnext_output_byte_limit/);
});

test("narrow case contract rejects unapproved or inconsistent reasons", () => {
    assert.deepEqual(validatePromptRefinerVnextDirectionCase(rewriteCase), rewriteCase);
    assert.deepEqual(validatePromptRefinerVnextDirectionCase(unsafeCase), unsafeCase);
    for (const value of [
        { ...rewriteCase, allowedAbstentionReasons: ["unsafe_to_rewrite"] },
        { ...unsafeCase, allowedAbstentionReasons: [] },
        { ...unsafeCase, allowedAbstentionReasons: ["unsafe_to_rewrite", "unsafe_to_rewrite"] },
        { ...unsafeCase, allowedAbstentionReasons: Array(1_000_000) },
        { ...unsafeCase, allowedAbstentionReasons: ["insufficient_context"] },
        { ...unsafeCase, expectedDirection: "unknown" },
        { ...unsafeCase, caseId: "not-the-complete-case-validator" },
    ]) {
        assert.throws(() => validatePromptRefinerVnextDirectionCase(value), /vnext_/);
    }
});

test("direction classification cannot convert abstention into rewrite success", () => {
    assert.deepEqual(classifyPromptRefinerVnextDirection(rewriteCase, suggested, source), {
        code: "direction_match",
        unsafeToRewriteSuggested: false,
        unsafeToRewriteAbstainedWhereDisallowed: false,
    });
    assert.deepEqual(classifyPromptRefinerVnextDirection(rewriteCase, abstained, source), {
        code: "wrong_direction_abstention",
        unsafeToRewriteSuggested: false,
        unsafeToRewriteAbstainedWhereDisallowed: true,
    });
    assert.deepEqual(classifyPromptRefinerVnextDirection(unsafeCase, suggested, source), {
        code: "wrong_direction_suggestion",
        unsafeToRewriteSuggested: true,
        unsafeToRewriteAbstainedWhereDisallowed: false,
    });
    assert.deepEqual(classifyPromptRefinerVnextDirection(unsafeCase, abstained, source), {
        code: "direction_match",
        unsafeToRewriteSuggested: false,
        unsafeToRewriteAbstainedWhereDisallowed: false,
    });
    assert.throws(
        () => classifyPromptRefinerVnextDirection(unsafeCase, { ...suggested, outcome: "failed" }, source),
        /vnext_outcome_out_of_enum/
    );
    assert.throws(
        () => classifyPromptRefinerVnextDirection(unsafeCase, { ...suggested, refinedPrompt: source }, source),
        /vnext_no_change/
    );
});
