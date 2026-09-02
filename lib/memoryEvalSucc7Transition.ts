/**
 * The succ-6 -> succ-7 transition: 54 cases out, 54 in, one for one.
 *
 * Why 54 and not the ten gold edits alone
 * (.github/audits/memory-eval-v8-wording-draft-2026-09-02.md section 4):
 *
 *   * ten cases carry an approved gold change, and a frozen decision set is
 *     not edited in place -- the modified gold is preserved in the regression
 *     corpus and the decision set gets a fresh case;
 *   * forty-four more were the evidence that selected the v8 intervention.
 *     `.github/audits/memory-eval-gold-contract-2026-08-27.md` section 12.1
 *     moves a case used to make, modify *or select* a rule, and synthetic
 *     prompt examples do not exempt it: what moves is decided by what the
 *     rule was chosen from, not by whose words appear in the prompt.
 *
 * The two sets are disjoint, so the union is exactly 54.
 *
 * `basis` records which of the two put each case here, because they are
 * preserved differently: `approved10` keeps the newly approved gold and
 * `polarity44` keeps the gold it already had.
 *
 * ## Why a transition also has a type
 *
 * Fifty-three replacements test the same boundary their original tested, on
 * new subject matter. One does not, and saying so is the point.
 *
 * `succ-injection-en-301` put a safety-gate demand and a presentation
 * preference in a single user turn, and the shipped prompt refuses such a turn
 * whole. A replacement keeping both in one turn would carry a gold the prompt
 * is instructed to refuse; splitting them across two turns produces a sound
 * case that no longer tests what the original tested. Neither is a same-
 * boundary replacement, so this one is typed `coverage_repair` and is not
 * counted among the 53.
 *
 * Adopted 2026-09-02 as option B. It does NOT relax the whole-turn
 * fail-closed rule and does NOT approve extracting the safe half of a mixed
 * turn; the question is preserved unresolved in the regression corpus.
 */
export type Succ7TransitionRow = {
    /** The succ-6 case leaving the decision set. */
    retired: string;
    /** Its 1:1 replacement, in the same category and language. */
    replacement: string;
    /** Why it moved. */
    basis: "approved10" | "polarity44";
    /**
     * Whether the replacement tests the original's boundary.
     *
     * `coverage_repair` means it does not, and must not be counted as though
     * it did. A tally that folded the two together would report 54 boundaries
     * still covered when one of them is not.
     */
    transitionType: "same_boundary" | "coverage_repair";
    /**
     * For a `coverage_repair`, the policy question the original raised and
     * that this transition deliberately does not answer.
     */
    unresolvedPolicy?: string;
};

/**
 * The open question, named once so the manifest can bind to the same string
 * the regression corpus records.
 */
export const SUCC7_MIXED_TURN_POLICY_QUESTION =
    "unresolved: when one user turn carries both a safety-gate demand and a " +
    "presentation preference, is the safe half extractable? The whole-turn " +
    "fail-closed rule stands unchanged and this transition does not answer it.";

export const SUCC7_TRANSITION: readonly Succ7TransitionRow[] = [
    { retired: "succ-assistant-en-19", replacement: "succ-assistant-en-601", basis: "approved10" , transitionType: "same_boundary" },
    { retired: "succ-assistant-en-28", replacement: "succ-assistant-en-602", basis: "approved10" , transitionType: "same_boundary" },
    { retired: "succ-assistant-en-313", replacement: "succ-assistant-en-603", basis: "approved10" , transitionType: "same_boundary" },
    { retired: "succ-assistant-en-401", replacement: "succ-assistant-en-604", basis: "polarity44" , transitionType: "same_boundary" },
    { retired: "succ-assistant-en-403", replacement: "succ-assistant-en-605", basis: "polarity44" , transitionType: "same_boundary" },
    { retired: "succ-assistant-en-405", replacement: "succ-assistant-en-606", basis: "polarity44" , transitionType: "same_boundary" },
    { retired: "succ-assistant-en-406", replacement: "succ-assistant-en-607", basis: "polarity44" , transitionType: "same_boundary" },
    { retired: "succ-assistant-en-93", replacement: "succ-assistant-en-608", basis: "approved10" , transitionType: "same_boundary" },
    { retired: "succ-assistant-ko-10", replacement: "succ-assistant-ko-601", basis: "approved10" , transitionType: "same_boundary" },
    { retired: "succ-assistant-ko-16", replacement: "succ-assistant-ko-602", basis: "approved10" , transitionType: "same_boundary" },
    { retired: "succ-assistant-ko-307", replacement: "succ-assistant-ko-603", basis: "polarity44" , transitionType: "same_boundary" },
    { retired: "succ-assistant-ko-316", replacement: "succ-assistant-ko-604", basis: "approved10" , transitionType: "same_boundary" },
    { retired: "succ-assistant-ko-403", replacement: "succ-assistant-ko-605", basis: "polarity44" , transitionType: "same_boundary" },
    { retired: "succ-assistant-ko-405", replacement: "succ-assistant-ko-606", basis: "polarity44" , transitionType: "same_boundary" },
    { retired: "succ-durable-en-103", replacement: "succ-durable-en-601", basis: "polarity44" , transitionType: "same_boundary" },
    { retired: "succ-durable-en-11", replacement: "succ-durable-en-602", basis: "polarity44" , transitionType: "same_boundary" },
    { retired: "succ-durable-en-155", replacement: "succ-durable-en-603", basis: "polarity44" , transitionType: "same_boundary" },
    { retired: "succ-durable-en-187", replacement: "succ-durable-en-604", basis: "polarity44" , transitionType: "same_boundary" },
    { retired: "succ-durable-en-188", replacement: "succ-durable-en-605", basis: "polarity44" , transitionType: "same_boundary" },
    { retired: "succ-durable-en-317", replacement: "succ-durable-en-606", basis: "polarity44" , transitionType: "same_boundary" },
    { retired: "succ-durable-en-406", replacement: "succ-durable-en-607", basis: "polarity44" , transitionType: "same_boundary" },
    { retired: "succ-durable-en-414", replacement: "succ-durable-en-608", basis: "polarity44" , transitionType: "same_boundary" },
    { retired: "succ-durable-en-417", replacement: "succ-durable-en-609", basis: "polarity44" , transitionType: "same_boundary" },
    { retired: "succ-durable-en-422", replacement: "succ-durable-en-610", basis: "polarity44" , transitionType: "same_boundary" },
    { retired: "succ-durable-en-427", replacement: "succ-durable-en-611", basis: "polarity44" , transitionType: "same_boundary" },
    { retired: "succ-durable-en-429", replacement: "succ-durable-en-612", basis: "polarity44" , transitionType: "same_boundary" },
    { retired: "succ-durable-en-431", replacement: "succ-durable-en-613", basis: "polarity44" , transitionType: "same_boundary" },
    { retired: "succ-durable-en-433", replacement: "succ-durable-en-614", basis: "polarity44" , transitionType: "same_boundary" },
    { retired: "succ-durable-en-436", replacement: "succ-durable-en-615", basis: "polarity44" , transitionType: "same_boundary" },
    { retired: "succ-durable-en-439", replacement: "succ-durable-en-616", basis: "polarity44" , transitionType: "same_boundary" },
    { retired: "succ-durable-en-441", replacement: "succ-durable-en-617", basis: "polarity44" , transitionType: "same_boundary" },
    { retired: "succ-durable-en-66", replacement: "succ-durable-en-618", basis: "approved10" , transitionType: "same_boundary" },
    { retired: "succ-durable-ko-101", replacement: "succ-durable-ko-601", basis: "polarity44" , transitionType: "same_boundary" },
    { retired: "succ-durable-ko-102", replacement: "succ-durable-ko-602", basis: "polarity44" , transitionType: "same_boundary" },
    { retired: "succ-durable-ko-155", replacement: "succ-durable-ko-603", basis: "polarity44" , transitionType: "same_boundary" },
    { retired: "succ-durable-ko-167", replacement: "succ-durable-ko-604", basis: "polarity44" , transitionType: "same_boundary" },
    { retired: "succ-durable-ko-188", replacement: "succ-durable-ko-605", basis: "polarity44" , transitionType: "same_boundary" },
    { retired: "succ-durable-ko-319", replacement: "succ-durable-ko-606", basis: "polarity44" , transitionType: "same_boundary" },
    { retired: "succ-durable-ko-38", replacement: "succ-durable-ko-607", basis: "polarity44" , transitionType: "same_boundary" },
    { retired: "succ-durable-ko-404", replacement: "succ-durable-ko-608", basis: "polarity44" , transitionType: "same_boundary" },
    { retired: "succ-durable-ko-408", replacement: "succ-durable-ko-609", basis: "polarity44" , transitionType: "same_boundary" },
    { retired: "succ-durable-ko-410", replacement: "succ-durable-ko-610", basis: "polarity44" , transitionType: "same_boundary" },
    { retired: "succ-durable-ko-411", replacement: "succ-durable-ko-611", basis: "polarity44" , transitionType: "same_boundary" },
    { retired: "succ-durable-ko-412", replacement: "succ-durable-ko-612", basis: "polarity44" , transitionType: "same_boundary" },
    { retired: "succ-durable-ko-414", replacement: "succ-durable-ko-613", basis: "polarity44" , transitionType: "same_boundary" },
    { retired: "succ-durable-ko-416", replacement: "succ-durable-ko-614", basis: "polarity44" , transitionType: "same_boundary" },
    { retired: "succ-durable-ko-423", replacement: "succ-durable-ko-615", basis: "polarity44" , transitionType: "same_boundary" },
    { retired: "succ-durable-ko-425", replacement: "succ-durable-ko-616", basis: "polarity44" , transitionType: "same_boundary" },
    { retired: "succ-durable-ko-428", replacement: "succ-durable-ko-617", basis: "polarity44" , transitionType: "same_boundary" },
    { retired: "succ-durable-ko-57", replacement: "succ-durable-ko-618", basis: "polarity44" , transitionType: "same_boundary" },
    { retired: "succ-durable-ko-6", replacement: "succ-durable-ko-619", basis: "polarity44" , transitionType: "same_boundary" },
    { retired: "succ-durable-ko-88", replacement: "succ-durable-ko-620", basis: "polarity44" , transitionType: "same_boundary" },
    { retired: "succ-injection-en-301", replacement: "succ-injection-en-601", basis: "approved10" , transitionType: "coverage_repair", unresolvedPolicy: SUCC7_MIXED_TURN_POLICY_QUESTION },
    { retired: "succ-injection-ko-53", replacement: "succ-injection-ko-601", basis: "approved10" , transitionType: "same_boundary" },
];

export const SUCC7_RETIRED_CASE_IDS: readonly string[] =
    SUCC7_TRANSITION.map((row) => row.retired);

export const SUCC7_REPLACEMENT_CASE_IDS: readonly string[] =
    SUCC7_TRANSITION.map((row) => row.replacement);

/** 53. The transitions whose replacement tests the original's boundary. */
export const SUCC7_SAME_BOUNDARY_COUNT = SUCC7_TRANSITION.filter(
    (row) => row.transitionType === "same_boundary"
).length;

/** 1. Counted apart, never folded into the number above. */
export const SUCC7_COVERAGE_REPAIR_COUNT = SUCC7_TRANSITION.filter(
    (row) => row.transitionType === "coverage_repair"
).length;
