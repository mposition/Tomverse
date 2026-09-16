/**
 * Provider-free Prompt Refiner shadow verification.
 *
 * This module accepts only checked-in synthetic fixtures. It has no adapter,
 * reservation-authority, product-route, provider, credential, billing or
 * rollout dependency.
 */
import { createHash } from "node:crypto";
import {
    canonicalBenchmarkJson,
    parseBenchmarkJson,
    strictBenchmarkObject,
} from "./routerDevelopmentBenchmark";
import {
    PROMPT_REFINER_INPUT_SCOPE,
    PROMPT_REFINER_MAX_PROMPT_BYTES,
    PROMPT_REFINER_MAX_PROMPT_CHARS,
    promptRefinerPromptProblem,
} from "./promptRefinerSuggestion";
import { promptRefinerModelMessages } from "./promptRefinerModelPrompt";
import { auditPromptRefinerMessages } from "./promptInjectionAudit";

export const PROMPT_REFINER_SHADOW_HARNESS_VERSION =
    "prompt-refiner-shadow-harness-v1" as const;
export const PROMPT_REFINER_SHADOW_CORPUS_VERSION =
    "prompt-refiner-shadow-corpus-v1" as const;
export const PROMPT_REFINER_SHADOW_CORPUS_ID =
    "tomverse-prompt-refiner-shadow-v1" as const;
export const PROMPT_REFINER_SHADOW_CORPUS_CASES = 16;
export const PROMPT_REFINER_SHADOW_MAX_CORPUS_BYTES = 256 * 1024;
export const PROMPT_REFINER_SHADOW_MAX_OUTPUT_BYTES = 64 * 1024;
export const PROMPT_REFINER_SHADOW_PROVIDER_CALLS = 0 as const;
export const PROMPT_REFINER_SHADOW_COST_MICRO_USD = 0 as const;

const CASE_CATEGORIES = Object.freeze([
    "rewrite",
    "quoted_data",
    "prompt_injection",
    "code",
    "invalid_shape",
    "invalid_syntax",
    "empty",
    "no_change",
] as const);

export type PromptRefinerShadowFailureCode =
    | "invalid_response"
    | "empty_response"
    | "no_change";

export type PromptRefinerShadowParseResult =
    | { status: "suggested"; failureCode: null; refinedPrompt: string }
    | {
          status: "failed";
          failureCode: PromptRefinerShadowFailureCode;
          refinedPrompt: null;
      };

export type PromptRefinerShadowCase = {
    id: string;
    language: "ko" | "en";
    category: (typeof CASE_CATEGORIES)[number];
    inputScope: typeof PROMPT_REFINER_INPUT_SCOPE;
    sourceText: string;
    fixtureOutput: string;
    expected: PromptRefinerShadowParseResult;
};

export type PromptRefinerShadowCorpus = {
    schemaVersion: typeof PROMPT_REFINER_SHADOW_CORPUS_VERSION;
    corpusId: typeof PROMPT_REFINER_SHADOW_CORPUS_ID;
    purpose: "development-only";
    dataClassification: "synthetic_test_only";
    contentDigest: string;
    cases: PromptRefinerShadowCase[];
};

export type PromptRefinerShadowCaseEvaluation = {
    caseId: string;
    status: PromptRefinerShadowParseResult["status"];
    failureCode: PromptRefinerShadowFailureCode | null;
    structuralBoundaryViolations: number;
    behavioralOutcomeMatched: boolean;
};

function fail(code: string): never {
    throw new Error(`prompt_refiner_shadow_${code}`);
}

function exactObject(
    value: unknown,
    fields: readonly string[],
    where: string
): Record<string, unknown> {
    if (
        value === null ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    ) {
        return fail(`${where}_object_required`);
    }
    const actual = Object.keys(value).sort();
    const expected = [...fields].sort();
    if (
        actual.length !== expected.length ||
        actual.some((key, index) => key !== expected[index])
    ) {
        fail(`${where}_unexpected_or_missing_fields`);
    }
    return value as Record<string, unknown>;
}

function boundedString(
    value: unknown,
    where: string,
    maxBytes: number,
    allowBlank = false
): string {
    if (
        typeof value !== "string" ||
        (!allowBlank && !value.trim()) ||
        Buffer.byteLength(value, "utf8") > maxBytes
    ) {
        fail(`${where}_invalid_string`);
    }
    return value;
}

const sha256 = (value: string): string =>
    createHash("sha256").update(value, "utf8").digest("hex");

const containsCredentialOrIdentityLikeMaterial = (value: string): boolean =>
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:sk|rk|pk)_[A-Za-z0-9_-]{16,}\b|\bAKIA[A-Z0-9]{16}\b|\bhttps?:\/\/|\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(
        value
    );

export function promptRefinerShadowCorpusDigest(
    value: Omit<PromptRefinerShadowCorpus, "contentDigest"> | Record<string, unknown>
): string {
    return sha256(canonicalBenchmarkJson(value));
}

/**
 * Strictly parses one model-shaped fixture result. Invalid model output is a
 * fixed failure code rather than an exception containing response content.
 */
export function parsePromptRefinerShadowOutput(input: {
    sourceText: string;
    outputText: string;
}): PromptRefinerShadowParseResult {
    if (promptRefinerPromptProblem(input.sourceText) !== null) {
        fail("source_text_out_of_contract");
    }
    if (typeof input.outputText !== "string") {
        return {
            status: "failed",
            failureCode: "invalid_response",
            refinedPrompt: null,
        };
    }
    const outputBytes = Buffer.byteLength(input.outputText, "utf8");
    if (
        outputBytes > PROMPT_REFINER_SHADOW_MAX_OUTPUT_BYTES ||
        input.outputText.charCodeAt(0) === 0xfeff
    ) {
        return {
            status: "failed",
            failureCode: "invalid_response",
            refinedPrompt: null,
        };
    }
    if (outputBytes === 0 || !input.outputText.trim()) {
        return {
            status: "failed",
            failureCode: "empty_response",
            refinedPrompt: null,
        };
    }

    let parsed: unknown;
    try {
        parsed = parseBenchmarkJson(
            input.outputText,
            PROMPT_REFINER_SHADOW_MAX_OUTPUT_BYTES
        );
    } catch {
        return {
            status: "failed",
            failureCode: "invalid_response",
            refinedPrompt: null,
        };
    }

    let object: Record<string, unknown>;
    try {
        object = strictBenchmarkObject(
            parsed,
            ["refinedPrompt"],
            "prompt_refiner_model_output"
        );
    } catch {
        return {
            status: "failed",
            failureCode: "invalid_response",
            refinedPrompt: null,
        };
    }
    if (typeof object.refinedPrompt !== "string") {
        return {
            status: "failed",
            failureCode: "invalid_response",
            refinedPrompt: null,
        };
    }
    const refinedPrompt = object.refinedPrompt;
    if (!refinedPrompt.trim()) {
        return {
            status: "failed",
            failureCode: "empty_response",
            refinedPrompt: null,
        };
    }
    if (
        refinedPrompt.length > PROMPT_REFINER_MAX_PROMPT_CHARS ||
        Buffer.byteLength(refinedPrompt, "utf8") >
            PROMPT_REFINER_MAX_PROMPT_BYTES
    ) {
        return {
            status: "failed",
            failureCode: "invalid_response",
            refinedPrompt: null,
        };
    }
    if (refinedPrompt.trim() === input.sourceText.trim()) {
        return {
            status: "failed",
            failureCode: "no_change",
            refinedPrompt: null,
        };
    }
    return { status: "suggested", failureCode: null, refinedPrompt };
}

function validateExpected(value: unknown): PromptRefinerShadowParseResult {
    const expected = exactObject(
        value,
        ["status", "failureCode", "refinedPrompt"],
        "expected"
    );
    if (expected.status === "suggested") {
        const refinedPrompt = boundedString(
            expected.refinedPrompt,
            "expected_refined_prompt",
            PROMPT_REFINER_MAX_PROMPT_BYTES
        );
        if (refinedPrompt.length > PROMPT_REFINER_MAX_PROMPT_CHARS) {
            fail("expected_refined_prompt_invalid_string");
        }
        if (expected.failureCode !== null) {
            fail("expected_suggested_failure_code");
        }
        return { status: "suggested", failureCode: null, refinedPrompt };
    }
    if (
        expected.status !== "failed" ||
        !["invalid_response", "empty_response", "no_change"].includes(
            expected.failureCode as string
        ) ||
        expected.refinedPrompt !== null
    ) {
        fail("expected_failure_shape");
    }
    return {
        status: "failed",
        failureCode:
            expected.failureCode as PromptRefinerShadowFailureCode,
        refinedPrompt: null,
    };
}

export function validatePromptRefinerShadowCorpus(
    value: unknown
): PromptRefinerShadowCorpus {
    const serialized = canonicalBenchmarkJson(value);
    if (
        Buffer.byteLength(serialized, "utf8") >
        PROMPT_REFINER_SHADOW_MAX_CORPUS_BYTES
    ) {
        fail("corpus_byte_limit");
    }
    const corpus = exactObject(
        value,
        [
            "schemaVersion",
            "corpusId",
            "purpose",
            "dataClassification",
            "contentDigest",
            "cases",
        ],
        "corpus"
    );
    if (
        corpus.schemaVersion !== PROMPT_REFINER_SHADOW_CORPUS_VERSION ||
        corpus.corpusId !== PROMPT_REFINER_SHADOW_CORPUS_ID ||
        corpus.purpose !== "development-only" ||
        corpus.dataClassification !== "synthetic_test_only" ||
        typeof corpus.contentDigest !== "string" ||
        !/^[a-f0-9]{64}$/.test(corpus.contentDigest)
    ) {
        fail("corpus_identity");
    }
    if (
        !Array.isArray(corpus.cases) ||
        corpus.cases.length !== PROMPT_REFINER_SHADOW_CORPUS_CASES
    ) {
        fail("corpus_case_count");
    }
    const ids = new Set<string>();
    const sourceTexts = new Set<string>();
    const languages = new Map<string, number>();
    const cases = corpus.cases.map((candidate) => {
        const item = exactObject(
            candidate,
            [
                "id",
                "language",
                "category",
                "inputScope",
                "sourceText",
                "fixtureOutput",
                "expected",
            ],
            "case"
        );
        const id = boundedString(item.id, "case_id", 64);
        if (!/^prsv1-(ko|en)-\d{2}$/.test(id) || ids.has(id)) {
            fail("case_id");
        }
        ids.add(id);
        if (
            !["ko", "en"].includes(item.language as string) ||
            !id.startsWith(`prsv1-${item.language}-`) ||
            !CASE_CATEGORIES.includes(
                item.category as (typeof CASE_CATEGORIES)[number]
            ) ||
            item.inputScope !== PROMPT_REFINER_INPUT_SCOPE
        ) {
            fail("case_metadata");
        }
        const sourceText = boundedString(
            item.sourceText,
            "case_source_text",
            PROMPT_REFINER_MAX_PROMPT_BYTES
        );
        if (
            sourceText.length > PROMPT_REFINER_MAX_PROMPT_CHARS ||
            sourceTexts.has(sourceText)
        ) {
            fail("case_source_text");
        }
        sourceTexts.add(sourceText);
        const fixtureOutput = boundedString(
            item.fixtureOutput,
            "case_fixture_output",
            PROMPT_REFINER_SHADOW_MAX_OUTPUT_BYTES,
            true
        );
        const expected = validateExpected(item.expected);
        if (
            containsCredentialOrIdentityLikeMaterial(sourceText) ||
            containsCredentialOrIdentityLikeMaterial(fixtureOutput) ||
            (expected.refinedPrompt !== null &&
                containsCredentialOrIdentityLikeMaterial(expected.refinedPrompt))
        ) {
            fail("case_not_synthetic_safe");
        }
        languages.set(
            item.language as string,
            (languages.get(item.language as string) ?? 0) + 1
        );
        return {
            id,
            language: item.language,
            category: item.category,
            inputScope: item.inputScope,
            sourceText,
            fixtureOutput,
            expected,
        } as PromptRefinerShadowCase;
    });
    if (languages.get("ko") !== 8 || languages.get("en") !== 8) {
        fail("corpus_language_balance");
    }
    const unsigned = {
        schemaVersion: corpus.schemaVersion,
        corpusId: corpus.corpusId,
        purpose: corpus.purpose,
        dataClassification: corpus.dataClassification,
        cases,
    };
    if (promptRefinerShadowCorpusDigest(unsigned) !== corpus.contentDigest) {
        fail("corpus_digest");
    }
    return { ...unsigned, contentDigest: corpus.contentDigest } as PromptRefinerShadowCorpus;
}

export function parsePromptRefinerShadowCorpus(
    text: string
): PromptRefinerShadowCorpus {
    if (
        typeof text !== "string" ||
        Buffer.byteLength(text, "utf8") >
            PROMPT_REFINER_SHADOW_MAX_CORPUS_BYTES ||
        text.charCodeAt(0) === 0xfeff
    ) {
        fail("corpus_bytes");
    }
    let parsed: unknown;
    try {
        parsed = parseBenchmarkJson(
            text,
            PROMPT_REFINER_SHADOW_MAX_CORPUS_BYTES
        );
    } catch (error) {
        const code = error instanceof Error ? error.message : "invalid_json";
        fail(`corpus_${/^[a-z0-9_:.-]+$/i.test(code) ? code : "invalid_json"}`);
    }
    return validatePromptRefinerShadowCorpus(parsed);
}

export function evaluatePromptRefinerShadowCase(
    item: PromptRefinerShadowCase
): PromptRefinerShadowCaseEvaluation {
    const messages = promptRefinerModelMessages({
        requestId: item.id,
        prompt: item.sourceText,
    });
    const structuralBoundaryViolations = auditPromptRefinerMessages({
        surface: "prompt-refiner",
        payloadId: item.id,
        payload: item.sourceText,
        messages,
        inputScope: item.inputScope,
    }).length;
    const actual = parsePromptRefinerShadowOutput({
        sourceText: item.sourceText,
        outputText: item.fixtureOutput,
    });
    return {
        caseId: item.id,
        status: actual.status,
        failureCode: actual.failureCode,
        structuralBoundaryViolations,
        behavioralOutcomeMatched:
            canonicalBenchmarkJson(actual) ===
            canonicalBenchmarkJson(item.expected),
    };
}
