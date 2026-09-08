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
    // The case's own registration first, then the record. A gold naming a
    // requirement the case never registered produces a miss nothing can
    // satisfy, and it would be recorded against the reviewer -- so a caller
    // cannot skip it, for the same reason it cannot skip the record check.
    const problems = [
        ...validateJudgedCase(testCase),
        ...verifyJudgementRecord(testCase, record, expected),
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
    observation: unknown;
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
        outcome: scoreJudgedCase(input.testCase, input.record, { observationRef }),
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
    observation: unknown;
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
    return problems;
}
