import "server-only";

import type { Prisma } from "@prisma/client";

import { ENGINEERING_AGENT_V22_REVIEW_CAUSE_PREFIX } from "@/lib/engineeringAgentCore";
import { PULL_DIGEST_PATTERN } from "@/lib/pullDiffDigestCore";
import { amuxV22ResultReviewRequestEndedSql } from "./decisionMakerRequestStore.ts";
import { AMUX_OWNER_QUEUE_DM_REQUESTED_ACTION, AMUX_OWNER_QUEUE_DM_RESENT_ACTION } from "./ownerQueueDmRequestCore.ts";
import { amuxV22KeptResultPublicationEnabled } from "./v22KeptResultCore.ts";
import { amuxV22KeptResultExistsSql, amuxV22ReviewAttemptLateralSql } from "./v22KeptResultRead.ts";

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
  /** The newest attempt that ended succeeded into review; `attemptId` is it when a review pull request is open. */
  reviewAttemptId: string | null;
  /** The open review pull request's binding, when the publisher opened one as a draft. */
  bindingId: string | null;
};

/**
 * Stopped v22 Tasks to file: an admin-idea-v4 Task in review or blocked, not
 * archived, holding its v22 receipt, role and grade, with an open or
 * acknowledged human escalation that has no settlement yet, nothing running,
 * and no other Decision Maker path holding it -- no result review the Decision
 * Maker still holds (and none it blocked for a person on this run), no worker question
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
  // Owner decision 2026-11-15: a Task holding a kept result -- a reviewed
  // patch whose publication never opened -- needs publishing, not running
  // again, so it is never put to the Decision Maker, whose answers include a
  // retry (v22KeptResultCore.ts). The publication round takes it; a person
  // still settles it from the owner queue. With v22 publication off, nothing
  // publishes it, and it is filed as before.
  const keepsNoResult = !amuxV22KeptResultPublicationEnabled();
  return tx.$queryRaw<AmuxDmOwnerSettlementCandidate[]>`
    SELECT w."id" AS "taskId", e."id" AS "escalationId", w."status" AS "taskStatus",
      -- The attempt a settlement is filed on: a review pull request's own (the
      -- review attempt), every other card's newest. Every caller files this one.
      CASE WHEN b."id" IS NOT NULL THEN ra."id" ELSE a."id" END AS "attemptId",
      ra."id" AS "reviewAttemptId", b."id" AS "bindingId"
    FROM "AmuxHumanEscalation" e
    JOIN "AmuxWorkItem" w ON w."id" = e."taskId"
    LEFT JOIN LATERAL (
      SELECT x."id" FROM "AmuxExecutionAttempt" x WHERE x."taskId" = w."id"
      ORDER BY x."taskRevision" DESC, x."startedAt" DESC, x."id" DESC LIMIT 1
    ) a ON true
    -- The attempt the card's review is for (amuxV22ReviewAttempt): its newest that
    -- ended succeeded into review. A review pull request is that attempt's, so a
    -- kept result published after later attempts failed is found (owner decision
    -- 2026-11-15); when the newest attempt is the review one, the two are the same.
    ${amuxV22ReviewAttemptLateralSql}
    LEFT JOIN LATERAL (
      SELECT bb."id" FROM "EngineeringAgentBinding" bb
      JOIN "EngineeringAgentRun" r ON r."id" = bb."runId"
      JOIN "EngineeringAgentWorkItem" i ON i."causeKey" = (${reviewPrefix}::text || r."id")
      WHERE r."amuxAttemptId" = ra."id" AND r."cardId" = w."id"
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
      -- A result review holds the card only while the Decision Maker holds the
      -- review (owner decision 2026-11-22: "DM은 접근권한 막지 마세요"). One
      -- handed to a person, or whose newest request ended with nothing for
      -- anyone to confirm -- routed to the operator, discarded, closed stale or
      -- answered directly, or a result that is no proposal -- is settled here
      -- instead, so the card is put to the Decision Maker again rather than
      -- waiting on the owner (AMUX-CRAWL-003 waited 12 hours). A proposal, a
      -- confirmation on its way to the walk, or an owner's rejection still holds it.
      AND NOT EXISTS (SELECT 1 FROM "AmuxV22ResultReview" v WHERE v."taskId" = w."id"
        AND ((v."state" = 'open' AND v."handoffAt" IS NULL AND NOT ${amuxV22ResultReviewRequestEndedSql})
          OR (v."attemptId" = a."id" AND v."decision" = 'block')))
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
      AND (${keepsNoResult} OR NOT ${amuxV22KeptResultExistsSql})
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
      !row.diffDigest || !PULL_DIGEST_PATTERN.test(row.diffDigest)) return null;
  return { verifiedHeadSha: row.verifiedHeadSha, diffDigest: row.diffDigest, patchBody: row.patchBody };
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
