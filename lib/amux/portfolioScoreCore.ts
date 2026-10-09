/** V4 portfolio scoring is distinct from the legacy scheduler's p0-p3 score.
 * A model may suggest these observations, but only confirmed evidence enters
 * this deterministic calculation. It never changes card status or SEV1. */
export const AMUX_PORTFOLIO_SCORE_VERSION = "amux-v4-portfolio-v1";
export const AMUX_ACTIVE_SCORE_MAX_AGE_MS = 7 * 86_400_000;
export const AMUX_BASELINE_SCORE_MAX_AGE_MS = 28 * 86_400_000;

export type PortfolioDimension = 0 | 1 | 2 | 3 | 4 | 5;
export type PortfolioUncertainty = "low" | "medium" | "high";
export type PortfolioScoreInput = {
  initiativeValue: PortfolioDimension;
  epicValue: PortfolioDimension;
  featureValue: PortfolioDimension;
  storyImpact: PortfolioDimension | null;
  taskContribution: PortfolioDimension;
  urgency: PortfolioDimension;
  dependencyUnlock: PortfolioDimension;
  workerCoverage: PortfolioDimension;
  effort: PortfolioDimension;
  deliveryRisk: PortfolioDimension;
  uncertainty: PortfolioUncertainty;
  /** This is the last actual evidence confirmation, not calculation time. */
  evidenceConfirmedAt: Date;
};

export type PortfolioScoreResult = {
  version: typeof AMUX_PORTFOLIO_SCORE_VERSION;
  total: number;
  components: {
    initiative: number; epic: number; feature: number; story: number;
    task: number; urgency: number; dependency: number; worker: number;
    effortPenalty: number; riskPenalty: number; uncertaintyPenalty: number;
  };
  evidenceConfirmedAt: string;
  activeStaleAt: string;
  baselineStaleAt: string;
  activeFresh: boolean;
  baselineFresh: boolean;
};

const boundedDimension = (value: number): value is PortfolioDimension =>
  Number.isInteger(value) && value >= 0 && value <= 5;

export function scoreAmuxPortfolio(input: PortfolioScoreInput,
  calculatedAt: Date): PortfolioScoreResult {
  const values = [input.initiativeValue, input.epicValue,
    input.featureValue, input.taskContribution, input.urgency,
    input.dependencyUnlock, input.workerCoverage, input.effort,
    input.deliveryRisk, ...(input.storyImpact === null ? [] : [input.storyImpact])];
  if (values.some((value) => !boundedDimension(value)) ||
      !["low", "medium", "high"].includes(input.uncertainty) ||
      !Number.isFinite(input.evidenceConfirmedAt.getTime()) ||
      !Number.isFinite(calculatedAt.getTime()) ||
      input.evidenceConfirmedAt.getTime() > calculatedAt.getTime()) {
    throw new Error("invalid_portfolio_score_input");
  }
  const components = {
    initiative: input.initiativeValue * 4,
    epic: input.epicValue * 3,
    feature: input.featureValue * 2,
    // Feature-direct Tasks receive the same available weight through their
    // own contribution; lacking a Story must not be a structural penalty.
    story: input.storyImpact === null ? 0 : input.storyImpact * 2,
    task: input.taskContribution * (input.storyImpact === null ? 6 : 4),
    urgency: input.urgency * 2,
    dependency: input.dependencyUnlock,
    worker: input.workerCoverage,
    effortPenalty: input.effort * 2,
    riskPenalty: input.deliveryRisk,
    uncertaintyPenalty: input.uncertainty === "high" ? 10 :
      input.uncertainty === "medium" ? 5 : 0,
  };
  const total = components.initiative + components.epic +
    components.feature + components.story + components.task +
    components.urgency + components.dependency + components.worker -
    components.effortPenalty - components.riskPenalty -
    components.uncertaintyPenalty;
  const observed = input.evidenceConfirmedAt.getTime();
  const activeStaleAt = new Date(observed + AMUX_ACTIVE_SCORE_MAX_AGE_MS);
  const baselineStaleAt = new Date(observed + AMUX_BASELINE_SCORE_MAX_AGE_MS);
  const activeFresh = calculatedAt.getTime() < activeStaleAt.getTime();
  const baselineFresh = calculatedAt.getTime() < baselineStaleAt.getTime();
  return { version: AMUX_PORTFOLIO_SCORE_VERSION, total, components,
    evidenceConfirmedAt: input.evidenceConfirmedAt.toISOString(),
    activeStaleAt: activeStaleAt.toISOString(),
    baselineStaleAt: baselineStaleAt.toISOString(),
    activeFresh, baselineFresh };
}
