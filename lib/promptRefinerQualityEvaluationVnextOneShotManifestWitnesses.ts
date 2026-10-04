/**
 * Development-only owner-runner pass over all 80 challenge witnesses.
 * It is deliberately not a full manifest, rubric-truth, seal, or dispatch check.
 * Manifest bytes and root remain in the owner's restricted environment.
 */
import { parseBenchmarkJson } from "./routerDevelopmentBenchmark";
import { verifyPromptRefinerVnextOneShotManifestCore } from
    "./promptRefinerQualityEvaluationVnextOneShotManifestCore";
import {
    validatePromptRefinerVnextOneShotChallengeWitness,
    type PromptRefinerVnextOneShotChallengeTag,
} from "./promptRefinerQualityEvaluationVnextOneShotChallengeWitness";

const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;
const CHALLENGE_TAGS = new Set<PromptRefinerVnextOneShotChallengeTag>([
    "boundary_near_miss", "adversarial_variant", "mixed_language", "constrained_format",
]);
const fail = (code: string): never => { throw new Error(code); };

export type PromptRefinerVnextOneShotManifestWitnessesCheck = Readonly<{
    caseCount: 80;
    challengeWitnessCount: 32;
    challengeWitnessesStructurallyValidated: true;
    adversarialAttackFormDiversityValidated: true;
    semanticTruthVerified: false;
    rubricTruthVerified: false;
    fullManifestValidated: false;
    dispatchAuthorized: false;
}>;

/**
 * Rehashes and rechecks the allocation before checking every tagged case.
 * No case text, witness, case ID, or root is returned or logged.
 */
export function verifyPromptRefinerVnextOneShotManifestWitnesses(
    manifestText: string,
    expectedRootDigest: string,
    expectedPreregistrationDigest: string
): PromptRefinerVnextOneShotManifestWitnessesCheck {
    verifyPromptRefinerVnextOneShotManifestCore(
        manifestText, expectedRootDigest, expectedPreregistrationDigest
    );
    const manifest = parseBenchmarkJson(manifestText, MAX_MANIFEST_BYTES) as
        { cases: Record<string, unknown>[] };
    const attackForms = { ko: new Set<string>(), en: new Set<string>() };
    let witnessed = 0;
    for (const item of manifest.cases) {
        if (!Object.hasOwn(item, "challengeWitness")) {
            return fail("vnext_one_shot_manifest_witness_missing");
        }
        const tag = item.eligibleChallengeTag;
        if (tag === null) {
            if (item.challengeWitness !== null) {
                return fail("vnext_one_shot_manifest_unallocated_witness");
            }
            continue;
        }
        if (typeof tag !== "string" ||
            !CHALLENGE_TAGS.has(tag as PromptRefinerVnextOneShotChallengeTag)) {
            return fail("vnext_one_shot_manifest_witness_tag_invalid");
        }
        // The previous core check has already validated language and source text.
        const language = item.language as "ko" | "en";
        try {
            validatePromptRefinerVnextOneShotChallengeWitness(
                JSON.stringify(item.challengeWitness),
                item.sourceText as string,
                language,
                tag as PromptRefinerVnextOneShotChallengeTag
            );
        } catch {
            return fail("vnext_one_shot_manifest_witness_invalid");
        }
        witnessed++;
        if (tag === "adversarial_variant") {
            const witness = item.challengeWitness as Record<string, unknown>;
            attackForms[language].add(witness.attackForm as string);
        }
    }
    if (witnessed !== 32) {
        return fail("vnext_one_shot_manifest_witness_count_invalid");
    }
    if (attackForms.ko.size < 2 || attackForms.en.size < 2) {
        return fail("vnext_one_shot_manifest_attack_diversity_invalid");
    }
    return Object.freeze({
        caseCount: 80,
        challengeWitnessCount: 32,
        challengeWitnessesStructurallyValidated: true,
        adversarialAttackFormDiversityValidated: true,
        semanticTruthVerified: false,
        rubricTruthVerified: false,
        fullManifestValidated: false,
        dispatchAuthorized: false,
    });
}
