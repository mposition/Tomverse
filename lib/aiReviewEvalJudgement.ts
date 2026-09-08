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
 * **The synonym problem is moved, not solved.** `2주` and `14일` become one
 * `requirementId` because a PERSON decided they are the same requirement. That
 * judgement still happens; it happens once, in the open, instead of being
 * approximated by a substring test on every score.
 *
 * ## What the record is, and what it is not
 *
 * A claim says: for THIS answer, about THIS requirement, the reviewer asserted
 * missing, present or unclear, and did so as a finding rather than in passing.
 * It carries the sentence it rests on, so a person can check it.
 *
 * **A structured field is still an author's declaration.** The whole reason
 * `gold.accusedLabel` had to be renamed a declaration check is that a field
 * saying "b" does not make the fault be in b. So every claim is confirmed by a
 * named person at a stated time, the RECORD itself is signed off as complete,
 * and anything short of that leaves the case unscorable -- not scored as zero,
 * not scored with the gap dropped.
 *
 * That check does not prove a signature is genuine. It stops an unsigned one
 * being read as signed, which is a smaller claim and a true one.
 *
 * ## The unit of judgement is (kind, label, requirement)
 *
 * Not the requirement alone. "c never gives the deadline" is not evidence that
 * `a` gives it, so a claim that `a` omits the same requirement is a DIFFERENT
 * question -- possibly a second omission the gold missed. Keying the gold's
 * scope by requirement id alone made that claim an automatic wrong finding and
 * threw away the person's verdict on it, which is the contract contradicting
 * itself: it offers a route for finding an incomplete gold and then ignores
 * the one shape such a finding most often takes.
 *
 * ## When the gold is disproved
 *
 * A gold declared exhaustive says "this is everything reportable of this
 * kind". A confirmed `gold_incomplete` says it is not. Both cannot stand, and
 * the numbers computed from the first are not repairable by noting the second
 * beside them: the precision denominator counted findings against a list now
 * known to be short, and the recall denominator was that same short list.
 *
 * So the kind is not scored, and the gap is reported so the case can be
 * corrected. **Correcting it means re-scoring every reviewer against the new
 * gold** -- dropping only the reviewer that found the gap would compare the
 * others on a different list from the one it was measured against.
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
 * refusals in `verifyJudgementRecord()`.
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

/**
 * For a submitted claim the gold does not contain: what a person decided.
 *
 * Required on exactly those claims and meaningless on the others, because only
 * there is there a question. A reviewer that reports something true which the
 * gold forgot has found a real fault; one that reports something that is not
 * there has invented it; and telling those apart is reading, not arithmetic.
 */
export const JUDGED_OUTSIDE_GOLD_VERDICTS = [
    /** The reviewer reported something that is not so. */
    "false_finding",
    /** The reviewer is right and the gold is short an item. */
    "gold_incomplete",
    /** Nobody has decided. The case is not scored. */
    "undetermined",
] as const;
export type AiReviewJudgedOutsideGoldVerdict =
    (typeof JUDGED_OUTSIDE_GOLD_VERDICTS)[number];

/** One thing the reviewer said, about one requirement, about one answer. */
export type AiReviewJudgedClaim = {
    /** The answer this claim is about. */
    targetLabel: string;
    /** The requirement, by the id the case's gold uses, or one the judge assigned. */
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
    /**
     * Required when this exact (kind, label, requirement) is not a gold item,
     * ignored otherwise. See `JUDGED_OUTSIDE_GOLD_VERDICTS`.
     */
    outsideGoldVerdict?: AiReviewJudgedOutsideGoldVerdict;
    /** Never scored while `pending`, and never scored without a signature. */
    status: "pending" | "confirmed";
    confirmedBy: string | null;
    confirmedAt: string | null;
};

/**
 * One judgement record: whose output it is about, and what was judged in it.
 *
 * The identity travels WITH the claims. Checking only the case's own version
 * would let a record written under an older contract, or about another case,
 * be scored against this one -- and neither the claims nor the caller would
 * say so.
 */
export type AiReviewJudgementRecord = {
    caseId: string;
    contractVersion: string;
    /**
     * Which reviewer output was read. Any stable identifier for the run and
     * its result -- an attempt id, a digest.
     *
     * `verifyJudgementRecord()` checks it is filled in, and compares it only
     * when the caller supplies what the output actually is. On its own this is
     * a "did anyone write down which output this was" check and nothing more;
     * binding it to the output itself belongs with the evidence bundle.
     */
    observationRef: string;
    /**
     * Who read the whole output and declared the extraction finished, and
     * when.
     *
     * Per-claim signatures cannot say this. A record with no claims at all is
     * either "read it through, there was nothing to report" or "nobody has
     * started", and those score very differently -- the first is a reviewer
     * that found nothing, the second is not a measurement.
     */
    reviewedBy: string;
    reviewedAt: string;
    claims: readonly AiReviewJudgedClaim[];
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
    /** Gold items found. The RECALL numerator, counted for every case. */
    truePositives: number;
    falseNegatives: number;
    /**
     * Wrong findings. Counted ONLY where the gold claims to be exhaustive --
     * an incomplete gold cannot tell an extra finding from one it forgot.
     */
    falsePositives: number;
    /**
     * Whether this kind's numbers may enter a precision aggregate at all.
     * False for a non-exhaustive gold, where BOTH the numerator and the
     * denominator are excluded.
     */
    precisionCounted: boolean;
    /**
     * The precision numerator: `truePositives` where `precisionCounted`, and 0
     * otherwise. Separate from `truePositives` so that an aggregator holding
     * only these objects cannot sum the wrong one -- summing `truePositives`
     * across a mixed set is the exact failure the M5 contract calls out.
     */
    precisionTruePositives: number;
    /**
     * Claims that repeat a gold item already matched. Neither credited nor
     * penalised: repeating a true finding is not a second finding, and it is
     * not a wrong one either. Counted so that a reviewer padding its output is
     * visible rather than invisible.
     */
    duplicates: number;
    /**
     * Confirmed findings outside the gold that a person judged correct. A fact
     * about the CASE, not about the reviewer -- and, where the gold claimed to
     * be exhaustive, the fact that stops the kind being scored at all.
     */
    goldGaps: number;
};

export type AiReviewJudgedOutcome =
    | {
          scored: false;
          /** Why no number may be produced. Never a zero in disguise. */
          reason: string;
          /**
           * Per kind, the confirmed gold gaps found before scoring stopped.
           * The diagnosis survives the refusal: it is what the case has to be
           * corrected with.
           */
          goldGaps?: Readonly<Record<AiReviewEvalFindingKind, number>>;
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
    precisionCounted: false,
    precisionTruePositives: 0,
    duplicates: 0,
    goldGaps: 0,
});

const claimKey = (item: { requirementId: string; targetLabel: string }) =>
    `${item.targetLabel} ${item.requirementId}`;

const isSignedTimestamp = (value: unknown): value is string =>
    typeof value === "string" &&
    value.trim() !== "" &&
    !Number.isNaN(Date.parse(value));

const isSignedName = (value: unknown): value is string =>
    typeof value === "string" && value.trim() !== "";

/**
 * Everything that must hold before a record may be scored at all.
 *
 * Separate from scoring because it is a different question -- "is this record
 * about this case, written under this contract, and signed" -- and because the
 * answer is a list a person can act on rather than one refusal.
 *
 * `expected.observationRef`, when the caller knows what the scored output
 * actually is, turns the observation check from "was anything written down"
 * into a comparison. Without it the field is only checked for presence, and
 * this function does not pretend otherwise.
 *
 * `scoreJudgedCase()` runs this too. A caller cannot skip it.
 */
export function verifyJudgementRecord(
    testCase: AiReviewJudgedCase,
    record: AiReviewJudgementRecord,
    expected: { observationRef?: string } = {}
): readonly string[] {
    const problems: string[] = [];
    if (testCase.contractVersion !== AI_REVIEW_SCORING_CONTRACT_VERSION) {
        problems.push(
            `the case was written for ${testCase.contractVersion} and this scorer is ` +
                `${AI_REVIEW_SCORING_CONTRACT_VERSION}; scores do not carry across contracts`
        );
    }
    if (record.contractVersion !== AI_REVIEW_SCORING_CONTRACT_VERSION) {
        problems.push(
            `the judgement record was written for ${record.contractVersion} and this ` +
                `scorer is ${AI_REVIEW_SCORING_CONTRACT_VERSION}; a record made under ` +
                `other rules cannot be re-read under these`
        );
    }
    if (record.caseId !== testCase.caseId) {
        problems.push(
            `the record is about ${record.caseId} and the case is ${testCase.caseId}`
        );
    }
    if (!isSignedName(record.observationRef)) {
        problems.push(
            "the record does not say which reviewer output it was made from, so it " +
                "could be scored against any of them"
        );
    } else if (
        expected.observationRef !== undefined &&
        record.observationRef !== expected.observationRef
    ) {
        problems.push(
            `the record was made from ${record.observationRef} and the output being ` +
                `scored is ${expected.observationRef}`
        );
    }
    // The record's own sign-off, which no per-claim signature can stand in for:
    // a record with no claims is either "read through, nothing to report" or
    // "nobody has started", and those are not the same measurement.
    if (!isSignedName(record.reviewedBy)) {
        problems.push(
            "nobody has signed the record off as read through, so an empty one cannot " +
                "be told from one nobody has started"
        );
    }
    if (!isSignedTimestamp(record.reviewedAt)) {
        problems.push(
            `the record says it was read through at ${JSON.stringify(record.reviewedAt)}, ` +
                `which is not a time`
        );
    }
    for (const [index, claim] of record.claims.entries()) {
        const where = `claim[${index}] (${claim.targetLabel}/${claim.requirementId})`;
        if (claim.status !== "confirmed") {
            problems.push(
                `${where} is ${claim.status}: a structured field is the extractor's ` +
                    `declaration, and scoring around it would report a number about text ` +
                    `nobody read`
            );
            continue;
        }
        // A confirmation is a person's act, so it names one and says when.
        // This does not prove the signature is genuine; it stops an absent one
        // being read as present, which is what `status: "confirmed"` alone did.
        if (!isSignedName(claim.confirmedBy)) {
            problems.push(`${where} is marked confirmed by nobody`);
        }
        if (!isSignedTimestamp(claim.confirmedAt)) {
            problems.push(
                `${where} is marked confirmed at ${JSON.stringify(claim.confirmedAt)}, ` +
                    `which is not a time`
            );
        }
    }
    return problems;
}

/**
 * Scores one case against one verified judgement record.
 *
 * Refuses rather than approximates. An unverified record, a submitted claim
 * outside the gold that nobody has ruled on, and an exhaustive gold a
 * confirmed gap has disproved each return `scored: false` with the reason and
 * NO score field, so a caller cannot read the refusal as a zero.
 */
export function scoreJudgedCase(
    testCase: AiReviewJudgedCase,
    record: AiReviewJudgementRecord,
    expected: { observationRef?: string } = {}
): AiReviewJudgedOutcome {
    const problems = verifyJudgementRecord(testCase, record, expected);
    if (problems.length > 0) {
        return {
            scored: false,
            reason: `${testCase.caseId} cannot be scored:\n  - ${problems.join("\n  - ")}`,
        };
    }

    // The gold's scope, per kind, keyed by the whole triple. A claim about the
    // same requirement in ANOTHER answer is a different question: "c omits the
    // deadline" says nothing about whether `a` gives it.
    const goldKeys = Object.fromEntries(
        AI_REVIEW_EVAL_FINDING_KINDS.map((kind) => [
            kind,
            new Set((testCase.gold[kind] ?? []).map((item) => claimKey(item))),
        ])
    ) as Record<AiReviewEvalFindingKind, Set<string>>;

    const submitted = record.claims.filter(
        (claim) => claim.submittedAs !== "prose"
    ) as readonly (AiReviewJudgedClaim & { submittedAs: AiReviewEvalFindingKind })[];
    const outsideGold = (claim: (typeof submitted)[number]) =>
        !goldKeys[claim.submittedAs].has(claimKey(claim));

    const unruled = submitted.filter(
        (claim) =>
            outsideGold(claim) &&
            (claim.outsideGoldVerdict === undefined ||
                claim.outsideGoldVerdict === "undetermined")
    );
    if (unruled.length > 0) {
        return {
            scored: false,
            reason:
                `${testCase.caseId} has ${unruled.length} confirmed finding(s) the gold ` +
                `does not contain (${[
                    ...new Set(unruled.map((claim) => claimKey(claim))),
                ].join(", ")}) with no verdict on whether the reviewer invented them or ` +
                `the gold is short an item. Only a person settles that, and a score ` +
                `computed either way would be about a case nobody has finished reading`,
        };
    }

    // Gaps first, because an exhaustive gold with a confirmed gap cannot be
    // scored at all and the gap has to survive the refusal.
    const gaps = Object.fromEntries(
        AI_REVIEW_EVAL_FINDING_KINDS.map((kind) => [
            kind,
            submitted.filter(
                (claim) =>
                    claim.submittedAs === kind &&
                    outsideGold(claim) &&
                    claim.outsideGoldVerdict === "gold_incomplete"
            ).length,
        ])
    ) as Record<AiReviewEvalFindingKind, number>;

    const disproved = AI_REVIEW_EVAL_FINDING_KINDS.filter(
        (kind) => testCase.goldCompleteness[kind] === true && gaps[kind] > 0
    );
    if (disproved.length > 0) {
        return {
            scored: false,
            goldGaps: gaps,
            reason:
                `${testCase.caseId} declares its ${disproved.join(", ")} gold exhaustive, ` +
                `and a confirmed finding outside it says otherwise. Both cannot stand: ` +
                `the precision denominator counted findings against a list now known to ` +
                `be short, and recall's denominator was that same list. Correct the gold ` +
                `and re-score EVERY reviewer against the corrected one -- dropping only ` +
                `the reviewer that found the gap would compare the rest on a different ` +
                `list from the one they were measured against`,
        };
    }

    const byKind = Object.fromEntries(
        AI_REVIEW_EVAL_FINDING_KINDS.map((kind) => [kind, emptyKind()])
    ) as Record<AiReviewEvalFindingKind, AiReviewJudgedKindOutcome>;

    for (const kind of AI_REVIEW_EVAL_FINDING_KINDS) {
        const gold = testCase.gold[kind] ?? [];
        const exhaustive = testCase.goldCompleteness[kind] === true;
        const outcome = byKind[kind];
        outcome.precisionCounted = exhaustive;
        outcome.goldGaps = gaps[kind];
        const matched = new Set<string>();

        // Only what was SUBMITTED as a finding of this kind can score. The same
        // words in the reviewer's explanation, or inside a quote, are not a
        // report -- that is what `submittedAs` is for.
        for (const claim of submitted) {
            if (claim.submittedAs !== kind) continue;
            const key = claimKey(claim);
            if (
                !outsideGold(claim) &&
                claim.assertion === "missing" &&
                claim.speechAct === "finding"
            ) {
                if (matched.has(key)) {
                    outcome.duplicates += 1;
                    continue;
                }
                matched.add(key);
                outcome.truePositives += 1;
                continue;
            }
            // A confirmed finding outside the gold that a person judged
            // correct says the gold is short an item. Only reachable here when
            // the gold did NOT claim to be exhaustive -- the exhaustive case
            // refused above.
            if (outsideGold(claim) && claim.outsideGoldVerdict === "gold_incomplete") {
                continue;
            }
            // Everything else submitted into a findings field is a finding the
            // reviewer put forward and the gold does not contain: the opposite
            // asserted, a quotation filed as a finding, or something a person
            // ruled invented. Counted only where the gold claims to be
            // exhaustive.
            if (exhaustive) outcome.falsePositives += 1;
        }
        outcome.falseNegatives = gold.length - matched.size;
        outcome.precisionTruePositives = exhaustive ? outcome.truePositives : 0;
    }

    return {
        scored: true,
        contractVersion: AI_REVIEW_SCORING_CONTRACT_VERSION,
        byKind,
    };
}
