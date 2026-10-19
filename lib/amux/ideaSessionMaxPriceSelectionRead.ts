import "server-only";

import type { Prisma } from "@prisma/client";
import { isAmuxIdeaAnalysisProvider } from "./ideaAnalysisChannelCore.ts";
import { readApprovedAmuxIdeaAnalysisPriceVersion } from
  "./ideaAnalysisPriceVersionRead.ts";

type Tx = Prisma.TransactionClient;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Content-free price selection for one queued subscription reservation, on
 * the reservation's own CLI channel (owner decision 2026-10-20). The claim
 * transaction rechecks this version and every admission guard. */
export async function readAmuxV19MaxPriceSelection(tx: Tx, input: {
  reservationId: string; ideaId: string;
}): Promise<{ kind: "ready"; priceVersionId: string; modelId: string;
  reasoningEffort: string } | { kind: "hold" }> {
  if (!UUID.test(input.reservationId) || !UUID.test(input.ideaId)) {
    return { kind: "hold" };
  }
  await tx.$queryRaw`
    SELECT set_config('statement_timeout', '5000', true) AS statement_limit,
           set_config('idle_in_transaction_session_timeout', '10000', true) AS idle_limit,
           set_config('TimeZone', 'UTC', true) AS transaction_zone
  `;
  const clock = await tx.$queryRaw<Array<{ now: Date }>>`
    SELECT clock_timestamp() AS "now"
  `;
  const now = clock[0]?.now;
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    return { kind: "hold" };
  }
  const reservation = await tx.amuxIdeaSessionAnalysisReservation.findUnique({
    where: { id: input.reservationId },
    select: { ideaId: true, status: true, modelProvider: true,
      modelId: true, reasoningEffort: true,
      idea: { select: { submissionOrigin: true, state: true,
        cancelledAt: true, analysisCompletedAt: true,
        analysisDeadlineAt: true } } },
  });
  if (!reservation || reservation.ideaId !== input.ideaId ||
      reservation.status !== "queued" ||
      !isAmuxIdeaAnalysisProvider(reservation.modelProvider) ||
      reservation.idea.submissionOrigin !== "session" ||
      !["submitted", "analyzing"].includes(reservation.idea.state) ||
      reservation.idea.cancelledAt !== null ||
      reservation.idea.analysisCompletedAt !== null ||
      now >= reservation.idea.analysisDeadlineAt) return { kind: "hold" };
  const row = await tx.amuxIdeaAnalysisPriceVersion.findFirst({
    where: { provider: reservation.modelProvider, modelId: reservation.modelId,
      mode: "subscription_cli", status: "approved", revokedAt: null },
    orderBy: { version: "desc" }, select: { id: true },
  });
  if (!row) return { kind: "hold" };
  const approved = await readApprovedAmuxIdeaAnalysisPriceVersion(tx, {
    priceVersionId: row.id, provider: reservation.modelProvider,
    modelId: reservation.modelId, now,
  });
  if (approved.decision !== "ready" ||
      approved.price.mode !== "subscription_cli") return { kind: "hold" };
  return { kind: "ready", priceVersionId: row.id,
    modelId: reservation.modelId,
    reasoningEffort: reservation.reasoningEffort };
}
