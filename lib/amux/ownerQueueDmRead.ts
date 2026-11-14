import "server-only";

import { prisma } from "@/lib/prisma";
import { dmInternalRoutesEnabled } from "@/lib/amux/decisionMakerInternalRoute";
import { readDecisionMakerSwitches } from "@/lib/amux/decisionMakerSwitchStore";
import { engineeringAgentT2DmReviewEnabled } from "@/lib/engineeringAgentT2DmReviewCore";
import { amuxDmOwnerSettlementEnabled } from "./dmOwnerSettlementCore.ts";
import {
  readAmuxDmOwnerSettlementRequestedAmong, scanAmuxDmOwnerSettlementCandidates,
} from "./dmOwnerSettlementRead.ts";
import { readAmuxDmRelaySeenAt } from "./dmRelayLivenessStore.ts";
import {
  amuxDmRelayView, amuxOwnerQueueDmRequestResult, amuxOwnerQueueDmView,
  type AmuxDmRelayView, type AmuxOwnerQueueDmFacts, type AmuxOwnerQueueDmRequestFact,
  type AmuxOwnerQueueDmSwitches, type AmuxOwnerQueueDmView,
} from "./ownerQueueDmCore.ts";
import { amuxV22ResultReviewDmEnabled } from "./v22ResultReviewCore.ts";
import { amuxV22Provider } from "./v22WorkerClaimCore.ts";

/**
 * The owner queue's Decision Maker column (ownerQueueDmCore.ts): for each
 * card, the row of every path that could ask the Decision Maker about it, the
 * newest DM request of each filed card, and whether the settlement scan would
 * file its escalation. Reads only, six statements for the whole list, never
 * one per card. A read that fails leaves the column out (null), so the queue
 * still opens; it never shows a state it did not see.
 */

type QuestionRow = { id: string; taskId: string; localCardId: string | null; parked: boolean;
  taskBlocked: boolean; bodyAvailable: boolean; provider: string | null };
type ReviewRow = { id: string; taskId: string; localCardId: string | null; handoffReason: string | null };
type T2Row = { workItemId: string; taskId: string; localCardId: string | null; unfilable: boolean };
type SettlementRow = { id: string; escalationId: string; state: string; localCardId: string | null;
  handoffReason: string | null; cancelReason: string | null };

export type AmuxOwnerQueueDmRead = {
  /** Null when the relay record could not be read (unknown, not "never"). */
  relay: AmuxDmRelayView | null;
  byTask: Map<string, AmuxOwnerQueueDmView>;
};

export async function readAmuxOwnerQueueDm(items: ReadonlyArray<{ taskId: string; escalationId: string | null }>,
  now: Date = new Date()): Promise<AmuxOwnerQueueDmRead> {
  const relay = await readAmuxDmRelaySeenAt().then((at) => amuxDmRelayView(at, now), () => null);
  const taskIds = items.map((item) => item.taskId);
  const escalationIds = items.flatMap((item) => item.escalationId ? [item.escalationId] : []);
  if (taskIds.length === 0) return { relay, byTask: new Map() };

  const [questions, reviews, t2s, settlements, eligible, dmSwitches] = await Promise.all([
    prisma.$queryRaw<QuestionRow[]>`
      SELECT DISTINCT ON (q."taskId") q."id", q."taskId", q."localCardId",
        (a."endedAt" IS NOT NULL AND a."reason" = 'owner_question') AS "parked",
        (w."status" = 'blocked' AND w."archivedAt" IS NULL) AS "taskBlocked",
        (r."attemptId" IS NOT NULL AND r."bodyPurgedAt" IS NULL) AS "bodyAvailable",
        g."provider"
      FROM "AmuxV22TaskQuestion" q
      JOIN "AmuxWorkItem" w ON w."id" = q."taskId"
      LEFT JOIN "AmuxExecutionAttempt" a ON a."id" = q."attemptId"
      LEFT JOIN "AmuxV22TaskResult" r ON r."attemptId" = q."attemptId" AND r."taskId" = q."taskId"
      LEFT JOIN "AmuxV22WorkerAssignment" g ON g."id" = a."v22AssignmentId"
      WHERE q."taskId" = ANY(${taskIds}::text[]) AND q."state" = 'open'
      ORDER BY q."taskId", q."sequence" DESC`,
    prisma.$queryRaw<ReviewRow[]>`
      SELECT DISTINCT ON (v."taskId") v."id", v."taskId", v."localCardId", v."handoffReason"
      FROM "AmuxV22ResultReview" v
      WHERE v."taskId" = ANY(${taskIds}::text[]) AND v."state" = 'open'
      ORDER BY v."taskId", v."createdAt" DESC`,
    // A draft with no patch is never put to the Decision Maker, so it is not a path.
    prisma.$queryRaw<T2Row[]>`
      SELECT DISTINCT ON (r."cardId") i."id" AS "workItemId", r."cardId" AS "taskId",
        d."localCardId", (d."unfilableAt" IS NOT NULL) AS "unfilable"
      FROM "EngineeringAgentWorkItem" i
      JOIN "EngineeringAgentRun" r ON r."id" = i."runId"
      LEFT JOIN "EngineeringAgentDmReview" d ON d."workItemId" = i."id"
      WHERE r."cardId" = ANY(${taskIds}::text[]) AND i."kind" = 't2_draft' AND i."state" = 'open'
        AND i."patchBody" IS NOT NULL
      ORDER BY r."cardId", i."createdAt" DESC`,
    escalationIds.length === 0 ? Promise.resolve([] as SettlementRow[]) : prisma.$queryRaw<SettlementRow[]>`
      SELECT s."id", s."escalationId", s."state", s."localCardId", s."handoffReason", s."cancelReason"
      FROM "AmuxDmOwnerSettlement" s WHERE s."escalationId" = ANY(${escalationIds}::text[])`,
    escalationIds.length === 0 ? Promise.resolve([]) :
      scanAmuxDmOwnerSettlementCandidates(prisma, escalationIds.length, escalationIds),
    dmInternalRoutesEnabled() ? readDecisionMakerSwitches(prisma) : Promise.resolve(null),
  ]);
  const requested = await readAmuxDmOwnerSettlementRequestedAmong(prisma, settlements.map((row) => row.id));

  const cardIds = [...questions, ...reviews, ...t2s, ...settlements]
    .flatMap((row) => row.localCardId ? [row.localCardId] : []);
  const requests = new Map<string, AmuxOwnerQueueDmRequestFact>();
  if (cardIds.length > 0) {
    // A proposal the owner can still confirm: a proposal result and no
    // judgment. Any other result, or a judged one, is `closed`.
    const rows = await prisma.$queryRaw<Array<{ id: string; cardId: string; resultKind: string | null;
      judged: boolean }>>`
      SELECT DISTINCT ON (q."cardId") q."id", q."cardId", d."resultKind",
        EXISTS (SELECT 1 FROM "AmuxDecisionMakerJudgment" j WHERE j."requestId" = q."id") AS "judged"
      FROM "AmuxDecisionMakerRequest" q
      LEFT JOIN "AmuxDecisionMakerResultDetail" d ON d."requestId" = q."id"
      WHERE q."cardId" = ANY(${cardIds}::text[])
      ORDER BY q."cardId", q."questionRevision" DESC`;
    for (const row of rows) requests.set(row.cardId, { requestId: row.id,
      result: amuxOwnerQueueDmRequestResult(row) });
  }
  const requestOf = (cardId: string | null) => (cardId ? requests.get(cardId) : undefined) ?? null;

  const switches: AmuxOwnerQueueDmSwitches = {
    routing: dmInternalRoutesEnabled(),
    killSwitch: dmSwitches?.killSwitch ?? null,
    resultReview: amuxV22ResultReviewDmEnabled(),
    t2: engineeringAgentT2DmReviewEnabled(),
    settlement: amuxDmOwnerSettlementEnabled(),
  };
  const byKey = <T,>(rows: T[], key: (row: T) => string) => new Map(rows.map((row) => [key(row), row]));
  const questionBy = byKey(questions, (row) => row.taskId);
  const reviewBy = byKey(reviews, (row) => row.taskId);
  const t2By = byKey(t2s, (row) => row.taskId);
  const settlementBy = byKey(settlements, (row) => row.escalationId);
  const eligibleSet = new Set(eligible.map((row) => row.escalationId));

  const byTask = new Map<string, AmuxOwnerQueueDmView>();
  for (const item of items) {
    const question = questionBy.get(item.taskId);
    const review = reviewBy.get(item.taskId);
    const t2 = t2By.get(item.taskId);
    const settlement = item.escalationId ? settlementBy.get(item.escalationId) : undefined;
    const facts: AmuxOwnerQueueDmFacts = {
      question: question ? { id: question.id, localCardId: question.localCardId,
        request: requestOf(question.localCardId), parked: question.parked, taskBlocked: question.taskBlocked,
        bodyAvailable: question.bodyAvailable,
        providerKnown: question.provider !== null && amuxV22Provider(question.provider) !== null } : null,
      review: review ? { id: review.id, localCardId: review.localCardId, request: requestOf(review.localCardId),
        handoffReason: review.handoffReason } : null,
      t2: t2 ? { workItemId: t2.workItemId, localCardId: t2.localCardId, request: requestOf(t2.localCardId),
        unfilable: t2.unfilable } : null,
      settlement: settlement ? { id: settlement.id, state: settlement.state, localCardId: settlement.localCardId,
        request: requestOf(settlement.localCardId), handoffReason: settlement.handoffReason,
        cancelReason: settlement.cancelReason, requested: requested.has(settlement.id) } : null,
      escalationId: item.escalationId,
      settlementEligible: item.escalationId !== null && eligibleSet.has(item.escalationId),
    };
    byTask.set(item.taskId, amuxOwnerQueueDmView(facts, switches));
  }
  return { relay, byTask };
}
