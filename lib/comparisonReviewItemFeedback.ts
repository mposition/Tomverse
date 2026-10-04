/**
 * Stable identifiers for the individual claims inside an AI Review, and the
 * vocabulary a user's verdict on one is written in.
 *
 * docs/policy/ai-review-m5-quality-contract.md §9.
 *
 * Pure, and deliberately not stored. A review row's `result` JSON is validated
 * on read against the schemas in lib/comparisonReview.ts, so adding an `id`
 * field to every claim would invalidate every cached review ever written --
 * the same reason the grounding rename stopped at the `lib/sourceGrounding.ts`
 * boundary rather than renaming the stored `confidence`. The id is therefore
 * DERIVED from what is already there.
 *
 * What it is derived from, and why each part is in it:
 *
 *   * the **reviewer slot** -- the dialog shows the primary and the second
 *     independent reviewer in their own tabs, and the two disagree by design.
 *     A verdict on the primary's claim is not a verdict on the secondary's,
 *     even where the two happen to have written the same sentence;
 *   * the **section** -- "incorrect" on a contradiction and "incorrect" on an
 *     omission are different reports about different things;
 *   * the **ordinal** -- two claims in one section can legitimately read
 *     similarly, and the user pointed at one of them;
 *   * a **digest of the claim's own text** -- the ordinal alone would silently
 *     re-point an old verdict at a new claim if a review were ever
 *     regenerated at the same input hash. With the digest, a changed claim
 *     gets a new id and the old verdict simply stops matching, which is the
 *     safe direction.
 *
 * The id is per-review and is never sent to analytics: a set of them beside
 * timestamps would narrow a small population toward one conversation.
 */

import { createHash } from "node:crypto";

export const COMPARISON_REVIEW_ITEM_SECTIONS = [
    "consensus",
    "contradictions",
    "differences",
    "missingPoints",
    "verificationNeeded",
] as const;
export type ComparisonReviewItemSection =
    (typeof COMPARISON_REVIEW_ITEM_SECTIONS)[number];

export const COMPARISON_REVIEW_ITEM_REVIEWERS = ["primary", "secondary"] as const;
export type ComparisonReviewItemReviewer =
    (typeof COMPARISON_REVIEW_ITEM_REVIEWERS)[number];

export const COMPARISON_REVIEW_ITEM_VERDICTS = [
    "helpful",
    "incorrect",
    "unclear",
    "missing_point",
] as const;
export type ComparisonReviewItemVerdict =
    (typeof COMPARISON_REVIEW_ITEM_VERDICTS)[number];

const normalize = (value: string) =>
    value.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();

/**
 * The id for one claim. Truncated to 16 hex characters: this is a
 * within-one-review disambiguator, not a security token, and the section and
 * ordinal already carry most of the identity.
 */
export const comparisonReviewItemId = (
    reviewer: ComparisonReviewItemReviewer,
    section: ComparisonReviewItemSection,
    ordinal: number,
    text: string
) =>
    `${reviewer}:${section}:${ordinal}:${createHash("sha256")
        .update(normalize(text))
        .digest("hex")
        .slice(0, 16)}`;

/** The shape the ids are derived from -- the verified result, structurally. */
export type ComparisonReviewItemSource = {
    consensus: readonly { text: string }[];
    contradictions: readonly { text: string }[];
    differences: readonly { issue: string }[];
    missingPoints: readonly string[];
    verificationNeeded: readonly string[];
};

export type ComparisonReviewItem = {
    id: string;
    reviewer: ComparisonReviewItemReviewer;
    section: ComparisonReviewItemSection;
    ordinal: number;
    text: string;
};

/**
 * Every item in a review, in the order the dialog renders them.
 *
 * `modelAssessments`, `synthesis` and `limitations` are deliberately absent.
 * The first is per-response rather than a claim about the comparison, and the
 * other two are framing the review always carries; a thumbs-down on
 * "this review is not external fact verification" would be feedback about the
 * product's own disclaimer, not about review quality.
 */
export const comparisonReviewItems = (
    result: ComparisonReviewItemSource,
    reviewer: ComparisonReviewItemReviewer = "primary"
): readonly ComparisonReviewItem[] => {
    const items: ComparisonReviewItem[] = [];
    const push = (
        section: ComparisonReviewItemSection,
        texts: readonly string[]
    ) => {
        for (const [ordinal, text] of texts.entries()) {
            items.push({
                id: comparisonReviewItemId(reviewer, section, ordinal, text),
                reviewer,
                section,
                ordinal,
                text,
            });
        }
    };
    push("consensus", result.consensus.map((claim) => claim.text));
    push("contradictions", result.contradictions.map((claim) => claim.text));
    push("differences", result.differences.map((difference) => difference.issue));
    push("missingPoints", result.missingPoints);
    push("verificationNeeded", result.verificationNeeded);
    return items;
};

/**
 * Whether an id the client sent belongs to this review.
 *
 * The server never trusts a client-supplied item id: an id that matches no
 * item is refused rather than stored, so the feedback table cannot accumulate
 * rows pointing at claims that do not exist -- and so a caller cannot use it
 * as free storage.
 */
export const isKnownComparisonReviewItem = (
    review: {
        primary: ComparisonReviewItemSource;
        secondary?: ComparisonReviewItemSource | null;
    },
    itemId: string
) => {
    const candidates = [
        ...comparisonReviewItems(review.primary, "primary"),
        ...(review.secondary
            ? comparisonReviewItems(review.secondary, "secondary")
            : []),
    ];
    return candidates.some((item) => item.id === itemId);
};

export const sectionOfItemId = (
    itemId: string
): ComparisonReviewItemSection | null => {
    const section = itemId.split(":")[1];
    return COMPARISON_REVIEW_ITEM_SECTIONS.includes(
        section as ComparisonReviewItemSection
    )
        ? (section as ComparisonReviewItemSection)
        : null;
};

/**
 * What a set of verdicts says, and what it does not.
 *
 * One "incorrect" is a user's opinion about one claim, not a finding that the
 * reviewer was wrong -- the user may have misread the claim, disagreed with a
 * correct one, or been right. The summary therefore reports counts and a rate
 * with its denominator, and carries no verdict of its own; the contract's
 * quality claims come from the evaluation, and this is a signal that tells a
 * person where to look.
 */
export type ComparisonReviewFeedbackSummary = {
    total: number;
    byVerdict: Readonly<Record<ComparisonReviewItemVerdict, number>>;
    bySection: Readonly<Record<string, number>>;
    /** null below the floor, so a handful of rows cannot read as a rate. */
    negativeRate: number | null;
    minimumForRate: number;
};

export const summariseItemFeedback = (
    rows: readonly { verdict: string; section: string }[],
    minimumForRate = 20
): ComparisonReviewFeedbackSummary => {
    const byVerdict = Object.fromEntries(
        COMPARISON_REVIEW_ITEM_VERDICTS.map((verdict) => [verdict, 0])
    ) as Record<ComparisonReviewItemVerdict, number>;
    const bySection: Record<string, number> = {};
    for (const row of rows) {
        if ((COMPARISON_REVIEW_ITEM_VERDICTS as readonly string[]).includes(row.verdict)) {
            byVerdict[row.verdict as ComparisonReviewItemVerdict] += 1;
        }
        bySection[row.section] = (bySection[row.section] ?? 0) + 1;
    }
    const negative = byVerdict.incorrect + byVerdict.unclear + byVerdict.missing_point;
    return {
        total: rows.length,
        byVerdict,
        bySection,
        negativeRate: rows.length >= minimumForRate ? negative / rows.length : null,
        minimumForRate,
    };
};
