import "server-only";

import type { Prisma } from "@prisma/client";

import { writeSystemAuditLog } from "@/lib/adminAudit";
import { AMUX_V22_AUTO_ADMIT_AUDIT_ACTOR } from
  "@/lib/adminAuditSystemActors";

/** The v22 writer can record admission, unknown and halt evidence only. */
export function writeV22AutoPromotionAudit(tx: Prisma.TransactionClient,
  entry: { action: "amux.v22.auto_promotion.consumed" |
      "amux.v22.auto_promotion.outcome_unknown" |
      "amux.auto_promotion.halted";
    targetType: "AmuxV22PromotionReceipt" |
      "AmuxV22PromotionUnknown" | "AmuxRecommendationAutoHalt";
    targetId: string; summary: string;
    metadata: Record<string, string | number | null> }) {
  return writeSystemAuditLog({ tx, systemActor:
    AMUX_V22_AUTO_ADMIT_AUDIT_ACTOR,
    action: entry.action, targetType: entry.targetType,
    targetId: entry.targetId, summary: entry.summary,
    metadata: entry.metadata });
}
