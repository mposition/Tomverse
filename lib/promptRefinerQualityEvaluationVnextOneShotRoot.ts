/**
 * Owner-runner manifest rehash primitive for the one-shot vNext proposal.
 * It does not seal a holdout, validate case predicates, reserve money, call a
 * provider, or authorize dispatch. Raw manifest bytes must stay in the owner's
 * restricted environment; never log the input, root, or a case digest.
 */
import { createHash } from "node:crypto";
import {
    canonicalBenchmarkJson,
    parseBenchmarkJson,
} from "./routerDevelopmentBenchmark";

export const PROMPT_REFINER_VNEXT_ONE_SHOT_MANIFEST_VERSION =
    "prompt-refiner-vnext-one-shot-manifest-v1" as const;

const ROOT_HEX = /^[0-9a-f]{64}$/;
const CASE_ID = /^prsvnext-(ko|en)-(?:00[1-9]|0[1-3][0-9]|040)$/;
const MANIFEST_MAX_BYTES = 16 * 1024 * 1024;

export type PromptRefinerVnextOneShotManifestCheck = Readonly<{
    caseCount: 80;
    koCount: number;
    enCount: number;
    fullManifestValidated: false;
    // This is deliberately not an admission result or a content-free receipt.
    dispatchAuthorized: false;
}>;

const fail = (code: string): never => { throw new Error(code); };

/**
 * Re-read and verify the entire versioned manifest before *each* intended
 * dispatch. The root covers every field except rootDigest, using the v1
 * canonicalBenchmarkJson algorithm. This is one required check, not a full
 * manifest/corpus/predicate validator or server-owned approval read-back.
 */
export function verifyPromptRefinerVnextOneShotManifestRoot(
    manifestText: string,
    expectedRootDigest: string,
    expectedPreregistrationDigest: string
): PromptRefinerVnextOneShotManifestCheck {
    if (typeof manifestText !== "string" ||
        Buffer.byteLength(manifestText, "utf8") > MANIFEST_MAX_BYTES ||
        typeof expectedRootDigest !== "string" ||
        !ROOT_HEX.test(expectedRootDigest) ||
        typeof expectedPreregistrationDigest !== "string" ||
        !ROOT_HEX.test(expectedPreregistrationDigest)) {
        return fail("vnext_one_shot_manifest_input_invalid");
    }
    let parsed: unknown;
    try {
        parsed = parseBenchmarkJson(manifestText, MANIFEST_MAX_BYTES);
    } catch {
        return fail("vnext_one_shot_manifest_json_invalid");
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        return fail("vnext_one_shot_manifest_shape_invalid");
    }
    const manifest = parsed as Record<string, unknown>;
    if (manifest.version !== PROMPT_REFINER_VNEXT_ONE_SHOT_MANIFEST_VERSION ||
        manifest.preregistrationDigest !== expectedPreregistrationDigest ||
        manifest.rootDigest !== expectedRootDigest ||
        !Array.isArray(manifest.cases) || manifest.cases.length !== 80) {
        return fail("vnext_one_shot_manifest_binding_invalid");
    }
    const identifiers = new Set<string>();
    const languageCounts = { ko: 0, en: 0 };
    for (const candidate of manifest.cases) {
        if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
            return fail("vnext_one_shot_manifest_case_invalid");
        }
        const caseId = (candidate as Record<string, unknown>).caseId;
        const match = typeof caseId === "string" ? CASE_ID.exec(caseId) : null;
        if (!match || identifiers.has(caseId as string)) {
            return fail("vnext_one_shot_manifest_case_id_invalid");
        }
        identifiers.add(caseId as string);
        languageCounts[match[1] === "ko" ? "ko" : "en"]++;
    }
    // Unreachable with today's exact 001..040 ID universe and 80 unique IDs;
    // retain this defense for a future case-ID contract change.
    if (languageCounts.ko !== 40 || languageCounts.en !== 40) {
        return fail("vnext_one_shot_manifest_language_count_invalid");
    }
    // The manifest parser returns plain data, so a shallow copy cannot invoke
    // getters. Never mutate the restricted input or include the root in itself.
    const rootInput = { ...manifest };
    delete rootInput.rootDigest;
    let computed: string;
    try {
        computed = createHash("sha256")
            .update(canonicalBenchmarkJson(rootInput), "utf8")
            .digest("hex");
    } catch {
        // Strict JSON parsing yields plain data supported by this canonicalizer;
        // this is defensive against a future canonicalizer/parser contract change.
        return fail("vnext_one_shot_manifest_canonicalization_invalid");
    }
    if (computed !== expectedRootDigest) {
        return fail("vnext_one_shot_manifest_root_mismatch");
    }
    return Object.freeze({
        caseCount: 80,
        koCount: languageCounts.ko,
        enCount: languageCounts.en,
        fullManifestValidated: false,
        dispatchAuthorized: false,
    });
}
