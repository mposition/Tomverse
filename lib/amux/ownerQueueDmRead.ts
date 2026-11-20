import "server-only";

import { AMUX_DB_BOUNDARIES, withAmuxDbBoundary } from "@/lib/amux/dbBoundary";
import { readAmuxDmLocalCardState } from "@/lib/amux/v22OwnerQuestionDmRead";
import {
  amuxOwnerQueueDmSettlementOf,
  isAmuxOwnerQueueSettlementRow,
  type AmuxOwnerQueueDmSettlement,
  type AmuxOwnerQueueSettlementRow,
} from "./ownerQueueDmCore.ts";
import type { AmuxV22QuestionDm } from "./v22OwnerQuestionDmCore.ts";

/**
 * The Decision Maker's part of each owner queue card (owner decision
 * 2026-11-13, docs/policy/amux-decision-maker.md §0a-5). Reads only: the
 * settlement of each card's open escalation in one bounded statement, then,
 * for a settlement the Decision Maker's path still holds, where its card
 * stands -- through `readAmuxDmLocalCardState`, the same read as a worker
 * question's and a result review's card. No other table is read here.
 *
 * Nothing in this read can fail the queue. A settlement lookup that fails
 * marks each card `unread`; a card whose state cannot be read is
 * `unavailable` on that card only; a viewer without `ops:write` gets
 * `restricted` in place of the Decision Maker's bodies, as the request drawer
 * does. A card with no settlement is absent from the map.
 */

/** Cards whose Decision Maker card is read in one call; the rest say they were not read. */
export const AMUX_OWNER_QUEUE_DM_READ_LIMIT = 20;
const READ_CONCURRENCY = 4;

export type AmuxOwnerQueueDmCard = { taskId: string; escalationId: string | null };

export async function readAmuxOwnerQueueDm(
  cards: readonly AmuxOwnerQueueDmCard[],
  canReadDm: boolean,
): Promise<Map<string, AmuxOwnerQueueDmSettlement>> {
  const byTask = new Map<string, AmuxOwnerQueueDmSettlement>();
  const withEscalation = cards.filter(
    (card): card is { taskId: string; escalationId: string } => card.escalationId !== null);
  if (withEscalation.length === 0) return byTask;
  const unreadAll = () => {
    for (const card of withEscalation) byTask.set(card.taskId, { status: "unread" });
    return byTask;
  };

  let rows: unknown[];
  try {
    const escalationIds = withEscalation.map((card) => card.escalationId);
    rows = await withAmuxDbBoundary(AMUX_DB_BOUNDARIES.ownerQueueSettlementRead, (tx) =>
      tx.$queryRaw<unknown[]>`
        SELECT s."escalationId", s."id" AS "settlementId", s."kind", s."state", s."decision",
          s."handoffReason", s."localCardId"
        FROM "AmuxDmOwnerSettlement" s
        WHERE s."escalationId" = ANY(${escalationIds})`);
  } catch {
    console.warn(JSON.stringify({ subsystem: "amux", event: "owner_queue_settlement_read_failed" }));
    return unreadAll();
  }
  const settlements = new Map<string, AmuxOwnerQueueSettlementRow>();
  const stored = new Set<string>();
  for (const row of rows) {
    if (isAmuxOwnerQueueSettlementRow(row)) settlements.set(row.escalationId, row);
    else if (row && typeof row === "object" && typeof (row as { escalationId?: unknown }).escalationId === "string")
      stored.add((row as { escalationId: string }).escalationId);
  }

  // A settlement the Decision Maker's path still holds has a card to read.
  const toRead: Array<{ taskId: string; row: AmuxOwnerQueueSettlementRow & { localCardId: string } }> = [];
  for (const card of withEscalation) {
    const row = settlements.get(card.escalationId);
    if (!row) {
      // A row the read could not name is this card's, never a card without a settlement.
      if (stored.has(card.escalationId)) byTask.set(card.taskId, { status: "unread" });
      continue;
    }
    if (row.state === "open" && row.localCardId !== null) toRead.push({ taskId: card.taskId,
      row: { ...row, localCardId: row.localCardId } });
    else byTask.set(card.taskId, amuxOwnerQueueDmSettlementOf(row, null));
  }

  const states = new Map<string, AmuxV22QuestionDm>();
  const reading = toRead.slice(0, AMUX_OWNER_QUEUE_DM_READ_LIMIT);
  for (const { taskId } of toRead.slice(AMUX_OWNER_QUEUE_DM_READ_LIMIT)) states.set(taskId, { state: "unavailable" });
  for (let at = 0; at < reading.length; at += READ_CONCURRENCY) {
    await Promise.all(reading.slice(at, at + READ_CONCURRENCY).map(async ({ taskId, row }) => {
      states.set(taskId, !canReadDm ? { state: "restricted" }
        : await readAmuxDmLocalCardState(row.localCardId).catch((): AmuxV22QuestionDm => ({ state: "unavailable" })));
    }));
  }
  for (const { taskId, row } of toRead) byTask.set(taskId, amuxOwnerQueueDmSettlementOf(row, states.get(taskId) ?? null));
  return byTask;
}
