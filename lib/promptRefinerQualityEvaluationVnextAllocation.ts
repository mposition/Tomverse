/**
 * Offline-only validation of the content-free allocation projection for the
 * approved 80-slot design. This is not a full manifest validator: it cannot
 * verify prompts, witnesses, source closure, a manifest root, or CSPRNG origin.
 * Never use its return value as sealing, admission, or gate evidence.
 */
import { createHmac } from "node:crypto";
import { parseBenchmarkJson, strictBenchmarkObject } from "./routerDevelopmentBenchmark";
import { validatePromptRefinerVnextDirectionCase } from "./promptRefinerQualityEvaluationVnextCore";

const LANGUAGES = ["ko", "en"] as const;
const CASES_PER_LANGUAGE = 40;
const ALLOCATION_BYTES = 64 * 1024;
const SEED_HEX = /^[0-9a-f]{64}$/;
const CASE_ID = /^prsvnext-(ko|en)-(?:00[1-9]|0[1-3][0-9]|040)$/;

const CELLS = {
    general_rewrite: { count: 8, direction: "rewrite_expected" },
    injection_framing: { count: 4, direction: "rewrite_expected" },
    quoted_literal: { count: 4, direction: "rewrite_expected" },
    code_json_literal: { count: 4, direction: "rewrite_expected" },
    constraint_negation: { count: 4, direction: "rewrite_expected" },
    range_number: { count: 4, direction: "rewrite_expected" },
    forbidden_or_safety_addition: { count: 4, direction: "rewrite_expected" },
    safety_abstain_direct: { count: 4, direction: "abstain_preferred" },
    safety_abstain_indirect: { count: 4, direction: "abstain_preferred" },
} as const;

const CHALLENGE_QUOTAS = {
    boundary_near_miss: { constraint_negation: 2, range_number: 2 },
    adversarial_variant: {
        injection_framing: 1,
        forbidden_or_safety_addition: 1,
        safety_abstain_direct: 1,
        safety_abstain_indirect: 1,
    },
    mixed_language: {
        general_rewrite: 1,
        quoted_literal: 1,
        code_json_literal: 1,
        forbidden_or_safety_addition: 1,
    },
    constrained_format: {
        general_rewrite: 2,
        quoted_literal: 1,
        code_json_literal: 1,
    },
} as const;

type Language = (typeof LANGUAGES)[number];
type Cell = keyof typeof CELLS;
type Challenge = keyof typeof CHALLENGE_QUOTAS;

function fail(code: string): never {
    throw new Error(code);
}

function ordinalId(language: Language, rank: number): string {
    return `prsvnext-${language}-${String(rank).padStart(3, "0")}`;
}

function expectedIds(seed: Buffer, language: Language): Map<number, string> {
    const ranked = Array.from({ length: CASES_PER_LANGUAGE }, (_, index) => {
        const ordinal = index + 1;
        const message = `case-id-v1:${language}:${String(ordinal).padStart(3, "0")}`;
        return {
            ordinal,
            digest: createHmac("sha256", seed).update(message, "utf8").digest(),
        };
    }).sort((left, right) => Buffer.compare(left.digest, right.digest));
    if (ranked.some((entry, index) => index > 0 && entry.digest.equals(ranked[index - 1].digest))) {
        return fail("vnext_allocation_digest_collision");
    }
    return new Map(ranked.map((entry, index) => [entry.ordinal, ordinalId(language, index + 1)]));
}

/**
 * Input is strict JSON, never a caller-owned object with getters or Proxies.
 * The projection contains no source text, case label, witness, or rubric.
 * A valid projection is still insufficient to seal or run a restricted manifest.
 */
export function validatePromptRefinerVnextAllocationProjection(text: string): void {
    if (typeof text !== "string") return fail("vnext_allocation_json_invalid");
    let parsed: unknown;
    try {
        parsed = parseBenchmarkJson(text, ALLOCATION_BYTES);
    } catch {
        return fail("vnext_allocation_json_invalid");
    }
    const projection = strictBenchmarkObject(parsed, ["version", "seedHex", "cases"], "vnext_allocation");
    if (projection.version !== "allocation-projection-v1" ||
        typeof projection.seedHex !== "string" || !SEED_HEX.test(projection.seedHex)) {
        return fail("vnext_allocation_header_invalid");
    }
    if (!Array.isArray(projection.cases) || projection.cases.length !== 80) {
        return fail("vnext_allocation_case_count_invalid");
    }
    const seed = Buffer.from(projection.seedHex, "hex");
    const ids = Object.fromEntries(LANGUAGES.map((language) => [language, expectedIds(seed, language)])) as Record<Language, Map<number, string>>;
    const ordinals = new Set<string>();
    const cellCounts = new Map<string, number>();
    const challengeCounts = new Map<string, number>();
    for (const candidate of projection.cases) {
        const item = strictBenchmarkObject(candidate, [
            "language", "ordinal", "caseId", "baseCell", "eligibleChallengeTag",
            "expectedDirection", "allowedAbstentionReasons",
        ], "vnext_allocation_case");
        if (item.language !== "ko" && item.language !== "en") {
            return fail("vnext_allocation_language_invalid");
        }
        const language = item.language;
        if (!Number.isSafeInteger(item.ordinal) || (item.ordinal as number) < 1 ||
            (item.ordinal as number) > CASES_PER_LANGUAGE) {
            return fail("vnext_allocation_ordinal_invalid");
        }
        const ordinal = item.ordinal as number;
        const ordinalKey = `${language}:${ordinal}`;
        if (ordinals.has(ordinalKey)) return fail("vnext_allocation_duplicate_ordinal");
        ordinals.add(ordinalKey);
        if (typeof item.caseId !== "string" || !CASE_ID.test(item.caseId) ||
            item.caseId !== ids[language].get(ordinal)) {
            return fail("vnext_allocation_case_id_invalid");
        }
        if (typeof item.baseCell !== "string" || !Object.hasOwn(CELLS, item.baseCell)) {
            return fail("vnext_allocation_cell_invalid");
        }
        const cell = item.baseCell as Cell;
        const contract = validatePromptRefinerVnextDirectionCase({
            expectedDirection: item.expectedDirection,
            allowedAbstentionReasons: item.allowedAbstentionReasons,
        });
        if (contract.expectedDirection !== CELLS[cell].direction ||
            (contract.expectedDirection === "abstain_preferred" &&
                // Defence in depth if the shared reason enum widens later.
                (contract.allowedAbstentionReasons.length !== 1 ||
                    contract.allowedAbstentionReasons[0] !== "unsafe_to_rewrite"))) {
            return fail("vnext_allocation_direction_invalid");
        }
        const cellKey = `${language}:${cell}`;
        cellCounts.set(cellKey, (cellCounts.get(cellKey) ?? 0) + 1);
        if (item.eligibleChallengeTag !== null) {
            if (typeof item.eligibleChallengeTag !== "string" ||
                !Object.hasOwn(CHALLENGE_QUOTAS, item.eligibleChallengeTag)) {
                return fail("vnext_allocation_challenge_invalid");
            }
            const challenge = item.eligibleChallengeTag as Challenge;
            const quota = CHALLENGE_QUOTAS[challenge] as Partial<Record<Cell, number>>;
            if (!Object.hasOwn(quota, cell)) return fail("vnext_allocation_challenge_cell_invalid");
            const key = `${language}:${challenge}:${cell}`;
            challengeCounts.set(key, (challengeCounts.get(key) ?? 0) + 1);
        }
    }
    for (const language of LANGUAGES) {
        for (const [cell, rule] of Object.entries(CELLS)) {
            if (cellCounts.get(`${language}:${cell}`) !== rule.count) {
                return fail("vnext_allocation_cell_quota_invalid");
            }
        }
        for (const [challenge, quota] of Object.entries(CHALLENGE_QUOTAS)) {
            for (const [cell, count] of Object.entries(quota)) {
                if (challengeCounts.get(`${language}:${challenge}:${cell}`) !== count) {
                    return fail("vnext_allocation_challenge_quota_invalid");
                }
            }
        }
    }
}
