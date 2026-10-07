import { z } from "zod";

const rating = z.number().int().min(0).max(5);
const opaqueId = z.string().regex(/^[A-Za-z0-9:_-]{8,128}$/);

export const amuxPortfolioAssessmentPayloadSchema = z.object({
  id: z.uuid(), requestId: z.uuid(),
  subject: z.object({ kind: z.enum(["initiative", "epic", "feature", "story", "task"]),
    id: opaqueId }).strict(),
  metrics: z.unknown(),
  uncertainty: z.enum(["low", "medium", "high"]),
  evidenceRefs: z.array(opaqueId).min(1).max(16),
  evidenceAsOf: z.iso.datetime({ offset: true }),
  reasonCode: z.enum(["initial", "new_evidence", "operator_override", "major_event"]),
  modelProposalDigest: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
}).strict();

export const amuxPortfolioScorePayloadSchema = z.object({
  id: z.uuid(), requestId: z.uuid(), taskId: opaqueId,
}).strict();

export const amuxPortfolioAssessmentApprovalSchema = z.object({
  payload: amuxPortfolioAssessmentPayloadSchema,
  confirmationDigest: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

export const amuxPortfolioScoreApprovalSchema = z.object({
  payload: amuxPortfolioScorePayloadSchema,
  confirmationDigest: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

const metricSchemas = {
  initiative: z.object({ value: rating }).strict(),
  epic: z.object({ value: rating }).strict(),
  feature: z.object({ value: rating }).strict(),
  story: z.object({ impact: rating }).strict(),
  task: z.object({ contribution: rating, urgency: rating,
    dependencyUnlock: rating, workerCoverage: rating,
    effort: rating, deliveryRisk: rating }).strict(),
} as const;

export type AmuxPortfolioAssessmentPayload = z.infer<
  typeof amuxPortfolioAssessmentPayloadSchema>;
export type AmuxPortfolioScorePayload = z.infer<typeof amuxPortfolioScorePayloadSchema>;

export function parseAmuxPortfolioMetrics(kind: keyof typeof metricSchemas,
  value: unknown): Record<string, number> {
  return metricSchemas[kind].parse(value);
}
