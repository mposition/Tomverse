import { z } from "zod";

export const RESEARCH_PREVIEW_RUN_PUBLIC_STATUSES = [
  "queued",
  "running",
  "checkpointed",
  "completed",
  "failed",
  "cancelled",
  "attention",
  // Engine v2 only. A v1 row never enters these states.
  "draft",
  "planning",
  "awaiting_input",
  "paused",
  "finalizing",
] as const;

export const RESEARCH_PREVIEW_RUN_STATUSES = [
  "preparing",
  ...RESEARCH_PREVIEW_RUN_PUBLIC_STATUSES,
] as const;

export const RESEARCH_PREVIEW_GENERATION_STATUSES = [
  "intent",
  "dispatch_started",
  "completed",
  "dispatch_refused",
  "outcome_unknown",
] as const;

export const RESEARCH_PREVIEW_RUN_STOP_REASONS = [
  "report_submitted",
  "invalid_report",
  "unknown_source",
  "missing_report",
  "budget_exhausted",
  "usage_unknown",
  "timeout",
  "aborted",
  "provider_error",
  "cancelled",
  "outcome_unknown",
  "checkpoint_expired",
  "dispatch_refused",
  // Engine v2 only.
  "partial_report",
  "run_deadline",
  "source_revoked",
] as const;

export type ResearchPreviewRunStatus =
  (typeof RESEARCH_PREVIEW_RUN_STATUSES)[number];
export type ResearchPreviewRunPublicStatus =
  (typeof RESEARCH_PREVIEW_RUN_PUBLIC_STATUSES)[number];
export type ResearchPreviewGenerationStatus =
  (typeof RESEARCH_PREVIEW_GENERATION_STATUSES)[number];
export type ResearchPreviewRunStopReason =
  (typeof RESEARCH_PREVIEW_RUN_STOP_REASONS)[number];

export const researchPreviewRunStatusSchema = z.enum(
  RESEARCH_PREVIEW_RUN_STATUSES
);
export const researchPreviewGenerationStatusSchema = z.enum(
  RESEARCH_PREVIEW_GENERATION_STATUSES
);
export const researchPreviewRunStopReasonSchema = z.enum(
  RESEARCH_PREVIEW_RUN_STOP_REASONS
);

const idSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/);

export const researchPreviewRunCreateSchema = z
  .object({
    conversationId: idSchema,
    sourceUserMessageId: z.string().uuid(),
    assistantMessageId: z.string().uuid(),
    modelId: z.string().trim().min(1).max(100),
    locale: z
      .string()
      .trim()
      .min(2)
      .max(16)
      .regex(/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/)
      .optional(),
  })
  .strict();

export type ResearchPreviewRunCreateInput = z.infer<
  typeof researchPreviewRunCreateSchema
>;

export type ResearchPreviewRunMessage = {
  id: string;
  role: string;
  content: string;
  status: string;
  modelId: string | null;
  pendingJobId: string | null;
  researchRunId: string | null;
  searchMetadata: unknown;
  createdAt: Date | string;
  [key: string]: unknown;
};

export type ResearchPreviewRunDto = {
  id: string;
  /** 1 = Preview, 2 = Deep Research engine; clients render v2 with the shared workspace. */
  engineVersion?: 1 | 2;
  conversationId: string;
  assistantMessageId: string;
  modelId: string;
  status: ResearchPreviewRunPublicStatus;
  stepCount: number;
  searchCount: number;
  readCount: number;
  canResume: boolean;
  stopReason?: ResearchPreviewRunStopReason;
  createdAt: Date | string;
  updatedAt: Date | string;
  message?: ResearchPreviewRunMessage;
};

export const toResearchPreviewRunPublicStatus = (
  status: ResearchPreviewRunStatus
): ResearchPreviewRunPublicStatus => (status === "preparing" ? "queued" : status);
