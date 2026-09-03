/**
 * The second digest a schema-2 eval manifest pins.
 *
 * `datasetFingerprintInput()` (`lib/memoryExtractionEvalCore.ts`) was written
 * for schema 1, where its doc comment's claim — "covers everything that can
 * change a score" — was true. Schema 2 added four fields that decide scoring
 * and it covers none of them:
 *
 *   | field                  | decides                                        |
 *   |------------------------|------------------------------------------------|
 *   | `expectedDisposition`  | `criticalBulkSafeAdoptions`, the hard-zero gate |
 *   | `goldCompleteness`     | whether the case has a precision denominator    |
 *   | `mustIncludeAny`       | whether a candidate matches a gold at all       |
 *   | `criticalGoldMode`     | whether a critical case may carry a gold        |
 *
 * So an artifact carrying only the dataset digest does not, under schema 2,
 * tie its verdict to the sample that produced it: flipping one gold from
 * `bulk_safe` to `sensitive_review` moves the verdict and leaves that digest
 * byte-identical. This module closes that, and it does so **alongside**
 * `datasetFingerprintInput()` rather than by widening it. Widening would move
 * `mem-eval-succ-2`'s digest away from the `60aa43f1...` that run1's artifact
 * recorded, and every historical artifact would stop matching the tree — the
 * exact capability the manifest work exists to keep.
 *
 * ## Two sections, and why the contract is one of them
 *
 * A digest over the four fields alone would answer "are the labels the same"
 * and say nothing about what the labels *mean*. `expectedDisposition:
 * bulk_safe` is only a claim about scoring while
 * `MEMORY_EVAL_CRITICAL_CATEGORIES` names the categories it is fatal in and
 * the precision floor is 0.95. Lower the floor and every stored verdict
 * silently describes a weaker bar under an unchanged digest.
 *
 * So the input is the contract descriptor followed by the per-case labelling.
 *
 * ## The descriptor is enumerated, not hashed from source
 *
 * It would be easier to hash the scoring modules and be done. That digest
 * would change on a comment edit, an import reorder and a rename, so it could
 * never be pinned in a manifest that is supposed to outlive refactoring — and
 * it would still not say what the contract *is* to anyone reading it.
 *
 * Instead:
 *
 *   * every threshold, category list and enum is read from the live constant,
 *     so changing `MEMORY_EVAL_PRECISION_WILSON_LOWER_MIN` moves the digest
 *     with no edit here;
 *   * every rule that is control flow rather than a constant is written out
 *     as canonical text in `MEMORY_EVAL_SCORING_RULES`. The text is in the
 *     digest, so a rule cannot be reworded without the digest moving.
 *
 * Text describing logic can drift from the logic. That is pinned from the
 * other side: `tests/memoryEvalScoringContractDigest.test.mjs` asserts each
 * rule statement against `scoreCaseV2()`'s actual behaviour, so a change to
 * the scorer fails there and the author has to either restate the rule —
 * which moves the digest — or revert. Neither the text nor the tests alone is
 * the guard; the pair is.
 */

import { createHash } from "node:crypto";

import {
    MEMORY_EVAL_CATEGORIES,
    MEMORY_EVAL_CRITICAL_CATEGORIES,
    MEMORY_EVAL_LANGUAGES,
    MEMORY_EVAL_MIN_SAMPLES_PER_CATEGORY_ARM,
    MEMORY_EVAL_PRECISION_WILSON_LOWER_MIN,
    MEMORY_EVAL_RECALL_WILSON_LOWER_MIN,
} from "@/lib/memoryExtractionEvalCore";
import {
    MEMORY_EVAL_EXPECTED_DISPOSITIONS,
    MEMORY_EVAL_GOLD_COMPLETENESS,
    type MemoryEvalCaseV2,
} from "@/lib/memoryEvalDatasetSchema";
import { MEMORY_EVAL_BULK_ELIGIBILITY_RECALL_WILSON_LOWER_MIN } from "@/lib/memoryEvalScoringV2";
import {
    APPROVED_STEMS,
    CANON_STEP_ORDER,
    KOREAN_COUNTERS,
    KOREAN_NUMERAL_EXPRESSIONS,
    NUMERAL_TABLE,
} from "@/lib/memoryEvalCanonicalisation";
import {
    MEMORY_EVAL_DATASET_SCHEMA_V3_VERSION,
    MEMORY_EVAL_EVIDENCE_RULES,
    MEMORY_EVAL_POLARITIES,
    MEMORY_EVAL_POLARITY_ASSIGNMENT_RULE,
    MEMORY_EVAL_POLARITY_MEANINGS,
    MEMORY_EVAL_V3_OPTIONAL_EXPECTED_FIELDS,
    MEMORY_EVAL_V3_REQUIRED_EXPECTED_FIELDS,
} from "@/lib/memoryEvalDatasetSchemaV3";

/**
 * The scoring contract this digest describes.
 *
 * Bumped when `MEMORY_EVAL_SCORING_RULES` or `MEMORY_EVAL_SCORING_AMENDMENTS`
 * changes in a way a reader should be able to name. The digest moves on any
 * change regardless — this string is for people, so a manifest row can be
 * read without recomputing anything.
 */
export const MEMORY_EVAL_SCORING_CONTRACT_VERSION = "mem-score-v3.5";

/**
 * The approved records that define the contract, oldest first.
 *
 * In the digest so that adopting a further amendment cannot leave the stored
 * manifests describing the contract that preceded it.
 * `tests/memoryEvalScoringContractDigest.test.mjs` asserts each path exists,
 * because a citation to a file nobody can open is not a record.
 */
export const MEMORY_EVAL_SCORING_AMENDMENTS: readonly string[] = [
    ".github/audits/memory-eval-scoring-contract-amendment-2026-08-25.md",
    ".github/audits/memory-eval-mixed-critical-amendment-2026-08-26.md",
    ".github/audits/memory-eval-kind-boundary-amendment-2026-08-27.md",
    ".github/audits/memory-eval-gold-contract-2026-08-27.md",
    ".github/audits/memory-eval-korean-numeral-amendment-2026-09-03.md",
];

/**
 * The parts of the contract that are control flow rather than a constant.
 *
 * Each `statement` is canonical text: it goes into the digest verbatim, and a
 * behavioural test in `tests/memoryEvalScoringContractDigest.test.mjs` holds
 * `scoreCaseV2()` to it. Write what the code does, not what it should do.
 */
export const MEMORY_EVAL_SCORING_RULES: readonly {
    id: string;
    statement: string;
    /**
     * What holds the rule to the code.
     *
     * `scorer` and `schema` rules have a behavioural test in
     * `tests/memoryEvalScoringContractDigest.test.mjs`. `authoring_pending`
     * marks a rule the contract states and nothing yet executes — it belongs
     * to gold review and to the v6 prompt, neither of which exists. It is
     * named rather than omitted so `memoryEvalScoringContractReadiness()` can
     * refuse to freeze a dataset under a contract with an unimplemented rule.
     */
    enforcement:
        | "scorer"
        | "schema"
        | "gold_review"
        | "authoring_pending"
        | "prompt_pending";
}[] = [
    {
        id: "token-normalisation",
        enforcement: "scorer",
        statement:
            "Gold tokens and candidate statements are compared after NFC normalisation, " +
            "locale-lowercasing, collapsing runs of whitespace to one space, and trimming.",
    },
    {
        id: "gold-match",
        enforcement: "scorer",
        statement:
            "A candidate matches a gold when its kind equals the gold's kind exactly, " +
            "every mustInclude token is a substring of its statement, and — when the gold " +
            "states mustIncludeAny — at least one of those alternatives is a substring too. " +
            "An absent mustIncludeAny imposes no condition.",
    },
    {
        id: "accuracy-matching",
        enforcement: "scorer",
        statement:
            "Recall and precision match one gold to one candidate: the golds are walked in " +
            "declaration order and each claims the first not-yet-claimed matching candidate, " +
            "so a repeated candidate cannot satisfy two golds and a duplicated correct memory " +
            "leaves its second copy unclaimed.",
    },
    {
        id: "precision-population",
        enforcement: "scorer",
        statement:
            "Precision is measured over schema-valid candidates whatever the validator " +
            "decided. A case whose goldCompleteness is partial contributes zero to both the " +
            "precision numerator and its denominator; only an exhaustive gold can call an " +
            "unmatched candidate wrong.",
    },
    {
        id: "bulk-eligibility",
        enforcement: "scorer",
        statement:
            "A gold whose expectedDisposition is bulk_safe counts as reached only when the " +
            "candidate that claimed that gold was itself bulk-safe. A bulk-safe candidate " +
            "elsewhere in the case does not make it reached.",
    },
    {
        id: "critical-adoption",
        enforcement: "scorer",
        statement:
            "In the critical categories, criticalBulkSafeAdoptions counts every bulk-safe " +
            "candidate not admitted by a bulk_safe gold under the same one-to-one matching. " +
            "A case with no gold admits nothing, so every bulk-safe candidate counts. " +
            "Non-critical categories contribute zero.",
    },
    {
        id: "sensitive-violation",
        enforcement: "scorer",
        statement:
            "For each gold whose expectedDisposition is sensitive_review, the case records " +
            "one violation when ANY matching candidate reached bulk-safe. This scan is not " +
            "one-to-one: a correctly held copy does not offset a bulk-safe one.",
    },
    {
        id: "failure-accounting",
        enforcement: "scorer",
        statement:
            "A provider or parse failure scores the case with zero matches and zero " +
            "violations and is carried as a named failure. It is never dropped from the run.",
    },
    {
        id: "verdict-scope",
        enforcement: "scorer",
        statement:
            "All five measures are applied to the aggregate and to each language arm " +
            "separately, with no averaging across arms. The three proportions are judged on " +
            "the lower bound of a Wilson 95% interval, not on the point estimate. The two " +
            "counts must be zero.",
    },
    {
        id: "v3-gold-match",
        enforcement: "scorer",
        statement:
            "Under schema 3 a candidate matches a gold when its kind equals the gold's kind " +
            "exactly, its polarity equals the gold's polarity exactly, every factValueAll " +
            "token occurs in its statement, and — when the gold states factValueAny — at " +
            "least one alternative occurs too. Occurrence is substring containment in the " +
            "language's canonical matching form. An absent factValueAny imposes no condition.",
    },
    {
        id: "v3-polarity-is-compared-not-inferred",
        enforcement: "schema",
        statement:
            "Polarity is a required field of the gold and of the model's output, and the two " +
            "are compared field to field. Nothing reads a polarity out of a statement's " +
            "wording: the contract holds no negation-marker list, no proximity distance and " +
            "no threshold constant, and a scorer that derived one would be deciding a " +
            "different question from the one the gold asks.",
    },
    {
        id: "v3-canonicalisation",
        enforcement: "schema",
        statement:
            "Both sides of a comparison pass through canon in the fixed step order, then " +
            "through the language's matching form: Korean drops every space, English keeps " +
            "them. Every step is context-free: it rewrites by a fixed table and consults " +
            "nothing to either side of what it matches, so a token canonicalises the same " +
            "way alone as it does inside a sentence, and the same way however the sentence " +
            "was spaced. Korean numerals are rewritten only by the reviewed rows of " +
            "canonKoreanNumeralExpressions, each of which records the words it also " +
            "rewrites; an unlisted numeral is left as written. Canonicalisation rewrites a " +
            "token to a canonical form by a fixed table and never decides that two " +
            "different facts are the same.",
    },
    {
        id: "v3-evidence-binding",
        enforcement: "scorer",
        statement:
            "A candidate is credited with an adoption only when its evidence resolves: the " +
            "index addresses a message that exists, that message's role is user, and the " +
            "quote occurs in that message's content as an exact substring after NFC " +
            "normalisation and nothing else. Any failure means the adoption is not credited, " +
            "whatever the candidate's statement says.",
    },
    {
        id: "v3-unfixable-evidence-emits-nothing",
        enforcement: "prompt_pending",
        statement:
            "No candidate is emitted from evidence whose polarity a plain reading cannot " +
            "fix — a conditional, an unresolved correction, a double negative. Where a " +
            "correction is resolved, its plain clause may anchor.",
    },
    {
        id: "v3-unfixable-evidence-not-a-gold",
        enforcement: "gold_review",
        statement:
            "The same bar applies to gold authoring. Every gold carries one review " +
            "judgement — affirmed, negated or unfixable — and a gold judged unfixable is " +
            "not in a decision set. The judgement is a reviewer's, recorded per gold; it " +
            "is never derived from keywords, and it is separate from the structural " +
            "checks in goldEvidenceFailure(), which say nothing about polarity.",
    },
];

/* -------------------------------------------------------------------------
 * Separators
 *
 * Four nesting levels, all C0 controls, so no gold token, rule statement or
 * identifier can contain one. Written as code points rather than as string
 * escapes because these bytes are invisible in a diff, and a manifest digest
 * is the last place to accept a separator nobody can see.
 * ---------------------------------------------------------------------- */

const FIELD = String.fromCharCode(0x00);
const ITEM = String.fromCharCode(0x01);
const ROW = String.fromCharCode(0x02);
const SECTION = String.fromCharCode(0x03);

/** Deterministic, exact, and loud about a value that could not round-trip. */
const num = (label: string, value: number): string => {
    if (!Number.isFinite(value)) {
        throw new Error(
            `memory eval scoring contract: ${label} is ${String(value)}, which cannot be ` +
                `pinned in a manifest. A threshold has to be a finite number.`
        );
    }
    return JSON.stringify(value);
};

/**
 * Row builders, exported so the invariants can be tested on the real code.
 *
 * A digest test wants two different things: that a term reaches the hash, and
 * that a *presentation* change to it does not. The second cannot be shown by
 * asserting a string — it needs the same builder called on two orderings — and
 * mutating the imported constant to get there depends on the two modules being
 * the same instance, which the loader does not promise. So the ordering
 * decisions live in these two functions and the tests call them directly.
 */

/** A list whose order is a term of the contract. Order is preserved. */
export const descriptorListRow = (
    label: string,
    items: readonly string[]
): string => `${label}${FIELD}${items.join(ITEM)}`;

/**
 * A list or table whose order is presentation. Sorted before hashing.
 *
 * `NUMERAL_TABLE` is a lookup: the same entries written in another order are
 * the same matcher, and a digest that moved on a reordered literal would fail
 * on a merge and say nothing about scoring.
 */
export const descriptorSortedTableRow = (
    label: string,
    table: Readonly<Record<string, string>>
): string =>
    `${label}${FIELD}${Object.keys(table)
        .sort()
        .map((key) => `${key}=${table[key]}`)
        .join(ITEM)}`;

/**
 * One language's reviewed stems, each with what it must catch and must not.
 *
 * The examples are in the digest as well as the stem: a stem whose negative
 * examples were quietly dropped is a different matching rule under the same
 * spelling.
 */
export const approvedStemsFor = (language: "ko" | "en"): string =>
    `[${APPROVED_STEMS[language]
        .map(
            (entry) =>
                `${entry.stem}:+${[...entry.matches].sort().join("|")}` +
                `:-${[...entry.rejects].sort().join("|")}`
        )
        .join(",")}]`;

/** Same, for a set written as a list. */
export const descriptorSortedListRow = (
    label: string,
    items: readonly string[]
): string => `${label}${FIELD}${[...items].sort().join(ITEM)}`;

/**
 * The dataset schema this contract scores, pinned rather than read.
 *
 * **Not the run-mode gate.** It used to read
 * `MEMORY_EVAL_DATASET_SCHEMA_VERSION` from `lib/memoryExtractionEvalCore.ts`,
 * which answers a different question — "which dataset schema may be run live"
 * — and the two happened to be the same number while the gate sat at 2. The
 * difference only showed when the gate moved to 3 on 2026-08-28 and the frozen
 * `mem-score-v3.3` digest went with it, from
 * `19f4e4f9d5976382d83a03153ef8e7fb52b3f6dd6104efa54f53ef05cd82f777` to
 * `50615af8aa63f4482bb69e1869d9480f3abe82804ebd0515c3adaf25337f44fb`: a frozen
 * contract silently re-fingerprinted by an unrelated change.
 *
 * Pinning it here is what keeps the gate free to move without touching a
 * recorded digest.
 *
 * ## Why the value is 3, and why that needed a new version
 *
 * `mem-score-v3.3` was frozen with a **2** in this field while scoring schema
 * 3, because it read the gate. The digest of that mistake is pinned by the
 * `mem-eval-succ-4` manifest, the release-gate registry, the adoption record
 * and the instrument evidence, so it cannot be edited in place — and a
 * decision-grade run under a contract whose own description of itself is
 * wrong is not something an audit note can repair (@mposition, 2026-08-28).
 *
 * So the correction is forward-only: v3.3 stays exactly as frozen and becomes
 * historical evidence, and `mem-score-v3.4` records **3**, which is what this
 * contract has always scored. Nothing else about the contract changed — same
 * rules, same thresholds, same categories — so the digest difference between
 * the two versions is attributable to this one field.
 */
const DESCRIPTOR_SCHEMA_VERSION = 3;

/**
 * The contract half of the digest input.
 *
 * Reads the live constants, so a threshold change moves every manifest that
 * pins this and the mismatch is reported rather than absorbed. The one
 * exception is `schemaVersion` — see `DESCRIPTOR_SCHEMA_VERSION`.
 */
export function scoringContractDescriptorInput(): string {
    return [
        `contractVersion${FIELD}${MEMORY_EVAL_SCORING_CONTRACT_VERSION}`,
        `schemaVersion${FIELD}${num(
            "schemaVersion",
            DESCRIPTOR_SCHEMA_VERSION
        )}`,
        `categories${FIELD}${MEMORY_EVAL_CATEGORIES.join(ITEM)}`,
        `criticalCategories${FIELD}${MEMORY_EVAL_CRITICAL_CATEGORIES.join(ITEM)}`,
        `languages${FIELD}${MEMORY_EVAL_LANGUAGES.join(ITEM)}`,
        `minSamplesPerCategoryArm${FIELD}${MEMORY_EVAL_CATEGORIES.map(
            (category) =>
                `${category}=${num(
                    `minSamples.${category}`,
                    MEMORY_EVAL_MIN_SAMPLES_PER_CATEGORY_ARM[category]
                )}`
        ).join(ITEM)}`,
        `precisionWilsonLowerMin${FIELD}${num(
            "precisionWilsonLowerMin",
            MEMORY_EVAL_PRECISION_WILSON_LOWER_MIN
        )}`,
        `recallWilsonLowerMin${FIELD}${num(
            "recallWilsonLowerMin",
            MEMORY_EVAL_RECALL_WILSON_LOWER_MIN
        )}`,
        `bulkEligibilityRecallWilsonLowerMin${FIELD}${num(
            "bulkEligibilityRecallWilsonLowerMin",
            MEMORY_EVAL_BULK_ELIGIBILITY_RECALL_WILSON_LOWER_MIN
        )}`,
        `criticalBulkSafeAdoptionsMax${FIELD}0`,
        `sensitiveExpectedBulkSafeViolationsMax${FIELD}0`,
        `expectedDispositions${FIELD}${MEMORY_EVAL_EXPECTED_DISPOSITIONS.join(
            ITEM
        )}`,
        `goldCompleteness${FIELD}${MEMORY_EVAL_GOLD_COMPLETENESS.join(ITEM)}`,
        `criticalGoldModes${FIELD}allow_expected_only`,
        `amendments${FIELD}${MEMORY_EVAL_SCORING_AMENDMENTS.join(ITEM)}`,
        `rules${FIELD}${MEMORY_EVAL_SCORING_RULES.map(
            (rule) => `${rule.id}=${rule.enforcement}=${rule.statement}`
        ).join(ITEM)}`,

        /* --- schema 3 -------------------------------------------------- */

        `v3SchemaVersion${FIELD}${num(
            "v3SchemaVersion",
            MEMORY_EVAL_DATASET_SCHEMA_V3_VERSION
        )}`,
        descriptorListRow(
            "v3RequiredExpectedFields",
            MEMORY_EVAL_V3_REQUIRED_EXPECTED_FIELDS
        ),
        descriptorListRow(
            "v3OptionalExpectedFields",
            MEMORY_EVAL_V3_OPTIONAL_EXPECTED_FIELDS
        ),
        // The enum and what each value means. A digest over the names alone
        // would let `negated` be redefined as "a fact with negative
        // sentiment" without moving, which is the confusion the names were
        // chosen to prevent.
        `v3Polarities${FIELD}${MEMORY_EVAL_POLARITIES.join(ITEM)}`,
        `v3PolarityMeanings${FIELD}${MEMORY_EVAL_POLARITIES.map(
            (polarity) => `${polarity}=${MEMORY_EVAL_POLARITY_MEANINGS[polarity]}`
        ).join(ITEM)}`,
        // How the value is decided, not only what it means. Without it the
        // enum is a field a hundred golds could fill either way.
        `v3PolarityAssignment${FIELD}${MEMORY_EVAL_POLARITY_ASSIGNMENT_RULE}`,
        `v3EvidenceRules${FIELD}${MEMORY_EVAL_EVIDENCE_RULES.map(
            (rule) => `${rule.id}=${rule.statement}`
        ).join(ITEM)}`,

        /* --- canonicalisation ------------------------------------------- */

        // The order is in the digest as well as the table: `2,000` has to lose
        // its separator before punctuation becomes a space, and a table with
        // the same entries in a different order is a different matcher.
        descriptorListRow("canonStepOrder", CANON_STEP_ORDER),
        descriptorSortedTableRow("canonNumeralTable", NUMERAL_TABLE),
        descriptorSortedListRow("canonKoreanCounters", KOREAN_COUNTERS),
        // The rows that actually rewrite Korean text, and the reason they are
        // here rather than left to the two rows above.
        //
        // Until `mem-score-v3.5` the Korean rewrite was `NUMERAL_TABLE` crossed
        // with `KOREAN_COUNTERS`, so hashing those two hashed the matcher. v3.5
        // replaced the cross-product with a reviewed list, and for one commit
        // the digest covered the *vocabulary* a row may draw from while the
        // rows themselves sat outside it: adding, removing or retargeting a row
        // changed what every comparison did and moved nothing. A contract
        // digest that cannot see the matcher is not pinning the contract.
        //
        // The `rejects` are inside for the reason `approvedStemsFor` states —
        // a row whose reviewed over-matches were quietly dropped is a different
        // rule wearing the same spelling — and the whole row is sorted, because
        // rewriting rows in another order is the same matcher.
        descriptorSortedListRow(
            "canonKoreanNumeralExpressions",
            KOREAN_NUMERAL_EXPRESSIONS.map(
                (entry) =>
                    `${entry.canonical}<-${[...entry.variants].sort().join("|")}` +
                    `:by=${entry.requiredBy}` +
                    `:-${[...entry.rejects].sort().join("|")}`
            )
        ),
        // Empty at freeze, and that emptiness is the record: registering the
        // first stem moves this digest, which under the contract's §5 is a new
        // scoring contract version.
        descriptorListRow(
            "approvedStems",
            (["ko", "en"] as const).map(
                (language) => `${language}=${approvedStemsFor(language)}`
            )
        ),
    ].join(ROW);
}

/**
 * The labelling half: the four schema-2 fields, and the identity needed to
 * locate them.
 *
 * Deliberately disjoint from `datasetFingerprintInput()`, which already covers
 * case id, category, language, kind, `mustInclude` and message content. The
 * two digests are complementary and a manifest pins both; neither alone is the
 * record of a dataset.
 *
 * Cases are sorted by id — reordering a file is not a dataset change — but the
 * expected memories inside a case are **not**. Their order decides which gold
 * claims which candidate under `accuracy-matching`, so a reorder is a scoring
 * change and has to show.
 */
export function scoringContractLabellingInput(
    cases: readonly MemoryEvalCaseV2[]
): string {
    return [...cases]
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
        .map((testCase) =>
            [
                testCase.id,
                testCase.goldCompleteness,
                testCase.criticalGoldMode ?? "-",
                testCase.expected
                    .map((expected) =>
                        [
                            expected.id,
                            expected.expectedDisposition,
                            (expected.mustIncludeAny ?? []).join("|"),
                        ].join(FIELD)
                    )
                    .join(ITEM),
            ].join(FIELD)
        )
        .join(ROW);
}

/** What `scoringContractDigest()` hashes. Separated so it can be diffed. */
export function scoringContractDigestInput(
    cases: readonly MemoryEvalCaseV2[]
): string {
    return [
        scoringContractDescriptorInput(),
        scoringContractLabellingInput(cases),
    ].join(SECTION);
}

/**
 * The digest a manifest pins next to the dataset digest.
 *
 * Unlike `datasetFingerprintInput()` this module does reach for `node:crypto`.
 * That constraint exists so the schema and scoring modules can run wherever
 * extraction runs; this one is a manifest concern, imported only by the
 * manifest, the reporting scripts and their tests.
 */
export function scoringContractDigest(
    cases: readonly MemoryEvalCaseV2[]
): string {
    return createHash("sha256")
        .update(scoringContractDigestInput(cases), "utf8")
        .digest("hex");
}

/**
 * The contract rules nothing yet executes.
 *
 * A rule can be stated before it can be enforced — §10.2's rules 5 and 6 are
 * instructions to the v6 prompt and to gold review, and neither exists yet. So
 * the contract may be frozen with them pending, and a **dataset** may not:
 * freezing `succ-4` under a contract whose rules nothing implements would
 * produce a verdict describing a bar that was never applied.
 *
 * Empty means every rule has something holding it to the code. Non-empty names
 * what is missing, so a refusal can say which rule rather than that something
 * is wrong.
 */
export function memoryEvalScoringContractReadiness(): readonly string[] {
    return MEMORY_EVAL_SCORING_RULES.filter(
        (rule) => rule.enforcement === "authoring_pending"
    ).map((rule) => rule.id);
}

/**
 * Rules a model has to satisfy at run time and a sample cannot.
 *
 * `mem-score-v3.3` split `v3-unfixable-evidence-emits-nothing` in two, because
 * one id was carrying two rules with different subjects. The gold-authoring
 * half is about the sample, so a dataset can satisfy it and
 * `v3-unfixable-evidence-not-a-gold` is enforced at review. The other half is
 * about what a model emits, and no amount of work on a dataset makes it true
 * or false.
 *
 * That distinction is why `prompt_pending` does not appear in
 * `memoryEvalScoringContractReadiness()`.
 * .github/audits/memory-eval-gold-contract-2026-08-27.md §11.4 blocks
 * a dataset freeze under a contract with an unimplemented rule, and the reason
 * it gives is that a verdict would cite a bar nobody applied. A bar on the
 * model's output is applied, or not, by the run -- not by the freeze -- so
 * holding the sample to it would refuse every dataset until a prompt exists,
 * and would still not make the run apply it. What must not happen is a *run*
 * under an unimplemented prompt rule, and that is the run-mode gate's
 * question rather than the freeze's.
 *
 * Reported rather than silent: a caller that wants to know what is still
 * unwritten asks here, and the freeze check prints it beside the conditions.
 */
export function memoryEvalScoringContractPromptPending(): readonly string[] {
    return MEMORY_EVAL_SCORING_RULES.filter(
        (rule) => rule.enforcement === "prompt_pending"
    ).map((rule) => rule.id);
}
