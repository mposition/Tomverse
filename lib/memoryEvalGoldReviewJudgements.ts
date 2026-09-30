/**
 * The review judgement every gold carries, and the register of the ones a
 * plain reading cannot fix.
 *
 * `mem-score-v3.3`, rule `v3-unfixable-evidence-not-a-gold`. A gold's evidence
 * quote can be a shape whose polarity nobody can settle -- a conditional, an
 * unresolved correction, a double negative -- and such a gold is not in a
 * decision set. This module is where that judgement lives.
 *
 * ## Not a classifier
 *
 * There is no keyword scan here and there must not be one. "Conditional",
 * "unresolved correction" and "double negative" name readings, not strings:
 * «if I move I will need a lift» is conditional and «I moved, so I need a
 * lift» is not, and the two differ by a word that a marker list would treat
 * the same. The same mistake was already made once and recorded --
 * `POLARITY_MARKERS` was a fixed diagnostic list that could not decide a
 * label, and `.github/audits/memory-eval-gold-contract-2026-08-27.md` §9.4
 * demoted it to a pointer for exactly that reason. A classifier here would
 * reintroduce it one layer up, where the answer is a freeze rather than a
 * score.
 *
 * So the judgement is a reviewer's, recorded per gold. The register below is
 * the only way a gold becomes `unfixable`.
 *
 * ## Separate from `goldEvidenceFailure()`
 *
 * That function proves three structural things: the anchor names a real
 * message, its role is `user`, and the quote is an exact span containing the
 * fact. It proves nothing about polarity -- which is how
 * `succ-assistant-en-306` passed it while anchored on the user quoting the
 * assistant's premise back. The judgement here is the separate check that
 * defect asked for, and neither stands in for the other.
 *
 * ## The register is empty, and that is a finding
 *
 * No `succ-4` gold is judged unfixable. Not because nothing was examined --
 * three anchors of exactly these shapes were found and *moved* rather than
 * judged unfixable: `succ-assistant-en-306` and `en-307` off the user
 * restating the assistant's premise, and `succ-assistant-ko-308` off
 * «전주가 아니라 정읍이에요» onto its plain clause. A resolved correction's
 * plain clause may anchor, so those golds are fixable and were fixed.
 *
 * An empty register is therefore a claim, not a default: every gold in the
 * decision set was looked at and none was left in an unreadable shape. If a
 * later reading finds one, it goes here and the freeze stops.
 */

export const MEMORY_EVAL_GOLD_REVIEW_JUDGEMENTS = [
    "affirmed",
    "negated",
    "unfixable",
] as const;

export type GoldReviewJudgement =
    (typeof MEMORY_EVAL_GOLD_REVIEW_JUDGEMENTS)[number];

/** The shapes rule `v3-unfixable-evidence-not-a-gold` names. */
export type UnfixableShape =
    | "conditional"
    | "unresolved-correction"
    | "double-negative"
    | "other";

export type UnfixableGold = {
    /** `caseId:goldId`. */
    key: string;
    shape: UnfixableShape;
    /** The reviewer's reason, in their words. */
    reason: string;
    auditRef: string;
};

/**
 * Golds a reviewer judged unfixable.
 *
 * Empty. See the module comment: this emptiness is a recorded finding about
 * `succ-4`, not an unexamined default, and adding the first entry is what
 * stops a freeze rather than something that needs a new mechanism.
 */
export const MEMORY_EVAL_UNFIXABLE_GOLDS: readonly UnfixableGold[] = [];

export type GoldReviewCoverage = {
    judgements: ReadonlyMap<string, GoldReviewJudgement>;
    /** Golds in the set with no judgement at all. */
    unjudged: readonly string[];
    /** Golds a source judged twice, with different answers. */
    conflicting: readonly string[];
    /** Register entries naming a gold the set does not contain. */
    unknownUnfixable: readonly string[];
    /** Unfixable golds that are nonetheless in the decision set. */
    unfixableInDecisionSet: readonly string[];
};

/**
 * Every gold's judgement, and every way the record can be wrong.
 *
 * Pure: the caller supplies the golds and the polarity each one was labelled
 * with, so this can be tested against a set that is deliberately incomplete.
 * A coverage check only ever run over the corpus that happens to be complete
 * says nothing about the one that is not.
 *
 * `polarityByKey` is the labelling already recorded -- readings, batches and
 * the replacements' own `polarity` field. The register overrides it, because a
 * gold whose evidence cannot be read has no polarity to have been right about.
 * An override is reported when the two disagree only in the sense that the
 * register wins; a gold in the register *and* labelled is the normal case, not
 * a conflict.
 */
export function goldReviewCoverage(input: {
    /** Every gold in the decision set, as `caseId:goldId`. */
    decisionSetGoldKeys: readonly string[];
    /** What each gold was labelled, from the review records. */
    polarityByKey: ReadonlyMap<string, string>;
    /** Every gold that exists at all, decision set or not. */
    knownGoldKeys?: readonly string[];
    register?: readonly UnfixableGold[];
}): GoldReviewCoverage {
    const {
        decisionSetGoldKeys,
        polarityByKey,
        knownGoldKeys = decisionSetGoldKeys,
        register = MEMORY_EVAL_UNFIXABLE_GOLDS,
    } = input;

    const known = new Set(knownGoldKeys);
    const decisionSet = new Set(decisionSetGoldKeys);
    const unfixable = new Map(register.map((entry) => [entry.key, entry]));

    const judgements = new Map<string, GoldReviewJudgement>();
    const unjudged: string[] = [];
    const conflicting: string[] = [];

    for (const key of decisionSetGoldKeys) {
        if (unfixable.has(key)) {
            judgements.set(key, "unfixable");
            continue;
        }
        const polarity = polarityByKey.get(key);
        if (polarity === "affirmed" || polarity === "negated") {
            judgements.set(key, polarity);
            continue;
        }
        if (polarity === undefined) {
            unjudged.push(key);
            continue;
        }
        // A label that is neither polarity nor a register entry is a third
        // answer nobody defined, and treating it as one of the two would be
        // the coverage check inventing the judgement it exists to read.
        conflicting.push(`${key} is labelled "${polarity}"`);
    }

    const duplicates = new Set<string>();
    const seen = new Set<string>();
    for (const entry of register) {
        if (seen.has(entry.key)) duplicates.add(entry.key);
        seen.add(entry.key);
    }
    for (const key of duplicates) {
        conflicting.push(`${key} is in the unfixable register twice`);
    }

    return {
        judgements,
        unjudged,
        conflicting,
        unknownUnfixable: register
            .map((entry) => entry.key)
            .filter((key) => !known.has(key)),
        unfixableInDecisionSet: register
            .map((entry) => entry.key)
            .filter((key) => decisionSet.has(key)),
    };
}

/** The freeze-blocking failures, as lines. Empty means the rule is satisfied. */
export function goldReviewFailures(
    coverage: GoldReviewCoverage
): readonly string[] {
    const failures: string[] = [];
    if (coverage.unjudged.length > 0) {
        failures.push(
            `${coverage.unjudged.length} gold(s) with no review judgement: ` +
                coverage.unjudged.slice(0, 5).join(", ")
        );
    }
    if (coverage.conflicting.length > 0) {
        failures.push(
            `${coverage.conflicting.length} gold(s) judged more than one way: ` +
                coverage.conflicting.slice(0, 5).join("; ")
        );
    }
    if (coverage.unknownUnfixable.length > 0) {
        failures.push(
            `the unfixable register names ${coverage.unknownUnfixable.length} gold(s) that do not exist: ` +
                coverage.unknownUnfixable.slice(0, 5).join(", ")
        );
    }
    if (coverage.unfixableInDecisionSet.length > 0) {
        failures.push(
            `${coverage.unfixableInDecisionSet.length} gold(s) judged unfixable are in the decision set: ` +
                coverage.unfixableInDecisionSet.slice(0, 5).join(", ")
        );
    }
    return failures;
}
