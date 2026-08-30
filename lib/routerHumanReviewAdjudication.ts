/**
 * Resolving a split between the two reviewers, without telling the third what
 * the split was.
 *
 * ## Why the adjudicator grades rather than chooses
 *
 * Showing a third person "reviewer A said FIRST, reviewer B said SECOND, pick
 * one" makes them a referee, and referees anchor: the order of presentation,
 * the seniority of a name, the wish not to contradict twice. So the
 * adjudicator gets an ordinary blind sheet holding only the disputed items and
 * gives their own verdict. The final verdict is then the majority of three,
 * decided by arithmetic that had no opinion.
 *
 * ## Why three can still fail to decide
 *
 * FIRST, SECOND and EQUIVALENT are three verdicts, so three graders can hold
 * one each. That is `no_consensus`, and it is recorded as itself. Breaking the
 * tie -- by seniority, by dropping EQUIVALENT, by asking a fourth -- would put
 * a rule into the measurement chosen after the answers were seen.
 *
 * ## The comparison is positional
 *
 * Both reviewers saw the same answer in position A, so two verdicts can be
 * compared without knowing which arm either position was. Nothing here reads
 * an arm; lib/routerHumanReviewSubmission.ts's `resolveToArms` does that
 * afterwards, on the settled verdict.
 */

import type { PositionalVerdict } from "./routerJudgeRubric";
import type { AnswerBundle } from "./routerAnswerBundle";
import type { ReviewSheet, SheetKeyRow } from "./routerHumanReviewSheet";
import { buildSheetFor } from "./routerHumanReviewSheet";
import type { Submission } from "./routerHumanReviewSubmission";

export const ADJUDICATION_VERSION = "router-human-review-adjudication-v1";

/** What every grader said about one pair, and what that settles to. */
export type PairVerdicts = {
    pairId: string;
    /** Keyed by reviewer, positional. An absent reviewer did not grade it. */
    byReviewer: Readonly<Record<string, PositionalVerdict>>;
    status: "agreed" | "adjudicated" | "needs_adjudication" | "no_consensus" | "incomplete";
    /** Present once the pair has settled. */
    verdict?: PositionalVerdict;
};

/** A pairId for each of a reviewer's items. Carries no arm, by construction. */
export const pairIdIndex = (key: readonly SheetKeyRow[]): ReadonlyMap<string, string> =>
    new Map(key.map((row) => [`${row.reviewerId}/${row.itemId}`, row.pairId]));

const positionalByPair = (
    submission: Submission,
    index: ReadonlyMap<string, string>
): ReadonlyMap<string, PositionalVerdict> =>
    new Map(
        submission.verdicts
            .map((entry) => [index.get(`${submission.reviewerId}/${entry.itemId}`), entry.verdict] as const)
            .filter((entry): entry is readonly [string, PositionalVerdict] => typeof entry[0] === "string")
    );

/**
 * Where the graders stand on every pair in the sample.
 *
 * `submissions` is whoever has graded so far: two reviewers before
 * adjudication, three after. The status says what each pair needs next, and a
 * pair nobody has finished grading is `incomplete` rather than a disagreement.
 */
export const collateVerdicts = (input: {
    submissions: readonly Submission[];
    key: readonly SheetKeyRow[];
    reviewerIds: readonly string[];
    pairIds: readonly string[];
}): readonly PairVerdicts[] => {
    const index = pairIdIndex(input.key);
    const byReviewer = new Map(
        input.submissions.map((submission) => [submission.reviewerId, positionalByPair(submission, index)])
    );

    return [...input.pairIds].sort().map((pairId) => {
        const said: Record<string, PositionalVerdict> = {};
        for (const reviewerId of input.reviewerIds) {
            const verdict = byReviewer.get(reviewerId)?.get(pairId);
            if (verdict) said[reviewerId] = verdict;
        }
        const votes = Object.values(said);

        if (votes.length < input.reviewerIds.length) {
            return { pairId, byReviewer: said, status: "incomplete" as const };
        }
        const distinct = new Set(votes);
        if (distinct.size === 1) {
            return { pairId, byReviewer: said, status: "agreed" as const, verdict: votes[0] };
        }
        const counted = new Map<PositionalVerdict, number>();
        for (const vote of votes) counted.set(vote, (counted.get(vote) ?? 0) + 1);
        const majority = [...counted.entries()].find(([, count]) => count > votes.length / 2);
        if (majority) {
            return { pairId, byReviewer: said, status: "adjudicated" as const, verdict: majority[0] };
        }
        // Two graders who disagree need a third; three who all differ have
        // said everything there is to say.
        return {
            pairId,
            byReviewer: said,
            status: votes.length >= 3 ? ("no_consensus" as const) : ("needs_adjudication" as const),
        };
    });
};

/** The pairs an adjudicator has to look at, in a stable order. */
export const pairsNeedingAdjudication = (collated: readonly PairVerdicts[]): readonly string[] =>
    collated.filter((pair) => pair.status === "needs_adjudication").map((pair) => pair.pairId);

/**
 * A blind sheet holding only the disputed pairs.
 *
 * The same builder as the reviewers' sheets, so the adjudicator's copy carries
 * exactly what theirs did: the question, both answers in the order the model
 * judge saw them, and the rubric. What the two reviewers said is not an
 * argument to this function, so it cannot appear on the sheet.
 */
export const buildAdjudicationSheet = (input: {
    adjudicatorId: string;
    collated: readonly PairVerdicts[];
    bundle: AnswerBundle;
    seed: number;
    populationDigest: string;
    reviewerIds: readonly string[];
}): { sheet: ReviewSheet; key: readonly SheetKeyRow[] } => {
    if (input.reviewerIds.includes(input.adjudicatorId)) {
        throw new Error(
            `${input.adjudicatorId} already graded this sample, so their second look would not be a third opinion`
        );
    }
    const pairIds = pairsNeedingAdjudication(input.collated);
    if (pairIds.length === 0) {
        throw new Error("nothing is in dispute, so there is nothing to adjudicate");
    }
    return buildSheetFor({
        reviewerId: input.adjudicatorId,
        pairIds,
        bundle: input.bundle,
        seed: input.seed,
        populationDigest: input.populationDigest,
    });
};

/**
 * Why an adjudication cannot stand. Empty means it can.
 *
 * The adjudicator has to be a third person, and has to have graded exactly the
 * disputed pairs -- no more. A sheet holding pairs the reviewers agreed on
 * would let a third opinion overturn an agreement, which is not what
 * adjudication is for.
 */
export const adjudicationProblems = (input: {
    collated: readonly PairVerdicts[];
    adjudication: Submission;
    key: readonly SheetKeyRow[];
    reviewerIds: readonly string[];
}): readonly string[] => {
    const problems: string[] = [];
    if (input.reviewerIds.includes(input.adjudication.reviewerId)) {
        problems.push(`${input.adjudication.reviewerId} is one of the two reviewers, not a third opinion`);
    }
    const index = pairIdIndex(input.key);
    const graded = positionalByPair(input.adjudication, index);
    const disputed = new Set(pairsNeedingAdjudication(input.collated));
    for (const pairId of graded.keys()) {
        if (!disputed.has(pairId)) {
            problems.push(`${pairId} was not in dispute, so an adjudication of it would overturn an agreement`);
        }
    }
    for (const pairId of disputed) {
        if (!graded.has(pairId)) problems.push(`${pairId} is in dispute and was not adjudicated`);
    }
    return problems;
};

export type AdjudicatedSample = {
    adjudicationVersion: typeof ADJUDICATION_VERSION;
    populationDigest: string;
    reviewerIds: readonly string[];
    adjudicatorId: string | null;
    settledAt: string;
    settledBy: string;
    pairs: readonly PairVerdicts[];
    counts: {
        agreed: number;
        adjudicated: number;
        needsAdjudication: number;
        noConsensus: number;
        incomplete: number;
    };
    /**
     * Of the pairs both reviewers graded, the share they agreed on before any
     * adjudication. This is the number that says how hard the judgement is,
     * and it is computed before the third opinion by construction.
     */
    reviewerAgreementRate: number | null;
};

/**
 * Settle the sample: two reviewers, and an adjudicator where they split.
 *
 * `adjudication` is omitted on the first pass, which is how the disputed pairs
 * are found in the first place. Nothing is forced: a pair three graders read
 * three ways stays `no_consensus`.
 */
export const settleSample = (input: {
    submissions: readonly Submission[];
    adjudication?: Submission | null;
    key: readonly SheetKeyRow[];
    reviewerIds: readonly string[];
    pairIds: readonly string[];
    populationDigest: string;
    settledAt: string;
    settledBy: string;
}): AdjudicatedSample => {
    const reviewersOnly = collateVerdicts({
        submissions: input.submissions,
        key: input.key,
        reviewerIds: input.reviewerIds,
        pairIds: input.pairIds,
    });

    const decidedByReviewers = reviewersOnly.filter(
        (pair) => pair.status !== "incomplete"
    );
    const reviewerAgreementRate =
        decidedByReviewers.length === 0
            ? null
            : decidedByReviewers.filter((pair) => pair.status === "agreed").length / decidedByReviewers.length;

    const pairs = input.adjudication
        ? collateVerdicts({
              submissions: [...input.submissions, input.adjudication],
              key: input.key,
              reviewerIds: [...input.reviewerIds, input.adjudication.reviewerId],
              pairIds: input.pairIds,
          })
        : reviewersOnly;

    // A pair the two reviewers agreed on is agreed however many people grade
    // it later, so collating with three would call it `incomplete` when the
    // adjudicator was never asked about it. The reviewers' reading stands.
    const settled = pairs.map((pair, index) =>
        pair.status === "incomplete" && reviewersOnly[index].status === "agreed" ? reviewersOnly[index] : pair
    );

    const count = (status: PairVerdicts["status"]) => settled.filter((pair) => pair.status === status).length;
    return {
        adjudicationVersion: ADJUDICATION_VERSION,
        populationDigest: input.populationDigest,
        reviewerIds: input.reviewerIds,
        adjudicatorId: input.adjudication?.reviewerId ?? null,
        settledAt: input.settledAt,
        settledBy: input.settledBy,
        pairs: settled,
        counts: {
            agreed: count("agreed"),
            adjudicated: count("adjudicated"),
            needsAdjudication: count("needs_adjudication"),
            noConsensus: count("no_consensus"),
            incomplete: count("incomplete"),
        },
        reviewerAgreementRate,
    };
};

/**
 * The settled human verdicts, as statements about the arms.
 *
 * Only settled pairs appear: a pair still in dispute, or one three graders
 * read three ways, is not evidence about the Router and is left out rather
 * than counted as a tie.
 */
export const settledArmVerdicts = (
    settled: AdjudicatedSample,
    key: readonly SheetKeyRow[]
): readonly { pairId: string; verdict: "auto" | "baseline" | "equivalent" }[] => {
    const arms = new Map(key.map((row) => [row.pairId, { a: row.aArm, b: row.bArm }]));
    return settled.pairs
        .filter((pair) => pair.verdict !== undefined)
        .map((pair) => {
            const sides = arms.get(pair.pairId);
            if (!sides) throw new Error(`${pair.pairId} is not in the key, so its sides are unknown`);
            return {
                pairId: pair.pairId,
                verdict:
                    pair.verdict === "equivalent"
                        ? ("equivalent" as const)
                        : pair.verdict === "first"
                          ? sides.a
                          : sides.b,
            };
        });
};
