import { z } from "zod";

import { AMUX_EXECUTION_GRADE_PROPOSALS, AMUX_TASK_ROLE_PROPOSALS } from
  "./ideaAnalysisChunkCore.ts";

const id = z.uuid();
const text = (max: number) => z.string().min(1).max(max);
const card = z.object({
  cardType: z.enum(["story", "task"]),
  storyKind: z.enum(["general", "bug"]).nullable(),
  title: text(200), problem: text(2_000),
  scopeIn: z.array(text(500)).min(1).max(12),
  scopeOut: z.array(text(500)).max(12),
  completionCriteria: z.array(text(500)).min(1).max(12),
  featureRef: text(128), parentStoryRef: text(128).nullable(),
  dependencyRefs: z.array(text(128)).max(16),
  duplicateCandidateRefs: z.array(text(128)).max(8),
  taskRole: z.enum(AMUX_TASK_ROLE_PROPOSALS).nullable(),
  executionGrade: z.enum(AMUX_EXECUTION_GRADE_PROPOSALS).nullable(),
  executionBrief: text(2_000).nullable(),
}).strict();

export const amuxDerivationPayloadSchema = z.object({
  ideaId: z.string().regex(/^[A-Za-z0-9:_-]{8,80}$/),
  groupId: id, requestId: id,
  operation: z.enum(["split", "merge"]),
  sourceUnitIds: z.array(id).min(1).max(40),
  targetUnitIds: z.array(id).min(1).max(40),
  cards: z.array(card).min(1).max(40),
  reason: text(500),
}).strict();

export const amuxDerivationApprovalSchema = z.object({
  payload: amuxDerivationPayloadSchema,
  confirmationDigest: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
