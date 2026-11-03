import type { AiReviewJudgedRunAggregate } from "./aiReviewJudgedRunAggregate";
import type {
  AiReviewJudgementRecord,
  AiReviewJudgedCase,
  AiReviewJudgedOutcome,
} from "./aiReviewEvalJudgement";

export type AiReviewCaseEvidence = {
  caseId: string;
  language: string;
  taskType: string;
  phenomenon: string;
  question: string;
  responses: Array<{ label: string; content: string }>;
  testCase: AiReviewJudgedCase;
  record: AiReviewJudgementRecord;
  outcome: AiReviewJudgedOutcome;
  /** Indexes from the scorer's own population, not a second role filter. */
  scoredClaimIndexes: number[];
};

export type AiReviewJudgedRunReport = {
  id: string;
  datasetVersion: string | null;
  datasetDigest: string | null;
  generatedAt: string | null;
  plannedCases: number | null;
  completedCases: number | null;
  journalEntries: number;
  bundleCount: number;
  planCount: number;
  result: AiReviewJudgedRunAggregate;
  /** Only exposed after the entire run passes shared verification. */
  cases: AiReviewCaseEvidence[];
};

export type AiReviewJudgedRunCatalog = {
  state: "unconfigured" | "available" | "unavailable";
  reports: AiReviewJudgedRunReport[];
  problems: string[];
};
