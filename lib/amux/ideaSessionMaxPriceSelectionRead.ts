import "server-only";

import type { Prisma } from "@prisma/client";
import { isAmuxIdeaAnalysisProvider } from "./ideaAnalysisChannelCore.ts";
import { AMUX_V19_SUBSCRIPTION_NO_PRICE_ID } from
  "./ideaAnalysisApprovedCostProfile.ts";

type Tx = Prisma.TransactionClient;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Content-free readiness of one queued subscription reservation, on the
 * reservation's own CLI channel. A subscription CLI call has no per-call price,
 * so no price approval is needed (owner decision 2026-11-04); the runner still
 * carries the fixed id in this reply and its signed claim. The claim
 * transaction rechecks every admission guard. */
export async function readAmuxV19MaxPriceSelection(tx: Tx, input: {
  reservationId: string; ideaId: string;
}): Promise<{ kind: "ready"; priceVersionId: string; provider: string;
  modelId: string; reasoningEffort: string } | { kind: "hold" }> {
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
        analysisDeadlineAt: true,
        planRefusals: { where: { state: "open" }, select: { id: true }, take: 1 } } } },
  });
  if (!reservation || reservation.ideaId !== input.ideaId ||
      reservation.status !== "queued" ||
      !isAmuxIdeaAnalysisProvider(reservation.modelProvider) ||
      reservation.idea.submissionOrigin !== "session" ||
      !["submitted", "analyzing"].includes(reservation.idea.state) ||
      reservation.idea.cancelledAt !== null ||
      reservation.idea.analysisCompletedAt !== null ||
      reservation.idea.planRefusals.length > 0 ||
      now >= reservation.idea.analysisDeadlineAt) return { kind: "hold" };
  // The channel tells the launcher which CLI and sign-in run this claim.
  return { kind: "ready", priceVersionId: AMUX_V19_SUBSCRIPTION_NO_PRICE_ID,
    provider: reservation.modelProvider, modelId: reservation.modelId,
    reasoningEffort: reservation.reasoningEffort };
}
