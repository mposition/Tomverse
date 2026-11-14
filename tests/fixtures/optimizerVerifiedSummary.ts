import { observeOptimizerCost, type OptimizerCostCoverage } from "../../lib/autoOptimizerCost";
import { optimizerEvaluation } from "../../lib/autoRouterOptimizerCore";

/** Explicit new-cycle evidence; legacy fixtures opt out instead of being backfilled. */
export const verifiedOptimizerSummary = () => {
  const cost = observeOptimizerCost({ inputTokens: 1, outputTokens: 1 }, { inputUsdPerMillionTokens: 1, outputUsdPerMillionTokens: 1 });
  if (cost.state !== "known") throw new Error("Invalid test cost fixture");
  const costCoverage: OptimizerCostCoverage = {
    version: "optimizer-cost-v1", basis: "reported_usage_configured_prices", complete: true,
    knownMicroUsd: cost.amountMicroUsd, started: 1, completed: 1, notStarted: 0, failed: 0,
    knownCalls: 1, noDispatchCalls: 0, unknownCalls: 0, usagePricedCalls: 1,
    calls: [{ kind: "generate", provider: "test", failed: false, ...cost }],
  };
  return {
    evaluated: 12, unchanged: 0, decided: 6, candidateWins: 6, incumbentWins: 0,
    ties: 0, undecided: 6, unrouted: 0, incumbentCredits: 12, candidateCredits: 12,
    evaluation: optimizerEvaluation(true), costCoverage,
    quality: { status: "passed" as const, failure: null },
    gate: { basis: "judged" as const, failure: null, towardWinner: 0, towardLoser: 0 },
  };
};
