/**
 * The Router's scoring policy, as one versioned bundle.
 *
 * Everything a routing decision needs in order to be attributable later lives
 * here: what a quality band means, which models carry one, how ties are
 * broken, how much better a challenger must look before Auto changes model,
 * and the cost and latency thresholds those comparisons use. They are in one
 * file with one version because they are one decision -- a switch margin is a
 * difference between two numbers, so it means something different the moment
 * the numbers change scale, and a margin versioned separately from the scale
 * it is measured on is a number nobody can interpret afterwards.
 *
 * ## Why this is not the model finder's table
 *
 * `MODEL_FINDER_SCORES` in `lib/modelFinder.ts` is static product curation: a
 * questionnaire that recommends one of six Standard models to somebody setting
 * up an account. It answers "which model should this person start on".
 *
 * This answers "which model should serve this turn", over every enabled model,
 * and it is operational rather than editorial. The two were the same table
 * until now, which had two consequences. Twenty-four of the thirty enabled
 * models were absent from it, so the Router could only reach them when
 * everything ahead of them failed a hard filter -- premium-reasoning and
 * research models were unreachable as a class. And a change made for the
 * Router's benefit would have silently rewritten a product recommendation.
 * They are separate now, and `tests/modelFinder.test.mjs` pins the finder's
 * output so the separation stays real rather than nominal.
 *
 * ## Bands, not scores
 *
 * Quality is a band in `1 | 2 | 3`, never a point score. Three levels is as
 * much resolution as anybody can defend today: nothing here has been measured.
 * A six-point scale would look like a measurement and would be read as one.
 *
 * Every cell starts at the neutral band. A model is not scored down for being
 * cheap, nor up for being expensive, for carrying a "premium" usage class, or
 * for supporting a capability -- capability is a hard filter in
 * `lib/routerCandidates.ts` and folding it into quality would apply it twice,
 * once as a rule and once as an opinion. A band moves only when
 * `RouterQualityEvidence` names an approved record it moved for. Until such a
 * record exists, the bands are level and the tie-break below is what actually
 * decides, which is the honest arrangement: cost, health and latency are
 * measured, and quality is not.
 *
 * `qualityCi95Lower` is null everywhere for the same reason. The existing
 * `eval:router-quality` harness compares the Router as a whole against a fixed
 * baseline; it is not a multi-arm evaluation and produces no per-(model, task)
 * interval. Those need their own pre-registered protocol.
 *
 * Pure. No I/O, no database, no clock, no model call.
 */

import type { AiProvider } from "@/lib/models";
import type { TaskKind, TaskProfile } from "@/lib/taskProfileCore";

/**
 * Bump on any change to a band, a threshold, the tie-break order, or the set
 * of models below. Recorded on `RoutingRun.selectionPolicyVersion` beside the
 * component versions, because a decision whose policy is not recorded cannot
 * be attributed to one afterwards.
 *
 * v2: the measured signals are wired to real data, `health_degraded` joins the
 * tie-break, and the observation thresholds those two need arrive with them.
 * Under v1 criteria 3 and 4 abstained on every turn because nothing supplied
 * them, so a v1 decision and a v2 decision on identical candidates can differ
 * -- which is the whole reason the version moves rather than the numbers being
 * edited in place.
 */
export const ROUTER_SCORE_POLICY_VERSION = "router-score-policy-v2";

/**
 * Quality, in three levels.
 *
 * 3 -- approved evidence puts this model ahead for this kind of work.
 * 2 -- neutral. No approved evidence either way. Every cell starts here.
 * 1 -- approved evidence puts this model behind for this kind of work.
 *
 * There is no zero: a model that must not serve a turn is refused by a hard
 * filter, not ranked last.
 */
export type RouterQualityBand = 1 | 2 | 3;

export const ROUTER_QUALITY_BANDS: readonly RouterQualityBand[] = [1, 2, 3];

/** Where every (model, task) cell sits until evidence moves it. */
export const NEUTRAL_QUALITY_BAND: RouterQualityBand = 2;

/**
 * Why a cell is not neutral.
 *
 * `evidenceRef` is a fixed identifier for an approved record -- a release-gate
 * ID, an evaluation report -- never prose and never a justification written at
 * the keyboard. Requiring one is what stops the snapshot drifting back into
 * curation: raising a band means naming what raised it.
 */
export type RouterQualityEvidence = {
    evidenceRef: string;
    qualityBand: RouterQualityBand;
    /**
     * Lower bound of a 95% confidence interval from that record, on whatever
     * scale the record defines, or null when it carries no interval.
     *
     * Only ever compared against another cell's lower bound from the same kind
     * of record, and only inside one band -- see `compareRouterScoreCells`.
     */
    qualityCi95Lower: number | null;
};

export type RouterScoreCell = {
    qualityBand: RouterQualityBand;
    qualityCi95Lower: number | null;
    /** Null when the cell is neutral, which is every cell today. */
    evidenceRef: string | null;
};

export type RouterScoreSnapshotEntry = {
    modelId: string;
    /**
     * The provider this model is served by.
     *
     * Recorded now although provider-variant routing is out of scope for v1:
     * the same model reached through two providers is two different costs,
     * latencies and health signals, and a snapshot with nowhere to say which
     * one it scored would have to be rebuilt rather than extended.
     */
    providerId: AiProvider;
    /**
     * Cells that approved evidence has moved off neutral. Absent keys are
     * neutral, which is all of them today.
     */
    quality?: Partial<Record<TaskKind, RouterQualityEvidence>>;
};

/**
 * Every enabled model in the catalogue, and nothing else.
 *
 * Enrolment is the point. `tests/routerScorePolicy.test.mjs` fails when an
 * enabled model is missing, so adding one to the catalogue is a decision about
 * routing rather than an omission nobody notices -- the failure this replaces
 * is twenty-four models being unroutable because a curated six-model table
 * never mentioned them.
 *
 * A model absent from here still routes, at the neutral band: an unregistered
 * model is unmeasured, not bad, and refusing it would let a catalogue addition
 * take a model out of Auto silently. The test is what makes the omission
 * visible; the runtime stays forgiving.
 */
export const ROUTER_SCORE_SNAPSHOT: readonly RouterScoreSnapshotEntry[] = [
    { modelId: "gpt-5-6-sol", providerId: "openai" },
    { modelId: "gpt-5-6-terra", providerId: "openai" },
    { modelId: "gpt-5-6-luna", providerId: "openai" },
    { modelId: "gpt-5-5", providerId: "openai" },
    { modelId: "gpt-5-5-thinking", providerId: "openai" },
    { modelId: "gpt-5-4-mini", providerId: "openai" },

    { modelId: "claude-fable-5", providerId: "anthropic" },
    { modelId: "claude-opus-4-8", providerId: "anthropic" },
    { modelId: "claude-sonnet-5", providerId: "anthropic" },
    { modelId: "claude-haiku-4-5", providerId: "anthropic" },

    { modelId: "gemini-3-7-flash", providerId: "google" },
    { modelId: "gemini-3-6-flash", providerId: "google" },
    { modelId: "gemini-3-1-pro", providerId: "google" },
    { modelId: "gemini-2-5-flash", providerId: "google" },

    { modelId: "grok-4-5", providerId: "xai" },

    { modelId: "deepseek-v4-flash", providerId: "deepseek" },
    { modelId: "deepseek-v4-pro", providerId: "deepseek" },

    { modelId: "mistral-small-4", providerId: "mistral" },
    { modelId: "mistral-large-3", providerId: "mistral" },
    { modelId: "mistral-medium-3-1", providerId: "mistral" },

    { modelId: "kimi-k2.7-code", providerId: "moonshot" },
    { modelId: "kimi-k3", providerId: "moonshot" },

    { modelId: "minimax-m3", providerId: "minimax" },

    { modelId: "qwen3.7-max", providerId: "qwen" },
    { modelId: "qwen3.7-plus", providerId: "qwen" },
    { modelId: "qwen3.6-flash", providerId: "qwen" },

    { modelId: "glm-5.2", providerId: "zhipu" },

    { modelId: "perplexity/sonar", providerId: "perplexity" },
    { modelId: "perplexity/sonar-pro", providerId: "perplexity" },
    { modelId: "perplexity/sonar-reasoning-pro", providerId: "perplexity" },
    { modelId: "perplexity/sonar-deep-research", providerId: "perplexity" },
];

const snapshotByModelId = new Map(
    ROUTER_SCORE_SNAPSHOT.map((entry) => [entry.modelId, entry])
);

const NEUTRAL_CELL: RouterScoreCell = {
    qualityBand: NEUTRAL_QUALITY_BAND,
    qualityCi95Lower: null,
    evidenceRef: null,
};

/** What the snapshot says about one (model, task) pair. Never throws. */
export const getRouterScoreCell = (
    modelId: string,
    kind: TaskKind
): RouterScoreCell => {
    const evidence = snapshotByModelId.get(modelId)?.quality?.[kind];
    if (!evidence) return NEUTRAL_CELL;
    return {
        qualityBand: evidence.qualityBand,
        qualityCi95Lower: evidence.qualityCi95Lower,
        evidenceRef: evidence.evidenceRef,
    };
};

export const isRouterScoreSnapshotModel = (modelId: string) =>
    snapshotByModelId.has(modelId);

/**
 * The order ties are broken in, most decisive first.
 *
 * Exported as data so the policy can be read without reading the comparator,
 * and so a test can assert the implementation applies exactly these, in this
 * order.
 *
 *   quality_band         curated-and-evidenced quality, above.
 *   health_degraded      the health path reports this model misbehaving.
 *   expected_total_cost  what this turn would cost on this model.
 *   recent_success_rate  how often it has answered lately.
 *   ttft_p95             how long it makes people wait.
 *   model_id             a stable, arbitrary, total order.
 *
 * `health_degraded` sits above cost deliberately. A degraded model is not
 * refused -- refusal is `unavailable`, and that is a hard filter -- but "this
 * model is currently misbehaving" is a stronger reason to pick the other one
 * than "this model is cheaper". Only measured-or-evidenced quality outranks
 * it. It is a set rather than a rate, and a model absent from the set counts
 * as not degraded whether it is healthy or merely unprobed: uncertainty
 * demotes nobody, the same rule that keeps unprobed models out of the hard
 * filter.
 *
 * The last one is not a quality judgement and is not meant to be: what it
 * guarantees is that two runs over the same inputs produce the same answer,
 * which the previous fallback -- position in the model finder's six-model
 * order -- could not do for the twenty-four models that order never listed.
 */
export const ROUTER_TIE_BREAK_ORDER = [
    "quality_band",
    "health_degraded",
    "expected_total_cost",
    "recent_success_rate",
    "ttft_p95",
    "model_id",
] as const;

export type RouterTieBreakCriterion = (typeof ROUTER_TIE_BREAK_ORDER)[number];

/**
 * Measured signals for criteria 2 to 4, supplied by the caller.
 *
 * Injected rather than looked up, exactly as `unhealthyModelIds` already is:
 * where a number comes from is the caller's business, and what it means is
 * this policy's. That is also what keeps `selectRouterModel` pure.
 *
 * A missing entry means *unknown*, not zero and not best. An unknown value
 * never wins and never loses a comparison; the criterion is skipped for that
 * pair and the next one decides. Treating an absent success rate as 100%
 * would rank a model nobody has ever called above one with a measured record.
 */
export type RouterTieBreakSignals = {
    /** Expected total cost of this turn, per model, in US dollars. */
    expectedTotalCostUsdByModelId?: Readonly<Record<string, number>>;
    /**
     * Recent success rate per model, as a fraction in [0, 1].
     *
     * From dispatch outcomes only -- see `lib/routerSignalCore.ts` for why a
     * probe success rate is never mixed in, and why an under-sampled model has
     * no entry rather than a provisional number.
     */
    recentSuccessRateByModelId?: Readonly<Record<string, number>>;
    /** Observed time to first token per model, p95, in milliseconds. */
    ttftP95MsByModelId?: Readonly<Record<string, number>>;
    /**
     * Models the health path reports as degraded: still answering, not well.
     *
     * A set rather than a rate, and kept apart from the success rate above
     * because the two are measured on different populations -- this is
     * synthetic probe evidence about whether the provider answers at all, and
     * that is real traffic. Absence means "not known to be degraded", which
     * covers a healthy model and an unprobed one alike.
     */
    degradedModelIds?: readonly string[];
};

/**
 * The cost and latency thresholds the tie-break compares against.
 *
 * Two measurements that differ by less than these are the same measurement.
 * Without them the cost criterion decides every tie on the fourth decimal
 * place of a price, and the Router would reshuffle itself on a rounding
 * difference while reporting a confident reason for it.
 *
 * They are here, under this file's version, rather than beside the code that
 * applies them, because a threshold is only meaningful against the scale it
 * thresholds -- the same argument that put the switch margin here.
 */
export const ROUTER_COST_TIE_EPSILON_RATIO = 0.05;
export const ROUTER_SUCCESS_RATE_TIE_EPSILON = 0.01;
export const ROUTER_TTFT_TIE_EPSILON_MS = 250;

/**
 * How much recent dispatch history the measured signals are computed over.
 *
 * One window for every model, because a rate over the last day compared
 * against a rate over the last week is not a comparison. Widening it buys
 * coverage on a quiet catalogue and pays for it in freshness, which is a
 * policy decision rather than a tuning knob -- hence a version, not a default.
 */
export const ROUTER_SIGNAL_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * How many observations a model needs before its number is used at all.
 *
 * Below these the model has no entry and the criterion abstains. The success
 * rate needs enough attempts for a difference larger than
 * `ROUTER_SUCCESS_RATE_TIE_EPSILON` to mean something -- at ten attempts the
 * smallest expressible difference is ten points, so the epsilon would be
 * decorative. The p95 needs enough points that the ninety-fifth percentile is
 * not simply the largest observation: at twenty it is exactly that, and at
 * fifty there are two above it.
 */
export const ROUTER_SUCCESS_RATE_MIN_OBSERVATIONS = 30;
export const ROUTER_TTFT_MIN_OBSERVATIONS = 50;

/**
 * How long a computed signal snapshot may be reused before it is read again.
 *
 * A bound on how stale a decision's inputs may be, which makes it a property
 * of the decision rather than of the cache -- so it lives here, beside the
 * numbers it bounds, and moves with them. The chat path cannot afford a query
 * per turn (`ROUTE-02` bounds the whole routing decision at a p95 of 300ms),
 * and a signal describing the last day does not change meaningfully in a
 * minute.
 */
export const ROUTER_SIGNAL_SNAPSHOT_TTL_MS = 60_000;

/**
 * How much better a challenger must look before Auto changes model mid
 * conversation, in whole quality bands.
 *
 * One band. It was 2 in the old table's units, where scores ran from 0 to 12
 * and 2 was a small step; on a three-level band scale the same literal would
 * mean "only a 1 to 3 jump ever switches", which is a different policy wearing
 * the old policy's number. This is the re-expression that item, not a relaxed
 * threshold: a full band is the smallest difference this scale can state.
 *
 * A consequence worth stating plainly: while every band is neutral, no
 * challenger can clear this, so Auto keeps its model until that model fails a
 * hard filter. That is the correct behaviour for a scale with no measurements
 * in it yet -- there is no evidence on which to move anyone -- and it is why
 * the first approved evidence record is also the first thing that can make
 * Auto switch.
 */
export const ROUTER_STICKY_SWITCH_MARGIN_BANDS = 1;

/**
 * And how many consecutive turns must favour the challenger by that margin.
 *
 * One turn is not a trend. A single question of a different shape inside a
 * long conversation should not move the model, because the next turn is
 * usually back to the original subject.
 */
export const ROUTER_STICKY_HYSTERESIS_TURNS = 2;

/**
 * Extra consecutive turns required when the turn's kind rests on one signal.
 *
 * The task profiler bands its own agreement as `none | weak | strong`, and
 * until now the Router ignored it: a turn where one keyword fired and a turn
 * where three rules agreed ranked identically. They should not, and the honest
 * use of a band that is explicitly not a probability is to make the ambiguous
 * turn move the conversation more slowly rather than to weight it by some
 * invented factor.
 *
 * `none` does not appear here because it is handled earlier and more simply:
 * it ranks on the `general` table instead. See `rankingKindFor`.
 */
export const ROUTER_WEAK_CONFIDENCE_EXTRA_TURNS = 1;

/**
 * Which column of the snapshot ranks this turn.
 *
 * A profile whose kind rests on no signal at all is not a weak opinion about
 * the kind; it is the absence of one. Ranking it on that kind's column would
 * let a default label pick a specialist, so it ranks on `general` -- the same
 * column a turn that genuinely looks general uses.
 *
 * Today's profiler only ever reports `none` together with `general`, so this
 * changes nothing on its own. It is written as a rule anyway because the next
 * profiler version may not hold that coincidence, and the invariant that
 * matters -- an unsupported kind never steers routing -- should not depend on
 * one having noticed.
 */
export const rankingKindFor = (profile: TaskProfile): TaskKind =>
    profile.kindConfidence === "none" ? "general" : profile.kind;

/** Consecutive turns a switch needs, given how well-supported the kind is. */
export const stickyHysteresisTurnsFor = (profile: TaskProfile): number =>
    profile.kindConfidence === "weak"
        ? ROUTER_STICKY_HYSTERESIS_TURNS + ROUTER_WEAK_CONFIDENCE_EXTRA_TURNS
        : ROUTER_STICKY_HYSTERESIS_TURNS;

/**
 * Orders two cells by quality alone. Negative means the left one ranks higher.
 *
 * Band first, always, and the interval only refines *within* a band. The
 * tempting alternative -- let a measured interval outrank a band -- does not
 * survive contact with a partly-measured snapshot: with A ahead of B on an
 * interval, B ahead of C on a band and C ahead of A on a band, the comparator
 * has no consistent answer and the sort result depends on input order. A
 * strict primary key is what makes this a total order.
 *
 * An interval is compared only when both cells carry one, for the same reason
 * a missing signal is skipped below: a cell with no interval is unmeasured,
 * not zero.
 */
export const compareRouterScoreCells = (
    left: RouterScoreCell,
    right: RouterScoreCell
): number => {
    if (left.qualityBand !== right.qualityBand) {
        return right.qualityBand - left.qualityBand;
    }
    if (left.qualityCi95Lower !== null && right.qualityCi95Lower !== null) {
        return right.qualityCi95Lower - left.qualityCi95Lower;
    }
    return 0;
};
