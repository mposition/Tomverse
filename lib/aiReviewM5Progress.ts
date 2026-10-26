import type { AiReviewPreparationCatalog } from "./aiReviewPreparation";
import type { AiReviewJudgedRunCatalog } from "./aiReviewJudgedReportTypes";
import {
  AI_REVIEW_EVAL_REGISTER,
  AI_REVIEW_M5_PROMOTION,
} from "./aiReviewEvalRegister";
import {
  AI_REVIEW_JUDGED_THRESHOLD_SETS,
  judgedThresholdProblems,
} from "./aiReviewJudgedThresholds";
import { datasetProblems, freezeDrift } from "./aiReviewEvalRun";

export type AiReviewM5Progress = {
  candidates: number;
  adopted: number;
  frozenAdequateSets: number;
  signedJudgedThresholds: number;
  reportConnection: AiReviewJudgedRunCatalog["state"];
  verifiedRuns: number;
  refusedRuns: number;
  unreadableReports: number;
  registeredApprovedPairs: number;
  observationPolicyRecorded: boolean;
  rollbackDrillRecorded: boolean;
  promotionSignatureRecorded: boolean;
};

/** Inventory of actual records, never a substitute for the promotion gate. */
export function aiReviewM5Progress(
  preparation: AiReviewPreparationCatalog,
  reports: AiReviewJudgedRunCatalog,
): AiReviewM5Progress {
  const cases = preparation.sets.flatMap((set) => set.dataset.cases);
  return {
    candidates: cases.filter((item) => item.status === "candidate").length,
    adopted: cases.filter((item) => item.status === "adopted").length,
    frozenAdequateSets: preparation.sets.filter(
      (set) =>
        !set.shortfalls.length &&
        !datasetProblems(set.dataset).length &&
        !freezeDrift(set.dataset),
    ).length,
    signedJudgedThresholds: AI_REVIEW_JUDGED_THRESHOLD_SETS.filter(
      (set) => !judgedThresholdProblems(set).length,
    ).length,
    reportConnection: reports.state,
    verifiedRuns: reports.reports.filter((report) => report.result.aggregable)
      .length,
    refusedRuns: reports.reports.filter((report) => !report.result.aggregable)
      .length,
    unreadableReports: reports.problems.length,
    registeredApprovedPairs: AI_REVIEW_EVAL_REGISTER.filter(
      (entry) => entry.status === "approved",
    ).length,
    observationPolicyRecorded: Boolean(
      AI_REVIEW_M5_PROMOTION.observationPolicy,
    ),
    rollbackDrillRecorded: Boolean(AI_REVIEW_M5_PROMOTION.rollbackDrill),
    promotionSignatureRecorded: Boolean(
      AI_REVIEW_M5_PROMOTION.promotionSignature,
    ),
  };
}
