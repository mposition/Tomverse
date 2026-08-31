/**
 * What the decision set has to contain, what a partial set still needs, and
 * the arithmetic that counts it.
 *
 * docs/policy/ai-review-m5-quality-contract.md §4.
 *
 * ## Why this exists
 *
 * "Write 1,200 cases" was being reported as human work in its entirety, and
 * that is not how this repository divides labour. A person's part of an
 * evaluation set is the part only a person can do: deciding that a planted
 * contradiction really is one, judging blind, freezing, approving, signing.
 * Counting cells, finding the gap, spotting near-duplicates and checking that
 * an exhaustive-gold claim is even plausible are arithmetic, and arithmetic
 * handed to a person is a set that never gets built -- or gets built with a
 * cell quietly at 40.
 *
 * So this module answers three questions with no judgement in any of them:
 *
 *   1. what does the set need (`evalCoveragePlan`);
 *   2. what does it have and what is missing (`coverageGap`);
 *   3. what is in it, cell by cell (`datasetManifest`).
 *
 * Nothing here writes a gold, adopts a case, or decides that a set is ready.
 */

import {
    AI_REVIEW_EVAL_LANGUAGES,
    AI_REVIEW_EVAL_MIN_CASES,
    AI_REVIEW_EVAL_MODES,
    AI_REVIEW_EVAL_PHENOMENA,
    AI_REVIEW_EVAL_TASK_TYPES,
    type AiReviewEvalCase,
} from "@/lib/aiReviewEvalCore";

export type AiReviewEvalCell = {
    language: string;
    taskType: string;
    /** How many cases this cell needs. */
    required: number;
};

/**
 * The cells of the decision set and their floors.
 *
 * Derived from the axes and the floors, never written out as a list: a second
 * copy of "twelve cells of one hundred" is a copy that can disagree with the
 * adequacy check the runner applies.
 */
export const evalCoveragePlan = (): readonly AiReviewEvalCell[] =>
    AI_REVIEW_EVAL_LANGUAGES.flatMap((language) =>
        AI_REVIEW_EVAL_TASK_TYPES.map((taskType) => ({
            language,
            taskType,
            required: AI_REVIEW_EVAL_MIN_CASES.perLanguageTaskTypeCell,
        }))
    );

export type AiReviewEvalCellGap = AiReviewEvalCell & {
    present: number;
    missing: number;
};

export type AiReviewEvalCoverageGap = {
    cells: readonly AiReviewEvalCellGap[];
    /** Total cases still to be written, summed over the cells. */
    missingCases: number;
    /** Modes below their own floor, which cuts across the cells. */
    modeShortfalls: readonly { mode: string; present: number; required: number }[];
    /**
     * Phenomena with no case at all. Not a floor -- the contract sets no
     * per-phenomenon count -- but a phenomenon nothing plants is a phenomenon
     * the evaluation cannot say anything about, and that is worth naming
     * before the set is frozen rather than after.
     */
    unplantedPhenomena: readonly string[];
};

export const coverageGap = (
    cases: readonly Pick<
        AiReviewEvalCase,
        "language" | "taskType" | "mode" | "phenomenon"
    >[]
): AiReviewEvalCoverageGap => {
    const cells = evalCoveragePlan().map((cell) => {
        const present = cases.filter(
            (item) =>
                item.language === cell.language && item.taskType === cell.taskType
        ).length;
        return { ...cell, present, missing: Math.max(0, cell.required - present) };
    });
    const modeShortfalls = AI_REVIEW_EVAL_MODES.map((mode) => ({
        mode,
        present: cases.filter((item) => item.mode === mode).length,
        required: AI_REVIEW_EVAL_MIN_CASES.perMode,
    })).filter((entry) => entry.present < entry.required);
    const unplantedPhenomena = AI_REVIEW_EVAL_PHENOMENA.filter(
        (phenomenon) => !cases.some((item) => item.phenomenon === phenomenon)
    );
    return {
        cells,
        missingCases: cells.reduce((sum, cell) => sum + cell.missing, 0),
        modeShortfalls,
        unplantedPhenomena,
    };
};

/**
 * Two cases whose question is the same once whitespace, case and punctuation
 * are set aside.
 *
 * Reported, not removed. A repeated question can be deliberate -- the same ask
 * under two modes is a real comparison -- and a tool that deleted one would be
 * making a judgement about the set. What it must not do is stay silent: a
 * cell filled to a hundred by paraphrase measures one question a hundred
 * times, and that is indistinguishable from a full cell in every count above.
 */
export const duplicateQuestions = (
    cases: readonly Pick<AiReviewEvalCase, "id" | "question" | "mode">[]
): readonly { normalised: string; ids: readonly string[] }[] => {
    const groups = new Map<string, string[]>();
    for (const testCase of cases) {
        const key = testCase.question
            .toLowerCase()
            .replace(/[^\p{L}\p{N}]+/gu, " ")
            .trim();
        const group = groups.get(key);
        if (group) group.push(testCase.id);
        else groups.set(key, [testCase.id]);
    }
    return [...groups.entries()]
        .filter(([, ids]) => ids.length > 1)
        .map(([normalised, ids]) => ({ normalised, ids }));
};

/**
 * Cases claiming an exhaustive gold that plants nothing of that kind.
 *
 * `goldCompleteness.contradictions === true` with an empty contradictions gold
 * says "a fair reviewer could find no contradiction here at all". That is a
 * legitimate and useful case -- it is how false positives get measured -- but
 * it is also exactly what an author writes by accident when they set the flag
 * before writing the gold. The two cannot be told apart from the file, so this
 * lists them for a person to confirm rather than deciding either way.
 */
export const emptyExhaustiveClaims = (
    cases: readonly Pick<AiReviewEvalCase, "id" | "gold" | "goldCompleteness">[]
): readonly { id: string; kind: string }[] => {
    const found: { id: string; kind: string }[] = [];
    for (const testCase of cases) {
        for (const [kind, exhaustive] of Object.entries(
            testCase.goldCompleteness ?? {}
        )) {
            if (!exhaustive) continue;
            const planted = testCase.gold?.[kind as keyof typeof testCase.gold];
            if (!planted || planted.length === 0) {
                found.push({ id: testCase.id, kind });
            }
        }
    }
    return found;
};

export type AiReviewEvalManifest = {
    cases: number;
    byCell: readonly AiReviewEvalCellGap[];
    byMode: Readonly<Record<string, number>>;
    byPhenomenon: Readonly<Record<string, number>>;
    /** Per finding kind: how many cases claim an exhaustive gold for it. */
    exhaustiveGoldCases: Readonly<Record<string, number>>;
    gap: AiReviewEvalCoverageGap;
    duplicates: readonly { normalised: string; ids: readonly string[] }[];
    emptyExhaustiveClaims: readonly { id: string; kind: string }[];
};

/**
 * Everything countable about a set, in one object.
 *
 * The answer key a person needs beside a blind sheet, and the thing a reviewer
 * of the set reads before deciding whether it is worth freezing.
 */
export const datasetManifest = (
    cases: readonly AiReviewEvalCase[]
): AiReviewEvalManifest => {
    const tally = (key: (item: AiReviewEvalCase) => string) => {
        const counts: Record<string, number> = {};
        for (const item of cases) counts[key(item)] = (counts[key(item)] ?? 0) + 1;
        return counts;
    };
    const exhaustiveGoldCases: Record<string, number> = {};
    for (const testCase of cases) {
        for (const [kind, exhaustive] of Object.entries(
            testCase.goldCompleteness ?? {}
        )) {
            if (exhaustive) {
                exhaustiveGoldCases[kind] = (exhaustiveGoldCases[kind] ?? 0) + 1;
            }
        }
    }
    const gap = coverageGap(cases);
    return {
        cases: cases.length,
        byCell: gap.cells,
        byMode: tally((item) => item.mode),
        byPhenomenon: tally((item) => item.phenomenon),
        exhaustiveGoldCases,
        gap,
        duplicates: duplicateQuestions(cases),
        emptyExhaustiveClaims: emptyExhaustiveClaims(cases),
    };
};
