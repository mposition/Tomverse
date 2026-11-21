import { z } from "zod";

/** Owner decision 2026-11-21: the owner edits an active Initiative, Epic or
 * Feature from Admin. One save is one owner decision: an optional content
 * revision (title and description), one new value assessment bound to the
 * node's revision after the save, and the recalculation of every open Task
 * under the node through the existing score writer. */

export const AMUX_NODE_REVISE_ACTION = "amux.v4.portfolio.node.revise";
export const AMUX_NODE_REVISE_TARGET = "AmuxPortfolioNode";
export const AMUX_NODE_TITLE_MAX = 200;
export const AMUX_NODE_DESCRIPTION_MAX = 4_000;

export type AmuxPortfolioNodeLevel = "initiative" | "epic" | "feature";

/** The weight each level's value carries in the Task score
 * (portfolioScoreCore.ts): Initiative x4, Epic x3, Feature x2. */
export const AMUX_NODE_VALUE_WEIGHT: Record<AmuxPortfolioNodeLevel, number> = {
  initiative: 4, epic: 3, feature: 2,
};

const nodeId = z.string().regex(/^[A-Za-z0-9_-]{8,100}$/);
const rating = z.number().int().min(0).max(5);

const singleLine = (max: number) => z.string().trim().min(1).max(max)
  .refine((value) => !/[\u0000-\u001f\u007f]/.test(value), "control_character");
const multiLine = (max: number) => z.string().max(max)
  .transform((value) => value.replace(/\r\n?/g, "\n").trim())
  .refine((value) => !/[\u0000-\u0008\u000b-\u001f\u007f]/.test(value),
    "control_character");

export const amuxPortfolioNodeEditPayloadSchema = z.object({
  /** The new assessment's id and the save's idempotency key. */
  id: z.uuid(), requestId: z.uuid(),
  nodeId, expectedRevision: z.number().int().min(0).max(1_000_000),
  /** Null keeps the current title and description. */
  content: z.object({ title: singleLine(AMUX_NODE_TITLE_MAX),
    description: multiLine(AMUX_NODE_DESCRIPTION_MAX) }).strict().nullable(),
  value: rating,
  uncertainty: z.enum(["low", "medium", "high"]),
  reasonCode: z.enum(["initial", "new_evidence", "operator_override", "major_event"]),
  evidenceAsOf: z.iso.datetime({ offset: true }),
}).strict();

export type AmuxPortfolioNodeEditPayload = z.infer<
  typeof amuxPortfolioNodeEditPayloadSchema>;

export const amuxPortfolioNodeEditApprovalSchema = z.object({
  payload: amuxPortfolioNodeEditPayloadSchema,
  confirmationDigest: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

/** The evidence reference the owner's own edit records: the node and the
 * revision the assessment is bound to. It matches the assessment guard's
 * opaque-id rule (portfolioScoreSchemas.ts). */
export const amuxNodeEditEvidenceRef = (id: string, revision: number) =>
  `node:${id}:r${revision}`;

/** Everything the owner confirmed, canonical and sortable, for the keyed
 * confirmation digest. Plain text never enters it, only the content digest. */
export function amuxNodeEditBinding(input: {
  actorUserId: string; payload: AmuxPortfolioNodeEditPayload;
  level: AmuxPortfolioNodeLevel; priorContentDigest: string;
  nextContentDigest: string | null;
  /** The node's latest assessment the owner saw, or null for a first one. */
  priorAssessmentId: string | null;
  /** Each open Task with its latest score and, for every subject its score
   * reads (Initiative, Epic, Feature, Story, Task), that subject's revision
   * and latest assessment as the preview read them. Anything written
   * meanwhile asks the owner to review again. */
  affectedTasks: ReadonlyArray<AmuxNodeEditTaskInputs>;
}) {
  const { payload } = input;
  return {
    schemaVersion: 2, actorUserId: input.actorUserId,
    id: payload.id, requestId: payload.requestId,
    nodeId: payload.nodeId, level: input.level,
    expectedRevision: payload.expectedRevision,
    priorContentDigest: input.priorContentDigest,
    nextContentDigest: input.nextContentDigest,
    priorAssessmentId: input.priorAssessmentId,
    value: payload.value, uncertainty: payload.uncertainty,
    reasonCode: payload.reasonCode,
    evidenceAsOf: new Date(payload.evidenceAsOf).toISOString(),
    affectedTasks: [...input.affectedTasks]
      .map((task) => ({ taskId: task.taskId, scoreId: task.scoreId,
        inputs: task.inputs.map((item) => ({ subjectId: item.subjectId,
          revision: item.revision, assessmentId: item.assessmentId })) }))
      .sort((a, b) => a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0),
  };
}

export type AmuxNodeEditTaskInputs = { taskId: string; scoreId: string | null;
  /** Top down: Initiative, Epic, Feature, then the Story when present, then the Task. */
  inputs: ReadonlyArray<{ subjectId: string; revision: number | null;
    assessmentId: string | null }> };

/** The preview's estimate of a Task's next total: only this level's value
 * component moves. The saved score is recalculated from every input by the
 * score writer, so uncertainty or evidence age may still move it. */
export function amuxProjectedTaskScore(input: {
  level: AmuxPortfolioNodeLevel; nextValue: number;
  currentTotal: number | null; currentComponents: unknown;
}): number | null {
  if (input.currentTotal === null || typeof input.currentComponents !== "object" ||
      input.currentComponents === null) return null;
  const current = (input.currentComponents as Record<string, unknown>)[input.level];
  if (typeof current !== "number" || !Number.isFinite(current)) return null;
  return input.currentTotal - current +
    input.nextValue * AMUX_NODE_VALUE_WEIGHT[input.level];
}

/** A first assessment must say "initial"; a later one must not (the
 * assessment guard's version chain). */
export const amuxNodeEditReasonFits = (reasonCode: string, hasPrior: boolean) =>
  hasPrior ? reasonCode !== "initial" : reasonCode === "initial";
