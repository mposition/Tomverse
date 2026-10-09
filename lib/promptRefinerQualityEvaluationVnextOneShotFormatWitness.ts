/**
 * Development-only constrained-format fixture check for the one-shot owner
 * runner. This covers two built-in structural atoms; it does not validate a
 * full manifest, rubric meaning, independent holdout, seal or dispatch.
 */
import { strictBenchmarkObject } from "./routerDevelopmentBenchmark";
import {
    evaluatePromptRefinerVnextOneShotPredicate,
    validatePromptRefinerVnextOneShotPredicate,
} from "./promptRefinerQualityEvaluationVnextOneShotPredicateCore";

const STRUCTURAL_KINDS = new Set(["single_line", "json_object_keys"]);
const MAX_FIXTURE_BYTES = 16 * 1024;
const fail = (code: string): never => { throw new Error(code); };
const validFixtureText = (value: unknown): value is string =>
    typeof value === "string" && !!value.trim() &&
    Buffer.byteLength(value, "utf8") <= MAX_FIXTURE_BYTES;

export type PromptRefinerVnextOneShotFormatWitnessCheck = Readonly<{
    structuralPredicateCount: 2;
    syntheticFixtureChecksPassed: true;
    fullManifestValidated: false;
    rubricTruthVerified: false;
    dispatchAuthorized: false;
}>;

/**
 * A passing fixture must satisfy both distinct structural predicates. Each
 * failing fixture must violate exactly its indexed predicate and satisfy the
 * other one. All data stays local; no fixture text is returned or logged.
 */
export function validatePromptRefinerVnextOneShotFormatWitness(
    candidate: unknown
): PromptRefinerVnextOneShotFormatWitnessCheck {
    let witness: Record<string, unknown>;
    try {
        witness = strictBenchmarkObject(candidate, [
            "version", "passingFixture", "predicates", "failingFixtures",
        ], "vnext_one_shot_format_witness");
    } catch {
        return fail("vnext_one_shot_format_witness_shape_invalid");
    }
    if (witness.version !== "constrained-format-witness-v1" ||
        !Array.isArray(witness.predicates) || witness.predicates.length !== 2 ||
        !Array.isArray(witness.failingFixtures) || witness.failingFixtures.length !== 2) {
        return fail("vnext_one_shot_format_witness_contract_invalid");
    }
    if (!Object.hasOwn(witness.predicates, 0) ||
        !Object.hasOwn(witness.predicates, 1)) {
        return fail("vnext_one_shot_format_witness_predicates_invalid");
    }
    const predicates = witness.predicates.map((item) =>
        validatePromptRefinerVnextOneShotPredicate(item)
    );
    if (new Set(predicates.map((item) => item.kind)).size !== 2 ||
        predicates.some((item) => !STRUCTURAL_KINDS.has(item.kind))) {
        return fail("vnext_one_shot_format_witness_predicates_invalid");
    }
    const passingFixture = witness.passingFixture;
    if (!validFixtureText(passingFixture)) {
        return fail("vnext_one_shot_format_witness_pass_fixture_invalid");
    }
    if (predicates.some((item) =>
        !evaluatePromptRefinerVnextOneShotPredicate(item, passingFixture)
    )) {
        return fail("vnext_one_shot_format_witness_pass_fixture_invalid");
    }
    const seen = new Set<number>();
    for (const candidateFixture of witness.failingFixtures) {
        let fixture: Record<string, unknown>;
        try {
            fixture = strictBenchmarkObject(candidateFixture, [
                "predicateIndex", "output",
            ], "vnext_one_shot_format_failure");
        } catch {
            return fail("vnext_one_shot_format_witness_failure_shape_invalid");
        }
        if ((fixture.predicateIndex !== 0 && fixture.predicateIndex !== 1) ||
            seen.has(fixture.predicateIndex as number)) {
            return fail("vnext_one_shot_format_witness_failure_index_invalid");
        }
        const index = fixture.predicateIndex as number;
        seen.add(index);
        const output = fixture.output;
        if (!validFixtureText(output)) {
            return fail("vnext_one_shot_format_witness_failure_fixture_invalid");
        }
        for (let other = 0; other < predicates.length; other++) {
            const result = evaluatePromptRefinerVnextOneShotPredicate(
                predicates[other], output
            );
            if (result === (other === index)) {
                return fail("vnext_one_shot_format_witness_failure_fixture_invalid");
            }
        }
    }
    return Object.freeze({
        structuralPredicateCount: 2,
        syntheticFixtureChecksPassed: true,
        fullManifestValidated: false,
        rubricTruthVerified: false,
        dispatchAuthorized: false,
    });
}
