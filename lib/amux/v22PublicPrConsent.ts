import "server-only";

import type { Prisma, PrismaClient } from "@prisma/client";

import { loadCurrentAmuxContentKeys } from "@/lib/amux/ideaKeyConfig";
import { amuxV22PublicPrConsentAllowed } from
  "@/lib/amux/v22PublicPrConsentCore";
import { prisma } from "@/lib/prisma";

/** Read the card, owner decision and canonical audit independently. A UI
 * checkbox or a source snapshot alone is never publication authority. */
export async function readAmuxV22PublicPrConsent(cardId: string,
  db: PrismaClient | Prisma.TransactionClient = prisma): Promise<boolean> {
  const card = await db.amuxWorkItem.findUnique({ where: { id: cardId },
    select: { id: true, sourceSystem: true, cardType: true, taskRole: true,
      v4SourceApprovalId: true } });
  if (!card?.v4SourceApprovalId) return false;
  const decision = await db.amuxIdeaUnitDecision.findUnique({
    where: { id: card.v4SourceApprovalId },
    select: { id: true, state: true, action: true, actorUserId: true,
      registeredWorkItemId: true, confirmationDigest: true,
      confirmationDigestKeyId: true, confirmationSnapshot: true,
      finalAuditLogId: true },
  });
  if (!decision?.finalAuditLogId) return false;
  const audit = await db.adminAuditLog.findUnique({
    where: { id: decision.finalAuditLogId },
    select: { id: true, action: true, actorUserId: true,
      targetType: true, targetId: true, entryHash: true, metadata: true },
  });
  if (!audit) return false;
  try {
    const keys = loadCurrentAmuxContentKeys(process.env);
    try {
      return amuxV22PublicPrConsentAllowed({ cardId: card.id,
        sourceSystem: card.sourceSystem, cardType: card.cardType,
        taskRole: card.taskRole, sourceApprovalId: card.v4SourceApprovalId,
        decision, audit, digestKey: keys });
    } finally { keys.masterKey.fill(0); keys.digestKey.fill(0); }
  } catch {
    // Optional publication degrades to a private result if key material or
    // the historical snapshot cannot be verified. Database failures above
    // still abort the transaction instead of being disguised as a refusal.
    return false;
  }
}
