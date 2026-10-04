/**
 * Development-only closed-shape and duplicate pass for the owner-held manifest.
 * The manifest remains in the owner's restricted process. This check is not
 * authorship, privacy, sealing, server read-back, or dispatch authority.
 */
import { parseBenchmarkJson, strictBenchmarkObject } from "./routerDevelopmentBenchmark";
import { verifyPromptRefinerVnextOneShotManifestRubrics } from
    "./promptRefinerQualityEvaluationVnextOneShotManifestRubrics";

const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;
const MANIFEST_KEYS = [
    "version", "preregistrationDigest", "seedHex", "cases", "rootDigest",
] as const;
const CASE_KEYS = [
    "language", "ordinal", "caseId", "baseCell", "eligibleChallengeTag",
    "expectedDirection", "allowedAbstentionReasons", "sourceText",
    "challengeWitness", "rubric",
] as const;

const fail = (code: string): never => { throw new Error(code); };

export type PromptRefinerVnextOneShotManifestEnvelopeCheck = Readonly<{
    caseCount: 80;
    manifestShapeClosed: true;
    caseShapeClosed: true;
    duplicateSourceTextRejected: true;
    semanticTruthVerified: false;
    independentAuthorshipVerified: false;
    privacyExclusionVerified: false;
    fullManifestValidated: false;
    dispatchAuthorized: false;
}>;

/** No source text, case ID, root, or content digest is returned or logged. */
export function verifyPromptRefinerVnextOneShotManifestEnvelope(
    manifestText: string,
    expectedRootDigest: string,
    expectedPreregistrationDigest: string
): PromptRefinerVnextOneShotManifestEnvelopeCheck {
    verifyPromptRefinerVnextOneShotManifestRubrics(
        manifestText, expectedRootDigest, expectedPreregistrationDigest
    );
    const parsed = parseBenchmarkJson(manifestText, MAX_MANIFEST_BYTES);
    let manifest: Record<string, unknown>;
    try {
        manifest = strictBenchmarkObject(parsed, MANIFEST_KEYS, "vnext_one_shot_manifest");
    } catch {
        return fail("vnext_one_shot_manifest_envelope_shape_invalid");
    }
    // A matching bilingual challenge may reuse one source with different
    // primary output languages. Every other duplicate is rejected globally.
    const seenSources = new Map<string, Array<{
        language: string; tag: string | null; baseCell: string;
    }>>();
    for (const candidate of manifest.cases as unknown[]) {
        let item: Record<string, unknown>;
        try {
            item = strictBenchmarkObject(candidate, CASE_KEYS, "vnext_one_shot_case");
        } catch {
            return fail("vnext_one_shot_manifest_case_shape_invalid");
        }
        // The earlier source validator establishes this is a bounded string.
        // Compatibility, invisible format characters, spacing and casing
        // must not create a second slot for the same synthetic prompt. This
        // is conservative: an owner may replace an over-rejected source.
        const source = (item.sourceText as string)
            .normalize("NFKC")
            .replace(/\p{Default_Ignorable_Code_Point}/gu, "")
            .normalize("NFKC")
            .trim().replace(/\s+/gu, " ")
            .toUpperCase().toLowerCase().normalize("NFKC");
        const language = item.language as string;
        const tag = item.eligibleChallengeTag as string | null;
        const baseCell = item.baseCell as string;
        const previous = seenSources.get(source) ?? [];
        if (previous.some((seen) =>
            seen.language === language ||
            seen.tag !== "mixed_language" || tag !== "mixed_language" ||
            seen.baseCell !== baseCell
        )) {
            return fail("vnext_one_shot_manifest_duplicate_source");
        }
        previous.push({ language, tag, baseCell });
        seenSources.set(source, previous);
    }
    return Object.freeze({
        caseCount: 80,
        manifestShapeClosed: true,
        caseShapeClosed: true,
        duplicateSourceTextRejected: true,
        semanticTruthVerified: false,
        independentAuthorshipVerified: false,
        privacyExclusionVerified: false,
        fullManifestValidated: false,
        dispatchAuthorized: false,
    });
}
