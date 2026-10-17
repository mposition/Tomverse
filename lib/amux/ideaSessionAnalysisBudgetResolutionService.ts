import "server-only";

import type { Prisma } from "@prisma/client";
import type { Session } from "next-auth";
import { takeAuditChainLock, writeAdminAuditLog } from "@/lib/adminAudit";
import { getAdminRole, isAdminSession } from "@/lib/adminAuth";
import { assertRecentAdminAuthentication } from "@/lib/adminReauthentication";
import { AMUX_V19_SESSION_BUDGET_RESOLVE_ACTION,
  AMUX_V19_SESSION_BUDGET_TARGET } from "@/lib/adminAuditSystemActors";
import { AMUX_V4_ANALYSIS_NAMESPACE } from "./ideaAnalysisBudgetCore.ts";

type Tx = Prisma.TransactionClient;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DIGEST = /^[a-f0-9]{64}$/;

export class AmuxSessionBudgetResolutionError extends Error {
  constructor(readonly code: "forbidden" | "not_resolvable" |
    "integrity_unavailable") {
    super(code);
    this.name = "AmuxSessionBudgetResolutionError";
  }
}

/** The owner records an exact claim read-back and local execution proof. Only
 * positive evidence of no CLI start releases zero; otherwise the full API
 * conversion ceiling is consumed. This never retries or resumes that claim. */
export async function commitAmuxSessionBudgetUnknownResolution(tx: Tx, input: {
  claimId: string;
  session: Session;
  request: Request;
  verification: "proven_not_started" | "not_proven";
  localEvidenceDigest: string;
  ownerConfirmed: true;
}): Promise<{ claimId: string; status: "released" | "owner_consumed";
  settledMicroUsd: string; auditId: string }> {
  if (!UUID.test(input.claimId) || !DIGEST.test(input.localEvidenceDigest) ||
      (input.verification !== "proven_not_started" &&
       input.verification !== "not_proven") ||
      input.ownerConfirmed !== true || !isAdminSession(input.session) ||
      getAdminRole(input.session) !== "owner" || !input.session.user?.id) {
    throw new AmuxSessionBudgetResolutionError("forbidden");
  }
  await assertRecentAdminAuthentication(input.session);
  await tx.$queryRaw`
    SELECT set_config('statement_timeout', '5000', true) AS statement_limit,
           set_config('idle_in_transaction_session_timeout', '10000', true) AS idle_limit,
           set_config('TimeZone', 'UTC', true) AS transaction_zone
  `;
  await takeAuditChainLock(tx);
  const locked = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "AmuxIdeaSessionAnalysisBudgetClaim"
    WHERE "id" = ${input.claimId} FOR UPDATE
  `;
  if (locked.length !== 1) {
    throw new AmuxSessionBudgetResolutionError("not_resolvable");
  }
  const claim = await tx.amuxIdeaSessionAnalysisBudgetClaim.findUnique({
    where: { id: input.claimId },
  });
  if (!claim || claim.namespace !== AMUX_V4_ANALYSIS_NAMESPACE ||
      claim.status !== "outcome_unknown" || claim.closedAt !== null ||
      claim.settledMicroUsd !== null || !claim.resolutionAuditLogId) {
    throw new AmuxSessionBudgetResolutionError("not_resolvable");
  }
  const priorAudit = await tx.adminAuditLog.findUnique({
    where: { id: claim.resolutionAuditLogId },
    select: { action: true, targetType: true, targetId: true,
      entryHash: true, metadata: true },
  });
  const metadata = priorAudit?.metadata;
  if (!priorAudit?.entryHash ||
      priorAudit.action !== AMUX_V19_SESSION_BUDGET_RESOLVE_ACTION ||
      priorAudit.targetType !== AMUX_V19_SESSION_BUDGET_TARGET ||
      priorAudit.targetId !== claim.id ||
      !metadata || typeof metadata !== "object" || Array.isArray(metadata) ||
      (metadata as Record<string, unknown>).status !== "outcome_unknown") {
    throw new AmuxSessionBudgetResolutionError("integrity_unavailable");
  }
  const windowRows = await tx.$queryRaw<Array<{ spentMicroUsd: bigint;
    reservedMicroUsd: bigint }>>`
    SELECT "spentMicroUsd", "reservedMicroUsd"
    FROM "AmuxIdeaAnalysisBudgetWindow"
    WHERE "namespace" = ${claim.namespace}
      AND "monthStart" = ${claim.monthStart} FOR UPDATE
  `;
  const window = windowRows[0];
  if (!window || window.reservedMicroUsd < claim.reservedMicroUsd) {
    throw new AmuxSessionBudgetResolutionError("integrity_unavailable");
  }
  const clock = await tx.$queryRaw<Array<{ now: Date }>>`
    SELECT (clock_timestamp() AT TIME ZONE 'UTC')::TIMESTAMP(3) AS "now"
  `;
  const now = clock[0]?.now;
  if (!(now instanceof Date) || !Number.isFinite(now.getTime()) ||
      now < claim.createdAt) {
    throw new AmuxSessionBudgetResolutionError("integrity_unavailable");
  }
  const status = input.verification === "proven_not_started"
    ? "released" as const : "owner_consumed" as const;
  const settled = status === "released" ? BigInt(0) : claim.reservedMicroUsd;
  const auditId = await writeAdminAuditLog({
    tx, session: input.session, request: input.request,
    action: AMUX_V19_SESSION_BUDGET_RESOLVE_ACTION,
    targetType: AMUX_V19_SESSION_BUDGET_TARGET, targetId: claim.id,
    summary: "Owner resolved one unknown v19 session CLI claim from exact read-back and local evidence.",
    metadata: { reservationId: claim.reservationId,
      previousResolutionAuditLogId: claim.resolutionAuditLogId,
      verification: input.verification,
      localEvidenceDigest: input.localEvidenceDigest,
      status, settledMicroUsd: settled.toString(),
      reservedMicroUsd: claim.reservedMicroUsd.toString(),
      namespace: AMUX_V4_ANALYSIS_NAMESPACE,
      monthStart: claim.monthStart.toISOString(),
      modelCallStarted: status === "released" ? false : "unproven" },
  });
  const moved = await tx.amuxIdeaAnalysisBudgetWindow.updateMany({
    where: { namespace: claim.namespace, monthStart: claim.monthStart,
      spentMicroUsd: window.spentMicroUsd,
      reservedMicroUsd: window.reservedMicroUsd },
    data: { spentMicroUsd: { increment: settled },
      reservedMicroUsd: { decrement: claim.reservedMicroUsd } },
  });
  const updated = await tx.amuxIdeaSessionAnalysisBudgetClaim.updateMany({
    where: { id: claim.id, status: "outcome_unknown", closedAt: null,
      resolutionAuditLogId: claim.resolutionAuditLogId },
    data: { status, settledMicroUsd: settled,
      resolutionAuditLogId: auditId, closedAt: now },
  });
  if (moved.count !== 1 || updated.count !== 1) {
    throw new AmuxSessionBudgetResolutionError("integrity_unavailable");
  }
  return { claimId: claim.id, status,
    settledMicroUsd: settled.toString(), auditId };
}
