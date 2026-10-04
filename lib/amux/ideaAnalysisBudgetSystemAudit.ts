import "server-only";

import type { Prisma } from "@prisma/client";

import { writeSystemAuditLog } from "@/lib/adminAudit";
import { AMUX_V4_IDEA_SYSTEM_ACTOR,
  AMUX_V4_ANALYSIS_BUDGET_RESERVE_ACTION,
  AMUX_V4_ANALYSIS_BUDGET_RESERVE_TARGET } from
  "@/lib/adminAuditSystemActors";
import { AMUX_V4_ANALYSIS_NAMESPACE } from "./ideaAnalysisBudgetCore.ts";

/** Record the deterministic reservation separately from the owner's receipt. */
export function writeAmuxAnalysisBudgetSystemAudit(input: {
  tx: Prisma.TransactionClient;
  holdId: string;
  previewId: string;
  monthStartIso: string;
  provider: "openai" | "anthropic";
  modelId: string;
  pricingVersion: string;
  priceVersionId: string;
  reservedMicroUsd: string;
  amountMeaning: "api_price_reservation_ceiling" |
    "cli_api_conversion_estimate";
}): Promise<string> {
  return writeSystemAuditLog({
    tx: input.tx, systemActor: AMUX_V4_IDEA_SYSTEM_ACTOR,
    action: AMUX_V4_ANALYSIS_BUDGET_RESERVE_ACTION,
    targetType: AMUX_V4_ANALYSIS_BUDGET_RESERVE_TARGET,
    targetId: input.holdId,
    summary: "Reserved one AMUX v4 analysis Agent cost ceiling; no model was called.",
    metadata: { previewId: input.previewId,
      namespace: AMUX_V4_ANALYSIS_NAMESPACE,
      monthStart: input.monthStartIso, provider: input.provider,
      modelId: input.modelId, pricingVersion: input.pricingVersion,
      priceVersionId: input.priceVersionId,
      reservedMicroUsd: input.reservedMicroUsd,
      amountMeaning: input.amountMeaning, modelCallStarted: false },
  });
}
