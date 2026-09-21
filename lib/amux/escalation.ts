import "server-only";

import type { Prisma } from "@prisma/client";

/**
 * Opens at most one unresolved escalation for a task.
 *
 * Callers must already hold or have just written the task row in their
 * transaction. The partial unique index remains the database backstop.
 */
export async function openAmuxHumanEscalation(
  tx: Prisma.TransactionClient,
  input: {
    taskId: string;
    specialty: string | null;
    reason: string;
    openedBy: string;
  },
) {
  const existing = await tx.amuxHumanEscalation.findFirst({
    where: {
      taskId: input.taskId,
      status: { in: ["open", "acknowledged"] },
    },
    select: { id: true },
  });
  if (existing) return existing;

  return tx.amuxHumanEscalation.create({
    data: {
      taskId: input.taskId,
      specialty: input.specialty,
      reason: input.reason,
      openedBy: input.openedBy,
    },
    select: { id: true },
  });
}
