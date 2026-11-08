import "server-only";

import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { readBoardWorkerChannels } from "./adminBoardWorkerChannels.ts";
import { readAmuxCardTitle } from "./adminExecutionRead.ts";
import { AMUX_ESCALATION_AWAITING_STATUSES } from "./humanReviewCore.ts";
import {
  AMUX_OWNER_QUEUE_LIMIT,
  amuxAestDayStartMs,
  amuxOwnerQueueWhere,
  type AmuxOwnerQueueItem,
  type AmuxOwnerQueueRead,
} from "./ownerQueueCore.ts";
import { storedAmuxEscalationReasonCode } from "./escalation.ts";

/**
 * How many cards wait on the owner. The sidebar entry, the Execution board's
 * "Waiting on me" tab and the board column read this one count, so a card that
 * is in the attention lane and has an open question counts once.
 */
export const countAmuxOwnerQueue = () =>
  prisma.amuxWorkItem.count({ where: amuxOwnerQueueWhere() });

const rowSelect = {
  id: true, title: true, displayKey: true, sourceKey: true, sourceSystem: true,
  sourceSnapshot: true, status: true, updatedAt: true,
  v4TitleCiphertext: true, v4TitleKeyId: true, v4TitleKeyVersion: true,
  v4TitleDigest: true, v4TitleDigestKeyId: true,
  v22AcceptedAssignment: { select: { workerName: true } },
  // Why each card waits on a person: its newest open escalation, one per card.
  humanEscalations: {
    where: { status: { in: [...AMUX_ESCALATION_AWAITING_STATUSES] } },
    orderBy: { createdAt: "desc" }, take: 1,
    select: { id: true, reason: true, specialty: true, createdAt: true },
  },
  // A worker question still waiting: open, or answered but not yet resumed.
  v22OwnerQuestions: {
    where: { state: { in: ["open", "answered"] } },
    orderBy: { sequence: "desc" }, take: 1,
    select: { state: true, createdAt: true },
  },
} satisfies Prisma.AmuxWorkItemSelect;

/**
 * Escalations a person resolved (the review route records the signed-in email;
 * an automatic resolver records none) and questions a person answered since the
 * day began in Brisbane. A read that fails is null, shown as unknown, never as 0.
 */
async function readProcessedToday(now: Date): Promise<number | null> {
  const since = new Date(amuxAestDayStartMs(now.getTime()));
  try {
    const [escalations, questions] = await Promise.all([
      prisma.amuxHumanEscalation.count({ where: { resolvedAt: { gte: since }, resolvedByEmail: { not: null } } }),
      prisma.amuxV22TaskQuestion.count({ where: { answeredAt: { gte: since }, answerSource: "operator" } }),
    ]);
    return escalations + questions;
  } catch {
    return null;
  }
}

/**
 * The owner queue, read only: the newest cards that wait on the owner (at most
 * `AMUX_OWNER_QUEUE_LIMIT`), with the total of the set so a partial list says
 * so. It reads what the Execution board and the routing report already read,
 * and writes nothing; the decision on a card is made through the existing owner
 * review routes.
 */
export async function readAmuxOwnerQueue(now: Date = new Date()): Promise<AmuxOwnerQueueRead> {
  const where = amuxOwnerQueueWhere();
  const [total, rows, channels, processedToday] = await Promise.all([
    prisma.amuxWorkItem.count({ where }),
    prisma.amuxWorkItem.findMany({
      where, orderBy: [{ updatedAt: "desc" }, { id: "desc" }], take: AMUX_OWNER_QUEUE_LIMIT, select: rowSelect,
    }),
    readBoardWorkerChannels(),
    readProcessedToday(now),
  ]);
  const titles = await Promise.all(rows.map(readAmuxCardTitle));
  const items: AmuxOwnerQueueItem[] = rows.map((row, index) => {
    const escalation = row.humanEscalations[0] ?? null;
    const question = row.v22OwnerQuestions[0] ?? null;
    const worker = row.v22AcceptedAssignment?.workerName ?? null;
    return {
      taskId: row.id,
      displayKey: row.displayKey,
      sourceKey: row.sourceKey,
      title: titles[index],
      status: row.status,
      worker,
      channel: worker ? channels?.[worker] ?? null : null,
      attentionReason: escalation ? storedAmuxEscalationReasonCode(escalation.reason, escalation.specialty) : null,
      ownerQuestion: question ? (question.state === "open" ? "open" : "answered") : null,
      escalationId: escalation?.id ?? null,
      waitingSince: (escalation?.createdAt ?? (question?.state === "open" ? question.createdAt : null) ?? row.updatedAt)
        .toISOString(),
    };
  });
  return { items, total, processedToday, generatedAt: now.toISOString() };
}
