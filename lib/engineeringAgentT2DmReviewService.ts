import "server-only";

import type { Prisma } from "@prisma/client";

import { BoardImportError } from "@/lib/amux/boardImportCore";
import { engineeringAgentT2DmCard } from "@/lib/engineeringAgentT2DmReviewCore";

/**
 * A T2 draft put to the Decision Maker for advice (lib/engineeringAgentT2DmReviewCore.ts).
 * The relay's v22 question tick reads the open drafts with no card yet and
 * the cards of drafts no longer open; it names each card it files once, and
 * each card it closes once. The draft's id is the question id. Nothing here
 * changes a draft: the answer is read beside it in Admin and decides nothing.
 */

const CARD_ID = /^[A-Za-z0-9_-]{1,64}$/;
const QUESTION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const ENGINEERING_AGENT_T2_DM_SYNC_LIMIT = 3;

type PendingDraft = { workItemId: string; reason: string | null; patchBody: string | null; cardLabel: string | null };

/** Open T2 drafts with a patch and no card yet, and cards of drafts no longer
 * open that the relay has not closed. Two statements. */
export async function readEngineeringAgentT2DmSyncRows(tx: Prisma.TransactionClient) {
  const pending = await tx.$queryRaw<PendingDraft[]>`
    SELECT w."id" AS "workItemId", w."reason", w."patchBody",
      coalesce(c."displayKey", c."id") AS "cardLabel"
    FROM "EngineeringAgentWorkItem" w
    LEFT JOIN "EngineeringAgentRun" r ON r."id" = w."runId"
    LEFT JOIN "AmuxWorkItem" c ON c."id" = r."cardId"
    LEFT JOIN "EngineeringAgentDmReview" d ON d."workItemId" = w."id"
    WHERE w."kind" = 't2_draft' AND w."state" = 'open' AND w."patchBody" IS NOT NULL
      AND d."workItemId" IS NULL
    ORDER BY w."createdAt", w."id"
    LIMIT ${ENGINEERING_AGENT_T2_DM_SYNC_LIMIT}`;
  const closing = await tx.$queryRaw<Array<{ questionId: string; cardId: string }>>`
    SELECT d."workItemId" AS "questionId", d."localCardId" AS "cardId"
    FROM "EngineeringAgentDmReview" d
    JOIN "EngineeringAgentWorkItem" w ON w."id" = d."workItemId"
    WHERE w."state" <> 'open' AND d."localCardClosedAt" IS NULL
    ORDER BY d."createdAt", d."workItemId"
    LIMIT ${ENGINEERING_AGENT_T2_DM_SYNC_LIMIT}`;
  return { pending, closing };
}

/** The cards the relay files; a draft whose card cannot be written is left out. */
export function engineeringAgentT2DmCards(pending: PendingDraft[]) {
  return pending
    .map((row) => engineeringAgentT2DmCard({ workItemId: row.workItemId,
      cardLabel: row.cardLabel ?? "engineering draft", reason: row.reason, patchBody: row.patchBody }))
    .filter((card): card is NonNullable<typeof card> => card !== null);
}

/** Names the local card of a draft, once; the same card again is a read.
 * Null when the question is not a T2 draft's. Two statements at most. */
export async function recordEngineeringAgentT2DmLocalCard(tx: Prisma.TransactionClient,
  input: { questionId: string; cardId: string }) {
  if (!QUESTION_ID.test(input.questionId) || !CARD_ID.test(input.cardId)) return null;
  const inserted = await tx.$queryRaw<Array<{ workItemId: string }>>`
    INSERT INTO "EngineeringAgentDmReview" ("workItemId", "localCardId")
    SELECT w."id", ${input.cardId}::text FROM "EngineeringAgentWorkItem" w
    WHERE w."id" = ${input.questionId} AND w."kind" = 't2_draft'
    ON CONFLICT DO NOTHING
    RETURNING "workItemId"`;
  if (inserted.length === 1) return { recorded: true as const };
  const row = await tx.engineeringAgentDmReview.findUnique({
    where: { workItemId: input.questionId }, select: { localCardId: true } });
  if (!row) return null;
  if (row.localCardId !== input.cardId) throw new BoardImportError("card_conflict", 409);
  return { recorded: true as const };
}

/** Records that the relay closed a draft's card, once, after the draft left
 * the queue. Null when the question is not a T2 draft's. Two statements at most. */
export async function recordEngineeringAgentT2DmLocalCardClosed(tx: Prisma.TransactionClient,
  input: { questionId: string; cardId: string; now: Date }) {
  if (!QUESTION_ID.test(input.questionId) || !CARD_ID.test(input.cardId)) return null;
  const at = input.now.toISOString();
  const changed = await tx.$queryRaw<Array<{ workItemId: string }>>`
    UPDATE "EngineeringAgentDmReview" d
    SET "localCardClosedAt" = (${at}::timestamptz AT TIME ZONE 'UTC')
    FROM "EngineeringAgentWorkItem" w
    WHERE d."workItemId" = ${input.questionId} AND d."localCardId" = ${input.cardId}
      AND d."localCardClosedAt" IS NULL AND w."id" = d."workItemId" AND w."state" <> 'open'
    RETURNING d."workItemId"`;
  if (changed.length === 1) return { recorded: true as const };
  const row = await tx.engineeringAgentDmReview.findUnique({
    where: { workItemId: input.questionId }, select: { localCardId: true, localCardClosedAt: true } });
  if (!row) return null;
  if (row.localCardId !== input.cardId || !row.localCardClosedAt)
    throw new BoardImportError("not_closable", 409);
  return { recorded: true as const };
}
