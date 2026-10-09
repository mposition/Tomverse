/**
 * Owner-only, development-stage structural checks for a one-shot case rubric.
 * This never sees a production user prompt and must not log the restricted
 * source, rubric, fixtures, root or their digests. Syntactic fixture separation
 * is not evidence of semantic truth, independent authorship or run admission.
 */
import { parseBenchmarkJson, strictBenchmarkObject } from "./routerDevelopmentBenchmark";
import {
    validatePromptRefinerVnextModelOutput,
    validatePromptRefinerVnextSourceText,
} from "./promptRefinerQualityEvaluationVnextCore";
import {
    evaluatePromptRefinerVnextOneShotPredicate,
    validatePromptRefinerVnextOneShotPredicate,
} from "./promptRefinerQualityEvaluationVnextOneShotPredicateCore";

const MAX_RUBRIC_BYTES = 64 * 1024;
const MAX_EXPLANATION_BYTES = 4 * 1024;
const MAX_FIXTURE_BYTES = 16 * 1024;
const fail = (code: string): never => { throw new Error(code); };

export type PromptRefinerVnextOneShotRubricCheck = Readonly<{
    rubricStructureValidated: true;
    fixtureSeparationValidated: true;
    semanticTruthVerified: false;
    independentAuthorshipVerified: false;
    dispatchAuthorized: false;
}>;

function exactObject(value: unknown, keys: readonly string[]): Record<string, unknown> {
    try {
        return strictBenchmarkObject(value, keys, "vnext_one_shot_rubric");
    } catch {
        return fail("vnext_one_shot_rubric_shape_invalid");
    }
}

function explanation(value: unknown): string {
    if (typeof value !== "string" || value.trim().length < 8 ||
        Buffer.byteLength(value, "utf8") > MAX_EXPLANATION_BYTES) {
        return fail("vnext_one_shot_rubric_explanation_invalid");
    }
    return value;
}

function fixtureText(value: unknown): string {
    if (typeof value !== "string" || !value.trim() ||
        Buffer.byteLength(value, "utf8") > MAX_FIXTURE_BYTES) {
        return fail("vnext_one_shot_rubric_fixture_invalid");
    }
    return value;
}

/**
 * Checks a restricted, precommitted per-case rubric against synthetic fixture
 * shape only. A full manifest validator must call this for all 80 cases and
 * separately establish root, allocation, witness and owner attestations.
 */
export function validatePromptRefinerVnextOneShotRubric(
    rubricText: string,
    sourceText: string,
    expectedDirection: "rewrite_expected" | "abstain_preferred"
): PromptRefinerVnextOneShotRubricCheck {
    if (typeof rubricText !== "string" ||
        Buffer.byteLength(rubricText, "utf8") > MAX_RUBRIC_BYTES ||
        (expectedDirection !== "rewrite_expected" &&
            expectedDirection !== "abstain_preferred")) {
        return fail("vnext_one_shot_rubric_input_invalid");
    }
    let source: string;
    try {
        source = validatePromptRefinerVnextSourceText(sourceText);
    } catch {
        return fail("vnext_one_shot_rubric_source_invalid");
    }
    let parsed: unknown;
    try {
        parsed = parseBenchmarkJson(rubricText, MAX_RUBRIC_BYTES);
    } catch {
        return fail("vnext_one_shot_rubric_json_invalid");
    }
    const rubric = exactObject(parsed, [
        "version", "expectedDirection", "preRegisteredReason", "counterexample",
        "predicate", "passingFixture", "failingFixture",
    ]);
    if (rubric.version !== "one-shot-rubric-v1" ||
        rubric.expectedDirection !== expectedDirection) {
        return fail("vnext_one_shot_rubric_direction_invalid");
    }
    const reason = explanation(rubric.preRegisteredReason);
    const counterexample = explanation(rubric.counterexample);
    if (reason === counterexample) {
        return fail("vnext_one_shot_rubric_counterexample_invalid");
    }

    if (expectedDirection === "rewrite_expected") {
        const predicate = validatePromptRefinerVnextOneShotPredicate(rubric.predicate);
        const passing = fixtureText(rubric.passingFixture);
        const failing = fixtureText(rubric.failingFixture);
        if (passing === failing) {
            return fail("vnext_one_shot_rubric_fixture_invalid");
        }
        try {
            validatePromptRefinerVnextModelOutput({
                outcome: "suggested", refinedPrompt: passing, abstentionReason: null,
            }, source);
        } catch {
            return fail("vnext_one_shot_rubric_fixture_invalid");
        }
        if (!evaluatePromptRefinerVnextOneShotPredicate(predicate, passing) ||
            evaluatePromptRefinerVnextOneShotPredicate(predicate, failing)) {
            return fail("vnext_one_shot_rubric_fixture_invalid");
        }
    } else {
        const predicate = exactObject(rubric.predicate, ["kind", "reason"]);
        if (predicate.kind !== "abstention_reason" ||
            predicate.reason !== "unsafe_to_rewrite") {
            return fail("vnext_one_shot_rubric_predicate_invalid");
        }
        const passing = exactObject(
            rubric.passingFixture, ["outcome", "refinedPrompt", "abstentionReason"]
        );
        const failing = exactObject(
            rubric.failingFixture, ["outcome", "refinedPrompt", "abstentionReason"]
        );
        try {
            const passingOutput = validatePromptRefinerVnextModelOutput(passing, source);
            const failingOutput = validatePromptRefinerVnextModelOutput(failing, source);
            if (passingOutput.outcome !== "abstained" ||
                passingOutput.abstentionReason !== predicate.reason ||
                failingOutput.outcome !== "suggested") {
                return fail("vnext_one_shot_rubric_fixture_invalid");
            }
        } catch {
            return fail("vnext_one_shot_rubric_fixture_invalid");
        }
    }
    return Object.freeze({
        rubricStructureValidated: true,
        fixtureSeparationValidated: true,
        semanticTruthVerified: false,
        independentAuthorshipVerified: false,
        dispatchAuthorized: false,
    });
}
