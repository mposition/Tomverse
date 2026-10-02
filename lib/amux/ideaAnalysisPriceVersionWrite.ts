import "server-only";

import type { Prisma } from "@prisma/client";
import type { Session } from "next-auth";

import { takeAuditChainLock, writeAdminAuditLog } from "@/lib/adminAudit";
import { getAdminRole, isAdminSession } from "@/lib/adminAuth";
import { assertRecentAdminAuthentication } from "@/lib/adminReauthentication";

const ID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const MAX_INT = 2_147_483_647;

export type AmuxIdeaAnalysisPriceApproval = {
  id: string;
  provider: "openai" | "anthropic";
  modelId: string;
  mode: "subscription_cli" | "api";
  expectedPreviousVersion: number;
  inputTokensCap: number;
  outputTokensCap: number;
  inputMicroUsdPerMillion: number;
  outputMicroUsdPerMillion: number;
  evidenceDigest: string;
  ownerConfirmedWorstTier: true;
  verifiedAt: Date;
  expiresAt: Date;
};

export class AmuxIdeaAnalysisPriceApprovalError extends Error {
  constructor(readonly code: "forbidden" | "invalid_price_evidence" |
    "price_revision_changed" | "price_unavailable") {
    super(code);
    this.name = "AmuxIdeaAnalysisPriceApprovalError";
  }
}

async function requireOwnerAndStepUp(session: Session): Promise<string> {
  const actorUserId = session.user?.id;
  if (!actorUserId || !isAdminSession(session) || getAdminRole(session) !== "owner") {
    throw new AmuxIdeaAnalysisPriceApprovalError("forbidden");
  }
  await assertRecentAdminAuthentication(session);
  return actorUserId;
}

async function databaseNow(tx: Prisma.TransactionClient): Promise<Date> {
  const clock = await tx.$queryRaw<Array<{ now: Date }>>`
    SELECT (clock_timestamp() AT TIME ZONE 'UTC')::TIMESTAMP(3) AS "now"
  `;
  const now = clock[0]?.now;
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new AmuxIdeaAnalysisPriceApprovalError("price_unavailable");
  }
  return now;
}

function requireValidApproval(input: AmuxIdeaAnalysisPriceApproval): void {
  const positiveInt = (value: unknown): value is number =>
    typeof value === "number" && Number.isSafeInteger(value) &&
    value > 0 && value <= MAX_INT;
  if (!input || !ID.test(input.id) || !MODEL.test(input.modelId) ||
      !["openai", "anthropic"].includes(input.provider) ||
      !["subscription_cli", "api"].includes(input.mode) ||
      !Number.isSafeInteger(input.expectedPreviousVersion) ||
      input.expectedPreviousVersion < 0 ||
      input.expectedPreviousVersion >= MAX_INT ||
      !positiveInt(input.inputTokensCap) || !positiveInt(input.outputTokensCap) ||
      !positiveInt(input.inputMicroUsdPerMillion) ||
      !positiveInt(input.outputMicroUsdPerMillion) ||
      !DIGEST.test(input.evidenceDigest) ||
      input.ownerConfirmedWorstTier !== true ||
      !(input.verifiedAt instanceof Date) ||
      !Number.isFinite(input.verifiedAt.getTime()) ||
      !(input.expiresAt instanceof Date) ||
      !Number.isFinite(input.expiresAt.getTime())) {
    throw new AmuxIdeaAnalysisPriceApprovalError("invalid_price_evidence");
  }
}

/** Dark transaction body. This records an owner's explicit price evidence,
 * but cannot itself authorize a model call or seed a production price. The
 * future Admin route must bind these fields to the exact reviewed preview. */
export async function commitAmuxIdeaAnalysisPriceApproval(
  tx: Prisma.TransactionClient,
  input: { session: Session; request: Request; approval: AmuxIdeaAnalysisPriceApproval },
): Promise<{ priceVersionId: string; version: number; auditId: string }> {
  const actorUserId = await requireOwnerAndStepUp(input.session);
  requireValidApproval(input.approval);
  const price = input.approval;
  await tx.$queryRaw`
    SELECT set_config('statement_timeout', '5000', true) AS statement_limit,
           set_config('idle_in_transaction_session_timeout', '10000', true) AS idle_limit
  `;
  await takeAuditChainLock(tx);
  const now = await databaseNow(tx);
  if (price.verifiedAt > now || price.expiresAt <= now ||
      price.verifiedAt >= price.expiresAt) {
    throw new AmuxIdeaAnalysisPriceApprovalError("invalid_price_evidence");
  }
  const latest = await tx.amuxIdeaAnalysisPriceVersion.findFirst({
    where: { provider: price.provider, modelId: price.modelId, mode: price.mode },
    orderBy: { version: "desc" },
    select: { version: true, status: true },
  });
  if ((latest?.version ?? 0) !== price.expectedPreviousVersion ||
      latest?.status === "approved" ||
      (latest !== null && latest.status !== "revoked")) {
    throw new AmuxIdeaAnalysisPriceApprovalError("price_revision_changed");
  }
  const version = price.expectedPreviousVersion + 1;
  const metadata = {
    provider: price.provider, modelId: price.modelId, mode: price.mode,
    version, inputTokensCap: price.inputTokensCap,
    outputTokensCap: price.outputTokensCap,
    inputMicroUsdPerMillion: price.inputMicroUsdPerMillion,
    outputMicroUsdPerMillion: price.outputMicroUsdPerMillion,
    evidenceDigest: price.evidenceDigest,
    verifiedAt: price.verifiedAt.toISOString(), approvedAt: now.toISOString(),
    expiresAt: price.expiresAt.toISOString(),
    worstTierVerified: price.ownerConfirmedWorstTier, modelCallStarted: false,
  };
  const auditId = await writeAdminAuditLog({
    tx, session: input.session, request: input.request,
    action: "amux.v4.analysis_price.approved",
    targetType: "AmuxIdeaAnalysisPriceVersion", targetId: price.id,
    summary: "Owner approved one versioned AMUX analysis price ceiling; no model was called.",
    metadata,
  });
  await tx.amuxIdeaAnalysisPriceVersion.create({ data: {
    id: price.id, provider: price.provider, modelId: price.modelId,
    mode: price.mode, version, status: "approved",
    inputTokensCap: price.inputTokensCap,
    outputTokensCap: price.outputTokensCap,
    inputMicroUsdPerMillion: price.inputMicroUsdPerMillion,
    outputMicroUsdPerMillion: price.outputMicroUsdPerMillion,
    evidenceDigest: price.evidenceDigest, verifiedAt: price.verifiedAt,
    expiresAt: price.expiresAt, approvedAt: now,
    approvedByUserId: actorUserId, approvalAuditLogId: auditId,
  } });
  return { priceVersionId: price.id, version, auditId };
}

/** Revocation is one-way; a replacement price is a new version with a new
 * owner audit. Existing reservations keep their immutable price snapshot. */
export async function commitAmuxIdeaAnalysisPriceRevocation(
  tx: Prisma.TransactionClient,
  input: { session: Session; request: Request; priceVersionId: string;
    expectedVersion: number },
): Promise<{ priceVersionId: string; version: number; auditId: string }> {
  const actorUserId = await requireOwnerAndStepUp(input.session);
  if (!ID.test(input.priceVersionId) ||
      !Number.isSafeInteger(input.expectedVersion) ||
      input.expectedVersion <= 0 || input.expectedVersion > MAX_INT) {
    throw new AmuxIdeaAnalysisPriceApprovalError("invalid_price_evidence");
  }
  await tx.$queryRaw`
    SELECT set_config('statement_timeout', '5000', true) AS statement_limit,
           set_config('idle_in_transaction_session_timeout', '10000', true) AS idle_limit
  `;
  await takeAuditChainLock(tx);
  const locked = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "AmuxIdeaAnalysisPriceVersion"
    WHERE "id" = ${input.priceVersionId} FOR UPDATE
  `;
  if (locked.length !== 1) {
    throw new AmuxIdeaAnalysisPriceApprovalError("price_revision_changed");
  }
  const row = await tx.amuxIdeaAnalysisPriceVersion.findUnique({
    where: { id: input.priceVersionId },
  });
  if (!row || row.status !== "approved" || row.version !== input.expectedVersion ||
      row.revokedAt !== null || row.revocationAuditLogId !== null) {
    throw new AmuxIdeaAnalysisPriceApprovalError("price_revision_changed");
  }
  const now = await databaseNow(tx);
  if (now < row.approvedAt) {
    throw new AmuxIdeaAnalysisPriceApprovalError("price_unavailable");
  }
  const auditId = await writeAdminAuditLog({
    tx, session: input.session, request: input.request,
    action: "amux.v4.analysis_price.revoked",
    targetType: "AmuxIdeaAnalysisPriceVersion", targetId: row.id,
    summary: "Owner revoked one AMUX analysis price version; no model was called.",
    metadata: { provider: row.provider, modelId: row.modelId, mode: row.mode,
      version: row.version, priceVersionId: row.id,
      revokedAt: now.toISOString(), revokedByUserId: actorUserId,
      modelCallStarted: false },
  });
  await tx.amuxIdeaAnalysisPriceVersion.update({
    where: { id: row.id },
    data: { status: "revoked", revokedAt: now, revocationAuditLogId: auditId },
  });
  return { priceVersionId: row.id, version: row.version, auditId };
}
