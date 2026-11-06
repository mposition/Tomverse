import "server-only";

import type { Session } from "next-auth";

import { takeAuditChainLock, writeAdminAuditLog } from "@/lib/adminAudit";
import { getAdminRole, isAdminSession } from "@/lib/adminAuth";
import { assertRecentAdminAuthentication } from "@/lib/adminReauthentication";
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";
import { amuxIdeaCardCloseReasonValid, type AmuxIdeaCardCloseDecision } from "./ideaCardCloseCore.ts";
import { applyAmuxIdeaCardCloseAnswerInTransaction, isAmuxIdeaCardCloseBusy,
  openAmuxIdeaCardCloseDirectQuestionInTransaction, type AmuxIdeaCardCloseApplied } from "./ideaCardCloseService.ts";
import { amuxContentDigest, type AmuxDigestKey } from "./ideaCrypto.ts";
import { loadCurrentAmuxContentKeys } from "./ideaKeyConfig.ts";

/**
 * The owner's direct answer to a card close question (ideaCardCloseService.ts),
 * on its own: it writes a person's audit entry through the administrator writer,
 * and a module that calls that writer keeps clear of the system writer's actor
 * key (tests/adminAuditSystemActors.test.ts).
 */

export class AmuxIdeaCardCloseOwnerError extends Error {
  constructor(readonly code: "forbidden" | "invalid" | "integrity_unavailable" | "busy") {
    super(code);
    this.name = "AmuxIdeaCardCloseOwnerError";
  }
}

type OwnerAnswer = { actorUserId: string; reason: string; key: AmuxDigestKey };

/** Owner role, recent re-authentication, a reason and the digest key, before any write. */
async function ownerAnswer(input: { session: Session; reason: unknown }): Promise<OwnerAnswer> {
  const actorUserId = input.session.user?.id;
  if (!actorUserId || !isAdminSession(input.session) || getAdminRole(input.session) !== "owner")
    throw new AmuxIdeaCardCloseOwnerError("forbidden");
  await assertRecentAdminAuthentication(input.session);
  if (!amuxIdeaCardCloseReasonValid(input.reason)) throw new AmuxIdeaCardCloseOwnerError("invalid");
  try { return { actorUserId, reason: input.reason, key: loadCurrentAmuxContentKeys(process.env) }; }
  catch { throw new AmuxIdeaCardCloseOwnerError("integrity_unavailable"); }
}

/**
 * One transaction under the audit chain lock, with the database clock read in
 * the statement that sets its timeouts. A held card rolls the whole answer back.
 */
function inOwnerTransaction<T>(work: (tx: Prisma.TransactionClient, now: Date | null) => Promise<T>) {
  return prisma.$transaction(async (tx) => {
    const clock = await tx.$queryRaw<Array<{ now: Date }>>`
      SELECT set_config('statement_timeout', '5000', true),
             set_config('idle_in_transaction_session_timeout', '10000', true),
             date_trunc('milliseconds', clock_timestamp() AT TIME ZONE 'UTC') AS "now"`;
    await takeAuditChainLock(tx);
    const now = clock[0]?.now;
    return work(tx, now instanceof Date && Number.isFinite(now.getTime()) ? now : null);
  }, { maxWait: 5_000, timeout: 15_000 }).catch((error: unknown) => {
    // A worker held one of the cards; the whole answer rolled back.
    if (isAmuxIdeaCardCloseBusy(error)) throw new AmuxIdeaCardCloseOwnerError("busy");
    throw error;
  });
}

const applyForOwner = (tx: Prisma.TransactionClient, input: {
  session: Session; request: Request; ideaId: string; questionId: string; decision: AmuxIdeaCardCloseDecision;
  owner: OwnerAnswer; now: Date; direct: boolean;
}) => {
  // The reason is free text and may quote the idea, so the audit keeps only its keyed digest.
  const digest = amuxContentDigest(Buffer.from(input.owner.reason, "utf8"), "idea_raw",
    `${input.ideaId}:card-close-reason`, input.owner.key);
  return applyAmuxIdeaCardCloseAnswerInTransaction(tx, {
    questionId: input.questionId, decision: input.decision, source: "operator",
    answeredByUserId: input.owner.actorUserId, now: input.now,
    audit: (entry) => writeAdminAuditLog({ tx, session: input.session, request: input.request,
      action: entry.action, targetType: "AmuxIdeaCardCloseQuestion", targetId: input.questionId,
      // Only a close says so: an apply that refused keeps its own summary.
      summary: input.direct && entry.action === "amux.idea.card_close.closed" ?
        "Closed the remaining cards of a stalled AMUX idea directly, with no question open." : entry.summary,
      metadata: { ...entry.metadata, reasonDigest: digest.digest, reasonDigestKeyId: digest.digestKeyId,
        ...(input.direct ? { direct: true } : {}) } }),
  });
};

/**
 * The owner answers on the idea's detail: owner role, recent re-authentication,
 * a reason, and a person's audit entry. It is not the Decision Maker's path, so
 * the kill switch does not stop it (docs/policy/amux-decision-maker.md §6: "운영자의 직접 답"), and an open
 * question of the owner's own idea is all it needs.
 */
export async function answerAmuxIdeaCardCloseForOwner(input: {
  session: Session; request: Request; ideaId: string; questionId: string;
  decision: AmuxIdeaCardCloseDecision; reason: unknown;
}): Promise<AmuxIdeaCardCloseApplied> {
  const owner = await ownerAnswer(input);
  return inOwnerTransaction(async (tx, now) => {
    const owned = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT q."id" FROM "AmuxIdeaCardCloseQuestion" q
      JOIN "AmuxIdeaSubmission" i ON i."id" = q."ideaId"
      WHERE q."id" = ${input.questionId} AND q."ideaId" = ${input.ideaId}
        AND i."actorUserId" = ${owner.actorUserId}`;
    // Another owner's idea is indistinguishable from a missing one.
    if (!now || owned.length === 0) return { outcome: "not_found" as const };
    return applyForOwner(tx, { ...input, owner, now, direct: false });
  });
}

export type AmuxIdeaCardCloseDirectResult = AmuxIdeaCardCloseApplied | { outcome: "not_closable" };

/**
 * The owner closes a stalled idea's remaining cards with no question open
 * (owner decision 2026-11-06): the same cards a question would ask about, by
 * the same scan and judgment, without the day's limit or the quiet period after
 * a keep, since the owner decides it. An idea with an open question, or none to
 * close, or whose cards are no longer exactly the ones the owner was shown, is
 * `not_closable`: the detail then shows what is there now. It
 * writes the question row and answers it at once, so the cards, escalations and
 * audit take the one apply path. Twelve statements at most: setup and clock,
 * lock, the candidate read, the row, then the apply's eight with its audit.
 */
export async function closeAmuxIdeaCardsDirectlyForOwner(input: {
  session: Session; request: Request; ideaId: string; cardIds: readonly string[]; reason: unknown;
}): Promise<AmuxIdeaCardCloseDirectResult> {
  const owner = await ownerAnswer(input);
  return inOwnerTransaction(async (tx, now) => {
    if (!now) return { outcome: "not_closable" as const };
    const opened = await openAmuxIdeaCardCloseDirectQuestionInTransaction(tx,
      { ideaId: input.ideaId, actorUserId: owner.actorUserId, now, shownCardIds: input.cardIds });
    if (!opened) return { outcome: "not_closable" as const };
    return applyForOwner(tx, { ...input, questionId: opened.questionId, decision: "close", owner, now,
      direct: true });
  });
}
