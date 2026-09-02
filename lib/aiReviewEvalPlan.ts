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

// ---------------------------------------------------------------------------
// Drafting plan
// ---------------------------------------------------------------------------

/**
 * How many cases of each phenomenon a cell carries.
 *
 * docs/ops/ai-review-eval-runbook.md §1.2. Encoded here so the drafting plan
 * and the coverage report read one table rather than a person transcribing
 * the runbook's into a spreadsheet -- the balance is the part of the set that
 * decides what the evaluation can measure at all, and a cell that quietly ends
 * up all `direct_contradiction` measures one thing a hundred times.
 *
 * `prompt_injection` is deliberately absent: the runbook places it by cell
 * rather than per cell, and `injectionQuotaPerLanguage` below says where.
 */
export const CELL_PHENOMENON_MIX: Readonly<Record<string, number>> = {
    direct_contradiction: 20,
    partial_contradiction: 10,
    omission: 20,
    meaningful_difference: 10,
    unsupported_assertion: 10,
    genuine_consensus: 10,
    no_issue: 10,
    verbosity_bias: 5,
    position_bias: 5,
};

/**
 * Injection cases go in the safety-sensitive cell, at least this many per
 * language. Not spread across the cells: an embedded instruction can be
 * planted anywhere, but where it is dangerous is a safety question.
 */
export const INJECTION_QUOTA_PER_LANGUAGE = 20;

export type AiReviewDraftBatch = {
    language: string;
    taskType: string;
    phenomenon: string;
    mode: string;
    count: number;
};

/**
 * How many cases of a phenomenon each mode carries, in a given cell.
 *
 * ## Why this is derived from identity and not from a counter
 *
 * The first version walked the plan with a rotating cursor, which is fine for
 * a single pass and wrong for every pass after it: the cursor restarted at
 * zero each time the plan was recomputed, so an operator who drafted one batch
 * and re-planned got `balanced` again, and again. Running that loop to
 * completion produced 1,240 cases, all `balanced`, with `evidence` and
 * `action` empty and the plan reporting nothing left to do -- a set that
 * satisfies every cell floor and cannot measure two thirds of what it exists
 * to measure.
 *
 * So the target is a pure function of (language, taskType, phenomenon): the
 * count splits as evenly as three allows, and which mode receives a remainder
 * rotates by a stable index of that triple. Re-planning after any subset of
 * batches has run gives the same targets, so the plan converges instead of
 * drifting.
 */
export const modeTargets = (input: {
    language: string;
    taskType: string;
    phenomenon: string;
    count: number;
}): Readonly<Record<string, number>> => {
    const cellIndex = evalCoveragePlan().findIndex(
        (cell) => cell.language === input.language && cell.taskType === input.taskType
    );
    const phenomenonIndex = Object.keys({
        ...CELL_PHENOMENON_MIX,
        prompt_injection: 0,
    }).indexOf(input.phenomenon);
    const rotation =
        (Math.max(0, cellIndex) * 7 + Math.max(0, phenomenonIndex)) %
        AI_REVIEW_EVAL_MODES.length;

    const base = Math.floor(input.count / AI_REVIEW_EVAL_MODES.length);
    const remainder = input.count % AI_REVIEW_EVAL_MODES.length;
    const targets: Record<string, number> = {};
    for (const [index, mode] of AI_REVIEW_EVAL_MODES.entries()) {
        // The remainder goes to the modes starting at `rotation`, so across
        // the plan no single mode collects every leftover.
        const offset =
            (index - rotation + AI_REVIEW_EVAL_MODES.length) %
            AI_REVIEW_EVAL_MODES.length;
        targets[mode] = base + (offset < remainder ? 1 : 0);
    }
    return targets;
};

/** What a cell needs, by phenomenon, including the injection quota. */
const cellPhenomenonTargets = (taskType: string): Readonly<Record<string, number>> =>
    taskType === "safety_sensitive"
        ? { ...CELL_PHENOMENON_MIX, prompt_injection: INJECTION_QUOTA_PER_LANGUAGE }
        : CELL_PHENOMENON_MIX;

/**
 * The batches that fill a decision set from wherever it currently stands.
 *
 * Every batch is derived from a SHORTFALL against a fixed target -- the target
 * for (language, taskType, phenomenon, mode) -- so calling this again after
 * running some of the batches returns exactly the work that is left. Nothing
 * here carries state between calls, which is what makes the incremental loop
 * an operator actually runs converge on a balanced set.
 *
 * A batch is one phenomenon in one mode because that is what the drafting
 * instruction asks for. A batch mixing them would need the instruction to
 * describe several at once, and the rule that matters most -- plant exactly
 * one thing per case -- gets harder to hold the more it is asked to juggle.
 */
export const draftingBatches = (input: {
    existing: readonly Pick<
        AiReviewEvalCase,
        "language" | "taskType" | "phenomenon" | "mode"
    >[];
    /** Cases per drafting call. */
    batchSize: number;
}): readonly AiReviewDraftBatch[] => {
    const batches: AiReviewDraftBatch[] = [];

    for (const cell of evalCoveragePlan()) {
        for (const [phenomenon, target] of Object.entries(
            cellPhenomenonTargets(cell.taskType)
        )) {
            const targets = modeTargets({
                language: cell.language,
                taskType: cell.taskType,
                phenomenon,
                count: target,
            });
            for (const [mode, wanted] of Object.entries(targets)) {
                const have = input.existing.filter(
                    (item) =>
                        item.language === cell.language &&
                        item.taskType === cell.taskType &&
                        item.phenomenon === phenomenon &&
                        item.mode === mode
                ).length;
                let remaining = Math.max(0, wanted - have);
                while (remaining > 0) {
                    const count = Math.min(remaining, input.batchSize);
                    batches.push({
                        language: cell.language,
                        taskType: cell.taskType,
                        phenomenon,
                        mode,
                        count,
                    });
                    remaining -= count;
                }
            }
        }
    }
    return batches;
};

/**
 * What a plan costs at most, call by call.
 *
 * ## Why a single input estimate was not a ceiling
 *
 * The first version priced the whole plan at the length of its FIRST request,
 * and the request grows: every call is shown the questions already written for
 * its cell so it does not repeat them. Measured on the real instruction, the
 * input estimate went 685 tokens with nothing in the cell, 917 with ten
 * questions, 1,430 with fifty, 2,028 with ninety. Multiplying the first by the
 * call count understates the last ones by a factor of three, and a figure
 * called a ceiling that is not one is worse than no figure: it is what a
 * person approves a budget against.
 *
 * So the caller supplies the input estimate PER BATCH, having built each
 * instruction as it will actually be sent, and this sums them.
 */
export const draftingCostCeilingUsd = (input: {
    /** One entry per call: the input tokens that call will carry. */
    inputTokensPerCall: readonly number[];
    outputTokenCapPerCall: number;
    inputUsdPerMillionTokens: number;
    outputUsdPerMillionTokens: number;
}): number =>
    input.inputTokensPerCall.reduce(
        (total, inputTokens) =>
            total +
            (inputTokens / 1_000_000) * input.inputUsdPerMillionTokens +
            (input.outputTokenCapPerCall / 1_000_000) * input.outputUsdPerMillionTokens,
        0
    );

/**
 * The cost of one call, which is what a hard stop has to be able to check
 * before making it.
 */
export const draftingCallCostCeilingUsd = (input: {
    inputTokens: number;
    outputTokenCap: number;
    inputUsdPerMillionTokens: number;
    outputUsdPerMillionTokens: number;
}): number =>
    (input.inputTokens / 1_000_000) * input.inputUsdPerMillionTokens +
    (input.outputTokenCap / 1_000_000) * input.outputUsdPerMillionTokens;
