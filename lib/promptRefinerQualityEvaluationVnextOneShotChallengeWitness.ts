/**
 * Development-only checks for the four one-shot challenge witness shapes.
 * The caller must keep source and fixture text in the owner's restricted
 * environment. These syntactic checks cannot establish semantic truth,
 * independent authorship, a sealed manifest, or dispatch authority.
 */
import { parseBenchmarkJson, strictBenchmarkObject } from "./routerDevelopmentBenchmark";
import { validatePromptRefinerVnextSourceText } from "./promptRefinerQualityEvaluationVnextCore";
import {
    evaluatePromptRefinerVnextOneShotPredicate,
    validatePromptRefinerVnextOneShotPredicate,
} from "./promptRefinerQualityEvaluationVnextOneShotPredicateCore";
import { validatePromptRefinerVnextOneShotFormatWitness } from "./promptRefinerQualityEvaluationVnextOneShotFormatWitness";

const MAX_WITNESS_BYTES = 64 * 1024;
const MAX_FIXTURE_BYTES = 16 * 1024;
const MAX_BOUNDARY_BYTES = 512;
const BOUNDARY_KINDS = new Set([
    "negation", "numeric_open_closed", "exact_count", "literal_boundary",
]);
const ATTACK_FORMS = new Set([
    "role_spoofing", "tool_request", "authority_claim", "output_override",
]);
const PROHIBITED_OUTCOMES = new Set([
    "instruction_promotion", "unsafe_addition", "tool_use", "suggestion_instead_of_abstention",
]);
const fail = (code: string): never => { throw new Error(code); };

export type PromptRefinerVnextOneShotChallengeTag =
    "boundary_near_miss" | "adversarial_variant" | "mixed_language" | "constrained_format";

export type PromptRefinerVnextOneShotChallengeWitnessCheck = Readonly<{
    structuralWitnessValidated: true;
    semanticTruthVerified: false;
    fullManifestValidated: false;
    dispatchAuthorized: false;
}>;

function exactObject(value: unknown, fields: readonly string[]): Record<string, unknown> {
    try {
        return strictBenchmarkObject(value, fields, "vnext_one_shot_challenge_witness");
    } catch {
        return fail("vnext_one_shot_challenge_witness_shape_invalid");
    }
}

function boundedFixture(value: unknown): value is string {
    return typeof value === "string" && !!value.trim() &&
        Buffer.byteLength(value, "utf8") <= MAX_FIXTURE_BYTES;
}

function sourceSpan(value: unknown, source: string): string {
    const span = exactObject(value, ["startCodePoint", "endCodePoint"]);
    const codePoints = Array.from(source);
    if (!Number.isSafeInteger(span.startCodePoint) ||
        !Number.isSafeInteger(span.endCodePoint) ||
        (span.startCodePoint as number) < 0 ||
        (span.endCodePoint as number) <= (span.startCodePoint as number) ||
        (span.endCodePoint as number) > codePoints.length) {
        return fail("vnext_one_shot_challenge_span_invalid");
    }
    return codePoints.slice(
        span.startCodePoint as number, span.endCodePoint as number
    ).join("");
}

function predicateSeparates(
    predicate: unknown,
    passingFixture: unknown,
    failingFixture: unknown
): void {
    if (!boundedFixture(passingFixture) || !boundedFixture(failingFixture)) {
        return fail("vnext_one_shot_challenge_fixture_invalid");
    }
    validatePromptRefinerVnextOneShotPredicate(predicate);
    if (!evaluatePromptRefinerVnextOneShotPredicate(predicate, passingFixture) ||
        evaluatePromptRefinerVnextOneShotPredicate(predicate, failingFixture)) {
        return fail("vnext_one_shot_challenge_fixture_invalid");
    }
}

function validateBoundary(candidate: unknown, source: string): void {
    const item = exactObject(candidate, [
        "version", "boundaryKind", "sourceSpan", "originalBoundary",
        "alteredBoundary", "predicate", "passingFixture", "failingFixture",
    ]);
    if (item.version !== "boundary-near-miss-witness-v1" ||
        !BOUNDARY_KINDS.has(item.boundaryKind as string) ||
        typeof item.originalBoundary !== "string" || !item.originalBoundary.trim() ||
        typeof item.alteredBoundary !== "string" || !item.alteredBoundary.trim() ||
        item.originalBoundary === item.alteredBoundary ||
        Buffer.byteLength(item.originalBoundary, "utf8") > MAX_BOUNDARY_BYTES ||
        Buffer.byteLength(item.alteredBoundary, "utf8") > MAX_BOUNDARY_BYTES) {
        return fail("vnext_one_shot_boundary_contract_invalid");
    }
    if (sourceSpan(item.sourceSpan, source) !== item.originalBoundary) {
        return fail("vnext_one_shot_boundary_span_invalid");
    }
    if (!boundedFixture(item.passingFixture) || !boundedFixture(item.failingFixture)) {
        return fail("vnext_one_shot_challenge_fixture_invalid");
    }
    const passing = item.passingFixture as string;
    const original = item.originalBoundary as string;
    const first = passing.indexOf(original);
    if (first < 0 || passing.indexOf(original, first + 1) !== -1 ||
        item.failingFixture !== passing.slice(0, first) + item.alteredBoundary +
            passing.slice(first + original.length)) {
        return fail("vnext_one_shot_boundary_pair_invalid");
    }
    const predicate = validatePromptRefinerVnextOneShotPredicate(item.predicate);
    if (!((predicate.kind === "literal_present" && predicate.literal === original) ||
        (predicate.kind === "literal_absent" && predicate.literal === item.alteredBoundary))) {
        return fail("vnext_one_shot_boundary_predicate_invalid");
    }
    predicateSeparates(predicate, passing, item.failingFixture);
}

function validateAdversarial(candidate: unknown, source: string): void {
    const item = exactObject(candidate, [
        "version", "attackForm", "sourceSpan", "prohibitedOutcome", "predicate",
        "passingFixture", "failingFixture",
    ]);
    if (item.version !== "adversarial-variant-witness-v1" ||
        !ATTACK_FORMS.has(item.attackForm as string) ||
        !PROHIBITED_OUTCOMES.has(item.prohibitedOutcome as string) ||
        sourceSpan(item.sourceSpan, source).trim().length < 8) {
        return fail("vnext_one_shot_adversarial_contract_invalid");
    }
    const predicate = validatePromptRefinerVnextOneShotPredicate(item.predicate);
    if (predicate.kind !== "literal_absent") {
        return fail("vnext_one_shot_adversarial_predicate_invalid");
    }
    predicateSeparates(predicate, item.passingFixture, item.failingFixture);
}

function validateMixed(candidate: unknown, source: string, language: "ko" | "en"): void {
    const item = exactObject(candidate, [
        "version", "naturalLanguageSpan", "primaryLanguage", "predicate",
        "passingFixture", "failingFixture",
    ]);
    if (item.version !== "mixed-language-witness-v1" || item.primaryLanguage !== language) {
        return fail("vnext_one_shot_mixed_contract_invalid");
    }
    const span = sourceSpan(item.naturalLanguageSpan, source);
    // Count composed syllables after NFC so canonically equivalent NFD
    // source text keeps its original code-point offsets but passes this
    // lexical minimum on the same basis as NFC text.
    const hangul = span.normalize("NFC").match(/[가-힣]/gu)?.length ?? 0;
    const english = span.match(/\b[A-Za-z]+\b/gu)?.length ?? 0;
    // The lexical filter catches obvious URL/model/code spans; it is not a
    // semantic proof that an owner-authored span is natural language.
    if (hangul < 8 || english < 3 || /https?:\/\/|`|\b(?:gpt|claude)-[\w.-]+\b/iu.test(span)) {
        return fail("vnext_one_shot_mixed_span_invalid");
    }
    const predicate = validatePromptRefinerVnextOneShotPredicate(item.predicate);
    if (predicate.kind !== "literal_present") {
        return fail("vnext_one_shot_mixed_predicate_invalid");
    }
    predicateSeparates(predicate, item.passingFixture, item.failingFixture);
}

function validateConstrained(candidate: unknown, source: string): void {
    const item = exactObject(candidate, ["version", "sourceSpan", "formatWitness"]);
    if (item.version !== "constrained-format-challenge-witness-v1") {
        return fail("vnext_one_shot_constrained_contract_invalid");
    }
    const instruction = sourceSpan(item.sourceSpan, source).normalize("NFC");
    // The delegated helper fixes the only supported structural pair:
    // single-line output and exact JSON object keys. Require the owner to
    // mark a source instruction naming both; this lexical check does not
    // establish that the instruction is semantically binding.
    if (!/\bjson\b/iu.test(instruction) ||
        !/(?:single[\s-]?line|one[\s-]?line|한\s*줄)/iu.test(instruction)) {
        return fail("vnext_one_shot_constrained_span_invalid");
    }
    validatePromptRefinerVnextOneShotFormatWitness(item.formatWitness);
}

/**
 * Accepts strict JSON, never a caller-owned object with getters or scripts.
 * A valid return is only a bounded fixture signal; a separate full manifest
 * validator must check all 80 cases, quotas, rubric and owner attestations.
 */
export function validatePromptRefinerVnextOneShotChallengeWitness(
    witnessText: string,
    sourceText: string,
    language: "ko" | "en",
    challengeTag: PromptRefinerVnextOneShotChallengeTag
): PromptRefinerVnextOneShotChallengeWitnessCheck {
    if (typeof witnessText !== "string" ||
        Buffer.byteLength(witnessText, "utf8") > MAX_WITNESS_BYTES ||
        (language !== "ko" && language !== "en") ||
        !["boundary_near_miss", "adversarial_variant", "mixed_language", "constrained_format"]
            .includes(challengeTag)) {
        return fail("vnext_one_shot_challenge_input_invalid");
    }
    let source: string;
    try {
        source = validatePromptRefinerVnextSourceText(sourceText);
    } catch {
        return fail("vnext_one_shot_challenge_source_invalid");
    }
    let witness: unknown;
    try {
        witness = parseBenchmarkJson(witnessText, MAX_WITNESS_BYTES);
    } catch {
        return fail("vnext_one_shot_challenge_json_invalid");
    }
    switch (challengeTag) {
        case "boundary_near_miss": validateBoundary(witness, source); break;
        case "adversarial_variant": validateAdversarial(witness, source); break;
        case "mixed_language": validateMixed(witness, source, language); break;
        case "constrained_format": validateConstrained(witness, source); break;
        default: return fail("vnext_one_shot_challenge_tag_invalid");
    }
    return Object.freeze({
        structuralWitnessValidated: true,
        semanticTruthVerified: false,
        fullManifestValidated: false,
        dispatchAuthorized: false,
    });
}
