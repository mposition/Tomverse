import { createHash } from "node:crypto";

/**
 * What `mem-eval-succ-9` moved, and why each one moved.
 *
 * succ-7's transition recorded two bases — `approved10` for corrected golds
 * and `polarity44` for cases the `mem-extract-v8` *wording* was selected
 * from. This one records a third, and it is a narrower thing than either:
 * these five cases were not consulted for wording, they were **counted**.
 *
 * Choosing the kind for v8's worked examples meant listing the negations the
 * approved prompt licenses and then counting how many cases each already
 * scores. `relationship` had one, `expertise` had four, and that comparison
 * picked `relationship`. All five golds in it are therefore part of the
 * decision, including the four on the side that lost — a count is a
 * comparison, and the losing side is what made the winner a choice rather
 * than the only option.
 *
 * Retiring only the case in the chosen cell would have kept the four that
 * made the choice measurable, which is the mistake this basis exists to name.
 */
export type Succ9TransitionRow = {
    /** The succ-8 case leaving the decision set. */
    retired: string;
    /** Its 1:1 replacement, in the same category and language. */
    replacement: string;
    /** Why it moved. */
    basis: "promptSelection5";
    /**
     * What the replacement does relative to the original.
     *
     * `same_boundary` — every axis in `boundaryAxes()` matches, so the case
     * tests exactly what its predecessor tested with a different subject.
     *
     * `repair` — the replacement keeps the original's golds and **adds** one,
     * because the original was wrong in a way that would have been inherited.
     * A repair states what it fixes; a replacement that quietly changed its
     * gold set while claiming `same_boundary` is the thing this field exists
     * to make impossible.
     */
    transitionType: "same_boundary" | "repair";
    /**
     * What the repair fixes, for a `repair` row. Null on a `same_boundary`
     * one, and `succ9Problems()` fails either combination the other way round.
     */
    repairs: string | null;
    /** The gold that appeared in the selection count, `caseId#goldId`. */
    countedGold: string;
};

export const SUCC9_TRANSITION: readonly Succ9TransitionRow[] = [
    {
        retired: "succ-assistant-ko-407",
        replacement: "succ-assistant-ko-701",
        basis: "promptSelection5",
        transitionType: "same_boundary",
        repairs: null,
        countedGold: "succ-assistant-ko-407#g1",
    },
    {
        retired: "succ-assistant-en-603",
        replacement: "succ-assistant-en-701",
        basis: "promptSelection5",
        transitionType: "same_boundary",
        repairs: null,
        countedGold: "succ-assistant-en-603#g1",
    },
    {
        retired: "succ-assistant-en-608",
        replacement: "succ-assistant-en-702",
        basis: "promptSelection5",
        transitionType: "same_boundary",
        repairs: null,
        countedGold: "succ-assistant-en-608#g1",
    },
    {
        retired: "succ-durable-en-423",
        replacement: "succ-durable-en-701",
        basis: "promptSelection5",
        transitionType: "same_boundary",
        repairs: null,
        countedGold: "succ-durable-en-423#e1",
    },
    {
        retired: "succ-durable-ko-422",
        replacement: "succ-durable-ko-701",
        basis: "promptSelection5",
        transitionType: "repair",
        repairs:
            "succ-durable-ko-422 is marked exhaustive and claims two golds, " +
            "but its own user turn states a third durable fact — an ability " +
            "affirmed in the easy setting (실내 수영장에서 자유형만 하고). An " +
            "extractor returning it is correct and is scored as a false " +
            "positive: scoreCaseV3() reports candidateMatched 2 of 3 with no " +
            "unbound candidate. succ-durable-ko-701 keeps both golds and adds " +
            "the affirmed one (계곡, 텐트), so exhaustive is true of it.",
        countedGold: "succ-durable-ko-422#e2",
    },
];

/**
 * The pairing, as one digest.
 *
 * succ-7 learned that a manifest binding only the case list cannot say which
 * replacement stood in for which original, and that pairing is what a reviewer
 * actually judged. Sorted by `retired` so reordering the rows is not mistaken
 * for repairing them.
 */
export const SUCC9_TRANSITION_DIGEST = createHash("sha256")
    .update(
        [...SUCC9_TRANSITION]
            .sort((left, right) => left.retired.localeCompare(right.retired))
            .map(
                (row) =>
                    `${row.retired}->${row.replacement}:${row.basis}:` +
                    `${row.transitionType}:${row.repairs ?? "-"}:${row.countedGold}`
            )
            .join("\n"),
        "utf8"
    )
    .digest("hex");
