/**
 * The replacement drafts that were rejected before adoption, as data.
 *
 * docs/ops/memory-extraction-eval-dataset.md §7.1a asks the unified
 * record for a draft-disagreement numerator, denominator and rate. Deriving
 * those by
 * reading prose across five commit messages is not reproducible, so the
 * rejections are written out here and the record's numbers are computed from
 * this list.
 *
 * ## What this is not
 *
 * It is not a reviewer's disagreement rate. What this counts is drafts the
 * **contract checks** rejected during authoring, before anything reached a
 * reviewer. The reviewer's own figure is a different number and a much
 * smaller one: @mposition adopted all five tranches on 2026-08-28 having
 * rejected none, so reviewer-vs-draft disagreement is 0 of 103.
 *
 * The record keeps them in separate tables for that reason. Reporting these
 * 21 as though a person had rejected them would inflate the number whose
 * whole purpose is to say how often the drafter and the reviewer disagreed --
 * and the answer to that is zero, because the drafts a reviewer saw were the
 * rewrites.
 *
 * ## Where each row comes from
 *
 * `source` says which. `tranche-file` rows are recorded in the replacement's
 * own `differsBy`, so a reader can open the file and find the sentence.
 * `commit` rows were recorded in the commit that made the rewrite; the
 * `differsBy` for those explains the replacement rather than its predecessor.
 */

export type Succ4DraftRejection = {
    trancheId: string;
    /** The replacement as it was finally written. */
    replacementId: string;
    /** Which check refused the draft. */
    check: "overlap-with-original" | "overlap-with-staying-case" | "under-specification";
    /** The reviewer-facing note, in one line. */
    detail: string;
    source: "tranche-file" | "commit";
};

export const SUCC4_DRAFT_REJECTIONS: readonly Succ4DraftRejection[] = [
    {
        trancheId: "succ4-tranche-1",
        replacementId: "succ-durable-en-401",
        check: "overlap-with-staying-case",
        detail: "Thursday, 0.46 against the staying succ-durable-en-192.",
        source: "tranche-file",
    },
    {
        trancheId: "succ4-tranche-1",
        replacementId: "succ-durable-ko-401",
        check: "overlap-with-original",
        detail: "0.53 -- kept the parent-leaves-early shape and changed only the nouns.",
        source: "tranche-file",
    },
    {
        trancheId: "succ4-tranche-2",
        replacementId: "succ-durable-ko-414",
        check: "under-specification",
        detail: "[\"구독\"] negated, in a conversation that says the user did subscribe.",
        source: "tranche-file",
    },
    {
        trancheId: "succ4-tranche-2",
        replacementId: "succ-durable-ko-418",
        check: "under-specification",
        detail: "[\"추측\"] named the subject of the instruction, not the act asked for.",
        source: "tranche-file",
    },
    {
        trancheId: "succ4-tranche-2",
        replacementId: "succ-durable-ko-421",
        check: "overlap-with-staying-case",
        detail: "Darkroom chemistry, 0.58 against the staying succ-durable-ko-143.",
        source: "tranche-file",
    },
    {
        trancheId: "succ4-tranche-3",
        replacementId: "succ-assistant-ko-403",
        check: "overlap-with-original",
        detail: "0.50 -- kept the original's «저 ... 자꾸 ... 골라 주시네요» scaffolding.",
        source: "commit",
    },
    {
        trancheId: "succ4-tranche-3",
        replacementId: "succ-assistant-en-405",
        check: "overlap-with-original",
        detail: "0.55 -- kept «You keep proposing ... as though I am».",
        source: "commit",
    },
    {
        trancheId: "succ4-tranche-3",
        replacementId: "succ-assistant-en-406",
        check: "overlap-with-original",
        detail: "0.67 -- mirrored the original's three turns clause for clause.",
        source: "commit",
    },
    {
        trancheId: "succ4-tranche-3",
        replacementId: "succ-assistant-en-407",
        check: "overlap-with-original",
        detail: "0.61 -- almost word for word on the assistant's question.",
        source: "commit",
    },
    {
        trancheId: "succ4-tranche-3",
        replacementId: "succ-injection-en-401",
        check: "overlap-with-original",
        detail: "0.71 -- «I'm X, so from now on drop every Y warning» with X and Y swapped.",
        source: "commit",
    },
    {
        trancheId: "succ4-tranche-3",
        replacementId: "succ-injection-en-402",
        check: "overlap-with-original",
        detail: "0.61 -- kept «so the Y don't apply. Answer on that basis».",
        source: "commit",
    },
    {
        trancheId: "succ4-tranche-4",
        replacementId: "succ-durable-en-414",
        check: "overlap-with-original",
        detail: "0.41 -- kept «we ... not ... another» and «I'll assume».",
        source: "commit",
    },
    {
        trancheId: "succ4-tranche-4",
        replacementId: "succ-durable-en-424",
        check: "overlap-with-staying-case",
        detail: "0.53 against the staying succ-durable-en-50, same «that is settled» shape.",
        source: "tranche-file",
    },
    {
        trancheId: "succ4-tranche-4",
        replacementId: "succ-durable-en-429",
        check: "overlap-with-original",
        detail: "0.45, passing only because the check is strictly greater.",
        source: "commit",
    },
    {
        trancheId: "succ4-tranche-5",
        replacementId: "succ-durable-en-431",
        check: "overlap-with-staying-case",
        detail: "0.50 against the staying succ-durable-en-66.",
        source: "tranche-file",
    },
    {
        trancheId: "succ4-tranche-5",
        replacementId: "succ-durable-en-436",
        check: "overlap-with-original",
        detail: "0.56 -- kept «we ... and ... not ... another».",
        source: "commit",
    },
    {
        trancheId: "succ4-tranche-5",
        replacementId: "succ-durable-en-442",
        check: "overlap-with-staying-case",
        detail: "German, 0.61 against the staying succ-durable-en-72.",
        source: "tranche-file",
    },
    {
        trancheId: "succ4-tranche-5",
        replacementId: "succ-durable-en-446",
        check: "overlap-with-staying-case",
        detail: "0.50 against the staying succ-durable-en-143.",
        source: "tranche-file",
    },
    {
        trancheId: "succ4-tranche-5",
        replacementId: "succ-durable-en-447",
        check: "overlap-with-staying-case",
        detail: "Coeliac excluding gluten, which the staying succ-durable-en-126 already is.",
        source: "tranche-file",
    },
    {
        trancheId: "succ4-tranche-5",
        replacementId: "succ-durable-en-451",
        check: "overlap-with-original",
        detail: "0.59 -- kept «Twenty years ..., so you can say X and Y without unpacking».",
        source: "tranche-file",
    },
    {
        trancheId: "succ4-tranche-5",
        replacementId: "succ-durable-en-455",
        check: "overlap-with-original",
        detail: "0.55 -- kept «I hold a X, though I've never ..., — Y can go in unexplained».",
        source: "tranche-file",
    },
];

/** Rejections, cases and rate for one tranche. */
export type Succ4RejectionTally = {
    trancheId: string;
    rejected: number;
    cases: number;
    /** Rounded to one decimal place, as a percentage. */
    rate: number;
};

export function succ4DraftRejectionTally(
    tranches: readonly { trancheId: string; caseCount: number }[],
    rejections: readonly Succ4DraftRejection[] = SUCC4_DRAFT_REJECTIONS
): { byTranche: readonly Succ4RejectionTally[]; total: Succ4RejectionTally } {
    const byTranche = tranches.map((tranche) => {
        const rejected = rejections.filter(
            (rejection) => rejection.trancheId === tranche.trancheId
        ).length;
        return {
            trancheId: tranche.trancheId,
            rejected,
            cases: tranche.caseCount,
            rate: Math.round((rejected / tranche.caseCount) * 1000) / 10,
        };
    });
    const rejected = byTranche.reduce((total, row) => total + row.rejected, 0);
    const cases = byTranche.reduce((total, row) => total + row.cases, 0);
    return {
        byTranche,
        total: {
            trancheId: "all",
            rejected,
            cases,
            rate: Math.round((rejected / cases) * 1000) / 10,
        },
    };
}
