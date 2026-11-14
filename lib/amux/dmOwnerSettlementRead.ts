import "server-only";

import type { Prisma } from "@prisma/client";

import { ENGINEERING_AGENT_V22_REVIEW_CAUSE_PREFIX } from "@/lib/engineeringAgentCore";
import { AMUX_OWNER_QUEUE_DM_REQUESTED_ACTION, AMUX_OWNER_QUEUE_DM_RESENT_ACTION } from "./ownerQueueDmRequestCore.ts";

/**
 * The reads of the owner queue settlement (lib/amux/dmOwnerSettlementService.ts)
 * that look at the engineering agent's tables. They live apart from the
 * settlement's writers and only read: the binding, run and work item rows
 * stay their own store's (scripts/check-protected-table-writers-core.mjs).
 * Each function is one statement.
 */

export type AmuxDmOwnerSettlementCandidate = {
  taskId: string; escalationId: string; taskStatus: "review" | "blocked";
  attemptId: string | null;
  /** The open review pull request's binding, when the publisher opened one as a draft. */
  bindingId: string | null;
};

/**
 * Stopped v22 Tasks to file: an admin-idea-v4 Task in review or blocked, not
 * archived, holding its v22 receipt, role and grade, with an open or
 * acknowledged human escalation that has no settlement yet, nothing running,
 * and no other Decision Maker path holding it -- no open result review (and
 * none the Decision Maker blocked for a person on this run), no worker question
 * waiting, no open refused session answer or card close question on its idea.
 * The engineering side must be done with it: no work item still in flight for
 * any of its runs, and no open pull request but the review draft the
 * publisher opened for its newest run (an ordinary one is on the merge
 * observer's path). The oldest escalations first. `escalationIds` narrows the
 * scan to those escalations: the owner queue asks which of its cards would be
 * filed, and the owner's request files one (ownerQueueDmRequestService.ts).
 */
export async function scanAmuxDmOwnerSettlementCandidates(tx: Prisma.TransactionClient, limit: number,
  escalationIds: string[] | null = null) {
  const reviewPrefix = ENGINEERING_AGENT_V22_REVIEW_CAUSE_PREFIX;
  return tx.$queryRaw<AmuxDmOwnerSettlementCandidate[]>`
    SELECT w."id" AS "taskId", e."id" AS "escalationId", w."status" AS "taskStatus",
      a."id" AS "attemptId", b."id" AS "bindingId"
    FROM "AmuxHumanEscalation" e
    JOIN "AmuxWorkItem" w ON w."id" = e."taskId"
    LEFT JOIN LATERAL (
      SELECT x."id" FROM "AmuxExecutionAttempt" x WHERE x."taskId" = w."id"
      ORDER BY x."taskRevision" DESC, x."startedAt" DESC, x."id" DESC LIMIT 1
    ) a ON true
    LEFT JOIN LATERAL (
      SELECT bb."id" FROM "EngineeringAgentBinding" bb
      JOIN "EngineeringAgentRun" r ON r."id" = bb."runId"
      JOIN "EngineeringAgentWorkItem" i ON i."causeKey" = (${reviewPrefix}::text || r."id")
      WHERE r."amuxAttemptId" = a."id" AND r."cardId" = w."id"
        AND bb."state" = 'open' AND bb."supersededAt" IS NULL AND i."kind" = 'publish'
      ORDER BY bb."createdAt" DESC, bb."id" DESC LIMIT 1
    ) b ON true
    WHERE e."status" IN ('open', 'acknowledged')
      AND (${escalationIds === null} OR e."id" = ANY(${escalationIds ?? []}::text[]))
      AND w."sourceSystem" = 'admin-idea-v4' AND w."cardType" = 'task'
      AND w."status" IN ('review', 'blocked') AND w."archivedAt" IS NULL
      AND w."v22ReceiptId" IS NOT NULL AND w."taskRole" IS NOT NULL AND w."executionGrade" IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM "AmuxDmOwnerSettlement" s WHERE s."escalationId" = e."id")
      AND NOT EXISTS (SELECT 1 FROM "AmuxExecutionAttempt" x
        WHERE x."taskId" = w."id" AND x."endedAt" IS NULL)
      AND NOT EXISTS (SELECT 1 FROM "AmuxWorkDelivery" d
        WHERE d."taskId" = w."id" AND d."status" IN ('queued', 'leased'))
      AND NOT EXISTS (SELECT 1 FROM "AmuxV22ResultReview" v WHERE v."taskId" = w."id"
        AND (v."state" = 'open' OR (v."attemptId" = a."id" AND v."decision" = 'block')))
      AND NOT EXISTS (SELECT 1 FROM "AmuxV22TaskQuestion" q
        WHERE q."taskId" = w."id" AND q."state" IN ('open', 'answered'))
      AND NOT EXISTS (SELECT 1 FROM "AmuxIdeaUnitDecision" u
        JOIN "AmuxIdeaSessionPlanRefusal" f ON f."ideaId" = u."ideaId"
        WHERE u."registeredWorkItemId" = w."id" AND f."state" = 'open')
      AND NOT EXISTS (SELECT 1 FROM "AmuxIdeaUnitDecision" u
        JOIN "AmuxIdeaCardCloseQuestion" c ON c."ideaId" = u."ideaId"
        WHERE u."registeredWorkItemId" = w."id" AND c."state" = 'open')
      AND NOT EXISTS (SELECT 1 FROM "EngineeringAgentWorkItem" i
        JOIN "EngineeringAgentRun" r ON r."id" = i."runId"
        WHERE r."cardId" = w."id" AND (
          (i."kind" IN ('publish', 'expire_close', 'prune') AND
            i."state" IN ('queued', 'claimed', 'needs_lookup', 'outcome_unknown')) OR
          (i."kind" IN ('t2_draft', 'decision', 'state_mismatch') AND i."state" = 'open')))
      AND (b."id" IS NOT NULL OR NOT EXISTS (SELECT 1 FROM "EngineeringAgentBinding" ob
        JOIN "EngineeringAgentRun" r ON r."id" = ob."runId"
        WHERE r."cardId" = w."id" AND ob."state" = 'open'))
    ORDER BY e."createdAt", e."id"
    LIMIT ${limit}`;
}

/** The pull request number and the patch its publisher applied, for each
 * review pull request binding: the evidence a t2_pr card shows. */
export async function readAmuxDmOwnerSettlementPullEvidence(tx: Prisma.TransactionClient,
  bindingIds: string[]) {
  if (bindingIds.length === 0) return [];
  const reviewPrefix = ENGINEERING_AGENT_V22_REVIEW_CAUSE_PREFIX;
  return tx.$queryRaw<Array<{ bindingId: string; prNumber: number; patchBody: string | null }>>`
    SELECT b."id" AS "bindingId", coalesce(b."currentPrNumber", b."prNumber") AS "prNumber",
      i."patchBody"
    FROM "EngineeringAgentBinding" b
    JOIN "EngineeringAgentRun" r ON r."id" = b."runId"
    LEFT JOIN "EngineeringAgentWorkItem" i
      ON i."causeKey" = (${reviewPrefix}::text || r."id") AND i."kind" = 'publish'
    WHERE b."id" = ANY(${bindingIds})`;
}

/**
 * What an approval of a review pull request names: the binding's verified
 * head and the diff digest its snapshot holds, while the binding is still the
 * open, current one for the settled run, and the patch its publisher applied
 * (null when it is gone), which the develop merge gate judges (owner decision
 * 2026-11-13, lib/amux/dmT2MergeCore.ts). Null when the binding is not.
 */
export async function readAmuxDmOwnerSettlementApprovalFacts(tx: Prisma.TransactionClient,
  input: { bindingId: string; attemptId: string }) {
  const reviewPrefix = ENGINEERING_AGENT_V22_REVIEW_CAUSE_PREFIX;
  const rows = await tx.$queryRaw<Array<{ verifiedHeadSha: string; diffDigest: string | null;
    patchBody: string | null }>>`
    SELECT b."verifiedHeadSha", b."snapshot"->>'diffDigest' AS "diffDigest", i."patchBody"
    FROM "EngineeringAgentBinding" b
    JOIN "EngineeringAgentRun" r ON r."id" = b."runId"
    LEFT JOIN "EngineeringAgentWorkItem" i
      ON i."causeKey" = (${reviewPrefix}::text || r."id") AND i."kind" = 'publish'
    WHERE b."id" = ${input.bindingId} AND r."amuxAttemptId" = ${input.attemptId}
      AND b."state" = 'open' AND b."supersededAt" IS NULL`;
  const row = rows[0];
  if (!row || !/^[0-9a-f]{40}$/.test(row.verifiedHeadSha) ||
      !row.diffDigest || !/^[0-9a-f]{64}$/.test(row.diffDigest)) return null;
  return { verifiedHeadSha: row.verifiedHeadSha, diffDigest: row.diffDigest, patchBody: row.patchBody };
}

/**
 * The open settlements without a card that the owner asked for from the owner
 * queue (their audit entry, ownerQueueDmRequestService.ts): the sync files
 * these while TOMVERSE_AMUX_DM_OWNER_SETTLEMENT is off. One statement.
 */
export async function readAmuxDmOwnerSettlementRequestedIds(tx: Prisma.TransactionClient,
  limit: number): Promise<string[]> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT s."id" FROM "AmuxDmOwnerSettlement" s
    WHERE s."state" = 'open' AND s."localCardId" IS NULL AND s."handoffAt" IS NULL
      AND EXISTS (SELECT 1 FROM "AdminAuditLog" l
        WHERE l."action" = ${AMUX_OWNER_QUEUE_DM_REQUESTED_ACTION}
          AND l."targetType" = 'AmuxDmOwnerSettlement' AND l."targetId" = s."id")
    ORDER BY s."createdAt", s."id"
    LIMIT ${limit}`;
  return rows.map((row) => row.id);
}

/** Which of these settlements the owner asked for from the owner queue. One statement. */
export async function readAmuxDmOwnerSettlementRequestedAmong(tx: Prisma.TransactionClient,
  settlementIds: string[]): Promise<Set<string>> {
  if (settlementIds.length === 0) return new Set();
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT DISTINCT l."targetId" AS "id" FROM "AdminAuditLog" l
    WHERE l."action" = ${AMUX_OWNER_QUEUE_DM_REQUESTED_ACTION}
      AND l."targetType" = 'AmuxDmOwnerSettlement' AND l."targetId" = ANY(${settlementIds}::text[])`;
  return new Set(rows.map((row) => row.id));
}

/**
 * Which of these settlements and result reviews the owner sent to the DM from
 * the owner queue -- asked for, or sent again. The DM approver never applies
 * their answers: they stay proposals the owner confirms. One statement.
 */
export async function readAmuxOwnerQueueDmAskedAmong(tx: Prisma.TransactionClient,
  input: { settlementIds: string[]; reviewIds: string[] }): Promise<Set<string>> {
  if (input.settlementIds.length === 0 && input.reviewIds.length === 0) return new Set();
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT DISTINCT l."targetId" AS "id" FROM "AdminAuditLog" l
    WHERE (l."action" = ${AMUX_OWNER_QUEUE_DM_REQUESTED_ACTION} AND l."targetType" = 'AmuxDmOwnerSettlement'
        AND l."targetId" = ANY(${input.settlementIds}::text[]))
      OR (l."action" = ${AMUX_OWNER_QUEUE_DM_RESENT_ACTION} AND l."targetType" = 'AmuxV22ResultReview'
        AND l."targetId" = ANY(${input.reviewIds}::text[]))`;
  return new Set(rows.map((row) => row.id));
}
