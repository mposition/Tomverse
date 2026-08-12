/**
 * The arithmetic and the refusals behind `ROUTE-01`, separated from the
 * harness that spends money at a provider.
 *
 * `docs/ops/tomverse-chat-router-evaluation-set.md` fixes the procedure: the
 * same question is answered once by Auto and once by a pre-registered
 * fixed-model baseline, a blind judge says which answer better serves the
 * person who asked, and the lower bound of a 95% confidence interval on the
 * win-rate delta has to sit at or above -2pp.
 *
 * Everything here is pure, so the parts that decide whether a run counts can
 * be tested without a provider key. That split matters more than it looks:
 * the failure this file exists to prevent is a run that produced a number
 * being read as a run that produced evidence.
 *
 * ## What the shadow report cannot do, and why this exists
 *
 * Shadow records the model the Router *would* have chosen. It never generated
 * that model's answer, so there is no pair, no verdict and no win rate. A
 * Router that echoed the user's own choice would agree with every shadow row
 * and be worth nothing. `ROUTE-01` needs answers, which means real calls,
 * which is why this is an operator action rather than a CI test.
 */

/** Bump when a scoring rule, an exclusion rule or a reported field changes. */
export const ROUTER_QUALITY_EVAL_VERSION = "router-quality-eval-v1";

/** The paired unit, recorded verbatim so a report cannot leave it implicit. */
export const PAIRED_EVALUATION_UNIT =
  "one question, answered once by Auto and once by the pre-registered fixed-model baseline";

/** §6: "equivalent" is a first-class verdict, never a forced preference. */
export type JudgeVerdict = "auto" | "baseline" | "equivalent";

/**
 * Why a pair produced no verdict.
 *
 * Kept as distinct reasons rather than one `excluded` flag because they are
 * not the same event. `no_candidate` is the Router declining to route;
 * `auto_arm_failed` is a provider outage; `self_identified` is §5's blinding
 * rule firing. A report that collapsed them would hide which of the three was
 * happening, and only one of them is anybody's fault.
 */
export type PairExclusionReason =
  | "no_candidate"
  | "auto_arm_failed"
  | "baseline_arm_failed"
  | "self_identified"
  | "judge_failed";

export type PairOutcome =
  | { status: "judged"; verdict: JudgeVerdict }
  | { status: "excluded"; reason: PairExclusionReason };

export type EvaluatedPair = {
  itemId: string;
  stratum: string;
  cell: string;
  /** What the Router chose. `null` when it refused to route this item. */
  autoModelId: string | null;
  baselineModelId: string;
  /** Which slot the Auto answer occupied when the judge saw it. §5. */
  autoPosition: "first" | "second";
  outcome: PairOutcome;
};

/**
 * A judged pair as a number.
 *
 * `+1` Auto better, `-1` baseline better, `0` equivalent, `null` no verdict.
 *
 * Ties score zero and stay in the denominator. Dropping them is the standard
 * way this measurement goes wrong: it rescales both win rates against the
 * discordant pairs alone, turning a 2%-win / 2%-loss / 96%-tie result into
 * "50% versus 50%" of a much smaller sample, and the interval that comes out
 * describes a set nobody evaluated.
 */
export const pairScore = (pair: EvaluatedPair): 1 | 0 | -1 | null => {
  if (pair.outcome.status !== "judged") return null;
  if (pair.outcome.verdict === "auto") return 1;
  if (pair.outcome.verdict === "baseline") return -1;
  return 0;
};

export type CiMethod = "bootstrap_percentile" | "normal_approximation";

export type WinRateDelta = {
  /** Judged pairs. Excluded pairs are not in this number. */
  n: number;
  wins: number;
  losses: number;
  ties: number;
  discordantPairs: number;
  discordanceRate: number;
  pointEstimatePp: number;
  ci95LowerPp: number;
  ci95UpperPp: number;
  method: CiMethod;
  /** Present for bootstrap, `null` for the closed form, which needs none. */
  seed: number | null;
  resamples: number | null;
};

/**
 * A seeded generator, so a recorded seed replays a run exactly.
 *
 * `Math.random` would make the seed §9 requires a decoration: the report
 * would name a number that changed nothing. mulberry32 is small enough to
 * read and its sequence is fixed by the seed alone.
 */
export const seededRandom = (seed: number): (() => number) => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let drawn = Math.imul(state ^ (state >>> 15), 1 | state);
    drawn = (drawn + Math.imul(drawn ^ (drawn >>> 7), 61 | drawn)) ^ drawn;
    return ((drawn ^ (drawn >>> 14)) >>> 0) / 4294967296;
  };
};

const percentile = (sorted: readonly number[], quantile: number): number => {
  if (sorted.length === 0) return Number.NaN;
  const position = (sorted.length - 1) * quantile;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
};

const Z95 = 1.959963984540054;

export type DeltaOptions = {
  method?: CiMethod;
  seed?: number;
  resamples?: number;
};

/**
 * The win-rate delta and its 95% interval, in percentage points.
 *
 * Both methods are offered because they fail differently. The normal
 * approximation is closed-form and needs no seed, but it assumes a symmetric
 * sampling distribution, which a set dominated by ties does not have. The
 * bootstrap makes no such assumption and is what the seed in §9 is for. The
 * method has to be pre-registered either way: choosing it after seeing which
 * one clears -2pp is choosing the answer.
 */
export const computeWinRateDelta = (
  pairs: readonly EvaluatedPair[],
  options: DeltaOptions = {}
): WinRateDelta => {
  const method = options.method ?? "bootstrap_percentile";
  const resamples = options.resamples ?? 10_000;
  const scores = pairs
    .map(pairScore)
    .filter((score): score is 1 | 0 | -1 => score !== null);

  const n = scores.length;
  const wins = scores.filter((score) => score === 1).length;
  const losses = scores.filter((score) => score === -1).length;
  const ties = n - wins - losses;
  const discordantPairs = wins + losses;
  const pointEstimatePp = n === 0 ? Number.NaN : ((wins - losses) / n) * 100;

  const base = {
    n,
    wins,
    losses,
    ties,
    discordantPairs,
    discordanceRate: n === 0 ? Number.NaN : discordantPairs / n,
    pointEstimatePp,
    method,
  };

  // One judged pair has no spread to estimate. Reporting ±0 around it would
  // be an interval that claims certainty from a single observation.
  if (n < 2) {
    return {
      ...base,
      ci95LowerPp: Number.NaN,
      ci95UpperPp: Number.NaN,
      seed: method === "bootstrap_percentile" ? (options.seed ?? null) : null,
      resamples: method === "bootstrap_percentile" ? resamples : null,
    };
  }

  if (method === "normal_approximation") {
    const mean = (wins - losses) / n;
    const variance =
      scores.reduce((total: number, score) => total + (score - mean) ** 2, 0) / (n - 1);
    const halfWidth = Z95 * Math.sqrt(variance / n) * 100;
    return {
      ...base,
      ci95LowerPp: pointEstimatePp - halfWidth,
      ci95UpperPp: pointEstimatePp + halfWidth,
      seed: null,
      resamples: null,
    };
  }

  const seed = options.seed ?? 0;
  const random = seededRandom(seed);
  const means: number[] = [];
  for (let round = 0; round < resamples; round += 1) {
    let total = 0;
    for (let draw = 0; draw < n; draw += 1) {
      total += scores[Math.floor(random() * n)];
    }
    means.push((total / n) * 100);
  }
  means.sort((left, right) => left - right);

  return {
    ...base,
    ci95LowerPp: percentile(means, 0.025),
    ci95UpperPp: percentile(means, 0.975),
    seed,
    resamples,
  };
};

/**
 * How many items an interval of the given half-width needs, at a measured
 * discordance rate. §3's second table.
 *
 * Near parity the per-item variance is the discordance rate itself, so
 * `SE ≈ sqrt(d / n)`. The point of exposing this is that §3 asks for `n` to
 * be pre-registered from a *measured* pilot discordance. Guessing `d` and
 * discovering afterwards that the set was half the size it needed to be
 * produces a failed gate that says nothing about the Router.
 */
export const requiredSampleSize = (
  discordanceRate: number,
  halfWidthPp = 2
): number => {
  if (!(discordanceRate > 0) || !(halfWidthPp > 0)) return Number.NaN;
  return Math.ceil(discordanceRate / ((halfWidthPp / 100 / Z95) ** 2));
};

export type CellTarget = { stratum: string; cell: string; target: number };
export type CellShortfall = CellTarget & { judged: number };

const cellKey = (stratum: string, cell: string) => `${stratum}/${cell}`;

/**
 * Cells that did not reach their target, counting judged pairs only.
 *
 * §2 manages cells as independent, so a cell that came up short is not
 * something the other cells make up for -- an underfilled Korean coding cell
 * means the set says nothing about Korean coding, however many English
 * general-knowledge items were collected. Excluded pairs do not count towards
 * a target, because a pair with no verdict is not evidence about its cell.
 */
export const cellShortfalls = (
  pairs: readonly EvaluatedPair[],
  targets: readonly CellTarget[]
): readonly CellShortfall[] => {
  const judged = new Map<string, number>();
  for (const pair of pairs) {
    if (pair.outcome.status !== "judged") continue;
    const key = cellKey(pair.stratum, pair.cell);
    judged.set(key, (judged.get(key) ?? 0) + 1);
  }
  return targets
    .map((target) => ({
      ...target,
      judged: judged.get(cellKey(target.stratum, target.cell)) ?? 0,
    }))
    .filter((cell) => cell.judged < cell.target);
};

export type ExclusionSummary = {
  total: number;
  rate: number;
  byReason: Readonly<Record<PairExclusionReason, number>>;
};

export const summariseExclusions = (
  pairs: readonly EvaluatedPair[]
): ExclusionSummary => {
  const byReason: Record<PairExclusionReason, number> = {
    no_candidate: 0,
    auto_arm_failed: 0,
    baseline_arm_failed: 0,
    self_identified: 0,
    judge_failed: 0,
  };
  let total = 0;
  for (const pair of pairs) {
    if (pair.outcome.status !== "excluded") continue;
    byReason[pair.outcome.reason] += 1;
    total += 1;
  }
  return {
    total,
    rate: pairs.length === 0 ? Number.NaN : total / pairs.length,
    byReason,
  };
};

/**
 * The share of exclusions above which what survives is no longer a sample of
 * the set.
 *
 * Deliberately far tighter than the 50% `lib/defaultModelEvalGateCore.ts`
 * tolerates, because the failures are not the same shape. There, a blocked
 * host takes every arm down together and the survivors are unbiased. Here the
 * exclusions land on one arm: `no_candidate` fires exactly where the Router
 * found nothing to offer, and `auto_arm_failed` where its chosen model fell
 * over. Both select the harder items out of the set, so dropping them and
 * reporting the rest measures Auto on the questions it managed to answer.
 */
export const EXCLUSION_CEILING = 0.05;

/**
 * How often the judge preferred whichever answer it saw first.
 *
 * §5 requires a model judge's bias to be measured and reported, and position
 * is the bias every pairwise judge has. With order randomised per item this
 * should sit at 50%; a judge far from it is answering "which came first"
 * rather than "which is better", and the delta it produced is that habit
 * crossed with the seed rather than a result about the Router.
 */
export type PositionBias = {
  /** Non-tie verdicts, the only ones that can express a position preference. */
  decided: number;
  preferredFirst: number;
  firstRate: number;
  /** How the randomisation itself landed, so an unbalanced seed is visible. */
  autoFirstRate: number;
};

export const measurePositionBias = (
  pairs: readonly EvaluatedPair[]
): PositionBias => {
  const judged = pairs.filter((pair) => pair.outcome.status === "judged");
  const decided = judged.filter(
    (pair) =>
      pair.outcome.status === "judged" && pair.outcome.verdict !== "equivalent"
  );
  const preferredFirst = decided.filter((pair) => {
    if (pair.outcome.status !== "judged") return false;
    const autoWon = pair.outcome.verdict === "auto";
    return autoWon === (pair.autoPosition === "first");
  }).length;
  const autoFirst = judged.filter((pair) => pair.autoPosition === "first").length;
  return {
    decided: decided.length,
    preferredFirst,
    firstRate: decided.length === 0 ? Number.NaN : preferredFirst / decided.length,
    autoFirstRate: judged.length === 0 ? Number.NaN : autoFirst / judged.length,
  };
};

/** Beyond this, the judge is reading position rather than quality. */
export const POSITION_BIAS_CEILING = 0.65;

/**
 * The share of judged pairs where the Router chose something other than the
 * baseline model.
 *
 * Reported, never gating, and the distinction is worth stating. A Router that
 * picked the baseline for every item would score a delta of exactly zero with
 * a very tight interval and clear `ROUTE-01` cleanly -- correctly, because its
 * answers really are non-inferior. But "Auto passed the quality gate" would
 * then be read as "the Router's choices are good" when it means "the Router
 * hardly makes any". The number belongs in the report so the two readings stay
 * distinguishable; it is not a threshold, because non-inferiority is what the
 * gate asks and that Router is non-inferior.
 */
export const routedAwayRate = (pairs: readonly EvaluatedPair[]): number => {
  const judged = pairs.filter((pair) => pair.outcome.status === "judged");
  if (judged.length === 0) return Number.NaN;
  const away = judged.filter(
    (pair) => pair.autoModelId !== null && pair.autoModelId !== pair.baselineModelId
  ).length;
  return away / judged.length;
};

export type EvaluationOutcome =
  | "measured"
  | "underpowered"
  | "inconclusive"
  | "not_run";

export type EvaluationVerdict = {
  outcome: EvaluationOutcome;
  /** Why, in the order the rules were applied. Empty on a clean `measured`. */
  reasons: readonly string[];
  delta: WinRateDelta;
  exclusions: ExclusionSummary;
  shortfalls: readonly CellShortfall[];
  positionBias: PositionBias;
  routedAwayRate: number;
  /**
   * Whether the interval clears the margin -- `null` unless the outcome is
   * `measured`, so an underpowered run cannot be quoted as a pass or a fail.
   */
  meetsMargin: boolean | null;
};

export type EvaluationInput = {
  pairs: readonly EvaluatedPair[];
  cellTargets?: readonly CellTarget[];
  /** §3: fixed after the pilot, before the decision run. */
  preRegisteredSampleSize?: number | null;
  /** `ROUTE-01`'s `evaluation_win_rate_delta_ci95_lower_pp >= -2`. */
  marginPp?: number;
} & DeltaOptions;

/**
 * Whether a completed run is evidence, and of what.
 *
 * The order of the rules is the point. A run is disqualified before its number
 * is interpreted, never after: once a point estimate is on the table, "the
 * exclusions were a bit high but the delta was +3pp" is an argument somebody
 * will make. So `meetsMargin` is `null` for every outcome but `measured`, and
 * the reasons say which rule stopped it.
 */
export const evaluateRouterQualityRun = (
  input: EvaluationInput
): EvaluationVerdict => {
  const { pairs, cellTargets = [], preRegisteredSampleSize = null } = input;
  const marginPp = input.marginPp ?? -2;

  const delta = computeWinRateDelta(pairs, input);
  const exclusions = summariseExclusions(pairs);
  const shortfalls = cellShortfalls(pairs, cellTargets);
  const positionBias = measurePositionBias(pairs);
  const routedAway = routedAwayRate(pairs);

  const empty = {
    delta,
    exclusions,
    shortfalls,
    positionBias,
    routedAwayRate: routedAway,
    meetsMargin: null,
  } as const;

  if (pairs.length === 0) {
    return { ...empty, outcome: "not_run", reasons: ["no pairs were evaluated"] };
  }
  if (delta.n === 0) {
    return {
      ...empty,
      outcome: "not_run",
      reasons: [`all ${pairs.length} pair(s) were excluded, so nothing was judged`],
    };
  }

  const reasons: string[] = [];

  if (exclusions.rate > EXCLUSION_CEILING) {
    reasons.push(
      `${(exclusions.rate * 100).toFixed(1)}% of pairs were excluded, above the ` +
        `${(EXCLUSION_CEILING * 100).toFixed(0)}% ceiling; the exclusions fall on ` +
        `the Auto arm, so what remains is not a sample of the set`
    );
  }
  if (
    positionBias.decided > 0 &&
    (positionBias.firstRate > POSITION_BIAS_CEILING ||
      positionBias.firstRate < 1 - POSITION_BIAS_CEILING)
  ) {
    reasons.push(
      `the judge preferred the first answer in ${(positionBias.firstRate * 100).toFixed(1)}% ` +
        `of decided pairs, so it is reading position rather than quality`
    );
  }
  if (reasons.length > 0) {
    return { ...empty, outcome: "inconclusive", reasons };
  }

  if (shortfalls.length > 0) {
    reasons.push(
      `${shortfalls.length} cell(s) below target: ` +
        shortfalls
          .map((cell) => `${cell.stratum}/${cell.cell} ${cell.judged}/${cell.target}`)
          .join(", ")
    );
  }
  if (preRegisteredSampleSize !== null && delta.n < preRegisteredSampleSize) {
    reasons.push(
      `${delta.n} judged pairs against a pre-registered ${preRegisteredSampleSize}`
    );
  }
  if (reasons.length > 0) {
    return { ...empty, outcome: "underpowered", reasons };
  }

  return {
    delta,
    exclusions,
    shortfalls,
    positionBias,
    routedAwayRate: routedAway,
    outcome: "measured",
    reasons: [],
    meetsMargin: delta.ci95LowerPp >= marginPp,
  };
};

/**
 * §9's record: what a run has to emit to be citable at all.
 *
 * Checked as a shape rather than trusted, because the failure mode is a report
 * that carries a number and omits the seed, and a number nobody can replay is
 * not evidence however good it looks.
 */
export type EvaluationRecord = {
  evalVersion?: unknown;
  evaluationSetVersion?: unknown;
  cellCounts?: unknown;
  startedAt?: unknown;
  baseline?: {
    modelId?: unknown;
    catalogueVersion?: unknown;
    preRegisteredAt?: unknown;
  };
  versions?: {
    router?: unknown;
    estimator?: unknown;
    planner?: unknown;
    template?: unknown;
  };
  sampleSize?: unknown;
  discordantPairs?: unknown;
  pairedUnit?: unknown;
  ciMethod?: unknown;
  seed?: unknown;
  pointEstimatePp?: unknown;
  ci95LowerPp?: unknown;
  ci95UpperPp?: unknown;
  judge?: { identity?: unknown; isRoutableModel?: unknown; biasMeasurement?: unknown };
  exclusions?: unknown;
};

const present = (value: unknown) =>
  value !== undefined && value !== null && value !== "";

/**
 * Problems that stop a report being decision-grade evidence, as sentences.
 *
 * Empty means the record carries everything §9 lists and the two checks that
 * can be made from the record alone: that the baseline was named before the
 * run, and that the judge is not one of the models it is judging.
 */
export const evaluationRecordProblems = (
  record: EvaluationRecord | null | undefined,
  options: { routableModelIds?: readonly string[] } = {}
): readonly string[] => {
  if (!record || typeof record !== "object") {
    return ["the report is not an object"];
  }
  const problems: string[] = [];

  const required: [string, unknown][] = [
    ["evaluation set version", record.evaluationSetVersion],
    ["cell counts", record.cellCounts],
    ["run start time", record.startedAt],
    ["baseline model id", record.baseline?.modelId],
    ["baseline catalogue version", record.baseline?.catalogueVersion],
    ["baseline pre-registration date", record.baseline?.preRegisteredAt],
    ["Router version", record.versions?.router],
    ["Estimator version", record.versions?.estimator],
    ["Planner version", record.versions?.planner],
    ["template version", record.versions?.template],
    ["sample size", record.sampleSize],
    ["discordant pair count", record.discordantPairs],
    ["paired evaluation unit", record.pairedUnit],
    ["confidence-interval method", record.ciMethod],
    ["point estimate", record.pointEstimatePp],
    ["95% lower bound", record.ci95LowerPp],
    ["95% upper bound", record.ci95UpperPp],
    ["judge identity", record.judge?.identity],
    ["exclusion list", record.exclusions],
  ];
  for (const [label, value] of required) {
    if (!present(value)) problems.push(`no ${label}`);
  }

  // The seed is only meaningful for a method that consumes one, but the
  // ordering randomisation always does, so its absence is always a problem.
  if (!present(record.seed)) {
    problems.push("no randomisation seed, so the run cannot be replayed");
  }

  // §4. A baseline named after the run started is the comparison that
  // flattered Auto, chosen once the answers were already in hand.
  const preRegisteredAt = record.baseline?.preRegisteredAt;
  const startedAt = record.startedAt;
  if (typeof preRegisteredAt === "string" && typeof startedAt === "string") {
    const registered = Date.parse(preRegisteredAt);
    const started = Date.parse(startedAt);
    if (Number.isNaN(registered)) {
      problems.push(`baseline pre-registration date "${preRegisteredAt}" is not a date`);
    } else if (!Number.isNaN(started) && registered > started) {
      problems.push(
        "the baseline was pre-registered after the run started, so it was chosen with the answers in hand"
      );
    }
  }

  // §5. A routable model grading its own answers is the bias the blinding
  // exists to remove, and it cannot be blinded away.
  const identity = record.judge?.identity;
  const routable = options.routableModelIds ?? [];
  const judgesItself =
    record.judge?.isRoutableModel === true ||
    (typeof identity === "string" && routable.includes(identity));
  if (judgesItself && !present(record.judge?.biasMeasurement)) {
    problems.push(
      `the judge (${String(identity)}) is itself routable and carries no bias measurement`
    );
  }

  return problems;
};
