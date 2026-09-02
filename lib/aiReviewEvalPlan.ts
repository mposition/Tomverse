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
import { estimatePromptTokens } from "@/lib/chatTokenEstimate";
import { DRAFT_MIN_RESPONSE_CHARACTERS } from "@/lib/aiReviewEvalDraftPrompt";

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

/**
 * The response label each gold item names FIRST, counted.
 *
 * The first drafted batch put the odd answer out in slot `c` seven times out of
 * seven. Nothing in those files is wrong -- each case is a clean contradiction
 * and each gold is right -- but a set built entirely that way measures
 * something else than it means to: a reviewer that always accuses the last
 * answer scores perfect recall on it, and a reviewer that reads scores the
 * same. Position becomes a confound, and it only shows up when you count.
 *
 * Deliberately narrow. A gold item's prose names several labels -- "c
 * contradicts a and b" -- so counting every mention says nothing, and the whole
 * text cannot be parsed for intent without inventing confidence. What is read
 * here is one thing: the first label token in the item's first phrasing, which
 * is where a drafter puts the answer it is accusing. That is a heuristic, and
 * the name says so; an item whose leading phrase names no label is counted as
 * `unattributed` rather than guessed at.
 *
 * A count, not a rule, and a report rather than a gate. There is no correct
 * distribution to enforce: a two-response case has no third slot, and a
 * `genuine_consensus` case plants nothing at all. Concentration is what is
 * worth seeing, and a person decides whether it is too high.
 *
 * Label boundaries are ASCII-only on purpose. Korean gold writes `c는`, and a
 * Unicode letter boundary would refuse to see the `c` there -- which is how an
 * earlier version of this counter reported a distribution that was not the
 * one in the file.
 */
export const goldLeadLabels = (
    cases: readonly Pick<AiReviewEvalCase, "id" | "gold" | "responses">[]
): { readonly byLabel: Readonly<Record<string, number>>; readonly attributed: number } => {
    const byLabel: Record<string, number> = {};
    let attributed = 0;
    for (const testCase of cases) {
        const labels = (testCase.responses ?? [])
            .map((response) => response.label)
            .filter((label): label is string => typeof label === "string");
        for (const items of Object.values(testCase.gold ?? {})) {
            for (const item of items ?? []) {
                const lead =
                    (Array.isArray(item?.anyOf) ? item.anyOf[0] : undefined) ??
                    item?.description ??
                    "";
                let bestLabel: string | null = null;
                let bestIndex = Number.POSITIVE_INFINITY;
                for (const label of labels) {
                    // Escaped, because a label is data. A case whose label is
                    // `[` would otherwise throw here and take the whole report
                    // down -- a counter that cannot survive its own input is
                    // not a counter. `datasetProblems()` refuses such a label
                    // too, but this must hold for a file nobody has validated.
                    const match = new RegExp(
                        `(^|[^A-Za-z0-9])${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^A-Za-z0-9]|$)`
                    ).exec(lead);
                    if (match && match.index < bestIndex) {
                        bestIndex = match.index;
                        bestLabel = label;
                    }
                }
                if (bestLabel) {
                    byLabel[bestLabel] = (byLabel[bestLabel] ?? 0) + 1;
                    attributed += 1;
                } else {
                    byLabel.unattributed = (byLabel.unattributed ?? 0) + 1;
                }
            }
        }
    }
    return { byLabel, attributed };
};

/**
 * How long the answers are.
 *
 * The first paid batch averaged 108 characters, between 81 and 133. Each case
 * was well formed and the set would have been useless: a reviewer comparing
 * two-sentence stubs has nowhere for an omission to hide and nothing for a
 * contradiction to be buried in, so what gets measured is not what the product
 * does. The runbook asks for the length a real assistant produces, and
 * `DRAFT_MIN_RESPONSE_CHARACTERS` now enforces a floor on new drafting -- but
 * a floor says nothing about the shape above it, and a cell can still fill up
 * with answers sitting exactly on it.
 *
 * Characters, not tokens: the floor is stated in characters and a reader
 * checking one case by eye counts characters.
 */
export const responseLengths = (
    cases: readonly Pick<AiReviewEvalCase, "responses">[]
): {
    readonly count: number;
    readonly min: number;
    readonly median: number;
    readonly mean: number;
    readonly max: number;
    readonly belowFloor: number;
} => {
    const lengths = cases
        .flatMap((testCase) => testCase.responses ?? [])
        .map((response) => (response?.content ?? "").trim().length)
        .sort((left, right) => left - right);
    if (lengths.length === 0) {
        return { count: 0, min: 0, median: 0, mean: 0, max: 0, belowFloor: 0 };
    }
    const middle = Math.floor(lengths.length / 2);
    return {
        count: lengths.length,
        min: lengths[0],
        median:
            lengths.length % 2 === 1
                ? lengths[middle]
                : Math.round((lengths[middle - 1] + lengths[middle]) / 2),
        mean: Math.round(lengths.reduce((total, value) => total + value, 0) / lengths.length),
        max: lengths[lengths.length - 1],
        belowFloor: lengths.filter((value) => value < DRAFT_MIN_RESPONSE_CHARACTERS).length,
    };
};

/**
 * Where the fault was ASSIGNED, and where the gold's prose appears to accuse.
 *
 * These were one number and should never have been. `goldLeadLabels()` reads
 * the label a gold item names first, which worked while the drafter wrote
 * "c는 즉시 대피하지 말라고 한다" -- and stopped the moment v4's gold began
 * quoting the offending phrase instead ("30분 정도 조용히 관찰"). The report
 * then said `unattributed: 5` for a batch whose five cases each carried a
 * correct `targetLabel`, which reads as "the assignment did not happen" when
 * what happened is that the heuristic had nothing to read.
 *
 * So the assignment is reported from the record that actually holds it --
 * `draftedBy.targetLabel`, written by the drafter from `assignTargetLabels()`
 * -- and the prose heuristic is reported beside it as a second, weaker
 * observation. The two answer different questions:
 *
 *   * assigned: was the position spread, or is the set building a confound?
 *   * realized: does the gold, read as text, point at the same answer?
 *
 * A disagreement is worth a person's attention -- the gold may be accusing an
 * answer that was not the assigned one -- and so is a gold nothing can be read
 * from, but neither is a defect the way a silent `unattributed` implied one.
 */
export const plantedLabelReport = (
    cases: readonly (Pick<AiReviewEvalCase, "id" | "gold" | "responses"> & {
        draftedBy?: { targetLabel?: string | null } | null;
    })[]
): {
    readonly assigned: Readonly<Record<string, number>>;
    readonly realized: Readonly<Record<string, number>>;
    readonly disagreements: readonly { id: string; assigned: string; realized: string }[];
} => {
    const assigned: Record<string, number> = {};
    const disagreements: { id: string; assigned: string; realized: string }[] = [];
    for (const testCase of cases) {
        const target = testCase.draftedBy?.targetLabel ?? null;
        // A case with no drafting record, or one whose phenomenon plants
        // nothing, is not "assigned to nowhere" -- it was never in the
        // question. Counted apart so it cannot look like a spread.
        const key = target ?? "not assigned";
        assigned[key] = (assigned[key] ?? 0) + 1;
        if (target === null) continue;
        const lead = goldLeadLabels([testCase]);
        for (const [label, count] of Object.entries(lead.byLabel)) {
            if (count > 0 && label !== "unattributed" && label !== target) {
                disagreements.push({ id: testCase.id, assigned: target, realized: label });
            }
        }
    }
    return { assigned, realized: goldLeadLabels(cases).byLabel, disagreements };
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
    /** The label each gold item names first, counted. A heuristic; see goldLeadLabels(). */
    goldLeadLabels: { readonly byLabel: Readonly<Record<string, number>>; readonly attributed: number };
    /** Where the fault was assigned, and where the gold appears to accuse. */
    plantedLabels: ReturnType<typeof plantedLabelReport>;
    /** Answer length in characters, against the drafting floor. */
    responseLengths: ReturnType<typeof responseLengths>;
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
        goldLeadLabels: goldLeadLabels(cases),
        plantedLabels: plantedLabelReport(cases),
        responseLengths: responseLengths(cases),
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
 * The output cap for a batch, sized to what that batch was asked to write.
 *
 * A flat 12,000 was two wrong things at once. For the small batches -- and
 * most are small, because a batch belongs to one (cell, phenomenon, mode) and
 * the plan averages under four cases per call -- it charged a ceiling four
 * times what the call could produce. For a full batch at v3's answer length it
 * was under what the call NEEDS: measured on the pilot's own Korean answers at
 * 1.143 tokens per character, seven cases of three ~500-character answers plus
 * their questions, gold and notes come to about 17,200 output tokens. The
 * reply would have been truncated mid-JSON and the call billed for nothing --
 * the same way the length floor took the first v3 batch, one step later.
 *
 * So the cap is per case with a fixed allowance for the envelope, and the
 * ceiling that is checked against the approved total moves with it.
 *
 * 3,500 sizes it for the TOP of v4's band, not its middle: three answers of
 * 600 characters plus the question, gold and notes come to about 2,450
 * characters, ~2,800 tokens at the measured Korean density, and the gold gets
 * longer as the answers do. A cap that is occasionally generous costs a
 * slightly high reservation; one that is occasionally tight costs the whole
 * call, which has now happened once and been avoided once.
 *
 * The 1.143 comes from this repository's own estimator, which its comments say
 * overstates Korean by roughly 110% against o200k. Left overstated on purpose:
 * this number decides whether a reply fits, and the failure it prevents is
 * expensive while the cost of being wrong the other way is a reservation a
 * little larger than it needed to be.
 */
export const DRAFTING_OUTPUT_TOKENS_PER_CASE = 3_500;

/** The envelope: the JSON around the cases, whatever their number. */
export const DRAFTING_OUTPUT_TOKENS_FIXED = 500;

export const draftingOutputTokenCap = (count: number): number =>
    DRAFTING_OUTPUT_TOKENS_FIXED + DRAFTING_OUTPUT_TOKENS_PER_CASE * count;

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
    /**
     * One entry per call: the input tokens it carries and the output cap it
     * runs under. Both vary per call -- the input grows as a cell fills, and
     * the cap is sized to the batch -- so neither can be a single figure for
     * the whole plan.
     */
    perCall: readonly { inputTokens: number; outputTokenCap: number }[];
    inputUsdPerMillionTokens: number;
    outputUsdPerMillionTokens: number;
}): number =>
    input.perCall.reduce(
        (total, call) =>
            total +
            (call.inputTokens / 1_000_000) * input.inputUsdPerMillionTokens +
            (call.outputTokenCap / 1_000_000) * input.outputUsdPerMillionTokens,
        0
    );

/**
 * Tokens the chat envelope adds around the instruction itself.
 *
 * The request is one user message in a `messages` array plus the reply
 * priming, none of which is in the instruction text. Sixty-four is far above
 * what any current chat format spends on that -- which is the point: this is a
 * ceiling, and the failure it exists to prevent is a hard stop computed on a
 * number smaller than what is billed.
 */
export const DRAFTING_FRAMING_OVERHEAD_TOKENS = 64;

/**
 * An upper bound on the input tokens one drafting instruction will be billed
 * for. Not an estimate.
 *
 * `instruction.length / 4` was used here and is not a bound at all. It assumes
 * roughly four ASCII characters per token, and Korean breaks that assumption in
 * the dangerous direction: on the instruction a full Korean cell produces, it
 * reported 5,771 tokens where this repository's own multilingual estimator says
 * 30,521 -- a fifth of the real figure, feeding a hard stop that then lets
 * through five times the approved spend.
 *
 * Two bounds, whichever is larger, plus the envelope:
 *
 *   * **UTF-8 bytes.** Every token of a byte-level BPE vocabulary (o200k_base
 *     and its family) decodes to at least one byte, so a text can never
 *     tokenize to more tokens than it has bytes. This holds without knowing
 *     the tokenizer's merges, which is exactly what makes it a bound rather
 *     than a guess -- and Korean is where it bites, at three bytes per
 *     character.
 *   * **The repository's estimator.** `estimatePromptTokens()` is what the
 *     product reserves credits against. Spending here against a smaller number
 *     than the product would reserve for the same text cannot be justified,
 *     whatever a byte count says.
 *
 * Deliberately loose. A ceiling that is 3x the truth costs an over-reserved
 * budget; one that is 0.2x the truth costs money nobody approved.
 */
export const draftingInputTokenCeiling = (instruction: string): number =>
    Math.max(
        Buffer.byteLength(instruction, "utf8"),
        estimatePromptTokens(instruction)
    ) + DRAFTING_FRAMING_OVERHEAD_TOKENS;

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
