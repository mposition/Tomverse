/**
 * Ten judgements, to find out how many output tokens a reasoning judge spends.
 *
 * ## Why this exists before the calibration does
 *
 * The cost projection for the independent judge rests on one unmeasured
 * number. `docs/ops/tomverse-chat-router-calibration-cost.md` originally
 * priced the judge pass at a three-token verdict -- one word -- which is what
 * `gpt-5-6-luna` actually emitted, and the fit reproduced that run's total to
 * 0.0%. But `claude-fable-5` runs at effort `high` with adaptive thinking and
 * bills reasoning as output, so its verdict call is not three tokens, and
 * nobody has measured what it is. Everything downstream -- the stage ceiling,
 * whether the calibration is affordable at all -- follows from that one
 * quantity.
 *
 * So it is measured on ten pairs rather than assumed on 210. mposition
 * approved $0.60 for exactly that, and refused to let 400 tokens be adopted as
 * a number simply because it was written down.
 *
 * ## Why the sample is chosen rather than sampled
 *
 * Ten is too few to leave to a seed. A random ten could be ten short English
 * questions, and the thing being measured is how much a judge *thinks* -- which
 * is the quantity most likely to move with the language, the kind of task and
 * the length of what it is reading. So the ten are constructed to span all
 * three, and the selection is deterministic: the same bundle yields the same
 * ten, and a probe that cannot fill a cell says so instead of quietly
 * returning nine.
 */

import { estimateRawTextTokens } from "./chatTokenEstimate";
import type { AnswerBundle, AnswerBundleEntry } from "./routerAnswerBundle";
import { judgePrompt } from "./routerJudgeRubric";

/**
 * The five task kinds mposition named, in the set's own spelling.
 *
 * Named rather than "whatever the bundle holds": the point of the probe is to
 * cover the range, and a bundle missing one of these cannot demonstrate that.
 */
export const PROBE_STRATA = [
    "analysis_and_reasoning",
    "coding",
    "writing_and_rewriting",
    "current_information",
    "long_context_conversation",
] as const;

export const PROBE_CELLS = ["ko", "en"] as const;

/** Five strata by two languages. Ten, and it is not a coincidence. */
export const PROBE_SAMPLE_SIZE = PROBE_STRATA.length * PROBE_CELLS.length;

export type ProbeSelection = {
    entry: AnswerBundleEntry;
    stratum: string;
    cell: string;
    /** Which end of the length range this one was picked to represent. */
    lengthEnd: "short" | "long";
    /** The whole rendered request: rubric, prompt, both answers, schema. */
    renderedJudgeInputTokens: number;
};

/**
 * The tokens the judge actually receives for this pair.
 *
 * ## Not the user's prompt, and not the prompt plus the two answers
 *
 * mposition's correction, and the first version of this file had it wrong: it
 * ordered pairs by prompt + answer A + answer B, which is the varying part but
 * is not the request. The judge is sent the rubric and the output schema as
 * well, and those are most of a short pair's request -- so "short" measured
 * without them is a different quantity from "short" as the judge experiences
 * it, and the cost computed from it is wrong by a constant nobody declared.
 *
 * So the selection renders the real prompt, with `judgePrompt`, exactly as the
 * run does. What is measured is what is sent.
 */
export const renderedJudgeInputTokens = (entry: AnswerBundleEntry): number =>
    estimateRawTextTokens(
        judgePrompt(entry.prompt ?? "", entry.first?.text ?? "", entry.second?.text ?? "")
    );

export type ProbeSelectionResult = {
    selected: readonly ProbeSelection[];
    problems: readonly string[];
};

/**
 * Ten pairs spanning both languages, all five task kinds, and both ends of the
 * length range.
 *
 * Within a cell the two ends are taken from the same population, so the short
 * and long picks alternate across strata rather than always falling on the
 * same language. Otherwise "long" would mean "Korean" and the two variables
 * would be measured as one.
 */
export const selectProbeSample = (bundle: AnswerBundle): ProbeSelectionResult => {
    const problems: string[] = [];
    const selected: ProbeSelection[] = [];
    const usable = bundle.entries.filter(
        (entry) => (entry.first?.text ?? "").trim() !== "" && (entry.second?.text ?? "").trim() !== ""
    );
    if (usable.length < bundle.entries.length) {
        // Not a defect here: the bundle this probe reads came from the voided
        // run, and its empty answers are the reason that run was void. They
        // simply cannot be judged, so they cannot be measured either.
        problems.push(
            `${bundle.entries.length - usable.length} pair(s) hold an empty answer and were skipped; ` +
                "a judge cannot be measured on a pair it could not grade"
        );
    }

    for (const [index, stratum] of PROBE_STRATA.entries()) {
        for (const [cellIndex, cell] of PROBE_CELLS.entries()) {
            const candidates = usable
                .filter((entry) => entry.stratum === stratum && entry.cell === cell)
                .map((entry) => ({ entry, rendered: renderedJudgeInputTokens(entry) }))
                .sort((a, b) => a.rendered - b.rendered || a.entry.pairId.localeCompare(b.entry.pairId));
            if (candidates.length === 0) {
                problems.push(`${stratum}/${cell} holds no judgeable pair, so the probe cannot cover it`);
                continue;
            }
            // Alternate which language supplies the short end, so language and
            // length are not confounded across the ten.
            const wantShort = (index + cellIndex) % 2 === 0;
            const pick = wantShort ? candidates[0] : candidates[candidates.length - 1];
            selected.push({
                entry: pick.entry,
                stratum,
                cell,
                lengthEnd: wantShort ? "short" : "long",
                renderedJudgeInputTokens: pick.rendered,
            });
        }
    }

    if (selected.length !== PROBE_SAMPLE_SIZE) {
        problems.push(
            `the probe selected ${selected.length} pair(s), not ${PROBE_SAMPLE_SIZE}; a short sample ` +
                "measures a narrower range than the one that was approved"
        );
    }
    return { selected, problems };
};

/** Why a probe run must stop at once. Any one of them ends it. */
export const PROBE_ABORT_REASONS = [
    "output_budget_exhausted",
    "empty_verdict",
    "verdict_parse_failed",
    "per_request_cost_exceeded",
    "stage_cost_reached",
    /**
     * Not one of the five mposition listed, and kept distinct from them on
     * purpose. A call that never returned has no verdict to call empty and
     * nothing to fail parsing, so filing it under either would report a
     * finding about the judge that the run did not observe. The probe runs
     * with no retries, so it stops here too.
     */
    "provider_error",
] as const;
export type ProbeAbortReason = (typeof PROBE_ABORT_REASONS)[number];

export type ProbeObservation = {
    pairId: string;
    stratum: string;
    cell: string;
    lengthEnd: "short" | "long";
    /** What the selection measured: the whole rendered request. */
    renderedJudgeInputTokens: number;
    /** What the provider billed as input. The check on the estimate. */
    inputTokens: number;
    billedOutputTokens: number | null;
    visibleOutputTokens: number;
    /** Where the provider reports it separately. Null when it does not. */
    reasoningTokens: number | null;
    finishReason: string | null;
    normalizedFinishReason: string | null;
    parseSucceeded: boolean;
    costUsd: number;
};

/**
 * Whether this observation ends the probe, and why.
 *
 * mposition's list, in the order that reads most usefully in a log: the
 * mechanism first, then the two ways a verdict can be unusable, then the two
 * ways the money runs out.
 */
export const probeAbortReason = (
    observation: ProbeObservation,
    limits: {
        requestedMaxOutputTokens: number;
        perRequestMaxCostUsd: number;
        stageMaxCostUsd: number;
        accruedCostUsd: number;
    },
    budgetExhausted: boolean
): ProbeAbortReason | null => {
    if (budgetExhausted) return "output_budget_exhausted";
    if (observation.visibleOutputTokens === 0) return "empty_verdict";
    if (!observation.parseSucceeded) return "verdict_parse_failed";
    if (observation.costUsd > limits.perRequestMaxCostUsd) return "per_request_cost_exceeded";
    if (limits.accruedCostUsd >= limits.stageMaxCostUsd) return "stage_cost_reached";
    return null;
};

export type TokenDistribution = {
    n: number;
    min: number;
    median: number;
    p90: number;
    p95: number;
    max: number;
    mean: number;
};

export type ProbeSummary = {
    observations: readonly ProbeObservation[];
    aborted: { at: number; reason: ProbeAbortReason } | null;
    totalCostUsd: number;
    billedOutputTokens: TokenDistribution | null;
    renderedJudgeInputTokens: TokenDistribution | null;
    finishReasons: Record<string, number>;
    parsedCount: number;
};

const percentile = (sorted: readonly number[], p: number) =>
    sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)];

const median = (sorted: readonly number[]) => {
    if (sorted.length === 0) return 0;
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
};

/**
 * The spread, not just the middle.
 *
 * Ten observations, and the number this feeds is a ceiling -- so the tail
 * matters more than the average. A mean of 300 with a max of 4,000 is a very
 * different budget decision from a mean of 300 with a max of 350, and only one
 * of those is visible from the mean.
 */
export const distributionOf = (values: readonly number[]) => {
    const sorted = [...values].sort((a, b) => a - b);
    return {
        n: sorted.length,
        min: sorted[0],
        median: median(sorted),
        p90: percentile(sorted, 0.9),
        p95: percentile(sorted, 0.95),
        max: sorted[sorted.length - 1],
        mean: sorted.reduce((a, b) => a + b, 0) / sorted.length,
    };
};

export const summariseProbe = (
    observations: readonly ProbeObservation[],
    aborted: ProbeSummary["aborted"]
): ProbeSummary => {
    const billed = observations
        .map((o) => o.billedOutputTokens)
        .filter((value): value is number => typeof value === "number");
    const rendered = observations.map((o) => o.renderedJudgeInputTokens);
    return {
        observations,
        aborted,
        totalCostUsd: observations.reduce((sum, o) => sum + o.costUsd, 0),
        billedOutputTokens: billed.length === 0 ? null : distributionOf(billed),
        renderedJudgeInputTokens: rendered.length === 0 ? null : distributionOf(rendered),
        finishReasons: observations.reduce<Record<string, number>>((counts, o) => {
            const key = o.finishReason ?? "none";
            counts[key] = (counts[key] ?? 0) + 1;
            return counts;
        }, {}),
        parsedCount: observations.filter((o) => o.parseSucceeded).length,
    };
};
