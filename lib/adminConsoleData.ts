import { prisma } from "@/lib/prisma";
import type { AdminAuditRow } from "@/components/admin/AdminAuditPanel";
import type { AdminModelMetricRow } from "@/components/admin/AdminModelMetricsPanel";
import type {
  AdminProviderIncidentRow,
  ProviderHealthCheckRow,
} from "@/components/admin/AdminProviderOpsPanel";
import type { FeedbackRow } from "@/components/admin/FeedbackInboxPanel";
import type { RefundRequestRow } from "@/components/admin/RefundRequestsPanel";
import type { SlaRow } from "@/components/admin/AdminRiskPanels";
import { getRuntimeModels } from "@/lib/modelRegistry";
import {
  getProviderHealthDashboard,
  type ProviderHealthDashboard,
} from "@/lib/providerMonitoring";

/**
 * Per-surface loaders for the Admin Console.
 *
 * Each function loads exactly one surface's data. The console previously ran a
 * single 29-query `Promise.all` for every route -- opening the audit log paid
 * for the refund queue, the provider dashboard, the analytics rollup and the
 * credit ledger -- and this module is what lets a page ask for its own rows
 * instead. Nothing here is shared state; the sharing is at the query level, so
 * two surfaces that genuinely need the same rows (the refund queue and the work
 * queue) call the same function rather than copying it.
 */

/** How many rows each bounded read returns, named so pages can say so on screen. */
export const ADMIN_READ_LIMITS = {
  auditLog: 50,
  creditLedger: 100,
  feedback: 20,
  refunds: 20,
  providerIncidents: 50,
  providerChecks: 50,
  recentActivity: 8,
} as const;

const feedbackInclude = {
  // The linked evidence occurrence, when the report verified with an exact
  // link. Sanitized technical fields only -- the evidence model stores no
  // message bodies by contract.
  traceEvidence: {
    select: {
      occurrenceId: true,
      environment: true,
      release: true,
      routeClass: true,
      phase: true,
      errorCode: true,
      classificationSource: true,
      httpStatus: true,
      provider: true,
      modelId: true,
      sentryEventId: true,
      occurredAt: true,
    },
  },
  // Phase 2 shadow diagnosis state -- observational only; the panel labels it
  // explicitly as "no auto-fix exists".
  autoFixCase: {
    select: {
      state: true,
      classification: true,
      ineligibilityReason: true,
      updatedAt: true,
    },
  },
} as const;

export async function loadFeedbackRows(options?: {
  status?: string;
  take?: number;
}): Promise<FeedbackRow[]> {
  const rows = await prisma.feedback.findMany({
    where: options?.status ? { status: options.status } : undefined,
    orderBy: { createdAt: "desc" },
    take: options?.take ?? ADMIN_READ_LIMITS.feedback,
    include: feedbackInclude,
  });
  return rows.map((feedback) => ({
    id: feedback.id,
    userId: feedback.userId,
    email: feedback.email,
    type: feedback.type,
    status: feedback.status,
    message: feedback.message,
    traceId: feedback.traceId,
    modelId: feedback.modelId,
    plan: feedback.plan,
    hasAttachments: feedback.hasAttachments,
    attachmentCount: feedback.attachmentCount,
    path: feedback.path,
    userAgent: feedback.userAgent,
    language: feedback.language,
    emailUpdatesConsent: feedback.emailUpdatesConsent,
    closureOutcome: feedback.closureOutcome,
    userReply: feedback.userReply,
    errorReportVerification: feedback.errorReportVerification,
    traceProvenance: feedback.traceProvenance,
    errorClassificationSource: feedback.errorClassificationSource,
    clientErrorCode: feedback.clientErrorCode,
    evidenceAvailability: feedback.evidenceAvailability,
    traceEvidence: feedback.traceEvidence
      ? {
          occurrenceId: feedback.traceEvidence.occurrenceId,
          environment: feedback.traceEvidence.environment,
          release: feedback.traceEvidence.release,
          routeClass: feedback.traceEvidence.routeClass,
          phase: feedback.traceEvidence.phase,
          errorCode: feedback.traceEvidence.errorCode,
          classificationSource: feedback.traceEvidence.classificationSource,
          httpStatus: feedback.traceEvidence.httpStatus,
          provider: feedback.traceEvidence.provider,
          modelId: feedback.traceEvidence.modelId,
          sentryEventId: feedback.traceEvidence.sentryEventId,
          occurredAt: feedback.traceEvidence.occurredAt.toISOString(),
        }
      : null,
    autoFixCase: feedback.autoFixCase
      ? {
          state: feedback.autoFixCase.state,
          classification: feedback.autoFixCase.classification,
          ineligibilityReason: feedback.autoFixCase.ineligibilityReason,
          updatedAt: feedback.autoFixCase.updatedAt.toISOString(),
        }
      : null,
    createdAt: feedback.createdAt.toISOString(),
  }));
}

/** Open reports older than a day, oldest first, for the work queue. */
export const feedbackSlaRows = (rows: FeedbackRow[], now: Date): SlaRow[] =>
  rows
    .filter((feedback) => feedback.status === "open")
    .map((feedback) => ({
      id: feedback.id,
      email: feedback.email,
      type: feedback.type,
      status: feedback.status,
      ageHours: Math.floor(
        (now.getTime() - new Date(feedback.createdAt).getTime()) / 3_600_000
      ),
      createdAt: feedback.createdAt,
    }))
    .filter((feedback) => feedback.ageHours >= 24)
    .sort((left, right) => right.ageHours - left.ageHours)
    .slice(0, 10);

export async function loadRefundRequestRows(options?: {
  status?: string;
  take?: number;
}): Promise<RefundRequestRow[]> {
  const rows = await prisma.refundRequest.findMany({
    where: options?.status ? { status: options.status } : undefined,
    orderBy: { requestedAt: "desc" },
    take: options?.take ?? ADMIN_READ_LIMITS.refunds,
    include: {
      timelineEvents: { orderBy: { createdAt: "asc" } },
      user: {
        select: {
          creditDebtCredits: true,
          creditDebtCostMicroUsd: true,
          billingRiskStatus: true,
          creditPurchases: {
            select: {
              creditsPurchased: true,
              fundedCostMicroUsd: true,
              revokedCredits: true,
              revokedCostMicroUsd: true,
              unrecoveredCredits: true,
              unrecoveredCostMicroUsd: true,
              lots: {
                select: {
                  remainingCredits: true,
                  remainingFundedCostMicroUsd: true,
                },
              },
            },
          },
        },
      },
    },
  });

  return rows.map((request) => {
    const purchases = request.user?.creditPurchases || [];
    const purchasedCredits = purchases.reduce(
      (sum, purchase) => sum + purchase.creditsPurchased,
      0
    );
    const purchasedCostMicroUsd = purchases.reduce(
      (sum, purchase) => sum + Number(purchase.fundedCostMicroUsd),
      0
    );
    const remainingCredits = purchases.reduce(
      (sum, purchase) =>
        sum + purchase.lots.reduce((lotSum, lot) => lotSum + lot.remainingCredits, 0),
      0
    );
    const remainingCostMicroUsd = purchases.reduce(
      (sum, purchase) =>
        sum +
        purchase.lots.reduce(
          (lotSum, lot) => lotSum + Number(lot.remainingFundedCostMicroUsd),
          0
        ),
      0
    );
    const revokedCredits = purchases.reduce(
      (sum, purchase) => sum + purchase.revokedCredits,
      0
    );
    const revokedCostMicroUsd = purchases.reduce(
      (sum, purchase) => sum + Number(purchase.revokedCostMicroUsd),
      0
    );
    return {
      id: request.id,
      email: request.email,
      plan: request.plan,
      status: request.status,
      reason: request.reason,
      adminNote: request.adminNote,
      stripeCustomerId: request.stripeCustomerId,
      stripeSubscriptionId: request.stripeSubscriptionId,
      subscriptionStatus: request.subscriptionStatus,
      subscriptionBillingInterval: request.subscriptionBillingInterval,
      subscriptionCurrentPeriodEnd:
        request.subscriptionCurrentPeriodEnd?.toISOString() || null,
      stripeRefundId: request.stripeRefundId,
      stripeRefundStatus: request.stripeRefundStatus,
      stripeChargeId: request.stripeChargeId,
      refundAmountCents: request.refundAmountCents,
      refundCurrency: request.refundCurrency,
      requestedAt: request.requestedAt.toISOString(),
      reviewedAt: request.reviewedAt?.toISOString() || null,
      timelineEvents: request.timelineEvents.map((event) => ({
        id: event.id,
        eventType: event.eventType,
        message: event.message,
        actorEmail: event.actorEmail,
        createdAt: event.createdAt.toISOString(),
      })),
      creditRisk: {
        requiresReview:
          purchases.length > 0 || (request.user?.creditDebtCredits || 0) > 0,
        purchaseCount: purchases.length,
        purchasedCredits,
        remainingCredits,
        estimatedUsedCredits: Math.max(
          0,
          purchasedCredits - remainingCredits - revokedCredits
        ),
        purchasedCostMicroUsd,
        remainingCostMicroUsd,
        estimatedConsumedCostMicroUsd: Math.max(
          0,
          purchasedCostMicroUsd - remainingCostMicroUsd - revokedCostMicroUsd
        ),
        unrecoveredCredits: request.user?.creditDebtCredits || 0,
        unrecoveredCostMicroUsd: Number(
          request.user?.creditDebtCostMicroUsd || BigInt(0)
        ),
        billingRiskStatus: request.user?.billingRiskStatus || "normal",
      },
    };
  });
}

export async function loadAuditRows(
  take: number = ADMIN_READ_LIMITS.auditLog
): Promise<AdminAuditRow[]> {
  const logs = await prisma.adminAuditLog.findMany({
    orderBy: { createdAt: "desc" },
    take,
  });
  return logs.map((log) => ({
    id: log.id,
    actorUserId: log.actorUserId,
    actorEmail: log.actorEmail,
    action: log.action,
    targetType: log.targetType,
    targetId: log.targetId,
    summary: log.summary,
    metadata: log.metadata,
    ipAddress: log.ipAddress,
    userAgent: log.userAgent,
    createdAt: log.createdAt.toISOString(),
  }));
}

export type ProviderOpsData = {
  models: Awaited<ReturnType<typeof getRuntimeModels>>;
  incidents: AdminProviderIncidentRow[];
  checks: ProviderHealthCheckRow[];
};

export async function loadProviderOpsData(): Promise<ProviderOpsData> {
  const [models, incidents, checks] = await Promise.all([
    getRuntimeModels({ includeCatalogDeleted: true }),
    prisma.adminProviderIncident.findMany({
      orderBy: { createdAt: "desc" },
      take: ADMIN_READ_LIMITS.providerIncidents,
    }),
    prisma.providerHealthCheck.findMany({
      orderBy: { createdAt: "desc" },
      take: ADMIN_READ_LIMITS.providerChecks,
    }),
  ]);
  return {
    models: models.filter((model) => !model.catalogDeleted),
    incidents: incidents.map((incident) => ({
      id: incident.id,
      provider: incident.provider,
      modelId: incident.modelId,
      status: incident.status,
      title: incident.title,
      message: incident.message,
      fallbackModelIds: incident.fallbackModelIds,
      createdByEmail: incident.createdByEmail,
      resolvedByEmail: incident.resolvedByEmail,
      startsAt: incident.startsAt.toISOString(),
      resolvedAt: incident.resolvedAt?.toISOString() || null,
      createdAt: incident.createdAt.toISOString(),
    })),
    checks: checks.map((check) => ({
      id: check.id,
      provider: check.provider,
      modelId: check.modelId,
      status: check.status,
      latencyMs: check.latencyMs,
      errorCode: check.errorCode,
      message: check.message,
      createdByEmail: check.createdByEmail,
      createdAt: check.createdAt.toISOString(),
    })),
  };
}

/**
 * Per-model status, joined from the live dashboard and the most recent check.
 *
 * Takes the dashboard and the ops data as arguments rather than loading them:
 * the two pages that render this table already hold both, and re-querying would
 * put the console back in the habit this refactor removed.
 */
export const buildModelMetricRows = (
  dashboard: ProviderHealthDashboard,
  ops: ProviderOpsData
): AdminModelMetricRow[] => {
  const latestCheckByModel = new Map<string, ProviderHealthCheckRow>();
  const latestCheckByProvider = new Map<string, ProviderHealthCheckRow>();
  for (const check of ops.checks) {
    if (check.modelId && !latestCheckByModel.has(check.modelId)) {
      latestCheckByModel.set(check.modelId, check);
    }
    if (!latestCheckByProvider.has(check.provider)) {
      latestCheckByProvider.set(check.provider, check);
    }
  }
  const incidentByModel = new Map(
    dashboard.providers.flatMap((provider) =>
      provider.modelIncidents.map((incident) => [incident.modelId, incident] as const)
    )
  );
  const providerStatusById = new Map(
    dashboard.providers.map((provider) => [provider.provider, provider.status])
  );
  return ops.models.map((model) => {
    const incident = incidentByModel.get(model.id);
    const check =
      latestCheckByModel.get(model.id) || latestCheckByProvider.get(model.provider);
    return {
      modelId: model.id,
      modelName: model.name,
      provider: model.provider,
      status: incident
        ? "outage"
        : providerStatusById.get(model.provider) || "available",
      failureCount5m: incident?.failureCount5m || 0,
      recentErrorCode: incident?.recentErrorCode || check?.errorCode || null,
      updatedAt: incident?.updatedAt || check?.createdAt || null,
      latencyMs: check?.latencyMs || null,
    };
  });
};

export const loadProviderHealthDashboard = () =>
  getProviderHealthDashboard({ includeErrorEvents: true });
