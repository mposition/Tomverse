import "server-only";

import type { Prisma } from "@prisma/client";

import { takeAuditChainLock, writeSystemAuditLog } from "@/lib/adminAudit";
import {
  AMUX_V4_IDEA_AUTO_CANCEL_ACTION,
  AMUX_V4_IDEA_AUTO_CANCEL_TARGET,
  AMUX_V4_IDEA_SYSTEM_ACTOR,
} from "@/lib/adminAuditSystemActors";
import { commitAmuxIdeaAnalysisUnknownOutcome,
  AmuxIdeaAnalysisUnknownOutcomeError } from "./ideaAnalysisUnknownOutcomeService.ts";

const ID = /^[A-Za-z0-9:_-]{1,128}$/;
const UNFINISHED_STATES = ["submitted", "collecting", "awaiting_preview", "analyzing"];

export class AmuxIdeaAutoCancellationError extends Error {
  constructor(readonly code: "not_found" | "not_due" | "integrity_unavailable") {
    super(code);
    this.name = "AmuxIdeaAutoCancellationError";
  }
}

/** Dark transaction body for the approved seven-day retention tick. It
 * terminates analysis eligibility, marks an in-flight child outcome unknown,
 * and preserves its full budget hold and evidence. It does not erase the idea.
 * A caller must not blindly retry an uncertain COMMIT; the idea and audit row
 * require a read-back first. */
export async function commitAmuxOverdueIdeaAnalysisCancellation(
  tx: Prisma.TransactionClient, ideaId: string,
): Promise<{ ideaId: string; cancelledAt: string; auditId: string }> {
  if (!ID.test(ideaId)) throw new AmuxIdeaAutoCancellationError("not_found");
  await tx.$queryRaw`
    SELECT set_config('statement_timeout', '5000', true) AS statement_limit,
           set_config('idle_in_transaction_session_timeout', '10000', true) AS idle_limit
  `;
  await takeAuditChainLock(tx);
  const locked = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "AmuxIdeaSubmission" WHERE "id" = ${ideaId} FOR UPDATE
  `;
  if (locked.length !== 1) throw new AmuxIdeaAutoCancellationError("not_found");
  const idea = await tx.amuxIdeaSubmission.findUnique({ where: { id: ideaId } });
  const clock = await tx.$queryRaw<Array<{ now: Date }>>`
    SELECT (clock_timestamp() AT TIME ZONE 'UTC')::TIMESTAMP(3) AS "now"
  `;
  const now = clock[0]?.now;
  if (!(now instanceof Date) || !Number.isFinite(now.getTime()) || !idea ||
      !(idea.analysisDeadlineAt instanceof Date) ||
      !(idea.rawPurgeAfter instanceof Date) ||
      idea.rawPurgeAfter > idea.analysisDeadlineAt) {
    throw new AmuxIdeaAutoCancellationError("integrity_unavailable");
  }
  if (now < idea.analysisDeadlineAt || idea.analysisCompletedAt !== null ||
      idea.cancelledAt !== null || !UNFINISHED_STATES.includes(idea.state)) {
    throw new AmuxIdeaAutoCancellationError("not_due");
  }
  // Result writes lock the idea, chunk, preview, budget window and hold in
  // that order. Fence an in-flight child before cancelling its parent so a
  // late CLI result cannot turn the expired attempt into a successful draft.
  const inFlight = await tx.$queryRaw<Array<{ chunkIndex: number;
    currentPreviewId: string | null; leaseGeneration: number }>>`
    SELECT "chunkIndex", "currentPreviewId", "leaseGeneration"
    FROM "AmuxIdeaAnalysisChunk"
    WHERE "ideaId" = ${ideaId} AND "state" = 'in_flight' FOR UPDATE
  `;
  if (inFlight.length > 1 || (inFlight.length === 1 &&
      (!inFlight[0]!.currentPreviewId ||
        inFlight[0]!.leaseGeneration !== 1 || idea.state !== "analyzing"))) {
    throw new AmuxIdeaAutoCancellationError("integrity_unavailable");
  }
  let inFlightHoldId: string | null = null;
  if (inFlight.length === 1) {
    const chunk = inFlight[0]!;
    const preview = await tx.amuxIdeaTransferPreview.findUnique({
      where: { id: chunk.currentPreviewId! },
      select: { id: true, ideaId: true, chunkIndex: true, state: true,
        analysisBudgetHold: { select: { id: true } } },
    });
    if (!preview || preview.ideaId !== ideaId ||
        preview.chunkIndex !== chunk.chunkIndex ||
        preview.state !== "in_flight" || !preview.analysisBudgetHold) {
      throw new AmuxIdeaAutoCancellationError("integrity_unavailable");
    }
    try {
      await commitAmuxIdeaAnalysisUnknownOutcome(tx, {
        holdId: preview.analysisBudgetHold.id, reason: "invocation_unverified",
      });
    } catch (error) {
      if (error instanceof AmuxIdeaAnalysisUnknownOutcomeError) {
        throw new AmuxIdeaAutoCancellationError("integrity_unavailable");
      }
      throw error;
    }
    const fenced = await tx.amuxIdeaAnalysisChunk.updateMany({ where: {
      ideaId, chunkIndex: chunk.chunkIndex, state: "in_flight",
      currentPreviewId: preview.id,
    }, data: { state: "outcome_unknown" } });
    if (fenced.count !== 1) {
      throw new AmuxIdeaAutoCancellationError("integrity_unavailable");
    }
    inFlightHoldId = preview.analysisBudgetHold.id;
  }
  const auditId = await writeSystemAuditLog({
    tx, systemActor: AMUX_V4_IDEA_SYSTEM_ACTOR,
    action: AMUX_V4_IDEA_AUTO_CANCEL_ACTION,
    targetType: AMUX_V4_IDEA_AUTO_CANCEL_TARGET,
    targetId: ideaId,
    summary: "Stopped an unfinished AMUX v4 idea analysis at its seven-day deadline.",
    metadata: { submittedAt: idea.submittedAt.toISOString(),
      analysisDeadlineAt: idea.analysisDeadlineAt.toISOString(),
      rawPurgeAfter: idea.rawPurgeAfter.toISOString(),
      ...(inFlightHoldId ? { inFlightHoldId } : {}) },
  });
  const updated = await tx.amuxIdeaSubmission.updateMany({
    where: { id: ideaId, state: { in: UNFINISHED_STATES },
      analysisCompletedAt: null, cancelledAt: null,
      analysisDeadlineAt: { lte: now } },
    data: { state: "cancelled", cancelledAt: now },
  });
  if (updated.count !== 1) {
    throw new AmuxIdeaAutoCancellationError("integrity_unavailable");
  }
  return { ideaId, cancelledAt: now.toISOString(), auditId };
}
