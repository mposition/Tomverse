import "server-only";

import type { Session } from "next-auth";

import { takeAuditChainLock, writeAdminAuditLog } from "@/lib/adminAudit";
import { getAdminRole, isAdminSession } from "@/lib/adminAuth";
import { assertRecentAdminAuthentication } from "@/lib/adminReauthentication";
import { prisma } from "@/lib/prisma";
import { amuxIdeaCardCloseReasonValid, type AmuxIdeaCardCloseDecision } from "./ideaCardCloseCore.ts";
import { applyAmuxIdeaCardCloseAnswerInTransaction, type AmuxIdeaCardCloseApplied } from
  "./ideaCardCloseService.ts";
import { amuxContentDigest, type AmuxDigestKey } from "./ideaCrypto.ts";
import { loadCurrentAmuxContentKeys } from "./ideaKeyConfig.ts";

/**
 * The owner's direct answer to a card close question (ideaCardCloseService.ts),
 * on its own: it writes a person's audit entry through the administrator writer,
 * and a module that calls that writer keeps clear of the system writer's actor
 * key (tests/adminAuditSystemActors.test.ts).
 */

export class AmuxIdeaCardCloseOwnerError extends Error {
  constructor(readonly code: "forbidden" | "invalid" | "integrity_unavailable") {
    super(code);
    this.name = "AmuxIdeaCardCloseOwnerError";
  }
}

/**
 * The owner answers on the idea's detail: owner role, recent re-authentication,
 * a reason, and a person's audit entry. It is not the Decision Maker's path, so
 * the kill switch does not stop it (policy §6: "운영자의 직접 답"), and an open
 * question of the owner's own idea is all it needs. The reason is free text and
 * may quote the idea, so the audit keeps only its keyed digest.
 */
export async function answerAmuxIdeaCardCloseForOwner(input: {
  session: Session; request: Request; ideaId: string; questionId: string;
  decision: AmuxIdeaCardCloseDecision; reason: unknown;
}): Promise<AmuxIdeaCardCloseApplied> {
  const actorUserId = input.session.user?.id;
  if (!actorUserId || !isAdminSession(input.session) || getAdminRole(input.session) !== "owner")
    throw new AmuxIdeaCardCloseOwnerError("forbidden");
  await assertRecentAdminAuthentication(input.session);
  if (!amuxIdeaCardCloseReasonValid(input.reason)) throw new AmuxIdeaCardCloseOwnerError("invalid");
  const reason = input.reason;
  let key: AmuxDigestKey;
  try { key = loadCurrentAmuxContentKeys(process.env); }
  catch { throw new AmuxIdeaCardCloseOwnerError("integrity_unavailable"); }
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`
      SELECT set_config('statement_timeout', '5000', true),
             set_config('idle_in_transaction_session_timeout', '10000', true)`;
    await takeAuditChainLock(tx);
    const owned = await tx.$queryRaw<Array<{ now: Date }>>`
      SELECT date_trunc('milliseconds', clock_timestamp() AT TIME ZONE 'UTC') AS "now"
      FROM "AmuxIdeaCardCloseQuestion" q
      JOIN "AmuxIdeaSubmission" i ON i."id" = q."ideaId"
      WHERE q."id" = ${input.questionId} AND q."ideaId" = ${input.ideaId}
        AND i."actorUserId" = ${actorUserId}`;
    // Another owner's idea is indistinguishable from a missing one.
    const now = owned[0]?.now;
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) return { outcome: "not_found" as const };
    const digest = amuxContentDigest(Buffer.from(reason, "utf8"), "idea_raw",
      `${input.ideaId}:card-close-reason`, key);
    return applyAmuxIdeaCardCloseAnswerInTransaction(tx, {
      questionId: input.questionId, decision: input.decision, source: "operator",
      answeredByUserId: actorUserId, now,
      audit: (entry) => writeAdminAuditLog({ tx, session: input.session, request: input.request,
        action: entry.action, targetType: "AmuxIdeaCardCloseQuestion", targetId: input.questionId,
        summary: entry.summary,
        metadata: { ...entry.metadata, reasonDigest: digest.digest, reasonDigestKeyId: digest.digestKeyId } }),
    });
  }, { maxWait: 5_000, timeout: 15_000 });
}
