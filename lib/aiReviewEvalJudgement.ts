/**
 * The scoring contract that reads a JUDGEMENT, not a string.
 *
 * docs/ops/ai-review-eval-scoring-contract.md.
 *
 * ## Why the keyword scorer cannot be repaired
 *
 * `scoreCase()` matches a gold item's `anyOf` terms against the reviewer's
 * finding text. That answers one question -- does this text mention the thing
 * the gold is about -- and the evaluation needs four. Measured on 2026-09-08
 * against a real gold whose terms were the deadline and its synonyms, three
 * reviews scored one true positive each: the correct one, one accusing a
 * different answer, and one asserting the element was present after all.
 *
 * Lengthening the terms loses the synonym; adding the label to
 * `mustAlsoContain` separates the mis-accusation and not the contradiction,
 * and a one-character label is a substring of ordinary words. There is no
 * choice of strings that makes a substring test answer "which answer",
 * "missing or present" and "was this even a finding". So this module does not
 * choose better strings. It scores a record that already carries the answers.
 *
 * ## What the record is, and what it is not
 *
 * A claim says: for THIS answer, about THIS requirement, the reviewer asserted
 * missing, present or unclear, and did so as a finding rather than in passing.
 * It carries the sentence it rests on, so a person can check it.
 *
 * **A structured field is still an author's declaration.** The whole reason
 * `gold.accusedLabel` had to be renamed a declaration check is that a field
 * saying "b" does not make the fault be in b. So a claim is `pending` until a
 * person confirms it, and a case holding one pending claim **cannot be
 * scored** -- not scored as zero, not scored with it dropped. Producing a
 * number from a record nobody has read is the failure this contract exists to
 * remove.
 *
 * ## Scope
 *
 * Evaluation only. Nothing here reads or changes the product's AI Review
 * output, its API, its database or its UI: the reviewer keeps producing what
 * it produces, and the judgement is made about that output afterwards.
 */

import {
    AI_REVIEW_EVAL_FINDING_KINDS,
    type AiReviewEvalFindingKind,
} from "@/lib/aiReviewEvalCore";

/**
 * The contract a record was written against.
 *
 * Scores are not carried across versions. A record written for one set of
 * rules, re-scored under another, produces a number nobody approved -- see the
 * refusal in `scoreJudgedCase()`.
 */
export const AI_REVIEW_SCORING_CONTRACT_VERSION = "ai-review-scoring-judged-v1";

/** What the reviewer asserted about a requirement in one answer. */
export const JUDGED_ASSERTIONS = ["missing", "present", "unclear"] as const;
export type AiReviewJudgedAssertion = (typeof JUDGED_ASSERTIONS)[number];

/**
 * Whether the reviewer was REPORTING something or merely saying it.
 *
 * A quotation of an answer, a hypothetical, and a passing mention are not
 * findings. The distinction has to be recorded because the words are the same;
 * only the act differs.
 */
export const JUDGED_SPEECH_ACTS = [
    "finding",
    "quotation",
    "hypothetical",
    "mention",
] as const;
export type AiReviewJudgedSpeechAct = (typeof JUDGED_SPEECH_ACTS)[number];

/** One thing the reviewer said, about one requirement, about one answer. */
export type AiReviewJudgedClaim = {
    /** The answer this claim is about. */
    targetLabel: string;
    /** The requirement, by the id the case's gold uses. */
    requirementId: string;
    assertion: AiReviewJudgedAssertion;
    speechAct: AiReviewJudgedSpeechAct;
    /**
     * Where it came from. A claim submitted in a findings field can score --
     * as a hit or as a wrong finding. One read out of the reviewer's prose or
     * a quote is neither: the same words in an explanation are not a report.
     */
    submittedAs: AiReviewEvalFindingKind | "prose";
    /** Index within that findings array, so a person can find it again. */
    sourceIndex: number | null;
    /** The sentence the judgement rests on, verbatim. */
    evidenceQuote: string;
    /** Never scored while `pending`. */
    status: "pending" | "confirmed";
    confirmedBy: string | null;
    confirmedAt: string | null;
};

/** What the case says SHOULD be reported: this requirement, missing from this answer. */
export type AiReviewJudgedGoldItem = {
    requirementId: string;
    targetLabel: string;
};

export type AiReviewJudgedCase = {
    caseId: string;
    contractVersion: string;
    /** Per finding kind, what a correct review reports. */
    gold: Partial<Record<AiReviewEvalFindingKind, readonly AiReviewJudgedGoldItem[]>>;
    /** Per kind: is the gold above everything reportable of that kind? */
    goldCompleteness: Partial<Record<AiReviewEvalFindingKind, boolean>>;
};

export type AiReviewJudgedKindOutcome = {
    truePositives: number;
    falseNegatives: number;
    /**
     * Wrong findings. Counted ONLY where the gold claims to be exhaustive --
     * an incomplete gold cannot tell an extra finding from one it forgot.
     */
    falsePositives: number;
    /**
     * Claims that repeat a gold item already matched. Neither credited nor
     * penalised: repeating a true finding is not a second finding, and it is
     * not a wrong one either. Counted so that a reviewer padding its output is
     * visible rather than invisible.
     */
    duplicates: number;
};

export type AiReviewJudgedOutcome =
    | {
          scored: false;
          /** Why no number may be produced. Never a zero in disguise. */
          reason: string;
      }
    | {
          scored: true;
          contractVersion: string;
          byKind: Record<AiReviewEvalFindingKind, AiReviewJudgedKindOutcome>;
      };

const emptyKind = (): AiReviewJudgedKindOutcome => ({
    truePositives: 0,
    falseNegatives: 0,
    falsePositives: 0,
    duplicates: 0,
});

const claimKey = (item: { requirementId: string; targetLabel: string }) =>
    `${item.targetLabel} ${item.requirementId}`;

/**
 * Scores one case against one confirmed judgement record.
 *
 * Refuses rather than approximates. An unknown contract version, a claim
 * nobody has confirmed, a claim naming a requirement the gold does not know --
 * each returns `scored: false` with the reason, because every one of them
 * means the number would be about something other than what it claims.
 */
export function scoreJudgedCase(
    testCase: AiReviewJudgedCase,
    claims: readonly AiReviewJudgedClaim[]
): AiReviewJudgedOutcome {
    if (testCase.contractVersion !== AI_REVIEW_SCORING_CONTRACT_VERSION) {
        return {
            scored: false,
            reason:
                `${testCase.caseId} was judged against ${testCase.contractVersion} and ` +
                `this scorer is ${AI_REVIEW_SCORING_CONTRACT_VERSION}. Scores do not ` +
                `carry across contracts`,
        };
    }
    const pending = claims.filter((claim) => claim.status !== "confirmed");
    if (pending.length > 0) {
        return {
            scored: false,
            reason:
                `${testCase.caseId} has ${pending.length} claim(s) nobody has confirmed. ` +
                `A structured field is the extractor's declaration, not a judgement, and ` +
                `scoring around it would report a number about text nobody read`,
        };
    }
    // A requirement the gold does not name is not scored as a miss: it means
    // the record and the case disagree about what the case is, and a total
    // computed over that disagreement is not about either of them.
    const known = new Set<string>();
    for (const kind of AI_REVIEW_EVAL_FINDING_KINDS) {
        for (const item of testCase.gold[kind] ?? []) known.add(item.requirementId);
    }
    const unknown = claims.filter(
        (claim) => claim.submittedAs !== "prose" && !known.has(claim.requirementId)
    );
    if (unknown.length > 0) {
        return {
            scored: false,
            reason:
                `${testCase.caseId} has claim(s) about requirement(s) ` +
                `${[...new Set(unknown.map((claim) => claim.requirementId))].join(", ")}, ` +
                `which this case's gold does not name. Either the gold is short an item ` +
                `or the record is about another case`,
        };
    }

    const byKind = Object.fromEntries(
        AI_REVIEW_EVAL_FINDING_KINDS.map((kind) => [kind, emptyKind()])
    ) as Record<AiReviewEvalFindingKind, AiReviewJudgedKindOutcome>;

    for (const kind of AI_REVIEW_EVAL_FINDING_KINDS) {
        const gold = testCase.gold[kind] ?? [];
        const exhaustive = testCase.goldCompleteness[kind] === true;
        const outcome = byKind[kind];
        const wanted = new Set(gold.map((item) => claimKey(item)));
        const matched = new Set<string>();

        // Only what was SUBMITTED as a finding of this kind can score. The same
        // words in the reviewer's explanation, or inside a quote, are not a
        // report -- that is what `submittedAs` is for.
        for (const claim of claims) {
            if (claim.submittedAs !== kind) continue;
            const key = claimKey(claim);
            const isHit =
                wanted.has(key) &&
                claim.assertion === "missing" &&
                claim.speechAct === "finding";
            if (isHit) {
                if (matched.has(key)) {
                    outcome.duplicates += 1;
                    continue;
                }
                matched.add(key);
                outcome.truePositives += 1;
                continue;
            }
            // Everything else submitted into a findings field is a finding the
            // reviewer put forward and the gold does not contain: the wrong
            // answer accused, the opposite asserted, or a quotation filed as a
            // finding. Counted only where the gold claims to be exhaustive.
            if (exhaustive) outcome.falsePositives += 1;
        }
        outcome.falseNegatives = gold.length - matched.size;
    }

    return {
        scored: true,
        contractVersion: AI_REVIEW_SCORING_CONTRACT_VERSION,
        byKind,
    };
}
