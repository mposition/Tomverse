import "server-only";
import type { Prisma } from "@prisma/client";
import type { Session } from "next-auth";
import { takeAuditChainLock, writeAdminAuditLog } from "@/lib/adminAudit";
import { adminAuditIntegrityKeys } from "@/lib/adminAuditIntegrityCore";
import { getAdminRole, isAdminSession } from "@/lib/adminAuth";
import { assertRecentAdminAuthentication } from "@/lib/adminReauthentication";
import {
  AMUX_ANALYSIS_BUDGET_BOOTSTRAP, AMUX_ANALYSIS_BUDGET_SETTING_ACTION,
  AMUX_ANALYSIS_BUDGET_SETTING_TARGET, analysisBudgetUsdToMicroUsd,
  type AnalysisBudgetSnapshot,
} from "./ideaAnalysisBudgetSettingCore.ts";
import { AMUX_V4_ANALYSIS_NAMESPACE } from "./ideaAnalysisBudgetCore.ts";

type Tx = Prisma.TransactionClient;
export class AnalysisBudgetSettingError extends Error {
  constructor(readonly code: "forbidden" | "invalid_budget" | "revision_changed" |
    "below_committed_cost" | "request_already_seen" | "budget_unavailable") {
    super(code);
  }
}

export async function readAnalysisMonthlyBudgetSetting(tx: Tx) {
  const latest = await tx.amuxIdeaAnalysisBudgetSetting.findFirst({ orderBy: { version: "desc" } });
  // No catch/fallback on a failed read: a missing table or broken query closes admission.
  return latest ? { version: latest.version, limitMicroUsd: latest.limitMicroUsd.toString() }
    : AMUX_ANALYSIS_BUDGET_BOOTSTRAP;
}

async function databaseMonth(tx: Tx): Promise<Date> {
  const rows = await tx.$queryRaw<Array<{ monthStart: Date }>>`
    SELECT date_trunc('month', clock_timestamp() AT TIME ZONE 'UTC')::TIMESTAMP(3) AS "monthStart"
  `;
  const month = rows[0]?.monthStart;
  if (!(month instanceof Date) || !Number.isFinite(month.getTime())) {
    throw new AnalysisBudgetSettingError("budget_unavailable");
  }
  return month;
}

export async function readAnalysisBudgetSnapshot(tx: Tx): Promise<AnalysisBudgetSnapshot> {
  // The same lock keeps configuration and ledger counters in one coherent read.
  await takeAuditChainLock(tx);
  const setting = await readAnalysisMonthlyBudgetSetting(tx);
  const monthStart = await databaseMonth(tx);
  const window = await tx.amuxIdeaAnalysisBudgetWindow.findUnique({ where: {
    namespace_monthStart: { namespace: AMUX_V4_ANALYSIS_NAMESPACE, monthStart },
  } });
  if (window && window.limitMicroUsd !== BigInt(setting.limitMicroUsd)) {
    throw new AnalysisBudgetSettingError("budget_unavailable");
  }
  const spent = window?.spentMicroUsd ?? BigInt(0);
  const reserved = window?.reservedMicroUsd ?? BigInt(0);
  return { ...setting, monthStart: monthStart.toISOString(),
    spentMicroUsd: spent.toString(), reservedMicroUsd: reserved.toString(),
    remainingMicroUsd: (BigInt(setting.limitMicroUsd) - spent - reserved).toString() };
}

/** Sole configuration writer. It changes only the ceiling, never ledger usage. */
export async function commitAnalysisBudgetSetting(tx: Tx, input: {
  session: Session; request: Request; id: string; expectedPreviousVersion: number;
  monthlyUsd: string; ownerConfirmed: true;
}) {
  const actor = input.session.user?.id;
  if (!actor || !isAdminSession(input.session) || getAdminRole(input.session) !== "owner") {
    throw new AnalysisBudgetSettingError("forbidden");
  }
  await assertRecentAdminAuthentication(input.session);
  const limit = analysisBudgetUsdToMicroUsd(input.monthlyUsd);
  if (!limit || input.ownerConfirmed !== true ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(input.id) ||
      !Number.isSafeInteger(input.expectedPreviousVersion) ||
      input.expectedPreviousVersion < 0 || input.expectedPreviousVersion >= 2_147_483_647) {
    throw new AnalysisBudgetSettingError("invalid_budget");
  }
  if (!adminAuditIntegrityKeys(process.env)[0]) throw new AnalysisBudgetSettingError("budget_unavailable");
  await tx.$queryRaw`SELECT set_config('statement_timeout', '5000', true),
    set_config('idle_in_transaction_session_timeout', '10000', true)`;
  await takeAuditChainLock(tx);
  if (await tx.amuxIdeaAnalysisBudgetSetting.findUnique({ where: { id: input.id } })) {
    throw new AnalysisBudgetSettingError("request_already_seen");
  }
  const current = await readAnalysisMonthlyBudgetSetting(tx);
  if (current.version !== input.expectedPreviousVersion) throw new AnalysisBudgetSettingError("revision_changed");
  const monthStart = await databaseMonth(tx);
  const identity = { namespace: AMUX_V4_ANALYSIS_NAMESPACE, monthStart };
  await tx.$queryRaw`SELECT "namespace" FROM "AmuxIdeaAnalysisBudgetWindow"
    WHERE "namespace" = ${identity.namespace} AND "monthStart" = ${monthStart} FOR UPDATE`;
  const window = await tx.amuxIdeaAnalysisBudgetWindow.findUnique({ where: { namespace_monthStart: identity } });
  if (window && window.limitMicroUsd !== BigInt(current.limitMicroUsd)) {
    throw new AnalysisBudgetSettingError("budget_unavailable");
  }
  if (BigInt(limit) < (window?.spentMicroUsd ?? BigInt(0)) + (window?.reservedMicroUsd ?? BigInt(0))) {
    throw new AnalysisBudgetSettingError("below_committed_cost");
  }
  const version = current.version + 1;
  const auditId = await writeAdminAuditLog({ session: input.session, request: input.request,
    action: AMUX_ANALYSIS_BUDGET_SETTING_ACTION, targetType: AMUX_ANALYSIS_BUDGET_SETTING_TARGET,
    targetId: input.id, summary: "Owner changed the AMUX analysis monthly ceiling; usage preserved.",
    metadata: { namespace: AMUX_V4_ANALYSIS_NAMESPACE, version,
      previousVersion: current.version, previousLimitMicroUsd: current.limitMicroUsd,
      limitMicroUsd: limit, effectiveMonth: monthStart.toISOString(), policyVersion: 16 }, tx });
  await tx.amuxIdeaAnalysisBudgetSetting.create({ data: { id: input.id, version,
    limitMicroUsd: BigInt(limit), effectiveMonth: monthStart,
    approvedByUserId: actor, approvalAuditLogId: auditId } });
  if (window) await tx.amuxIdeaAnalysisBudgetWindow.update({ where: { namespace_monthStart: identity },
    data: { limitMicroUsd: BigInt(limit) } });
  return { id: input.id, version, limitMicroUsd: limit, auditId };
}
