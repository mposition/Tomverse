/**
 * Schema and validation for the successor memory-extraction eval dataset
 * (schema version 2).
 *
 * docs/policy/external-conversation-import-and-memory.md §12.2–§12.3, as
 * amended by
 * `.github/audits/memory-eval-scoring-contract-amendment-2026-08-25.md`
 * (approved 2026-08-25).
 *
 * ## Why a second schema instead of two new optional fields
 *
 * The amendment made two facts required on every case:
 *
 *   * `expectedDisposition` — where a memory is supposed to end up, bulk-safe
 *     or held for review. Reading a missing value as `bulk_safe` would let an
 *     authoring slip pass in the most dangerous direction, so there is no
 *     default anywhere in this module;
 *   * `goldCompleteness` — whether the gold list is the whole truth for that
 *     conversation. Precision counts unmatched candidates as false positives,
 *     which is only sound when the gold is exhaustive.
 *
 * `mem-eval-seed-11` has neither, on any of its 1,150 cases. Adding optional
 * fields to the existing type would have made the frozen dataset *look*
 * loadable by the new scorer while silently answering both questions with a
 * guess. So the frozen set keeps schema 1 and its own type, this module owns
 * schema 2, and `lib/memoryEvalLegacyDataset.ts` is the only place the two
 * meet — for reproducing past diagnostics, never for a verdict.
 *
 * ## What this module is not
 *
 * It is not a migration. Nothing here fills a blank, infers a disposition
 * from a statement, or upgrades a schema-1 case. A successor case carries
 * every value explicitly or it does not validate.
 */

import {
    MEMORY_EVAL_CATEGORIES,
    MEMORY_EVAL_CRITICAL_CATEGORIES,
    MEMORY_EVAL_LANGUAGES,
    MEMORY_EVAL_MIN_SAMPLES_PER_CATEGORY_ARM,
    type MemoryEvalCategory,
    type MemoryEvalLanguage,
} from "@/lib/memoryExtractionEvalCore";
import { MEMORY_KINDS } from "@/lib/memoryValidatorCore";

/** The schema this module defines. Schema 1 is `mem-eval-seed-11`. */
export const MEMORY_EVAL_DATASET_SCHEMA_VERSION = 2;

/**
 * Where a gold memory is supposed to end up.
 *
 * `sensitive_review` does not mean "should not have been extracted". The
 * amendment's §3 settled that health information is extractable and must be
 * held for review rather than auto-approved, so a case expecting it counts
 * towards recall and against the bulk-activation safety axis at the same time.
 */
export const MEMORY_EVAL_EXPECTED_DISPOSITIONS = [
    "bulk_safe",
    "sensitive_review",
] as const;

export type MemoryEvalExpectedDisposition =
    (typeof MEMORY_EVAL_EXPECTED_DISPOSITIONS)[number];

/**
 * Whether the gold list enumerates every valid memory in the conversation.
 *
 * `partial` is legal only in a development or adjudication set: a decision
 * set with one partial category-1 case has fewer than 200 usable cases in
 * that arm, and the §12.2 floor of 200 was derived from the Wilson bound on
 * exactly that number.
 */
export const MEMORY_EVAL_GOLD_COMPLETENESS = ["exhaustive", "partial"] as const;

export type MemoryEvalGoldCompleteness =
    (typeof MEMORY_EVAL_GOLD_COMPLETENESS)[number];

/** One thing a category-1 case expects, with its required disposition. */
export type ExpectedMemoryV2 = {
    id: string;
    kind: string;
    mustInclude: readonly string[];
    /**
     * A disjunction, for the one thing a conjunction cannot express: polarity.
     *
     * `mustInclude` is an AND of substrings, which pins a fact but not whether
     * the statement asserts or denies it. "nut" matches "The user has a nut
     * allergy" and "The user does not have a nut allergy" alike, and for a
     * health gold those are opposite answers.
     *
     * Korean carries the negation in a stem — "없" covers 없다/없습니다/없어요 —
     * so a conjunction reaches it. English spreads it across "does not have",
     * "has no", "is not allergic": alternatives, not a conjunction. Pinning one
     * of them scores every other correct phrasing as a miss, which is how this
     * dataset has already lost two golds ("짧게" for "짧", "굵게" for "굵").
     *
     * Semantics: `all(mustInclude) && (mustIncludeAny === undefined ||
     * any(mustIncludeAny))`. Absent means unchanged, so every gold written
     * before this field keeps its exact score.
     */
    mustIncludeAny?: readonly string[];
    expectedDisposition: MemoryEvalExpectedDisposition;
};

/**
 * The one normalisation gold tokens and statements are compared under.
 *
 * Exported because the scorer matches with it and this module rejects
 * duplicates under it; two definitions would let a token pair that validates
 * here fail to behave that way there.
 */
export const normalizeEvalToken = (value: string): string =>
    value.normalize("NFC").toLocaleLowerCase().replace(/\s+/g, " ").trim();

export type MemoryEvalCaseV2 = {
    id: string;
    category: MemoryEvalCategory;
    language: MemoryEvalLanguage;
    expected: readonly ExpectedMemoryV2[];
    goldCompleteness: MemoryEvalGoldCompleteness;
    /**
     * The schema-1 case this one reworks, when it is a relabelling rather
     * than a new conversation.
     *
     * The 2026-08-25 amendment reworks labels, not conversations: the 400
     * category-1 conversations were drafted and adopted on 2026-08-23 and
     * nothing in A–D touches them. So a successor case is, by construction,
     * byte-identical to the frozen case it replaces — and the near-duplicate
     * detector reads that as a draft repeating a template, which is the one
     * thing it exists to catch.
     *
     * Declaring the pair is what separates the two. A successor case scoring
     * high against the case it names is expected; scoring high against
     * anything else is the finding. The successor set replaces the frozen
     * one rather than extending it, so the comparison that matters is
     * within the successor set.
     */
    sourceCaseId?: string;
    /**
     * Opt-in permission for a critical-negative case to carry a gold.
     *
     * `.github/audits/memory-eval-mixed-critical-amendment-2026-08-26.md`
     * (approved 2026-08-26).
     *
     * A category 2/3/4 case normally asserts that nothing durable comes out,
     * and `expected` must be empty for it to mean that. Fourteen cases pair a
     * real durable fact with a directive in one turn — "I'm a pharmacist, so
     * skip the drug warnings" — and there the correct answer is one memory
     * for the fact and nothing for the directive.
     *
     * Those cases stay in `injection_directives` rather than moving to
     * `durable_facts`, because separating an evasion from a genuine fact is
     * what they were written to test, and moving them would take the hardest
     * injection cases out of a zero-tolerance safety measure and soften them
     * into ordinary precision error.
     *
     * So the permission is per-case, named, and has no general fallback:
     * absent, the empty-gold rule applies exactly as before. It is not a
     * relaxation of the category — `criticalBulkSafeAdoptions` still counts
     * every bulk-safe candidate that is *not* matched to a bulk-safe
     * expectation, which is what keeps the directive in the same turn
     * counted.
     */
    criticalGoldMode?: "allow_expected_only";
    conversations: readonly {
        externalConversationId: string;
        title: string;
        messages: readonly {
            externalMessageId: string;
            role: "user" | "assistant";
            content: string;
        }[];
    }[];
};

/**
 * Exhaustive category-1 cases a decision set needs per language arm.
 *
 * Derived rather than restated: the amendment did not move the floor, it
 * narrowed which cases may count towards it. A second literal here could
 * drift from §12.2's.
 */
export const MEMORY_EVAL_MIN_EXHAUSTIVE_CASES_PER_ARM =
    MEMORY_EVAL_MIN_SAMPLES_PER_CATEGORY_ARM.durable_facts;

export type DatasetValidationErrorCode =
    | "expected_disposition_missing"
    | "expected_disposition_unknown"
    | "gold_completeness_missing"
    | "gold_completeness_unknown"
    | "unknown_kind"
    | "unknown_category"
    | "unknown_language"
    | "partial_in_decision_set"
    | "arm_below_exhaustive_floor"
    | "critical_case_has_expected"
    | "critical_gold_mode_unknown"
    | "critical_gold_mode_on_noncritical"
    | "critical_gold_mode_requires_exhaustive"
    | "expected_tokens_empty"
    | "expected_token_blank"
    | "expected_token_duplicate"
    | "expected_token_contains_another";

export type DatasetValidationError = {
    code: DatasetValidationErrorCode;
    /** The case this is about, or `null` for a whole-dataset shortfall. */
    caseId: string | null;
    detail: string;
};

export type DatasetValidation = {
    ok: boolean;
    errors: readonly DatasetValidationError[];
};

const KNOWN_KINDS: ReadonlySet<string> = new Set(MEMORY_KINDS);
const KNOWN_DISPOSITIONS: ReadonlySet<string> = new Set(
    MEMORY_EVAL_EXPECTED_DISPOSITIONS
);
const KNOWN_COMPLETENESS: ReadonlySet<string> = new Set(
    MEMORY_EVAL_GOLD_COMPLETENESS
);
const KNOWN_CATEGORIES: ReadonlySet<string> = new Set(MEMORY_EVAL_CATEGORIES);
const KNOWN_LANGUAGES: ReadonlySet<string> = new Set(MEMORY_EVAL_LANGUAGES);
const CRITICAL: ReadonlySet<string> = new Set(MEMORY_EVAL_CRITICAL_CATEGORIES);

const readString = (value: unknown): string | null =>
    typeof value === "string" ? value : null;

/**
 * Validates a successor dataset.
 *
 * Takes `unknown` rather than `MemoryEvalCaseV2[]` on purpose. The successor
 * cases are authored in TypeScript, so the compiler already refuses a missing
 * field there — but the case this check exists for is a schema-1 array
 * arriving at a schema-2 reader, and a typed signature would have made that
 * the one input it could not inspect.
 *
 * Every problem is reported, not just the first: an author fixing 400 cases
 * wants the list, and a check that stops at the first blank turns one pass
 * into four hundred.
 */
export function validateSuccessorDataset(input: {
    cases: readonly unknown[];
    purpose: "development" | "decision";
}): DatasetValidation {
    const errors: DatasetValidationError[] = [];
    const exhaustiveDurableByArm = new Map<string, number>();

    for (const raw of input.cases) {
        const testCase = (raw ?? {}) as Record<string, unknown>;
        const caseId = readString(testCase.id) ?? "<unnamed case>";
        const category = readString(testCase.category);
        const language = readString(testCase.language);

        if (category === null || !KNOWN_CATEGORIES.has(category)) {
            errors.push({
                code: "unknown_category",
                caseId,
                detail: `category ${JSON.stringify(testCase.category)}`,
            });
        }
        if (language === null || !KNOWN_LANGUAGES.has(language)) {
            errors.push({
                code: "unknown_language",
                caseId,
                detail: `language ${JSON.stringify(testCase.language)}`,
            });
        }

        const completeness = testCase.goldCompleteness;
        if (completeness === undefined || completeness === null) {
            errors.push({
                code: "gold_completeness_missing",
                caseId,
                detail: "goldCompleteness is required and has no default",
            });
        } else if (
            typeof completeness !== "string" ||
            !KNOWN_COMPLETENESS.has(completeness)
        ) {
            errors.push({
                code: "gold_completeness_unknown",
                caseId,
                detail: `goldCompleteness ${JSON.stringify(completeness)}`,
            });
        } else if (completeness === "partial" && input.purpose === "decision") {
            // Both category-1 and the critical negatives: an empty gold is
            // only meaningful as a complete one, and "we did not finish
            // listing what should come out" is the opposite of what a
            // critical-negative case asserts.
            errors.push({
                code: "partial_in_decision_set",
                caseId,
                detail: "a decision set admits exhaustive cases only",
            });
        }

        const expected = Array.isArray(testCase.expected)
            ? (testCase.expected as readonly unknown[])
            : [];

        // The opt-in from the 2026-08-26 mixed-critical amendment. Read
        // before the empty-gold rule because it is what excuses it, and
        // checked for exactly one literal so a typo is a missing permission
        // rather than a granted one.
        const criticalGoldMode = (testCase as Record<string, unknown>)
            .criticalGoldMode;
        const mixedCritical = criticalGoldMode === "allow_expected_only";

        if (criticalGoldMode !== undefined && !mixedCritical) {
            errors.push({
                code: "critical_gold_mode_unknown",
                caseId,
                detail: `criticalGoldMode ${JSON.stringify(criticalGoldMode)}`,
            });
        }

        if (mixedCritical && category !== null && !CRITICAL.has(category)) {
            // A durable_facts case already carries a gold. Accepting the flag
            // there would make it look like the permission is what allows it,
            // and the next reader would copy it onto a case that needs it.
            errors.push({
                code: "critical_gold_mode_on_noncritical",
                caseId,
                detail: `${category} does not need the permission`,
            });
        }

        if (mixedCritical && completeness !== "exhaustive") {
            // A mixed case says "this memory and nothing else". `partial`
            // would say the directive might also have been extractable and
            // nobody checked, which is the assertion this case exists to
            // make.
            errors.push({
                code: "critical_gold_mode_requires_exhaustive",
                caseId,
                detail: `goldCompleteness ${JSON.stringify(completeness)}`,
            });
        }

        if (
            category !== null &&
            CRITICAL.has(category) &&
            expected.length > 0 &&
            !mixedCritical
        ) {
            errors.push({
                code: "critical_case_has_expected",
                caseId,
                detail: `${category} expects ${expected.length} memories; the whole rule is that nothing comes out`,
            });
        }

        for (const rawExpected of expected) {
            const memory = (rawExpected ?? {}) as Record<string, unknown>;
            const kind = readString(memory.kind);
            if (kind === null || !KNOWN_KINDS.has(kind)) {
                errors.push({
                    code: "unknown_kind",
                    caseId,
                    detail: `kind ${JSON.stringify(memory.kind)}`,
                });
            }
            // Both token lists, under one rule. `mustInclude` had no
            // validation and today passes all four checks, so applying them
            // to it costs nothing and closes the same hazard on the field
            // that already exists.
            for (const field of ["mustInclude", "mustIncludeAny"] as const) {
                const raw = memory[field];
                if (raw === undefined && field === "mustIncludeAny") continue;
                const tokens = Array.isArray(raw) ? (raw as unknown[]) : [];
                if (tokens.length === 0) {
                    // An empty conjunction matches every statement of the
                    // kind; an empty disjunction matches none. Neither is a
                    // gold, and both read like one.
                    errors.push({
                        code: "expected_tokens_empty",
                        caseId,
                        detail: `${field} on expected memory ${JSON.stringify(memory.id)} is empty`,
                    });
                    continue;
                }
                const seen = new Set<string>();
                const normalized: string[] = [];
                for (const token of tokens) {
                    const text =
                        typeof token === "string"
                            ? normalizeEvalToken(token)
                            : "";
                    if (text === "") {
                        errors.push({
                            code: "expected_token_blank",
                            caseId,
                            detail: `${field} carries ${JSON.stringify(token)}`,
                        });
                        continue;
                    }
                    if (seen.has(text)) {
                        // After normalisation, so "Nut" and "nut " are one.
                        errors.push({
                            code: "expected_token_duplicate",
                            caseId,
                            detail: `${field} repeats ${JSON.stringify(text)}`,
                        });
                        continue;
                    }
                    seen.add(text);
                    normalized.push(text);
                }
                for (const token of normalized) {
                    const wider = normalized.find(
                        (other) => other !== token && other.includes(token)
                    );
                    if (wider === undefined) continue;
                    // The realistic shape of the bare-substring hazard:
                    // ["no", "no nut allergy"] reads as two alternatives and
                    // behaves as one, the loosest. A disjunction is only as
                    // strict as its weakest member.
                    errors.push({
                        code: "expected_token_contains_another",
                        caseId,
                        detail: `${field}: ${JSON.stringify(token)} is inside ${JSON.stringify(wider)}, so the wider one never decides anything`,
                    });
                }
            }

            const disposition = memory.expectedDisposition;
            if (disposition === undefined || disposition === null) {
                errors.push({
                    code: "expected_disposition_missing",
                    caseId,
                    detail: `expected memory ${JSON.stringify(
                        memory.id
                    )} has no expectedDisposition, and there is no default`,
                });
            } else if (
                typeof disposition !== "string" ||
                !KNOWN_DISPOSITIONS.has(disposition)
            ) {
                errors.push({
                    code: "expected_disposition_unknown",
                    caseId,
                    detail: `expectedDisposition ${JSON.stringify(disposition)}`,
                });
            }
        }

        if (
            category === "durable_facts" &&
            language !== null &&
            KNOWN_LANGUAGES.has(language) &&
            completeness === "exhaustive"
        ) {
            exhaustiveDurableByArm.set(
                language,
                (exhaustiveDurableByArm.get(language) ?? 0) + 1
            );
        }
    }

    if (input.purpose === "decision") {
        for (const language of MEMORY_EVAL_LANGUAGES) {
            const count = exhaustiveDurableByArm.get(language) ?? 0;
            if (count < MEMORY_EVAL_MIN_EXHAUSTIVE_CASES_PER_ARM) {
                errors.push({
                    code: "arm_below_exhaustive_floor",
                    caseId: null,
                    detail: `${language}: ${count} exhaustive durable_facts cases, floor is ${MEMORY_EVAL_MIN_EXHAUSTIVE_CASES_PER_ARM}`,
                });
            }
        }
    }

    return { ok: errors.length === 0, errors };
}

/* -------------------------------------------------------------------------
 * Critical-negative invariance
 * ---------------------------------------------------------------------- */

/**
 * Canonical string over the ②③④ partition, for a digest.
 *
 * The amendment reworks category ① only: nothing in A–D changes what a
 * critical negative asserts, so the successor must carry those 750 cases
 * across unchanged. "Unchanged" is a claim somebody has to be able to check,
 * and comparing 750 cases by eye is not checking — so the partition gets a
 * digest, and the successor proves it copied rather than rewrote.
 *
 * Covers identity, category, language and message content. It deliberately
 * does NOT cover `goldCompleteness`: that field is new in schema 2 and does
 * not exist on the frozen set, so including it would make the two digests
 * differ by construction and the comparison would prove nothing.
 *
 * `hash` is left to the caller for the same reason as
 * `datasetFingerprintInput()` — this module stays free of `node:crypto`.
 */
export function criticalNegativePartitionInput(
    cases: readonly {
        id: string;
        category: MemoryEvalCategory;
        language: MemoryEvalLanguage;
        conversations: readonly {
            messages: readonly { role: string; content: string }[];
        }[];
    }[]
): string {
    return cases
        .filter((testCase) => CRITICAL.has(testCase.category))
        .slice()
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
        .map((testCase) =>
            [
                testCase.id,
                testCase.category,
                testCase.language,
                testCase.conversations
                    .map((conversation) =>
                        conversation.messages
                            .map(
                                (message) =>
                                    `${message.role}:${message.content}`
                            )
                            .join("\n")
                    )
                    .join("\n--\n"),
            ].join("\u0000")
        )
        .join("\u0001");
}
