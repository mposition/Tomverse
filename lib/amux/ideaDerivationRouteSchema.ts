import { z } from "zod";

import { AMUX_EXECUTION_GRADE_PROPOSALS, AMUX_TASK_ROLE_PROPOSALS } from
  "./ideaAnalysisChunkCore.ts";

// Owner direction 2026-11-15: a split or merge card has no length or count
// limit. Refs keep their 128-character format bound.
const id = z.uuid();
const text = (max?: number) => max === undefined ? z.string().min(1) : z.string().min(1).max(max);
const card = z.object({
  cardType: z.enum(["story", "task"]),
  storyKind: z.enum(["general", "bug"]).nullable(),
  title: text(), problem: text(),
  scopeIn: z.array(text()).min(1),
  scopeOut: z.array(text()),
  completionCriteria: z.array(text()).min(1),
  featureRef: text(128), parentStoryRef: text(128).nullable(),
  dependencyRefs: z.array(text(128)),
  duplicateCandidateRefs: z.array(text(128)),
  taskRole: z.enum(AMUX_TASK_ROLE_PROPOSALS).nullable(),
  executionGrade: z.enum(AMUX_EXECUTION_GRADE_PROPOSALS).nullable(),
  executionBrief: text().nullable(),
}).strict();

export const amuxDerivationPayloadSchema = z.object({
  ideaId: z.string().regex(/^[A-Za-z0-9:_-]{8,80}$/),
  groupId: id, requestId: id,
  operation: z.enum(["split", "merge"]),
  sourceUnitIds: z.array(id).min(1),
  targetUnitIds: z.array(id).min(1),
  cards: z.array(card).min(1),
  reason: text(500),
}).strict();

export const amuxDerivationApprovalSchema = z.object({
  payload: amuxDerivationPayloadSchema,
  confirmationDigest: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
