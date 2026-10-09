import "server-only";

import type { Prisma } from "@prisma/client";

import { auditRowActorKind } from "@/lib/adminAuditSystemActors";
import { adminAuditEntryHashVariants,
  adminAuditIntegrityKeys } from "@/lib/adminAuditIntegrityCore";
import type { AmuxIdeaAnalysisBudgetBasis } from "./ideaAnalysisBudgetCore.ts";

type PriceBasis = Pick<AmuxIdeaAnalysisBudgetBasis,
  "mode" | "provider" | "modelId" | "pricingVersion" |
  "pricingVerifiedAt" | "pricingExpiresAt" | "worstTierVerified" |
  "inputTokensCap" | "outputTokensCap" | "inputMicroUsdPerMillion" |
  "outputMicroUsdPerMillion">;

export async function readApprovedAmuxIdeaAnalysisPriceVersion(
  tx: Prisma.TransactionClient,
  input: { priceVersionId: string; provider: unknown; modelId: unknown; now: Date },
): Promise<
  | { decision: "ready"; price: PriceBasis }
  | { decision: "hold"; reason: "price_unverified" | "integrity_unavailable" }
> {
  if (!/^[A-Za-z0-9:_-]{1,128}$/.test(input.priceVersionId)) {
    return { decision: "hold", reason: "price_unverified" };
  }
  const locked = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "AmuxIdeaAnalysisPriceVersion"
    WHERE "id" = ${input.priceVersionId} FOR SHARE
  `;
  if (locked.length !== 1) return { decision: "hold", reason: "price_unverified" };
  const row = await tx.amuxIdeaAnalysisPriceVersion.findUnique({
    where: { id: input.priceVersionId },
  });
  if (!row || row.status !== "approved" || row.revokedAt !== null ||
      row.revocationAuditLogId !== null ||
      row.provider !== input.provider || row.modelId !== input.modelId ||
      (row.mode !== "subscription_cli" && row.mode !== "api") ||
      (row.provider !== "openai" && row.provider !== "anthropic") ||
      row.approvedAt > input.now || row.verifiedAt > input.now ||
      row.expiresAt <= input.now) {
    return { decision: "hold", reason: "price_unverified" };
  }
  const approval = await tx.adminAuditLog.findUnique({
    where: { id: row.approvalAuditLogId },
  });
  const predecessor = approval?.previousHash
    ? await tx.adminAuditLog.findUnique({
      where: { entryHash: approval.previousHash }, select: { id: true },
    }) : null;
  const revokedAudit = await tx.adminAuditLog.findFirst({
    where: { action: "amux.v4.analysis_price.revoked",
      targetType: "AmuxIdeaAnalysisPriceVersion", targetId: row.id },
    select: { id: true },
  });
  const metadata = approval?.metadata;
  if (revokedAudit || !approval?.entryHash ||
      approval.action !== "amux.v4.analysis_price.approved" ||
      approval.targetType !== "AmuxIdeaAnalysisPriceVersion" ||
      approval.targetId !== row.id ||
      approval.actorUserId !== row.approvedByUserId ||
      auditRowActorKind(approval) !== "human" ||
      !metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return { decision: "hold", reason: "integrity_unavailable" };
  }
  const keys = adminAuditIntegrityKeys(process.env);
  const hashInput = {
    previousHash: approval.previousHash,
    actorUserId: approval.actorUserId,
    actorEmail: approval.actorEmail,
    action: approval.action,
    targetType: approval.targetType,
    targetId: approval.targetId,
    summary: approval.summary,
    metadata: approval.metadata ?? null,
    ipAddress: approval.ipAddress,
    userAgent: approval.userAgent,
    createdAt: approval.createdAt.toISOString(),
  };
  if ((approval.previousHash !== null && predecessor === null) ||
      keys.length === 0 ||
      !keys.some((key) => Object.values(adminAuditEntryHashVariants(hashInput, key))
        .includes(approval.entryHash!))) {
    return { decision: "hold", reason: "integrity_unavailable" };
  }
  const value = metadata as Record<string, unknown>;
  if (value.provider !== row.provider || value.modelId !== row.modelId ||
      value.mode !== row.mode || value.version !== row.version ||
      value.inputTokensCap !== row.inputTokensCap ||
      value.outputTokensCap !== row.outputTokensCap ||
      value.inputMicroUsdPerMillion !== row.inputMicroUsdPerMillion ||
      value.outputMicroUsdPerMillion !== row.outputMicroUsdPerMillion ||
      value.evidenceDigest !== row.evidenceDigest ||
      value.verifiedAt !== row.verifiedAt.toISOString() ||
      value.expiresAt !== row.expiresAt.toISOString() ||
      value.approvedAt !== row.approvedAt.toISOString() ||
      value.worstTierVerified !== true ||
      value.modelCallStarted !== false) {
    return { decision: "hold", reason: "integrity_unavailable" };
  }
  return { decision: "ready", price: {
    mode: row.mode, provider: row.provider, modelId: row.modelId,
    pricingVersion: row.id,
    pricingVerifiedAt: row.verifiedAt.toISOString(),
    pricingExpiresAt: row.expiresAt.toISOString(),
    worstTierVerified: true,
    inputTokensCap: row.inputTokensCap,
    outputTokensCap: row.outputTokensCap,
    inputMicroUsdPerMillion: row.inputMicroUsdPerMillion,
    outputMicroUsdPerMillion: row.outputMicroUsdPerMillion,
  } };
}
