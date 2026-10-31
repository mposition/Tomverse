import "server-only";

import type { Session } from "next-auth";

import { takeAuditChainLock, writeAdminAuditLog } from "@/lib/adminAudit";
import { getAdminRole, isAdminSession } from "@/lib/adminAuth";
import { assertRecentAdminAuthentication } from "@/lib/adminReauthentication";
import { prisma } from "@/lib/prisma";
import { amuxContentDigest, type AmuxDigestKey } from "./ideaCrypto.ts";
import { loadCurrentAmuxContentKeys } from "./ideaKeyConfig.ts";
import { AMUX_IDEA_OWNER_CLOSABLE_STATE, AMUX_IDEA_OWNER_CLOSE_ACTION,
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
 * idea row lock first: unit approval, unit rejection and unattended
 * registration take the same lock and re-check the idea afterwards, so none
 * of them can commit against an idea this closed.
 *
 * The row, its encrypted body and its draft units stay. `rawPurgeAfter` is
 * not moved: the body leaves on its seven-day clock and proposed units on
 * their own expiry, exactly as for an idea nobody closed.
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
        now: Date }>>`
        SELECT "actorUserId", "state", "cancelledAt", "requestId"::text AS "requestId",
               "submissionOrigin",
               (clock_timestamp() AT TIME ZONE 'UTC')::TIMESTAMP(3) AS "now"
        FROM "AmuxIdeaSubmission" WHERE "id" = ${ideaId} FOR UPDATE
      `;
      const idea = locked[0];
      // Another owner's idea is indistinguishable from a missing one.
      if (!idea || idea.actorUserId !== input.actorUserId) {
        return { ideaId, result: "not_found" };
      }
      if (idea.state === "cancelled") return { ideaId, result: "already_closed" };
      if (idea.state !== AMUX_IDEA_OWNER_CLOSABLE_STATE || idea.cancelledAt !== null) {
        return { ideaId, result: "not_closable" };
      }
      const now = idea.now;
      if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
        throw new AmuxIdeaOwnerCloseError("integrity_unavailable");
      }
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
          reasonDigest: reason.digest, reasonDigestKeyId: reason.digestKeyId,
          batchSize: input.batchSize } });
      const updated = await tx.amuxIdeaSubmission.updateMany({
        where: { id: ideaId, actorUserId: input.actorUserId,
          state: AMUX_IDEA_OWNER_CLOSABLE_STATE, cancelledAt: null },
        data: { state: "cancelled", cancelledAt: now },
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
