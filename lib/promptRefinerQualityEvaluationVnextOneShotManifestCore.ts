/**
 * Owner-runner development primitive for the restricted one-shot manifest.
 * It checks the full root, deterministic 80-slot allocation and input bounds,
 * but not witnesses, predicates, rubric truth, sealing or run admission.
 * The caller must keep all manifest bytes and the root in the owner environment.
 */
import { parseBenchmarkJson } from "./routerDevelopmentBenchmark";
import {
    validatePromptRefinerVnextSourceText,
} from "./promptRefinerQualityEvaluationVnextCore";
import {
    validatePromptRefinerVnextAllocationProjection,
} from "./promptRefinerQualityEvaluationVnextAllocation";
import {
    verifyPromptRefinerVnextOneShotManifestRoot,
} from "./promptRefinerQualityEvaluationVnextOneShotRoot";

const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;

export type PromptRefinerVnextOneShotManifestCoreCheck = Readonly<{
    caseCount: 80;
    allocationValidated: true;
    sourceTextValidated: true;
    fullManifestValidated: false;
    dispatchAuthorized: false;
}>;

/** Rechecks root, allocation and text bounds; never seals or admits a run. */
export function verifyPromptRefinerVnextOneShotManifestCore(
    manifestText: string,
    expectedRootDigest: string,
    expectedPreregistrationDigest: string
): PromptRefinerVnextOneShotManifestCoreCheck {
    verifyPromptRefinerVnextOneShotManifestRoot(
        manifestText,
        expectedRootDigest,
        expectedPreregistrationDigest
    );
    // The root primitive already parsed these bytes strictly. Parsing again
    // keeps the raw object inside this owner-only function rather than adding
    // it to a content-free return value.
    const parsed = parseBenchmarkJson(manifestText, MAX_MANIFEST_BYTES);
    const manifest = parsed as Record<string, unknown>;
    const cases = manifest.cases as Record<string, unknown>[];
    // This projection contains metadata only and is never returned or logged.
    const projectionCases = cases.map((item) => {
        try {
            validatePromptRefinerVnextSourceText(item.sourceText);
        } catch {
            throw new Error("vnext_one_shot_manifest_source_invalid");
        }
        return {
            language: item.language,
            ordinal: item.ordinal,
            caseId: item.caseId,
            baseCell: item.baseCell,
            eligibleChallengeTag: item.eligibleChallengeTag,
            expectedDirection: item.expectedDirection,
            allowedAbstentionReasons: item.allowedAbstentionReasons,
        };
    });
    // The allocation validator checks the seed/ordinal HMAC permutation,
    // exact cell/challenge quotas and each direction/reason combination.
    // It receives only locally projected metadata; neither text nor root.
    validatePromptRefinerVnextAllocationProjection(JSON.stringify({
        version: "allocation-projection-v1",
        seedHex: manifest.seedHex,
        cases: projectionCases,
    }));
    return Object.freeze({
        caseCount: 80,
        allocationValidated: true,
        sourceTextValidated: true,
        fullManifestValidated: false,
        dispatchAuthorized: false,
    });
}
