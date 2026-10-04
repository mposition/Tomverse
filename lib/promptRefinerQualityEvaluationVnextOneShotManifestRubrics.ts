/**
 * Owner-runner, development-stage rubric pass over all 80 restricted cases.
 * It rechecks root, allocation and challenge witnesses first, but cannot
 * establish the truth of owner labels, provenance, privacy or run authority.
 */
import { parseBenchmarkJson } from "./routerDevelopmentBenchmark";
import { verifyPromptRefinerVnextOneShotManifestWitnesses } from
    "./promptRefinerQualityEvaluationVnextOneShotManifestWitnesses";
import { validatePromptRefinerVnextOneShotRubric } from
    "./promptRefinerQualityEvaluationVnextOneShotRubric";

const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;
const fail = (code: string): never => { throw new Error(code); };

export type PromptRefinerVnextOneShotManifestRubricsCheck = Readonly<{
    caseCount: 80;
    rubricCount: 80;
    challengeWitnessCount: 32;
    rubricStructureValidated: true;
    fixtureSeparationValidated: true;
    semanticTruthVerified: false;
    independentAuthorshipVerified: false;
    privacyExclusionVerified: false;
    fullManifestValidated: false;
    dispatchAuthorized: false;
}>;

/** No case ID, text, rubric, root or content digest leaves this function. */
export function verifyPromptRefinerVnextOneShotManifestRubrics(
    manifestText: string,
    expectedRootDigest: string,
    expectedPreregistrationDigest: string
): PromptRefinerVnextOneShotManifestRubricsCheck {
    verifyPromptRefinerVnextOneShotManifestWitnesses(
        manifestText, expectedRootDigest, expectedPreregistrationDigest
    );
    const manifest = parseBenchmarkJson(manifestText, MAX_MANIFEST_BYTES) as
        { cases: Record<string, unknown>[] };
    for (const item of manifest.cases) {
        if (!Object.hasOwn(item, "rubric")) {
            return fail("vnext_one_shot_manifest_rubric_missing");
        }
        try {
            validatePromptRefinerVnextOneShotRubric(
                JSON.stringify(item.rubric),
                item.sourceText as string,
                item.expectedDirection as "rewrite_expected" | "abstain_preferred"
            );
        } catch {
            return fail("vnext_one_shot_manifest_rubric_invalid");
        }
    }
    return Object.freeze({
        caseCount: 80,
        rubricCount: 80,
        challengeWitnessCount: 32,
        rubricStructureValidated: true,
        fixtureSeparationValidated: true,
        semanticTruthVerified: false,
        independentAuthorshipVerified: false,
        privacyExclusionVerified: false,
        fullManifestValidated: false,
        dispatchAuthorized: false,
    });
}
