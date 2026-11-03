import "server-only";

import type { Session } from "next-auth";

import { takeAuditChainLock, writeAdminAuditLog } from "@/lib/adminAudit";
import { getAdminRole, isAdminSession } from "@/lib/adminAuth";
import { assertRecentAdminAuthentication } from "@/lib/adminReauthentication";
import { prisma } from "@/lib/prisma";
import { amuxContentDigest, type AmuxDigestKey } from "./ideaCrypto.ts";
import { loadCurrentAmuxContentKeys } from "./ideaKeyConfig.ts";
import { AMUX_IDEA_OWNER_CLOSE_ACTION, amuxIdeaOwnerClosableState,
  inspectAmuxIdeaOwnerClose, type AmuxIdeaOwnerCloseOutcome } from
  "./ideaOwnerCloseCore.ts";

export class AmuxIdeaOwnerCloseError extends Error {
  constructor(readonly code: "forbidden" | "invalid" | "integrity_unavailable") {
    super(code);
    this.name = "AmuxIdeaOwnerCloseError";
  }
}

/**
 * Closes each idea in its own transaction, so one refusal or failure leaves
 * the others' outcomes intact. Every close takes the audit chain lock and the
 * idea row lock first: unit approval, unit rejection, unattended registration,
 * transfer confirmation and budget reservation take the same lock and
 * re-check the idea afterwards, so none of them can commit against an idea
 * this closed.
 *
 * The row and its draft units stay, and proposed units expire on their own
 * clock. The encrypted body keeps its purge time when that is already due
 * (every idea after analysis); an idea closed before an execution approval
 * becomes due for purge at the close, as a cancelled idea must be.
 */
export async function closeAmuxIdeasForOwner(input: {
  session: Session; request: Request; ideaIds: unknown; reason: unknown;
}): Promise<AmuxIdeaOwnerCloseOutcome[]> {
  const actorUserId = input.session.user?.id;
  if (!actorUserId || !isAdminSession(input.session) ||
      getAdminRole(input.session) !== "owner") {
    throw new AmuxIdeaOwnerCloseError("forbidden");
  }
  await assertRecentAdminAuthentication(input.session);
  const inspected = inspectAmuxIdeaOwnerClose(input);
  if (!inspected.ok) throw new AmuxIdeaOwnerCloseError("invalid");
  let key: AmuxDigestKey;
  try {
    key = loadCurrentAmuxContentKeys(process.env);
  } catch {
    throw new AmuxIdeaOwnerCloseError("integrity_unavailable");
  }
  const outcomes: AmuxIdeaOwnerCloseOutcome[] = [];
  // In order, one at a time: every close waits for the same audit lock anyway.
  for (const ideaId of inspected.ideaIds) {
    outcomes.push(await closeOne({ ...input, actorUserId, ideaId,
      reason: inspected.reason, key, batchSize: inspected.ideaIds.length }));
  }
  return outcomes;
}

async function closeOne(input: {
  session: Session; request: Request; actorUserId: string; ideaId: string;
  reason: string; key: AmuxDigestKey; batchSize: number;
}): Promise<AmuxIdeaOwnerCloseOutcome> {
  const { ideaId } = input;
  try {
    return await prisma.$transaction(async (tx): Promise<AmuxIdeaOwnerCloseOutcome> => {
      await tx.$queryRaw`
        SELECT set_config('statement_timeout', '5000', true),
               set_config('idle_in_transaction_session_timeout', '10000', true)
      `;
      await takeAuditChainLock(tx);
      const locked = await tx.$queryRaw<Array<{ actorUserId: string; state: string;
        cancelledAt: Date | null; requestId: string; submissionOrigin: string;
        rawPurgeAfter: Date | null; now: Date }>>`
        SELECT "actorUserId", "state", "cancelledAt", "requestId"::text AS "requestId",
               "submissionOrigin", "rawPurgeAfter",
               (clock_timestamp() AT TIME ZONE 'UTC')::TIMESTAMP(3) AS "now"
        FROM "AmuxIdeaSubmission" WHERE "id" = ${ideaId} FOR UPDATE
      `;
      const idea = locked[0];
      // Another owner's idea is indistinguishable from a missing one.
      if (!idea || idea.actorUserId !== input.actorUserId) {
        return { ideaId, result: "not_found" };
      }
      if (idea.state === "cancelled") return { ideaId, result: "already_closed" };
      if (!amuxIdeaOwnerClosableState(idea.state, idea.submissionOrigin) ||
          idea.cancelledAt !== null) {
        return { ideaId, result: "not_closable" };
      }
      if (idea.state === "submitted" || idea.state === "analyzing") {
        // Execution approval already set a paid analysis going: a confirmed
        // or running preview, or a held budget, keeps its own path (claim,
        // stop, release of an unused hold). Confirmation, reservation and
        // claim take the same two locks first, so none can land between this
        // read and the close. A running idea-lane run is the same: its claim
        // took this row's lock, and the run would still open its PR.
        const started = await tx.$queryRaw<Array<{ started: boolean }>>`
          SELECT (EXISTS (
            SELECT 1 FROM "AmuxIdeaTransferPreview" p
            LEFT JOIN "AmuxIdeaAnalysisBudgetHold" h ON h."previewId" = p."id"
            WHERE p."ideaId" = ${ideaId}
              AND (p."state" IN ('confirmed', 'in_flight', 'outcome_unknown')
                OR h."status" IN ('reserved', 'in_flight', 'outcome_unknown'))
          ) OR EXISTS (
            SELECT 1 FROM "AmuxIdeaLaneAttempt" a
            WHERE a."ideaId" = ${ideaId} AND a."outcome" IS NULL
              AND a."leaseUntil" > (clock_timestamp() AT TIME ZONE 'UTC')::TIMESTAMP(3)
          )) AS "started"
        `;
        if (started[0]?.started !== false) return { ideaId, result: "not_closable" };
      }
      const now = idea.now;
      if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
        throw new AmuxIdeaOwnerCloseError("integrity_unavailable");
      }
      // A cancelled idea's body must already be due for purge
      // (AmuxIdeaSubmission_raw_purge_bound_check). After analysis it is, by
      // analysisCompletedAt; before an execution approval the close makes it due
      // now, as the queued session cancel does, and the purge worker retires it.
      const rawPurgeAfter = idea.rawPurgeAfter && idea.rawPurgeAfter <= now
        ? idea.rawPurgeAfter : now;
      // The reason is the owner's free text and may quote the idea, so the
      // audit keeps only its keyed digest (as a unit rejection does).
      const reason = amuxContentDigest(Buffer.from(input.reason, "utf8"),
        "idea_raw", `${ideaId}:owner-close-reason`, input.key);
      const auditId = await writeAdminAuditLog({ tx, session: input.session,
        request: input.request, action: AMUX_IDEA_OWNER_CLOSE_ACTION,
        targetType: "AmuxIdeaSubmission", targetId: ideaId,
        summary: "Owner closed one AMUX idea that was waiting for the owner.",
        metadata: { requestId: idea.requestId,
          submissionOrigin: idea.submissionOrigin,
          previousState: idea.state, cancelledAt: now.toISOString(),
          rawPurgeAfter: rawPurgeAfter.toISOString(),
          reasonDigest: reason.digest, reasonDigestKeyId: reason.digestKeyId,
          batchSize: input.batchSize } });
      const updated = await tx.amuxIdeaSubmission.updateMany({
        where: { id: ideaId, actorUserId: input.actorUserId,
          state: idea.state, cancelledAt: null },
        data: { state: "cancelled", cancelledAt: now, rawPurgeAfter },
      });
      if (updated.count !== 1) {
        throw new AmuxIdeaOwnerCloseError("integrity_unavailable");
      }
      return { ideaId, result: "closed", cancelledAt: now.toISOString(), auditId };
    }, { maxWait: 5_000, timeout: 15_000 });
  } catch {
    // Not retried here: the caller reads the list back, and a repeat on a
    // closed idea only answers already_closed.
    return { ideaId, result: "outcome_unknown" };
  }
}
