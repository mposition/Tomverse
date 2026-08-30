/**
 * Reading back what a reviewer wrote, and refusing what cannot be read.
 *
 * ## Why this is stricter than the model judge's parser
 *
 * `readVerdict` in lib/routerJudgeRubric.ts scans a model's reply for a
 * verdict word, because a model asked for one word sometimes writes a
 * sentence. A person filling in a sheet is a different case: "not FIRST,
 * SECOND" and "FIRST or maybe EQUIVALENT" both contain a verdict word and
 * neither is a verdict. So a submission line has to hold exactly one, and
 * anything else is a parse failure a person resolves -- not a guess this
 * module makes on their behalf.
 *
 * ## What this module does not do
 *
 * It does not decide anything about the answers. It reads positional verdicts
 * -- FIRST, SECOND, EQUIVALENT -- and only `resolveToArms` turns those into
 * statements about Auto and the baseline, using the key that the reviewer
 * never saw. Adjudicating a split between two reviewers is a separate step
 * again.
 *
 * ## Structural failures are reported, never acted on
 *
 * A missing or unreadable line is reported in the vocabulary
 * lib/routerHumanReviewSample.ts accepts for a substitution. It is not turned
 * into one here. Spending a reserve is a person's decision with a recorded
 * reason, and a module that spent them automatically would be a module that
 * quietly dropped every pair two reviewers found hard to answer.
 */

import type { PositionalVerdict } from "./routerJudgeRubric";
import { JUDGE_VERDICT_WORDS } from "./routerJudgeRubric";
import type { StructuralSubstitutionReason } from "./routerHumanReviewSample";
import type { ReviewSheet, SheetKeyRow } from "./routerHumanReviewSheet";

export const HUMAN_SUBMISSION_VERSION = "router-human-review-submission-v1";

export type SubmittedVerdict = {
    itemId: string;
    verdict: PositionalVerdict;
    /** Free text the reviewer added. Recorded, never parsed for a verdict. */
    note?: string;
};

export type Submission = {
    submissionVersion: typeof HUMAN_SUBMISSION_VERSION;
    reviewerId: string;
    populationDigest: string;
    submittedAt: string;
    verdicts: readonly SubmittedVerdict[];
};

/** An item the reviewer left in a state nobody can grade from. */
export type StructuralFailure = {
    reviewerId: string;
    itemId: string;
    reason: Extract<StructuralSubstitutionReason, "missing_output" | "parse_failure">;
    detail: string;
};

const VERDICT_BY_WORD = new Map<string, PositionalVerdict>([
    ["FIRST", "first"],
    ["SECOND", "second"],
    ["EQUIVALENT", "equivalent"],
]);

/**
 * The verdict on one line, or why there isn't one.
 *
 * Exactly one verdict word, as a whole word. Two words is not a verdict and
 * neither is none, and both are said rather than resolved.
 */
export const readSheetVerdict = (
    text: string | null | undefined
): { verdict: PositionalVerdict } | { problem: string } => {
    const words = (text ?? "").toUpperCase().split(/[^A-Z]+/).filter(Boolean);
    const found = [...new Set(words.filter((word) => VERDICT_BY_WORD.has(word)))];
    if (found.length === 0) {
        return { problem: `"${(text ?? "").trim()}" holds none of ${JUDGE_VERDICT_WORDS.join(", ")}` };
    }
    if (found.length > 1) {
        return { problem: `"${(text ?? "").trim()}" holds ${found.join(" and ")}, so it is not one verdict` };
    }
    return { verdict: VERDICT_BY_WORD.get(found[0]) as PositionalVerdict };
};

/**
 * Read a filled-in markdown sheet back.
 *
 * The line the sheet asks for is "`<itemId>`: VERDICT". Anything else on the
 * page is ignored -- the reviewer is reading a document, not filling in a
 * form, and the rubric and the answers are all around the answer lines.
 */
export const parseSubmissionMarkdown = (input: {
    text: string;
    reviewerId: string;
    populationDigest: string;
    submittedAt: string;
}): { submission: Submission; unreadable: readonly { itemId: string; detail: string }[] } => {
    const verdicts: SubmittedVerdict[] = [];
    const unreadable: { itemId: string; detail: string }[] = [];
    const seen = new Set<string>();
    for (const line of input.text.split(/\r?\n/)) {
        const match = /^`([0-9a-f]{12})`\s*:\s*(.*)$/.exec(line.trim());
        if (!match) continue;
        const [, itemId, answer] = match;
        // A blank line is the sheet's own underscore rule, untouched. That is
        // an unanswered item, not a malformed one.
        const written = answer.replace(/[_\s]/g, "") === "" ? "" : answer;
        if (seen.has(itemId)) {
            unreadable.push({ itemId, detail: "the sheet was answered twice for this item" });
            continue;
        }
        seen.add(itemId);
        if (written === "") continue;
        const read = readSheetVerdict(written);
        if ("problem" in read) {
            unreadable.push({ itemId, detail: read.problem });
            continue;
        }
        verdicts.push({ itemId, verdict: read.verdict });
    }
    return {
        submission: {
            submissionVersion: HUMAN_SUBMISSION_VERSION,
            reviewerId: input.reviewerId,
            populationDigest: input.populationDigest,
            submittedAt: input.submittedAt,
            verdicts,
        },
        unreadable,
    };
};

/**
 * Why a submission cannot be used at all. Empty means it can.
 *
 * These are failures of the file, not of the reviewer: a submission against
 * the wrong sheet, or naming items that were never on it, is not evidence
 * about anything and cannot be repaired by asking one more question.
 */
export const submissionProblems = (
    submission: Submission,
    sheet: ReviewSheet
): readonly string[] => {
    const problems: string[] = [];
    if (submission.submissionVersion !== HUMAN_SUBMISSION_VERSION) {
        problems.push(`submission version ${String(submission.submissionVersion)} is not ${HUMAN_SUBMISSION_VERSION}`);
    }
    if (submission.reviewerId !== sheet.reviewerId) {
        problems.push(`the submission is from ${submission.reviewerId}, but this is ${sheet.reviewerId}'s sheet`);
    }
    if (submission.populationDigest !== sheet.populationDigest) {
        problems.push("the submission was made against a different population than this sheet");
    }
    for (const field of ["submittedAt"] as const) {
        if (typeof submission[field] !== "string" || submission[field] === "") {
            problems.push(`the submission has no ${field}`);
        }
    }
    const onSheet = new Set(sheet.items.map((item) => item.itemId));
    const counted = new Map<string, number>();
    for (const entry of submission.verdicts) {
        counted.set(entry.itemId, (counted.get(entry.itemId) ?? 0) + 1);
        if (!onSheet.has(entry.itemId)) {
            problems.push(`${entry.itemId} was never on this sheet`);
        }
    }
    for (const [itemId, count] of counted) {
        if (count > 1) problems.push(`${itemId} was answered ${count} times`);
    }
    return problems;
};

/**
 * The items this reviewer left ungradable, in the sample module's vocabulary.
 *
 * Returned rather than applied: see the note at the top of this file.
 */
export const structuralFailures = (
    submission: Submission,
    sheet: ReviewSheet,
    unreadable: readonly { itemId: string; detail: string }[] = []
): readonly StructuralFailure[] => {
    const answered = new Set(submission.verdicts.map((entry) => entry.itemId));
    const failed = new Map<string, StructuralFailure>();
    for (const entry of unreadable) {
        if (!sheet.items.some((item) => item.itemId === entry.itemId)) continue;
        failed.set(entry.itemId, {
            reviewerId: sheet.reviewerId,
            itemId: entry.itemId,
            reason: "parse_failure",
            detail: entry.detail,
        });
    }
    for (const item of sheet.items) {
        if (answered.has(item.itemId) || failed.has(item.itemId)) continue;
        failed.set(item.itemId, {
            reviewerId: sheet.reviewerId,
            itemId: item.itemId,
            reason: "missing_output",
            detail: "the sheet was returned with no verdict for this item",
        });
    }
    return [...failed.values()].sort((left, right) => (left.itemId < right.itemId ? -1 : 1));
};

/**
 * Pairs that no reviewer could grade, as candidates for a reserve.
 *
 * Candidates, not substitutions. One reviewer skipping an item is a reviewer
 * to go back to, not a pair to replace, so only a pair every reviewer left
 * ungradable appears here -- and even then a person records the reason and
 * spends the reserve. Nothing in this module writes a manifest.
 */
export const unreviewablePairs = (
    failures: readonly StructuralFailure[],
    key: readonly SheetKeyRow[],
    reviewerIds: readonly string[]
): readonly { pairId: string; reason: StructuralSubstitutionReason; detail: string }[] => {
    const pairIdOf = new Map(key.map((row) => [`${row.reviewerId}/${row.itemId}`, row.pairId]));
    const byPairId = new Map<string, StructuralFailure[]>();
    for (const failure of failures) {
        const pairId = pairIdOf.get(`${failure.reviewerId}/${failure.itemId}`);
        if (!pairId) continue;
        byPairId.set(pairId, [...(byPairId.get(pairId) ?? []), failure]);
    }
    const wanted = new Set(reviewerIds);
    return [...byPairId.entries()]
        .filter(([, entries]) => new Set(entries.map((entry) => entry.reviewerId)).size === wanted.size)
        .map(([pairId, entries]) => ({
            pairId,
            reason: (entries.every((entry) => entry.reason === "parse_failure")
                ? "parse_failure"
                : "missing_output") as StructuralSubstitutionReason,
            detail: entries.map((entry) => `${entry.reviewerId}: ${entry.detail}`).join("; "),
        }))
        .sort((left, right) => (left.pairId < right.pairId ? -1 : 1));
};

/** What a positional verdict says about the arms, once the key is applied. */
export type ArmVerdict = {
    pairId: string;
    reviewerId: string;
    /** The same vocabulary the model judges record, so the two can be compared. */
    verdict: "auto" | "baseline" | "equivalent";
};

/**
 * Turn positional verdicts into statements about the arms.
 *
 * Separate from reading the submission, and deliberately the only place the
 * key is used: up to this point nothing in the pipeline knows which side was
 * Auto, which is what makes "the reviewer did not know either" checkable
 * rather than asserted.
 */
export const resolveToArms = (
    submission: Submission,
    key: readonly SheetKeyRow[]
): readonly ArmVerdict[] => {
    const rows = new Map(
        key
            .filter((row) => row.reviewerId === submission.reviewerId)
            .map((row) => [row.itemId, row])
    );
    const resolved: ArmVerdict[] = [];
    for (const entry of submission.verdicts) {
        const row = rows.get(entry.itemId);
        if (!row) continue;
        resolved.push({
            pairId: row.pairId,
            reviewerId: submission.reviewerId,
            verdict:
                entry.verdict === "equivalent"
                    ? "equivalent"
                    : entry.verdict === "first"
                      ? row.aArm
                      : row.bArm,
        });
    }
    return resolved;
};

/** How a reviewer's verdicts fell. Reported for a person to look at, never enforced. */
export const verdictDistribution = (
    verdicts: readonly SubmittedVerdict[]
): { first: number; second: number; equivalent: number } => ({
    first: verdicts.filter((entry) => entry.verdict === "first").length,
    second: verdicts.filter((entry) => entry.verdict === "second").length,
    equivalent: verdicts.filter((entry) => entry.verdict === "equivalent").length,
});
