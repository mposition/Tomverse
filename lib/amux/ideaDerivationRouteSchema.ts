import { z } from "zod";

import { AMUX_EXECUTION_GRADE_PROPOSALS, AMUX_TASK_ROLE_PROPOSALS } from
  "./ideaAnalysisChunkCore.ts";
import { amuxIntakeLegacyLimits } from "./intakeLimitsCore.ts";

// Owner direction 2026-11-15: a split or merge card has no length or count
// limit; the former limits hold only under TOMVERSE_AMUX_INTAKE_LEGACY_LIMITS,
// read when the server starts. Refs keep their 128-character format bound.
const legacy = amuxIntakeLegacyLimits();
const cap = (former: number) => legacy ? former : Number.MAX_SAFE_INTEGER;
const id = z.uuid();
const text = (max: number) => z.string().min(1).max(max);
const card = z.object({
  cardType: z.enum(["story", "task"]),
  storyKind: z.enum(["general", "bug"]).nullable(),
  title: text(cap(200)), problem: text(cap(2_000)),
  scopeIn: z.array(text(cap(500))).min(1).max(cap(12)),
  scopeOut: z.array(text(cap(500))).max(cap(12)),
  completionCriteria: z.array(text(cap(500))).min(1).max(cap(12)),
  featureRef: text(128), parentStoryRef: text(128).nullable(),
  dependencyRefs: z.array(text(128)).max(cap(16)),
  duplicateCandidateRefs: z.array(text(128)).max(cap(8)),
  taskRole: z.enum(AMUX_TASK_ROLE_PROPOSALS).nullable(),
  executionGrade: z.enum(AMUX_EXECUTION_GRADE_PROPOSALS).nullable(),
  executionBrief: text(cap(2_000)).nullable(),
}).strict();

export const amuxDerivationPayloadSchema = z.object({
  ideaId: z.string().regex(/^[A-Za-z0-9:_-]{8,80}$/),
  groupId: id, requestId: id,
  operation: z.enum(["split", "merge"]),
  sourceUnitIds: z.array(id).min(1).max(cap(40)),
  targetUnitIds: z.array(id).min(1).max(cap(40)),
  cards: z.array(card).min(1).max(cap(40)),
  reason: text(500),
}).strict();

export const amuxDerivationApprovalSchema = z.object({
  payload: amuxDerivationPayloadSchema,
  confirmationDigest: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
