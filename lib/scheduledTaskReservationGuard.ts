import "server-only";

import type { Prisma } from "@prisma/client";

import { ChatAccessError } from "@/lib/chatSecurity";
import { SCHEDULED_TASK_CREDIT_CAP_CODE } from "@/lib/scheduledTaskCore";
import { currentScheduledTaskRun } from "@/lib/scheduledTaskRunContext";

/**
 * The per-run credit ceiling, enforced where credits are actually held.
 *
 * Handed to `acquireChatAccess` as `withinReservationTransaction`, the same
 * seam the external API uses for a key's own credit cap
 * (lib/externalApiAdmission.ts): it runs inside the reservation transaction,
 * after the account's credit lock and the reservation row, and a throw rolls
 * the whole hold back -- so a refused run leaves nothing held and calls no
 * provider.
 *
 * The ceiling is cumulative over the run. The run row records every credit
 * this run has reserved; a reservation is admitted only while that total stays
 * within what the account approved for one run, and the row is bound to the
 * first reservation so the runner can read back what was really charged.
 *
 * Outside a scheduled run this returns undefined and the reservation is
 * exactly what it always was.
 */
export const scheduledTaskReservationGuard = (userId: string | null | undefined) => {
  const scope = currentScheduledTaskRun();
  if (!scope) return undefined;
  return async (
    tx: Prisma.TransactionClient,
    reservation: { reservationId: string; usageCredits: number }
  ) => {
    if (!userId || userId !== scope.userId) {
      throw new ChatAccessError(403, "SCHEDULED_TASK_SCOPE_MISMATCH", "This scheduled run belongs to another account.");
    }
    const rows = await tx.$queryRaw<Array<{ status: string; reservedCredits: number }>>`
      SELECT "status", "reservedCredits" FROM "ScheduledTaskRun"
      WHERE "id" = ${scope.runId} AND "userId" = ${scope.userId}
      FOR UPDATE`;
    const run = rows[0];
    if (!run || run.status !== "running") {
      throw new ChatAccessError(409, "SCHEDULED_TASK_RUN_CLOSED", "This scheduled run is no longer running.");
    }
    if (
      !Number.isSafeInteger(reservation.usageCredits) ||
      reservation.usageCredits < 0 ||
      run.reservedCredits + reservation.usageCredits > scope.creditCeiling
    ) {
      throw new ChatAccessError(
        402,
        SCHEDULED_TASK_CREDIT_CAP_CODE,
        "This scheduled task would use more credits than were approved for one run."
      );
    }
    await tx.$executeRaw`
      UPDATE "ScheduledTaskRun"
      SET "reservedCredits" = "reservedCredits" + ${reservation.usageCredits},
          "chatReservationId" = COALESCE("chatReservationId", ${reservation.reservationId})
      WHERE "id" = ${scope.runId}`;
  };
};
