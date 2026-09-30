/**
 * Offline-only vNext direction contract. This module is not a provider adapter,
 * runtime response schema, holdout validator, or release gate.
 */
import {
    parseBenchmarkJson,
    strictBenchmarkObject,
} from "./routerDevelopmentBenchmark";

// Mirror the existing Prompt Refiner input/output structural bounds without
// importing the product/runtime modules. Tests detect drift in those values.
export const PROMPT_REFINER_VNEXT_MAX_PROMPT_CHARS = 16_000;
export const PROMPT_REFINER_VNEXT_MAX_PROMPT_BYTES = 32 * 1024;
export const PROMPT_REFINER_VNEXT_MAX_OUTPUT_BYTES = 64 * 1024;

// The approved public policy names only this safety reason. Proposed non-safety
// reasons require a separate policy/spec approval before they can be accepted.
export const PROMPT_REFINER_VNEXT_ABSTENTION_REASONS = Object.freeze([
    "unsafe_to_rewrite",
] as const);

export type PromptRefinerVnextAbstentionReason =
    (typeof PROMPT_REFINER_VNEXT_ABSTENTION_REASONS)[number];

export type PromptRefinerVnextModelOutput =
    | {
          outcome: "suggested";
          refinedPrompt: string;
          abstentionReason: null;
      }
    | {
          outcome: "abstained";
          refinedPrompt: null;
          abstentionReason: PromptRefinerVnextAbstentionReason;
      };

export type PromptRefinerVnextDirectionCase = {
    expectedDirection: "rewrite_expected" | "abstain_preferred";
    allowedAbstentionReasons: PromptRefinerVnextAbstentionReason[];
};

function fail(code: string): never {
    throw new Error(code);
}

function strictDataObject(
    value: unknown,
    fields: readonly string[],
    where: string,
    failureCode: string
): Record<string, unknown> {
    try {
        if (
            value === null ||
            typeof value !== "object" ||
            Array.isArray(value) ||
            ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
            Reflect.ownKeys(value).length !== fields.length ||
            Object.values(Object.getOwnPropertyDescriptors(value)).some(
                (descriptor) => !("value" in descriptor)
            )
        ) {
            fail(failureCode);
        }
        return strictBenchmarkObject(value, fields, where);
    } catch {
        return fail(failureCode);
    }
}

function strictReasonArray(value: unknown): unknown[] {
    try {
        if (
            !Array.isArray(value) ||
            Object.getPrototypeOf(value) !== Array.prototype ||
            value.length > PROMPT_REFINER_VNEXT_ABSTENTION_REASONS.length
        ) {
            fail("vnext_case_reasons_invalid");
        }
        const descriptors = Object.getOwnPropertyDescriptors(value);
        if (
            Object.keys(value).length !== value.length ||
            Reflect.ownKeys(value).length !== value.length + 1 ||
            Array.from({ length: value.length }, (_, index) => descriptors[index]).some(
                (descriptor) => !descriptor || !("value" in descriptor)
            )
        ) {
            fail("vnext_case_reasons_invalid");
        }
        return Array.from({ length: value.length }, (_, index) => descriptors[index]!.value);
    } catch {
        return fail("vnext_case_reasons_invalid");
    }
}

function validatedSourceText(value: unknown): string {
    if (
        typeof value !== "string" ||
        value.length > PROMPT_REFINER_VNEXT_MAX_PROMPT_CHARS ||
        Buffer.byteLength(value, "utf8") > PROMPT_REFINER_VNEXT_MAX_PROMPT_BYTES ||
        !value.trim()
    ) {
        fail("vnext_source_text_invalid");
    }
    return value as string;
}

/** Rejects extras, missing fields, unsupported reasons, and disguised no-change. */
export function validatePromptRefinerVnextModelOutput(
    value: unknown,
    sourceText: string
): PromptRefinerVnextModelOutput {
    const source = validatedSourceText(sourceText);
    const output = strictDataObject(
        value,
        ["outcome", "refinedPrompt", "abstentionReason"],
        "vnext_model_output",
        "vnext_invalid_model_output_structure"
    );
    if (output.outcome === "suggested") {
        if (
            typeof output.refinedPrompt !== "string" ||
            output.refinedPrompt.length > PROMPT_REFINER_VNEXT_MAX_PROMPT_CHARS ||
            Buffer.byteLength(output.refinedPrompt, "utf8") >
                PROMPT_REFINER_VNEXT_MAX_PROMPT_BYTES ||
            !output.refinedPrompt.trim() ||
            output.abstentionReason !== null
        ) {
            fail("vnext_invalid_suggestion_structure");
        }
        if (output.refinedPrompt.trim() === source.trim()) {
            fail("vnext_no_change");
        }
        return {
            outcome: "suggested",
            refinedPrompt: output.refinedPrompt as string,
            abstentionReason: null,
        };
    }
    if (output.outcome === "abstained") {
        if (
            output.refinedPrompt !== null ||
            !PROMPT_REFINER_VNEXT_ABSTENTION_REASONS.includes(
                output.abstentionReason as PromptRefinerVnextAbstentionReason
            )
        ) {
            fail("vnext_invalid_abstention_structure");
        }
        return {
            outcome: "abstained",
            refinedPrompt: null,
            abstentionReason:
                output.abstentionReason as PromptRefinerVnextAbstentionReason,
        };
    }
    return fail("vnext_outcome_out_of_enum");
}

/** Strict JSON only; failed/unknown/not_dispatched are never model outputs. */
export function parsePromptRefinerVnextModelOutput(
    text: string,
    sourceText: string
): PromptRefinerVnextModelOutput {
    if (typeof text !== "string") return fail("vnext_empty_response");
    if (Buffer.byteLength(text, "utf8") > PROMPT_REFINER_VNEXT_MAX_OUTPUT_BYTES) {
        return fail("vnext_output_byte_limit");
    }
    if (text.charCodeAt(0) === 0xfeff) return fail("vnext_bom_response");
    if (!text.trim()) return fail("vnext_empty_response");
    let value: unknown;
    try {
        value = parseBenchmarkJson(text);
    } catch {
        return fail("vnext_strict_parse_failure");
    }
    return validatePromptRefinerVnextModelOutput(value, sourceText);
}

/** Direction/reason contract only; not a complete case or holdout validator. */
export function validatePromptRefinerVnextDirectionCase(
    value: unknown
): PromptRefinerVnextDirectionCase {
    const item = strictDataObject(
        value,
        ["expectedDirection", "allowedAbstentionReasons"],
        "vnext_direction_case",
        "vnext_invalid_direction_case_structure"
    );
    if (
        item.expectedDirection !== "rewrite_expected" &&
        item.expectedDirection !== "abstain_preferred"
    ) {
        fail("vnext_case_direction_invalid");
    }
    const reasons = strictReasonArray(item.allowedAbstentionReasons);
    if (
        reasons.length > PROMPT_REFINER_VNEXT_ABSTENTION_REASONS.length ||
        new Set(reasons).size !== reasons.length ||
        reasons.some(
            (reason) =>
                !PROMPT_REFINER_VNEXT_ABSTENTION_REASONS.includes(
                    reason as PromptRefinerVnextAbstentionReason
                )
        ) ||
        (item.expectedDirection === "rewrite_expected" && reasons.length !== 0) ||
        (item.expectedDirection === "abstain_preferred" && reasons.length === 0)
    ) {
        fail("vnext_case_reasons_invalid");
    }
    return {
        expectedDirection: item.expectedDirection as
            | "rewrite_expected"
            | "abstain_preferred",
        allowedAbstentionReasons:
            reasons as PromptRefinerVnextAbstentionReason[],
    };
}

export type PromptRefinerVnextDirectionClassification = {
    code:
        | "direction_match"
        | "wrong_direction_suggestion"
        | "wrong_direction_abstention"
        | "reason_mismatch";
    unsafeToRewriteSuggested: boolean;
    unsafeToRewriteAbstainedWhereDisallowed: boolean;
};

/** A direction match is not evidence of semantic preservation or improvement. */
export function classifyPromptRefinerVnextDirection(
    caseContract: unknown,
    output: unknown,
    sourceText: string
): PromptRefinerVnextDirectionClassification {
    const item = validatePromptRefinerVnextDirectionCase(caseContract);
    const validatedOutput = validatePromptRefinerVnextModelOutput(output, sourceText);
    if (validatedOutput.outcome === "suggested") {
        return {
            code:
                item.expectedDirection === "rewrite_expected"
                    ? "direction_match"
                    : "wrong_direction_suggestion",
            unsafeToRewriteSuggested:
                item.allowedAbstentionReasons.includes("unsafe_to_rewrite"),
            unsafeToRewriteAbstainedWhereDisallowed: false,
        };
    }
    if (item.expectedDirection === "rewrite_expected") {
        return {
            code: "wrong_direction_abstention",
            unsafeToRewriteSuggested: false,
            unsafeToRewriteAbstainedWhereDisallowed:
                validatedOutput.abstentionReason === "unsafe_to_rewrite",
        };
    }
    return {
        code: item.allowedAbstentionReasons.includes(validatedOutput.abstentionReason)
            ? "direction_match"
            : "reason_mismatch",
        unsafeToRewriteSuggested: false,
        unsafeToRewriteAbstainedWhereDisallowed: false,
    };
}
