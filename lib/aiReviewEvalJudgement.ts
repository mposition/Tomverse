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
 * So the CASE is not scored -- not the offending kind alone, because a
 * reviewer's score is read across kinds and half of one is a different
 * measurement wearing the same name -- and the gap is reported so the case can
 * be corrected. **Correcting it means re-scoring every reviewer against the
 * new gold**: dropping only the reviewer that found the gap would compare the
 * others on a different list from the one it was measured against.
 *
 * Every refusal that gets this far carries `goldGaps`, whatever else is also
 * wrong with the record. A refusal is a report.
 *
 * ## Scope
 *
 * Evaluation only. Nothing here reads or changes the product's AI Review
 * output, its API, its database or its UI: the reviewer keeps producing what
 * it produces, and the judgement is made about that output afterwards.
 */

import { createHash } from "node:crypto";

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

/**
 * A requirement this case knows about, by the id its gold refers to.
 *
 * The catalogue exists so a gold cannot name something the case never
 * registered -- a typo in an id would otherwise become a gold item nothing
 * could ever satisfy, and it would read as the reviewer's failure.
 *
 * **It does not constrain what a reviewer may find.** A claim about an
 * unregistered requirement is not a registration error; it is a finding
 * outside the gold, and `outsideGoldVerdict` is where that is settled. The
 * catalogue is about the case's own bookkeeping and nothing else.
 */
export type AiReviewJudgedRequirement = {
    id: string;
    description: string;
};

export type AiReviewJudgedCase = {
    caseId: string;
    contractVersion: string;
    /**
     * A digest of the DATASET case a person read when judging: its id, its
     * question, and every answer's label and text.
     *
     * `caseDigest` in the artifact is a digest of THIS object -- the gold and
     * the catalogue. It says nothing about the question and answers the
     * judgement was made from, so a new evidence bundle keeping the same id and
     * labels while changing the question could carry an old judgement and an
     * old score, and everything verified.
     *
     * Compared against the frozen dataset by `verifyJudgedScoringEvidence()`.
     * It does not read the text or judge it; it asks whether the text a person
     * judged is the text that is there now.
     */
    sourceCaseDigest: string;
    /** The answers this case has, by label. Gold items must name one. */
    responseLabels: readonly string[];
    /** Requirements the case registers. Gold items must name one. */
    requirements: readonly AiReviewJudgedRequirement[];
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
        // An empty quote is not a quote.
        //
        // Every string contains the empty string, so `includes("")` is true of
        // any output -- a claim with no quote at all passed the check that its
        // evidence appears in the text it points at, in both the findings and
        // the prose branch. Refused here, in the record check, so it is refused
        // whether or not a caller supplies the output to compare against.
        //
        // This says nothing about how long a quote must be or whether it says
        // the right thing. Those are judgements; this is only the difference
        // between writing one and not.
        if (!isSignedName(claim.evidenceQuote)) {
            problems.push(
                `${where} has no evidence quote. Every string contains the empty ` +
                    `string, so a blank one would satisfy any output it was checked ` +
                    `against`
            );
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
    expected: {
        observationRef?: string;
        /**
         * The output the record was made from. Given it, the claims are
         * checked against it -- indexes in range, quotes present, every
         * submitted finding accounted for. A digest says the same bytes were
         * there; only this says the judgements point into them.
         */
        observation?: AiReviewJudgedObservation;
    } = {}
): AiReviewJudgedOutcome {
    // The case's own registration first, then the record. A gold naming a
    // requirement the case never registered produces a miss nothing can
    // satisfy, and it would be recorded against the reviewer -- so a caller
    // cannot skip it, for the same reason it cannot skip the record check.
    const problems = [
        ...validateJudgedCase(testCase),
        ...verifyJudgementRecord(testCase, record, expected),
        ...(expected.observation
            ? verifyRecordAgainstObservation(expected.observation, record)
            : []),
    ];
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

    // Both states are collected BEFORE anything returns.
    //
    // The gap count used to be computed after the undetermined refusal, so one
    // unrelated unruled claim swallowed it: the operator was told to go and
    // rule on something, and never told that a gold defect had already been
    // confirmed and every reviewer on this case would need re-scoring. A
    // refusal is a report, and it reports what is known.
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

    const unruled = submitted.filter(
        (claim) =>
            outsideGold(claim) &&
            (claim.outsideGoldVerdict === undefined ||
                claim.outsideGoldVerdict === "undetermined")
    );
    const disproved = AI_REVIEW_EVAL_FINDING_KINDS.filter(
        (kind) => testCase.goldCompleteness[kind] === true && gaps[kind] > 0
    );

    // Both refusals stop the WHOLE case, not the kind that caused them. A
    // reviewer's score is read across kinds, and half of one is not a smaller
    // score -- it is a different measurement wearing the same name.
    const refusals: string[] = [];
    if (unruled.length > 0) {
        refusals.push(
            `${unruled.length} confirmed finding(s) the gold does not contain ` +
                `(${[...new Set(unruled.map((claim) => claimKey(claim)))].join(", ")}) ` +
                `have no verdict on whether the reviewer invented them or the gold is ` +
                `short an item. Only a person settles that, and a score computed either ` +
                `way would be about a case nobody has finished reading`
        );
    }
    if (disproved.length > 0) {
        refusals.push(
            `the ${disproved.join(", ")} gold is declared exhaustive and a confirmed ` +
                `finding outside it says otherwise. Both cannot stand: the precision ` +
                `denominator counted findings against a list now known to be short, and ` +
                `recall's denominator was that same list. Correct the gold and re-score ` +
                `EVERY reviewer against the corrected one -- dropping only the reviewer ` +
                `that found the gap would compare the rest on a different list from the ` +
                `one they were measured against`
        );
    }
    if (refusals.length > 0) {
        return {
            scored: false,
            goldGaps: gaps,
            reason: `${testCase.caseId} is not scored:\n  - ${refusals.join("\n  - ")}`,
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

// ---------------------------------------------------------------------------
// Gold registration
// ---------------------------------------------------------------------------

/**
 * Whether the CASE is registered consistently with itself.
 *
 * A different question from anything the scorer asks, and it has to stay
 * different. This checks that the gold points at requirements and answers the
 * case declares -- a mistyped id would otherwise become a gold item nothing
 * can satisfy, and the miss would be recorded against the reviewer.
 *
 * **It says nothing about what a reviewer may report.** A finding about an
 * unregistered requirement is not a registration error: it is a finding
 * outside the gold, settled by `outsideGoldVerdict`, and the whole point of
 * that route is that a case's list is not the limit of what is true about it.
 * Nothing here may reject a claim, and nothing here reads the claims at all.
 */
export function validateJudgedCase(
    testCase: AiReviewJudgedCase
): readonly string[] {
    const problems: string[] = [];
    if (testCase.contractVersion !== AI_REVIEW_SCORING_CONTRACT_VERSION) {
        problems.push(
            `the case is written for ${testCase.contractVersion} and this contract is ` +
                `${AI_REVIEW_SCORING_CONTRACT_VERSION}`
        );
    }
    const labels = new Set(testCase.responseLabels ?? []);
    if (labels.size === 0) {
        problems.push("the case registers no answer labels, so no gold item can name one");
    }
    const requirementIds = new Set<string>();
    for (const requirement of testCase.requirements ?? []) {
        if (!isSignedName(requirement?.id)) {
            problems.push("a registered requirement has no id");
            continue;
        }
        if (requirementIds.has(requirement.id)) {
            problems.push(`requirement "${requirement.id}" is registered twice`);
            continue;
        }
        if (!isSignedName(requirement.description)) {
            problems.push(
                `requirement "${requirement.id}" has no description, so nobody reading ` +
                    `a score can tell what was required`
            );
        }
        requirementIds.add(requirement.id);
    }
    for (const kind of AI_REVIEW_EVAL_FINDING_KINDS) {
        const gold = testCase.gold[kind];
        if (gold === undefined) {
            if (testCase.goldCompleteness[kind] !== undefined) {
                problems.push(
                    `goldCompleteness.${kind} is stated and there is no ${kind} gold to ` +
                        `be complete about`
                );
            }
            continue;
        }
        if (testCase.goldCompleteness[kind] === undefined) {
            problems.push(
                `${kind} has gold and no completeness claim; whether wrong findings may ` +
                    `be counted depends on it, so it cannot be left unsaid`
            );
        }
        const seen = new Set<string>();
        for (const item of gold) {
            const key = claimKey(item);
            if (!requirementIds.has(item.requirementId)) {
                problems.push(
                    `${kind} gold names requirement "${item.requirementId}", which the ` +
                        `case does not register`
                );
            }
            if (!labels.has(item.targetLabel)) {
                problems.push(
                    `${kind} gold names answer "${item.targetLabel}", which the case does ` +
                        `not have`
                );
            }
            if (seen.has(key)) {
                problems.push(`${kind} gold lists ${key} twice`);
            }
            seen.add(key);
        }
    }
    return problems;
}

// ---------------------------------------------------------------------------
// Binding a score to the things it was computed from
// ---------------------------------------------------------------------------

/** Stable JSON: object keys sorted, so a digest is about content and not order. */
const canonical = (value: unknown): string => {
    if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
    if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
    const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries
        .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
        .join(",")}}`;
};

const digest = (value: unknown): string =>
    `sha256:${createHash("sha256").update(canonical(value), "utf8").digest("hex")}`;

/**
 * The identifier a judgement record must carry to be about THIS output.
 *
 * Derived from the output's own content rather than assigned beside it. A
 * hand-written reference is a label, and a label can name an output that does
 * not exist -- which is what `observationRef` was until now, by its own
 * admission.
 */
export const observationRefFor = (observation: unknown): string => digest(observation);

/** Content digests of the two things a score is computed from. */
export const judgedCaseDigest = (testCase: AiReviewJudgedCase): string =>
    digest(testCase);

/**
 * A digest of the source case's SUBSTANCE: what a person actually read.
 *
 * The id, the question, and every answer's label and text. Not the metadata
 * around them -- a cell label or a phenomenon name changing does not change
 * what was judged, and refusing over it would make the check noise. What it
 * covers is the text the judgement rests on, so an edited question or a
 * rewritten answer cannot keep an old judgement attached to it.
 */
export const judgedSourceCaseDigest = (datasetCase: {
    id?: string;
    question?: string;
    responses?: readonly { label?: string; content?: string }[];
}): string =>
    digest({
        id: datasetCase.id,
        question: datasetCase.question,
        responses: (datasetCase.responses ?? []).map((response) => ({
            label: response.label,
            content: response.content,
        })),
    });
export const judgementRecordDigest = (record: AiReviewJudgementRecord): string =>
    digest(record);

/**
 * A score, bound to the case, the record and the output it came from.
 *
 * Stored beside them, so a later reader can ask the only question that matters
 * about a stored number: is it still about these files.
 */
export type AiReviewJudgedScoringArtifact = {
    caseId: string;
    contractVersion: string;
    observationRef: string;
    caseDigest: string;
    recordDigest: string;
    scoredAt: string;
    outcome: AiReviewJudgedOutcome;
};

/** Scores, and binds the result to exactly what produced it. */
export function buildScoringArtifact(input: {
    testCase: AiReviewJudgedCase;
    record: AiReviewJudgementRecord;
    observation: AiReviewJudgedObservation;
    scoredAt: string;
}): AiReviewJudgedScoringArtifact {
    const observationRef = observationRefFor(input.observation);
    return {
        caseId: input.testCase.caseId,
        contractVersion: AI_REVIEW_SCORING_CONTRACT_VERSION,
        observationRef,
        caseDigest: judgedCaseDigest(input.testCase),
        recordDigest: judgementRecordDigest(input.record),
        scoredAt: input.scoredAt,
        outcome: scoreJudgedCase(input.testCase, input.record, {
            observationRef,
            observation: input.observation,
        }),
    };
}

/**
 * Whether a stored score is still about the files beside it.
 *
 * Edit the gold, edit a judgement, or score a different output, and the
 * digests stop matching. The artifact is then STALE -- not wrong, not
 * approximately right, just no longer a statement about anything present --
 * and re-scoring is the only thing that makes it a statement again.
 *
 * This is why the observation reference is derived rather than written down.
 * A reference somebody typed can go on matching after the output it names has
 * changed underneath it.
 */
export function verifyScoringArtifact(input: {
    testCase: AiReviewJudgedCase;
    record: AiReviewJudgementRecord;
    observation: AiReviewJudgedObservation;
    artifact: AiReviewJudgedScoringArtifact;
}): readonly string[] {
    const problems: string[] = [];
    const { artifact, testCase, record } = input;
    if (artifact.contractVersion !== AI_REVIEW_SCORING_CONTRACT_VERSION) {
        problems.push(
            `the artifact was scored under ${artifact.contractVersion} and this contract ` +
                `is ${AI_REVIEW_SCORING_CONTRACT_VERSION}`
        );
    }
    if (artifact.caseId !== testCase.caseId) {
        problems.push(
            `the artifact is about ${artifact.caseId} and the case is ${testCase.caseId}`
        );
    }
    const observationRef = observationRefFor(input.observation);
    if (artifact.observationRef !== observationRef) {
        problems.push(
            "the artifact was scored from a different reviewer output than the one here"
        );
    }
    if (artifact.caseDigest !== judgedCaseDigest(testCase)) {
        problems.push(
            "the case has changed since this was scored, so the score is about a gold " +
                "that no longer exists"
        );
    }
    if (artifact.recordDigest !== judgementRecordDigest(record)) {
        problems.push(
            "the judgement record has changed since this was scored, so the score is " +
                "about judgements nobody is making any more"
        );
    }
    // The record must also still be about this output, by the same derived
    // reference. An artifact whose digests match a record that does not is a
    // consistent statement about an inconsistent pair.
    if (record.observationRef !== observationRef) {
        problems.push(
            "the judgement record names a different reviewer output than the one here"
        );
    }
    // And the number itself, recomputed.
    //
    // The digests prove the inputs have not moved. They prove nothing about
    // the outcome written beside them, which is a separate object anybody can
    // edit -- a stored `truePositives: 999`, and a deleted `outcome`, both
    // verified clean. So the score is computed again from these inputs and
    // compared whole: the counts, the refusal, its reason, and the gap
    // diagnosis, because each of those is something a reader would act on.
    const recomputed = scoreJudgedCase(testCase, record, { observationRef, observation: input.observation });
    if (canonical(artifact.outcome) !== canonical(recomputed)) {
        problems.push(
            "the stored outcome is not what these inputs produce. A digest says the " +
                "inputs have not changed; it says nothing about the number written " +
                "beside them, so the score is recomputed and compared whole"
        );
    }
    return problems;
}

// ---------------------------------------------------------------------------
// Shape, before meaning
// ---------------------------------------------------------------------------

/**
 * The reviewer output a judgement record is made from.
 *
 * Only what the binding needs: the findings a claim can point into, and the
 * whole text a prose claim can be quoted from. Extra fields are ignored rather
 * than refused -- the product's observation carries more, and this contract
 * has no business dictating its shape.
 */
export type AiReviewJudgedObservation = {
    findings: Partial<Record<AiReviewEvalFindingKind, readonly string[]>>;
    allText: string;
};

const at = (file: string, path: string) => `${file}: ${path}`;

const typeProblem = (file: string, path: string, value: unknown, wanted: string) =>
    at(file, `${path} is ${JSON.stringify(value) ?? "undefined"}, not ${wanted}`);

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Whether a file holds the shape this contract expects.
 *
 * TypeScript says nothing about JSON somebody wrote. `"true"` where a boolean
 * belongs quietly turned `precisionCounted` false -- a wrong score, not an
 * error -- and a mistyped `submittedAs` printed two sections of `ok` before
 * throwing a TypeError. Both are checked here, before any meaning is read, and
 * every problem names the file and the field path so it can be fixed rather
 * than hunted.
 */
export function judgedCaseShapeProblems(
    value: unknown,
    file = "case.json"
): readonly string[] {
    const problems: string[] = [];
    if (!isPlainObject(value)) return [at(file, "is not an object")];
    for (const field of ["caseId", "contractVersion", "sourceCaseDigest"]) {
        if (typeof value[field] !== "string") {
            problems.push(typeProblem(file, field, value[field], "a string"));
        }
    }
    if (
        !Array.isArray(value.responseLabels) ||
        value.responseLabels.some((label) => typeof label !== "string")
    ) {
        problems.push(typeProblem(file, "responseLabels", value.responseLabels, "an array of strings"));
    }
    if (!Array.isArray(value.requirements)) {
        problems.push(typeProblem(file, "requirements", value.requirements, "an array"));
    } else {
        for (const [index, requirement] of value.requirements.entries()) {
            if (!isPlainObject(requirement)) {
                problems.push(typeProblem(file, `requirements[${index}]`, requirement, "an object"));
                continue;
            }
            for (const field of ["id", "description"]) {
                if (typeof requirement[field] !== "string") {
                    problems.push(
                        typeProblem(file, `requirements[${index}].${field}`, requirement[field], "a string")
                    );
                }
            }
        }
    }
    if (!isPlainObject(value.gold)) {
        problems.push(typeProblem(file, "gold", value.gold, "an object"));
    } else {
        for (const [kind, items] of Object.entries(value.gold)) {
            if (!(AI_REVIEW_EVAL_FINDING_KINDS as readonly string[]).includes(kind)) {
                problems.push(at(file, `gold.${kind} is not a finding kind`));
                continue;
            }
            if (!Array.isArray(items)) {
                problems.push(typeProblem(file, `gold.${kind}`, items, "an array"));
                continue;
            }
            for (const [index, item] of items.entries()) {
                if (!isPlainObject(item)) {
                    problems.push(typeProblem(file, `gold.${kind}[${index}]`, item, "an object"));
                    continue;
                }
                for (const field of ["requirementId", "targetLabel"]) {
                    if (typeof item[field] !== "string") {
                        problems.push(
                            typeProblem(file, `gold.${kind}[${index}].${field}`, item[field], "a string")
                        );
                    }
                }
            }
        }
    }
    if (!isPlainObject(value.goldCompleteness)) {
        problems.push(typeProblem(file, "goldCompleteness", value.goldCompleteness, "an object"));
    } else {
        for (const [kind, claimed] of Object.entries(value.goldCompleteness)) {
            if (!(AI_REVIEW_EVAL_FINDING_KINDS as readonly string[]).includes(kind)) {
                problems.push(at(file, `goldCompleteness.${kind} is not a finding kind`));
                continue;
            }
            // The one that produced a wrong score rather than an error.
            if (typeof claimed !== "boolean") {
                problems.push(
                    typeProblem(file, `goldCompleteness.${kind}`, claimed, "a boolean") +
                        ` -- anything else reads as "not exhaustive" and silently drops the ` +
                        `kind out of precision`
                );
            }
        }
    }
    return problems;
}

export function observationShapeProblems(
    value: unknown,
    file = "observation.json"
): readonly string[] {
    const problems: string[] = [];
    if (!isPlainObject(value)) return [at(file, "is not an object")];
    if (typeof value.allText !== "string") {
        problems.push(typeProblem(file, "allText", value.allText, "a string"));
    }
    if (!isPlainObject(value.findings)) {
        return [...problems, typeProblem(file, "findings", value.findings, "an object")];
    }
    for (const [kind, items] of Object.entries(value.findings)) {
        if (!(AI_REVIEW_EVAL_FINDING_KINDS as readonly string[]).includes(kind)) {
            problems.push(at(file, `findings.${kind} is not a finding kind`));
            continue;
        }
        if (!Array.isArray(items) || items.some((item) => typeof item !== "string")) {
            problems.push(typeProblem(file, `findings.${kind}`, items, "an array of strings"));
        }
    }
    return problems;
}

export function judgementRecordShapeProblems(
    value: unknown,
    file = "record.json"
): readonly string[] {
    const problems: string[] = [];
    if (!isPlainObject(value)) return [at(file, "is not an object")];
    for (const field of ["caseId", "contractVersion", "observationRef", "reviewedBy", "reviewedAt"]) {
        if (typeof value[field] !== "string") {
            problems.push(typeProblem(file, field, value[field], "a string"));
        }
    }
    if (!Array.isArray(value.claims)) {
        return [...problems, typeProblem(file, "claims", value.claims, "an array")];
    }
    const submittedValues = [...AI_REVIEW_EVAL_FINDING_KINDS, "prose"] as readonly string[];
    for (const [index, claim] of value.claims.entries()) {
        const path = `claims[${index}]`;
        if (!isPlainObject(claim)) {
            problems.push(typeProblem(file, path, claim, "an object"));
            continue;
        }
        for (const field of ["targetLabel", "requirementId", "evidenceQuote"]) {
            if (typeof claim[field] !== "string") {
                problems.push(typeProblem(file, `${path}.${field}`, claim[field], "a string"));
            }
        }
        if (!(JUDGED_ASSERTIONS as readonly string[]).includes(claim.assertion as string)) {
            problems.push(
                typeProblem(file, `${path}.assertion`, claim.assertion, `one of ${JUDGED_ASSERTIONS.join(", ")}`)
            );
        }
        if (!(JUDGED_SPEECH_ACTS as readonly string[]).includes(claim.speechAct as string)) {
            problems.push(
                typeProblem(file, `${path}.speechAct`, claim.speechAct, `one of ${JUDGED_SPEECH_ACTS.join(", ")}`)
            );
        }
        // The one that printed `ok` twice and then threw.
        if (!submittedValues.includes(claim.submittedAs as string)) {
            problems.push(
                typeProblem(file, `${path}.submittedAs`, claim.submittedAs, `one of ${submittedValues.join(", ")}`)
            );
        }
        if (
            claim.sourceIndex !== null &&
            (typeof claim.sourceIndex !== "number" || !Number.isInteger(claim.sourceIndex))
        ) {
            problems.push(typeProblem(file, `${path}.sourceIndex`, claim.sourceIndex, "an integer or null"));
        }
        if (claim.status !== "pending" && claim.status !== "confirmed") {
            problems.push(typeProblem(file, `${path}.status`, claim.status, "pending or confirmed"));
        }
        for (const field of ["confirmedBy", "confirmedAt"]) {
            if (claim[field] !== null && typeof claim[field] !== "string") {
                problems.push(typeProblem(file, `${path}.${field}`, claim[field], "a string or null"));
            }
        }
        if (
            claim.outsideGoldVerdict !== undefined &&
            !(JUDGED_OUTSIDE_GOLD_VERDICTS as readonly string[]).includes(claim.outsideGoldVerdict as string)
        ) {
            problems.push(
                typeProblem(
                    file,
                    `${path}.outsideGoldVerdict`,
                    claim.outsideGoldVerdict,
                    `one of ${JUDGED_OUTSIDE_GOLD_VERDICTS.join(", ")}`
                )
            );
        }
    }
    return problems;
}

export function scoringArtifactShapeProblems(
    value: unknown,
    file = "artifact.json"
): readonly string[] {
    const problems: string[] = [];
    if (!isPlainObject(value)) return [at(file, "is not an object")];
    for (const field of [
        "caseId",
        "contractVersion",
        "observationRef",
        "caseDigest",
        "recordDigest",
        "scoredAt",
    ]) {
        if (typeof value[field] !== "string") {
            problems.push(typeProblem(file, field, value[field], "a string"));
        }
    }
    if (!isPlainObject(value.outcome)) {
        problems.push(
            typeProblem(file, "outcome", value.outcome, "an object") +
                " -- an artifact with no outcome is not a score"
        );
    }
    return problems;
}

/**
 * Shape checks for the run's journal and the frozen dataset.
 *
 * The four files in a scoring directory were validated and these two were not,
 * so the newest inputs were the unchecked ones: a dataset whose `cases` was
 * `false` skipped the comparison entirely and the case stayed countable, one
 * whose `cases` was `{}` threw `.find is not a function`, and a journal with a
 * `null` line threw on `.caseId`. Whether a caller SUPPLIED an input and what
 * that input holds are two questions, and reading the second as the first is
 * what let a broken file count as an absent one.
 */
export function judgedJournalShapeProblems(
    value: unknown,
    file = "journal"
): readonly string[] {
    if (!Array.isArray(value)) {
        return [typeProblem(file, "", value, "an array of entries")];
    }
    const problems: string[] = [];
    for (const [index, entry] of value.entries()) {
        if (!isPlainObject(entry)) {
            problems.push(typeProblem(file, `[${index}]`, entry, "an object"));
            continue;
        }
        if (entry.caseId !== undefined && typeof entry.caseId !== "string") {
            problems.push(typeProblem(file, `[${index}].caseId`, entry.caseId, "a string"));
        }
    }
    return problems;
}

export function judgedDatasetShapeProblems(
    value: unknown,
    file = "dataset"
): readonly string[] {
    if (!isPlainObject(value)) return [typeProblem(file, "", value, "an object")];
    if (!Array.isArray(value.cases)) {
        return [
            typeProblem(file, "cases", value.cases, "an array") +
                " -- anything else skipped the comparison entirely and left the case countable",
        ];
    }
    const problems: string[] = [];
    for (const [index, item] of value.cases.entries()) {
        if (!isPlainObject(item)) {
            problems.push(typeProblem(file, `cases[${index}]`, item, "an object"));
            continue;
        }
        if (typeof item.id !== "string") {
            problems.push(typeProblem(file, `cases[${index}].id`, item.id, "a string"));
        }
        if (item.responses !== undefined && !Array.isArray(item.responses)) {
            problems.push(
                typeProblem(file, `cases[${index}].responses`, item.responses, "an array")
            );
        }
    }
    return problems;
}

// ---------------------------------------------------------------------------
// The record against the output it was made from
// ---------------------------------------------------------------------------

/**
 * Whether the record actually read THIS output.
 *
 * The output digest says the same bytes were present. It does not say the
 * judgements point anywhere in them, and both failures got through: a claim
 * with `sourceIndex: 999` and an invented quote scored a true positive, and a
 * record covering one of two submitted findings scored a clean sheet by
 * leaving the other one out.
 *
 * Three checks, and no more:
 *
 *   * an index is within the array it names;
 *   * the quote appears in the text it points at;
 *   * every submitted finding is accounted for by at least one claim.
 *
 * Splitting one finding into several claims is allowed -- what is not allowed
 * is a finding no claim mentions, which is how a wrong finding disappears.
 * **Nothing here decides how to split one, and nothing here judges meaning.**
 * Those are the undecided rules, and this check exists so that whatever is
 * decided later is applied to all of the output rather than to a chosen part.
 */
export function verifyRecordAgainstObservation(
    observation: AiReviewJudgedObservation,
    record: AiReviewJudgementRecord
): readonly string[] {
    const problems: string[] = [];
    const covered = new Map<string, Set<number>>();

    for (const [index, claim] of record.claims.entries()) {
        const where = `claim[${index}] (${claim.targetLabel}/${claim.requirementId})`;
        if (claim.submittedAs === "prose") {
            if (claim.sourceIndex !== null) {
                problems.push(
                    `${where} was read from prose and carries sourceIndex ` +
                        `${claim.sourceIndex}, which indexes nothing`
                );
            }
            if (!observation.allText.includes(claim.evidenceQuote)) {
                problems.push(`${where} quotes a sentence this output does not contain`);
            }
            continue;
        }
        const items = observation.findings[claim.submittedAs] ?? [];
        if (
            claim.sourceIndex === null ||
            claim.sourceIndex < 0 ||
            claim.sourceIndex >= items.length
        ) {
            problems.push(
                `${where} points at ${claim.submittedAs}[${claim.sourceIndex}] and this ` +
                    `output has ${items.length} such finding(s)`
            );
            continue;
        }
        if (!items[claim.sourceIndex].includes(claim.evidenceQuote)) {
            problems.push(
                `${where} quotes a sentence ${claim.submittedAs}[${claim.sourceIndex}] ` +
                    `does not contain`
            );
        }
        if (!covered.has(claim.submittedAs)) covered.set(claim.submittedAs, new Set());
        covered.get(claim.submittedAs)?.add(claim.sourceIndex);
    }

    for (const kind of AI_REVIEW_EVAL_FINDING_KINDS) {
        const items = observation.findings[kind] ?? [];
        for (const [index] of items.entries()) {
            if (covered.get(kind)?.has(index)) continue;
            problems.push(
                `${kind}[${index}] of this output has no claim about it. A submitted ` +
                    `finding nobody judged is a wrong finding that disappears, so it is ` +
                    `left as a gap rather than passed over`
            );
        }
    }
    return problems;
}

// ---------------------------------------------------------------------------
// One entry point, for every caller
// ---------------------------------------------------------------------------

/** The run's journal, reduced to what a judged artifact has to be found in. */
export type AiReviewJudgedJournalEntry = {
    caseId?: string;
    observation?: unknown;
};

/** The frozen dataset, reduced to the same. */
export type AiReviewJudgedDatasetCase = {
    id?: string;
    responses?: readonly { label?: string }[];
};

export type AiReviewJudgedEvidence = {
    /** Everything wrong with the evidence, in the order it was checked. */
    problems: readonly string[];
    /**
     * Whether these files may be counted in a score or cited in a promotion.
     *
     * Separate from `problems` on purpose, and stricter than it. A correctly
     * recorded refusal is sound evidence -- of a refusal. Files that agree with
     * each other but were never checked against the run are sound evidence too
     * -- of agreement. Reading either as "usable" is how a case nobody
     * finished judging, or one from no run at all, reaches an aggregate as
     * though it had been measured.
     */
    eligibleForAggregation: boolean;
    /** Why not, when not. Empty when it is. */
    ineligibleReasons: readonly string[];
    /**
     * Whether the output and the case were checked against the run's journal
     * and the frozen dataset, or only against each other.
     */
    externalBinding: "checked" | "not checked";
};

/**
 * The whole judged-scoring check, in the order it has to happen.
 *
 * **The order lives here and nowhere else.** Two callers each remembering a
 * sequence is how the old evidence checks drifted: each pile checked what its
 * author remembered, and the gaps were the same shape every time. The CLI and
 * the evidence bundle call this; neither owns a copy.
 *
 *   1. shapes -- every input, including the journal and the dataset;
 *   2. the case's own registration;
 *   3. the record against the output it names;
 *   4. the record's identity and signatures;
 *   5. the score, recomputed and compared whole;
 *   6. the output and the case against the run's journal and the dataset,
 *      including the SOURCE case's question and answers.
 *
 * Step 6 is why file-to-file agreement is not enough. Three files can agree
 * perfectly and be about an output this run never produced, a case that is not
 * in the frozen set, or a case whose question has been rewritten since a
 * person judged it -- a consistent statement about nothing.
 */
export function verifyJudgedScoringEvidence(input: {
    testCase: unknown;
    observation: unknown;
    record: unknown;
    artifact: unknown;
    /**
     * The run's journal entries, and the frozen dataset, when the caller has
     * them. `undefined` means NOT SUPPLIED; anything else is checked, because
     * reading a broken file as an absent one is how a dataset holding `false`
     * skipped its own comparison and stayed countable.
     */
    journal?: unknown;
    dataset?: unknown;
}): AiReviewJudgedEvidence {
    const externalBinding =
        input.journal !== undefined && input.dataset !== undefined
            ? "checked"
            : "not checked";
    const shapes = [
        ...judgedCaseShapeProblems(input.testCase),
        ...observationShapeProblems(input.observation),
        ...judgementRecordShapeProblems(input.record),
        ...scoringArtifactShapeProblems(input.artifact),
        ...(input.journal === undefined ? [] : judgedJournalShapeProblems(input.journal)),
        ...(input.dataset === undefined ? [] : judgedDatasetShapeProblems(input.dataset)),
    ];
    if (shapes.length > 0) {
        return {
            problems: shapes,
            eligibleForAggregation: false,
            ineligibleReasons: ["the evidence files do not have the shape this contract reads"],
            externalBinding,
        };
    }

    const testCase = input.testCase as AiReviewJudgedCase;
    const observation = input.observation as AiReviewJudgedObservation;
    const record = input.record as AiReviewJudgementRecord;
    const artifact = input.artifact as AiReviewJudgedScoringArtifact;

    const problems = [
        ...validateJudgedCase(testCase),
        ...verifyRecordAgainstObservation(observation, record),
        ...verifyScoringArtifact({ testCase, record, observation, artifact }),
    ];

    // The output has to be the one this run recorded for this case, and the
    // case has to be the one the frozen set holds -- the same question and the
    // same answers, not merely the same id.
    if (input.journal !== undefined) {
        const entries = (input.journal as AiReviewJudgedJournalEntry[]).filter(
            (entry) => entry.caseId === testCase.caseId
        );
        if (entries.length === 0) {
            problems.push(
                `the run's journal has no entry for ${testCase.caseId}, so this output ` +
                    `is not one the run recorded`
            );
        } else if (
            !entries.some(
                (entry) => observationRefFor(entry.observation) === artifact.observationRef
            )
        ) {
            problems.push(
                `the journal's output for ${testCase.caseId} is not the one that was ` +
                    `judged and scored here`
            );
        }
    }
    if (input.dataset !== undefined) {
        const cases = (input.dataset as { cases: AiReviewJudgedDatasetCase[] }).cases;
        const datasetCase = cases.find((item) => item.id === testCase.caseId);
        if (!datasetCase) {
            problems.push(
                `the frozen dataset has no case ${testCase.caseId}, so nothing here is ` +
                    `about a case the run was measured on`
            );
        } else {
            const labels = (datasetCase.responses ?? []).map((response) => response.label);
            if (
                JSON.stringify([...labels].sort()) !==
                JSON.stringify([...testCase.responseLabels].sort())
            ) {
                problems.push(
                    `${testCase.caseId} has answers ${labels.join(", ")} in the dataset and ` +
                        `${testCase.responseLabels.join(", ")} here, so a gold item could ` +
                        `name an answer the run never showed`
                );
            }
            // And the substance. Same id, same labels, rewritten question is a
            // different case to a person, and an old judgement attached to it
            // is a judgement of text that is no longer there.
            if (testCase.sourceCaseDigest !== judgedSourceCaseDigest(datasetCase)) {
                problems.push(
                    `${testCase.caseId}'s question or answers are not the ones this ` +
                        `judgement was made from, so the judgement is about text the ` +
                        `dataset no longer holds`
                );
            }
        }
    }

    // Integrity and usefulness are different questions, and running them
    // together is how a refusal becomes a score.
    const ineligibleReasons: string[] = [];
    if (problems.length > 0) {
        ineligibleReasons.push("the evidence does not verify");
    }
    if (!artifact.outcome?.scored) {
        ineligibleReasons.push(
            "the case is not scored, which is a correctly recorded refusal and not a " +
                "result: counting it would report a case nobody finished judging as one " +
                "that was judged"
        );
    }
    // Checking a judgement before a run exists is allowed and useful. Calling
    // the result countable is not: files that agree with each other have been
    // shown to agree with each other, and an aggregate is about a run.
    if (externalBinding === "not checked") {
        ineligibleReasons.push(
            "the run's journal and the frozen dataset were not supplied, so these files " +
                "have been checked against each other and against no run"
        );
    }
    return {
        problems,
        eligibleForAggregation: ineligibleReasons.length === 0,
        ineligibleReasons,
        externalBinding,
    };
}
