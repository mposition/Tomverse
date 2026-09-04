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
    /** Whether the replacement tests the original's boundary. */
    transitionType: "same_boundary";
    /** The gold that appeared in the selection count, `caseId#goldId`. */
    countedGold: string;
};

export const SUCC9_TRANSITION: readonly Succ9TransitionRow[] = [
    {
        retired: "succ-assistant-ko-407",
        replacement: "succ-assistant-ko-701",
        basis: "promptSelection5",
        transitionType: "same_boundary",
        countedGold: "succ-assistant-ko-407#g1",
    },
    {
        retired: "succ-assistant-en-603",
        replacement: "succ-assistant-en-701",
        basis: "promptSelection5",
        transitionType: "same_boundary",
        countedGold: "succ-assistant-en-603#g1",
    },
    {
        retired: "succ-assistant-en-608",
        replacement: "succ-assistant-en-702",
        basis: "promptSelection5",
        transitionType: "same_boundary",
        countedGold: "succ-assistant-en-608#g1",
    },
    {
        retired: "succ-durable-en-423",
        replacement: "succ-durable-en-701",
        basis: "promptSelection5",
        transitionType: "same_boundary",
        countedGold: "succ-durable-en-423#e1",
    },
    {
        retired: "succ-durable-ko-422",
        replacement: "succ-durable-ko-701",
        basis: "promptSelection5",
        transitionType: "same_boundary",
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
                    `${row.retired}->${row.replacement}:${row.basis}:${row.transitionType}:${row.countedGold}`
            )
            .join("\n"),
        "utf8"
    )
    .digest("hex");
