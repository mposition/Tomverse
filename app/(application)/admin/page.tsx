export const dynamic = "force-dynamic";

import Link from "next/link";
import type { ReactNode } from "react";
import { notFound, redirect } from "next/navigation";
import { getServerSession } from "next-auth/next";
import {
    Activity,
    AlertTriangle,
    ArrowRight,
    BarChart3,
    Bell,
    CheckCircle2,
    Cloud,
    CreditCard,
    Database,
    Gauge,
    KeyRound,
    LayoutDashboard,
    LifeBuoy,
    MessageSquare,
    RotateCcw,
    ScrollText,
    Search,
    ShieldCheck,
    Users,
    WalletCards,
    XCircle,
} from "lucide-react";
import { authOptions } from "@/lib/auth";
import { getAdminRole, isAdminSession } from "@/lib/adminAuth";
import {
    getAdminActivePaidWhere,
    getAdminUsersPage,
    getAdminUserStats,
} from "@/lib/adminUsers";
import { getPublicAppSettings } from "@/lib/appSettings";
import { AVAILABLE_MODELS } from "@/lib/models";
import { prisma } from "@/lib/prisma";
import { AdminProviderHealthPanel } from "@/components/admin/AdminProviderHealthPanel";
import { AdminAuditPanel, type AdminAuditRow } from "@/components/admin/AdminAuditPanel";
import { AdminAlertPolicyPanel } from "@/components/admin/AdminAlertPolicyPanel";
import { AdminApprovalsPanel } from "@/components/admin/AdminApprovalsPanel";
import { AdminBillingLifecyclePanel } from "@/components/admin/AdminBillingLifecyclePanel";
import { AdminGlobalSearchPanel } from "@/components/admin/AdminGlobalSearchPanel";
import { AdminInfrastructurePanel } from "@/components/admin/AdminInfrastructurePanel";
import { AdminModelMetricsPanel, type AdminModelMetricRow } from "@/components/admin/AdminModelMetricsPanel";
import { AdminNotificationsPanel, type AdminNotificationRow } from "@/components/admin/AdminNotificationsPanel";
import { AdminOperationsPanel } from "@/components/admin/AdminOperationsPanel";
import { AdminProductAnalyticsPanel } from "@/components/admin/AdminProductAnalyticsPanel";
import {
    AdminProviderOpsPanel,
    type AdminProviderIncidentRow,
    type ProviderHealthCheckRow,
} from "@/components/admin/AdminProviderOpsPanel";
import { AdminProviderTabs } from "@/components/admin/AdminProviderTabs";
import { AdminProviderUsageSyncPanel } from "@/components/admin/AdminProviderUsageSyncPanel";
import { AdminRetentionPanel } from "@/components/admin/AdminRetentionPanel";
import { AdminReportsPanel } from "@/components/admin/AdminReportsPanel";
import {
    AdminRiskPanels,
    type FunnelMetrics,
    type PromoRiskRow,
    type SlaRow,
} from "@/components/admin/AdminRiskPanels";
import { AdminSavedViewsPanel } from "@/components/admin/AdminSavedViewsPanel";
import { AdminUsersPanel } from "@/components/admin/AdminUsersPanel";
import { AdminWebhookPanel } from "@/components/admin/AdminWebhookPanel";
import { BillingAdminPanel } from "@/components/admin/BillingAdminPanel";
import { FeedbackInboxPanel, type FeedbackRow } from "@/components/admin/FeedbackInboxPanel";
import { ModelOverridesPanel } from "@/components/admin/ModelOverridesPanel";
import { PlatformSettingsPanel } from "@/components/admin/PlatformSettingsPanel";
import { RefundRequestsPanel, type RefundRequestRow } from "@/components/admin/RefundRequestsPanel";
import {
    getBillingPlans,
    getBillingPromotions,
    syncBillingDefaultsToDatabase,
} from "@/lib/billingConfig";
import { getBillingPriceCatalogWithMeta } from "@/lib/billingPriceCatalog";
import { parsePromotionRiskFlags } from "@/lib/billingPromotionSecurity";
import {
    getProviderHealthDashboard,
    type ProviderHealthStatus,
} from "@/lib/providerMonitoring";
import { getModelOverrides } from "@/lib/modelOverrides";
import { getProductAnalyticsDashboard } from "@/lib/productAnalyticsDashboard";

const money = (microUsd: number) => `$${(microUsd / 1_000_000).toFixed(2)}`;

const statusCopy: Record<ProviderHealthStatus, string> = {
    available: "Available",
    limited: "Limited",
    outage: "Outage",
};

const adminTabs = [
    {
        id: "overview",
        label: "Overview",
        description: "Launch status",
        icon: LayoutDashboard,
    },
    {
        id: "search",
        label: "Search",
        description: "Find records",
        icon: Search,
    },
    {
        id: "platform",
        label: "Platform",
        description: "Defaults and product settings",
        icon: Gauge,
    },
    {
        id: "users",
        label: "Users",
        description: "Accounts and usage",
        icon: Users,
    },
    {
        id: "billing",
        label: "Billing",
        description: "Plans and promotions",
        icon: CreditCard,
    },
    {
        id: "refunds",
        label: "Refunds",
        description: "Cancellation queue",
        icon: RotateCcw,
    },
    {
        id: "providers",
        label: "Providers",
        description: "Health and budgets",
        icon: Activity,
    },
    {
        id: "analytics",
        label: "Analytics",
        description: "Funnel and activation",
        icon: BarChart3,
    },
    {
        id: "infrastructure",
        label: "Infrastructure",
        description: "Railway, R2, and database",
        icon: Cloud,
    },
    {
        id: "alerts",
        label: "Alerts",
        description: "Delivery logs",
        icon: Bell,
    },
    {
        id: "retention",
        label: "Retention",
        description: "Cleanup status",
        icon: Database,
    },
    {
        id: "feedback",
        label: "Feedback",
        description: "Support inbox",
        icon: LifeBuoy,
    },
    {
        id: "audit",
        label: "Audit",
        description: "Admin activity",
        icon: ScrollText,
    },
] as const;

type AdminTab = (typeof adminTabs)[number]["id"];

const isAdminTab = (value: unknown): value is AdminTab =>
    typeof value === "string" && adminTabs.some((tab) => tab.id === value);

const isConfigured = (value: string | undefined) =>
    typeof value === "string" && value.trim().length > 0;
const isStrongSecret = (value: string | undefined) =>
    typeof value === "string" && value.trim().length >= 32;
const isGa4MeasurementId = (value: string | undefined) =>
    typeof value === "string" && /^G-[A-Z0-9]+$/.test(value.trim());
const azureOAuthRequested =
    isConfigured(process.env.AZURE_AD_CLIENT_ID) ||
    isConfigured(process.env.AZURE_AD_CLIENT_SECRET) ||
    isConfigured(process.env.AZURE_AD_TENANT_ID);
const azureOAuthConfigurationComplete =
    !azureOAuthRequested ||
    (isConfigured(process.env.AZURE_AD_CLIENT_ID) &&
        isConfigured(process.env.AZURE_AD_CLIENT_SECRET) &&
        isConfigured(process.env.AZURE_AD_TENANT_ID));

function MetricCard({
    label,
    value,
    detail,
    icon,
}: {
    label: string;
    value: string;
    detail: string;
    icon: ReactNode;
}) {
    return (
        <div className="rounded-2xl border border-zinc-800 bg-zinc-950/70 p-5">
            <div className="flex items-center gap-3 text-zinc-400">
                <span className="flex h-9 w-9 items-center justify-center rounded-xl border border-zinc-800 bg-zinc-900 text-blue-300">
                    {icon}
                </span>
                <span className="text-xs font-semibold uppercase tracking-[0.18em]">
                    {label}
                </span>
            </div>
            <div className="mt-5 text-2xl font-semibold text-white">{value}</div>
            <p className="mt-2 text-sm text-zinc-400">{detail}</p>
        </div>
    );
}

function CommercialKpiCard({
    label,
    value,
    detail,
    tone = "zinc",
}: {
    label: string;
    value: string;
    detail: string;
    tone?: "zinc" | "blue" | "emerald" | "amber" | "purple";
}) {
    const toneClass =
        tone === "blue"
            ? "border-blue-500/25 bg-blue-500/10"
            : tone === "emerald"
                ? "border-emerald-500/25 bg-emerald-500/10"
                : tone === "amber"
                    ? "border-amber-500/25 bg-amber-500/10"
                    : tone === "purple"
                        ? "border-purple-500/25 bg-purple-500/10"
                        : "border-zinc-800 bg-zinc-900/60";
    return (
        <div className={`rounded-2xl border p-4 ${toneClass}`}>
            <p className="text-[11px] font-black uppercase tracking-[0.16em] text-zinc-500">
                {label}
            </p>
            <p className="mt-2 text-2xl font-black text-white">{value}</p>
            <p className="mt-1 text-xs leading-5 text-zinc-400">{detail}</p>
        </div>
    );
}

function AdminNav({ activeTab }: { activeTab: AdminTab }) {
    return (
        <aside className="lg:sticky lg:top-6 lg:self-start">
            <div className="rounded-3xl border border-zinc-800 bg-zinc-950/80 p-3 shadow-2xl shadow-black/20">
                <div className="px-3 py-3">
                    <div className="text-xs font-black uppercase tracking-[0.18em] text-blue-300">
                        Tomverse
                    </div>
                    <div className="mt-1 text-lg font-black text-white">Admin Console</div>
                </div>
                <nav className="mt-2 grid gap-1">
                    {adminTabs.map((tab) => {
                        const Icon = tab.icon;
                        const active = activeTab === tab.id;
                        return (
                            <Link
                                key={tab.id}
                                href={tab.id === "overview" ? "/admin" : `/admin?tab=${tab.id}`}
                                className={`flex items-start gap-3 rounded-2xl px-3 py-3 text-sm font-bold transition ${
                                    active
                                        ? "border border-blue-500/30 bg-blue-600 text-white shadow-lg shadow-blue-950/30"
                                        : "text-zinc-400 hover:bg-zinc-900 hover:text-white"
                                }`}
                            >
                                <Icon className="mt-0.5 h-4 w-4 shrink-0" />
                                <span>
                                    <span className="block">{tab.label}</span>
                                    <span
                                        className={`mt-0.5 block text-xs font-semibold ${
                                            active ? "text-blue-100/80" : "text-zinc-600"
                                        }`}
                                    >
                                        {tab.description}
                                    </span>
                                </span>
                            </Link>
                        );
                    })}
                </nav>
                <Link
                    href="/chat"
                    className="mt-4 flex items-center justify-center gap-2 rounded-2xl border border-zinc-800 px-3 py-2.5 text-sm font-black text-zinc-200 transition hover:border-zinc-700 hover:bg-zinc-900"
                >
                    Open app <ArrowRight className="h-4 w-4" />
                </Link>
            </div>
        </aside>
    );
}

function SectionHeader({
    eyebrow,
    title,
    description,
}: {
    eyebrow: string;
    title: string;
    description: string;
}) {
    return (
        <div>
            <p className="text-xs font-black uppercase tracking-[0.18em] text-blue-300">
                {eyebrow}
            </p>
            <h2 className="mt-2 text-2xl font-black text-white">{title}</h2>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-zinc-400">
                {description}
            </p>
        </div>
    );
}

type AdminPageProps = {
    searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
};

export default async function AdminPage({ searchParams }: AdminPageProps) {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
        redirect("/auth/signin?callbackUrl=/admin");
    }
    if (!isAdminSession(session)) {
        notFound();
    }

    const query = await searchParams;
    const rawTab = Array.isArray(query.tab) ? query.tab[0] : query.tab;
    const activeTab = isAdminTab(rawTab) ? rawTab : "overview";

    await syncBillingDefaultsToDatabase();

    const now = new Date();
    const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const activePaidWhere = getAdminActivePaidWhere(now);

    const [
        dashboard,
        billingPlans,
        billingPromotions,
        billingPricing,
        promotionRiskSignalGroups,
        userStats,
        conversationCount,
        messageCount,
        initialUsersPage,
        feedbackRows,
        openFeedbackCount,
        refundRows,
        pendingRefundCount,
        todayUsage,
        monthlyUsage,
        appSettings,
        auditLogs,
        activePlanGroups,
        promotionRedemptions,
        approvedRefundCount,
        rejectedRefundCount,
        modelOverrides,
        notificationLogs,
        providerIncidents,
        providerChecks,
        checkoutStartedCount,
        usersWithConversations,
        productAnalyticsDashboard,
    ] = await Promise.all([
        getProviderHealthDashboard({ includeErrorEvents: true }),
        getBillingPlans(),
        getBillingPromotions(),
        getBillingPriceCatalogWithMeta(),
        prisma.billingPromotionRedemption.groupBy({
            by: ["promotionId", "riskFlags"],
            where: { riskFlags: { not: "[]" } },
            _count: { _all: true },
        }),
        getAdminUserStats(),
        prisma.conversation.count(),
        prisma.message.count(),
        getAdminUsersPage({ take: 30, now }),
        prisma.feedback.findMany({
            orderBy: { createdAt: "desc" },
            take: 10,
        }),
        prisma.feedback.count({ where: { status: "open" } }),
        prisma.refundRequest.findMany({
            orderBy: { requestedAt: "desc" },
            take: 20,
            include: {
                timelineEvents: {
                    orderBy: { createdAt: "asc" },
                },
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
        }),
        prisma.refundRequest.count({ where: { status: "pending" } }),
        prisma.chatUsageBucket.aggregate({
            where: {
                period: "day",
                periodStart: dayStart,
                key: { startsWith: "user:" },
            },
            _sum: { count: true },
        }),
        prisma.chatUsageBucket.aggregate({
            where: {
                period: "month",
                periodStart: monthStart,
                key: { startsWith: "user:" },
            },
            _sum: { count: true },
        }),
        getPublicAppSettings(),
        prisma.adminAuditLog.findMany({
            orderBy: { createdAt: "desc" },
            take: 50,
        }),
        prisma.user.groupBy({
            by: ["plan"],
            where: activePaidWhere,
            _count: { _all: true },
        }),
        prisma.billingPromotionRedemption.count(),
        prisma.refundRequest.count({ where: { status: "approved" } }),
        prisma.refundRequest.count({ where: { status: "rejected" } }),
        getModelOverrides(),
        prisma.adminNotificationLog.findMany({
            orderBy: { createdAt: "desc" },
            take: 50,
        }),
        prisma.adminProviderIncident.findMany({
            orderBy: { createdAt: "desc" },
            take: 50,
        }),
        prisma.providerHealthCheck.findMany({
            orderBy: { createdAt: "desc" },
            take: 50,
        }),
        prisma.stripeWebhookEventLog.count({
            where: { eventType: "checkout.session.completed" },
        }),
        prisma.conversation.groupBy({
            by: ["userId"],
            _count: { _all: true },
        }),
        getProductAnalyticsDashboard(),
    ]);
    const availableCount = dashboard.providers.filter(
        (provider) => provider.status === "available"
    ).length;
    const limitedCount = dashboard.providers.filter(
        (provider) => provider.status === "limited"
    ).length;
    const outageCount = dashboard.providers.filter(
        (provider) => provider.status === "outage"
    ).length;
    const monthSpend = dashboard.providers.reduce(
        (sum, provider) => sum + provider.monthCostMicroUsd,
        0
    );
    const totalUsers = userStats.totalAccounts;
    const paidUsers = userStats.activePaidSubscriptions;
    const activeSubscriptions = userStats.activePaidSubscriptions;
    const cancelAtPeriodEndCount = userStats.cancelingSubscriptions;
    const refundRequestRows: RefundRequestRow[] = refundRows.map((request) => {
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
                sum + purchase.lots.reduce(
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
    const feedbackInboxRows: FeedbackRow[] = feedbackRows.map((feedback) => ({
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
        createdAt: feedback.createdAt.toISOString(),
    }));
    const auditRows: AdminAuditRow[] = auditLogs.map((log) => ({
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
    const notificationRows: AdminNotificationRow[] = notificationLogs.map((log) => ({
        id: log.id,
        channel: log.channel,
        title: log.title,
        detail: log.detail,
        status: log.status,
        targetType: log.targetType,
        targetId: log.targetId,
        error: log.error,
        acknowledgedAt: log.acknowledgedAt?.toISOString() || null,
        acknowledgedByEmail: log.acknowledgedByEmail,
        createdAt: log.createdAt.toISOString(),
    }));
    const promotionRiskSignalCount = new Map<
        string,
        { total: number; sharedIp: number; sharedPaymentMethod: number }
    >();
    for (const row of promotionRiskSignalGroups) {
        const current = promotionRiskSignalCount.get(row.promotionId) || {
            total: 0,
            sharedIp: 0,
            sharedPaymentMethod: 0,
        };
        const flags = parsePromotionRiskFlags(row.riskFlags);
        current.total += row._count._all;
        if (flags.includes("shared_ip")) current.sharedIp += row._count._all;
        if (flags.includes("shared_payment_method")) {
            current.sharedPaymentMethod += row._count._all;
        }
        promotionRiskSignalCount.set(row.promotionId, current);
    }
    const promoRiskRows: PromoRiskRow[] = billingPromotions
        .map((promotion) => {
            const abuseSignals = promotionRiskSignalCount.get(promotion.id) || {
                total: 0,
                sharedIp: 0,
                sharedPaymentMethod: 0,
            };
            const abuseSignalCount = abuseSignals.total;
            const nearingLimit =
                promotion.maxRedemptions &&
                promotion.redeemedCount >= Math.floor(promotion.maxRedemptions * 0.8);
            const highDiscount = promotion.discountPercent >= 80;
            const exhausted =
                promotion.maxRedemptions !== null &&
                promotion.redeemedCount >= promotion.maxRedemptions;
            const risk = abuseSignalCount > 0
                ? `${abuseSignalCount} abuse signal${abuseSignalCount === 1 ? "" : "s"}`
                : exhausted
                ? "exhausted"
                : nearingLimit
                    ? "near limit"
                    : highDiscount
                        ? "high discount"
                        : "";
            return {
                code: promotion.code,
                redeemedCount: promotion.redeemedCount,
                maxRedemptions: promotion.maxRedemptions,
                discountPercent: promotion.discountPercent,
                abuseSignalCount,
                sharedIpSignalCount: abuseSignals.sharedIp,
                sharedPaymentMethodSignalCount: abuseSignals.sharedPaymentMethod,
                risk,
            };
        })
        .filter((promotion) => promotion.risk);
    const slaRows: SlaRow[] = feedbackRows
        .filter((feedback) => feedback.status === "open")
        .map((feedback) => ({
            id: feedback.id,
            email: feedback.email,
            type: feedback.type,
            status: feedback.status,
            ageHours: Math.floor((now.getTime() - feedback.createdAt.getTime()) / 3_600_000),
            createdAt: feedback.createdAt.toISOString(),
        }))
        .filter((feedback) => feedback.ageHours >= 24)
        .slice(0, 10);
    const funnelMetrics: FunnelMetrics = {
        totalUsers,
        usersWithConversations: usersWithConversations.length,
        usersWithPaidPlan: paidUsers,
        checkoutStarted: checkoutStartedCount,
        paidUsers,
    };
    const providerIncidentRows: AdminProviderIncidentRow[] = providerIncidents.map((incident) => ({
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
    }));
    const providerCheckRows: ProviderHealthCheckRow[] = providerChecks.map((check) => ({
        id: check.id,
        provider: check.provider,
        modelId: check.modelId,
        status: check.status,
        latencyMs: check.latencyMs,
        errorCode: check.errorCode,
        message: check.message,
        createdByEmail: check.createdByEmail,
        createdAt: check.createdAt.toISOString(),
    }));
    const latestCheckByModel = new Map<string, ProviderHealthCheckRow>();
    const latestCheckByProvider = new Map<string, ProviderHealthCheckRow>();
    for (const check of providerCheckRows) {
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
    const modelMetricRows: AdminModelMetricRow[] = AVAILABLE_MODELS.map((model) => {
        const incident = incidentByModel.get(model.id);
        const check = latestCheckByModel.get(model.id) || latestCheckByProvider.get(model.provider);
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
    const activePlanCounts = new Map(
        activePlanGroups.map((group) => [group.plan || "Free", group._count._all])
    );
    const activeProCount = activePlanCounts.get("Pro") || 0;
    const activeMaxCount = activePlanCounts.get("Max") || 0;
    const billingPlanById = new Map(billingPlans.map((plan) => [plan.id, plan]));
    const monthlyRevenueCents =
        activeProCount * (billingPlanById.get("pro")?.monthlyPriceCents || 0) +
        activeMaxCount * (billingPlanById.get("max")?.monthlyPriceCents || 0);
    const estimatedMrr = `$${(monthlyRevenueCents / 100).toFixed(0)}`;
    const paidConversion =
        totalUsers > 0 ? `${((paidUsers / totalUsers) * 100).toFixed(1)}%` : "0.0%";
    const refundRate =
        promotionRedemptions > 0 || paidUsers > 0
            ? `${((approvedRefundCount / Math.max(paidUsers + approvedRefundCount, 1)) * 100).toFixed(1)}%`
            : "0.0%";
    const needsAttention = [
        ...dashboard.providers
            .filter((provider) => provider.status !== "available")
            .map((provider) => ({
                title: `${provider.displayName} is ${statusCopy[provider.status]}`,
                detail: provider.recentErrorCode || provider.fallback.reason,
                tone: provider.status === "outage" ? "red" : "amber",
            })),
        ...dashboard.providers
            .filter((provider) => !provider.apiKeyConfigured)
            .map((provider) => ({
                title: `${provider.displayName} API key missing`,
                detail: "Provider calls will fail or remain unavailable until the key is configured.",
                tone: "zinc",
            })),
        ...(openFeedbackCount > 0
            ? [
                  {
                      title: `${openFeedbackCount} open feedback item${openFeedbackCount === 1 ? "" : "s"}`,
                      detail: "Review user-reported issues before launch traffic grows.",
                      tone: "blue",
                  },
              ]
            : []),
        ...(pendingRefundCount > 0
            ? [
                  {
                      title: `${pendingRefundCount} pending refund request${pendingRefundCount === 1 ? "" : "s"}`,
                      detail: "Review billing cancellation requests and approve or reject them before renewal disputes grow.",
                      tone: "amber",
                  },
              ]
            : []),
    ].slice(0, 6);
    const generatedAtLabel = dashboard.generatedAt.replace("T", " ").slice(0, 16);
    const monthSpendLabel = money(monthSpend);
    const activeTabInfo =
        adminTabs.find((tab) => tab.id === activeTab) || adminTabs[0];
    const ActiveTabIcon = activeTabInfo.icon;
    const adminRole = getAdminRole(session) || "owner";
    const missingEnvCount = [
        process.env.ADMIN_EMAILS,
        process.env.STRIPE_SECRET_KEY,
        process.env.STRIPE_WEBHOOK_SECRET,
        process.env.RESEND_API_KEY,
        process.env.GA4_API_SECRET,
    ].filter((value) => !isConfigured(value)).length +
        [
            isStrongSecret(process.env.NEXTAUTH_SECRET),
            isStrongSecret(process.env.OAUTH_TOKEN_ENCRYPTION_KEY),
            isStrongSecret(process.env.MAINTENANCE_SECRET),
            azureOAuthConfigurationComplete,
            isGa4MeasurementId(process.env.GA4_MEASUREMENT_ID),
        ].filter((configured) => !configured).length;
    const alertFailures = notificationRows.filter((row) => row.status === "failed").length;
    const healthScore = Math.max(
        0,
        Math.min(
            100,
            100 -
                outageCount * 18 -
                limitedCount * 8 -
                pendingRefundCount * 3 -
                openFeedbackCount * 2 -
                missingEnvCount * 10 -
                alertFailures * 4
        )
    );
    const envChecks = [
        {
            name: "NEXTAUTH_SECRET",
            configured: isStrongSecret(process.env.NEXTAUTH_SECRET),
            description: "Requires a stable, high-entropy value of at least 32 characters.",
        },
        {
            name: "OAUTH_TOKEN_ENCRYPTION_KEY",
            configured: isStrongSecret(process.env.OAUTH_TOKEN_ENCRYPTION_KEY),
            description: "Dedicated 32+ character key required for OAuth token encryption.",
        },
        {
            name: "AZURE_AD_*",
            configured: azureOAuthConfigurationComplete,
            description: "Client ID, client secret, and tenant ID must be configured together; common is supported for public sign-in.",
        },
        {
            name: "MAINTENANCE_SECRET",
            configured: isStrongSecret(process.env.MAINTENANCE_SECRET),
            description: "Protects the scheduled cleanup endpoint and must be at least 32 characters.",
        },
        {
            name: "ADMIN_EMAILS",
            configured: isConfigured(process.env.ADMIN_EMAILS),
            description: "Controls who can access this console.",
        },
        {
            name: "STRIPE_SECRET_KEY",
            configured: isConfigured(process.env.STRIPE_SECRET_KEY),
            description: "Required for checkout, refunds, and subscription cancellation.",
        },
        {
            name: "STRIPE_WEBHOOK_SECRET",
            configured: isConfigured(process.env.STRIPE_WEBHOOK_SECRET),
            description: "Required to trust Stripe billing events.",
        },
        {
            name: "GA4_MEASUREMENT_ID",
            configured: isGa4MeasurementId(process.env.GA4_MEASUREMENT_ID),
            description: "Public GA4 web data-stream identifier used after analytics consent.",
        },
        {
            name: "GA4_API_SECRET",
            configured: isConfigured(process.env.GA4_API_SECRET),
            description: "Server-only Measurement Protocol secret for purchase and cancellation events.",
        },
        {
            name: "RESEND_API_KEY",
            configured: isConfigured(process.env.RESEND_API_KEY),
            description: "Required for Tomverse transactional email.",
        },
        {
            name: "SUPPORT_NOTIFICATION_EMAIL",
            configured:
                isConfigured(process.env.SUPPORT_NOTIFICATION_EMAIL) ||
                isConfigured(process.env.ADMIN_ALERT_EMAIL) ||
                isConfigured(process.env.ADMIN_EMAILS),
            description: "Receives website support form notifications. Falls back to ADMIN_ALERT_EMAIL or ADMIN_EMAILS.",
        },
        {
            name: "TRANSACTIONAL_EMAIL_FROM",
            configured: true,
            description: "Verified sender used for account and billing emails. Defaults to hello@tomverse.app.",
        },
        {
            name: "SLACK_WEBHOOK_URL",
            configured: isConfigured(process.env.SLACK_WEBHOOK_URL),
            description: "Optional incident notification channel.",
        },
        {
            name: "PROVIDER_USAGE_SLACK_WEBHOOK_URL",
            configured:
                isConfigured(process.env.PROVIDER_USAGE_SLACK_WEBHOOK_URL) ||
                isConfigured(process.env.SLACK_WEBHOOK_URL),
            description: "Daily provider usage and estimated-balance report channel. Falls back to SLACK_WEBHOOK_URL.",
        },
        {
            name: "DISCORD_WEBHOOK_URL",
            configured: isConfigured(process.env.DISCORD_WEBHOOK_URL),
            description: "Optional secondary incident notification channel.",
        },
        {
            name: "SENTRY_DSN",
            configured: isConfigured(process.env.SENTRY_DSN),
            description: "DB-independent server error retention for outages that cannot be written to Prisma.",
        },
        {
            name: "OPS_ALERT_CHANNEL",
            configured:
                isConfigured(process.env.OPS_ALERT_SLACK_WEBHOOK_URL) ||
                isConfigured(process.env.SLACK_WEBHOOK_URL) ||
                isConfigured(process.env.OPS_ALERT_DISCORD_WEBHOOK_URL) ||
                isConfigured(process.env.DISCORD_WEBHOOK_URL) ||
                (isConfigured(process.env.RESEND_API_KEY) &&
                    (isConfigured(process.env.OPS_ALERT_EMAIL) ||
                        isConfigured(process.env.ADMIN_ALERT_EMAIL))),
            description: "At least one DB-independent Slack, Discord, or email incident channel.",
        },
    ];

    return (
        <main className="min-h-screen bg-zinc-950 text-zinc-100">
            <div className="mx-auto grid w-full max-w-[96rem] gap-6 px-5 py-6 lg:grid-cols-[16rem_1fr] lg:px-8">
                <AdminNav activeTab={activeTab} />
                <div className="flex min-w-0 flex-col gap-8">
                    <header id="overview" className="rounded-3xl border border-zinc-800 bg-gradient-to-br from-zinc-900 to-zinc-950 p-6 shadow-2xl shadow-black/20">
                        <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
                            <div>
                                <div className="inline-flex items-center gap-2 rounded-full border border-blue-500/30 bg-blue-500/10 px-3 py-1 text-xs font-semibold uppercase tracking-[0.18em] text-blue-200">
                                    <ShieldCheck className="h-3.5 w-3.5" />
                                    Admin only
                                </div>
                                <h1 className="mt-5 text-3xl font-black tracking-tight text-white sm:text-4xl">
                                    Tomverse Operations
                                </h1>
                                <p className="mt-3 max-w-3xl text-sm leading-6 text-zinc-400">
                                    Commercial launch console for users, billing, provider health,
                                    feedback, alerts, and launch-critical limits.
                                </p>
                            </div>
                            <div className="text-sm text-zinc-500">
                                <span className="inline-flex items-center gap-2 rounded-full border border-zinc-800 bg-zinc-950 px-3 py-1.5 font-bold text-zinc-300">
                                    <ActiveTabIcon className="h-4 w-4 text-blue-300" />
                                    {activeTabInfo.label}
                                </span>
                                <span className="ml-2 inline-flex items-center gap-2 rounded-full border border-purple-500/30 bg-purple-500/10 px-3 py-1.5 font-bold capitalize text-purple-200">
                                    {adminRole}
                                </span>
                                <div className="mt-2 text-right text-xs">
                                    Generated {generatedAtLabel} UTC
                                </div>
                            </div>
                        </div>
                    </header>

                    {activeTab === "overview" && (
                        <>
                            <AdminSavedViewsPanel activeTab={activeTab} />

                            <AdminOperationsPanel
                                generatedAt={generatedAtLabel}
                                totalUsers={totalUsers}
                                paidUsers={paidUsers}
                                activeSubscriptions={activeSubscriptions}
                                openFeedbackCount={openFeedbackCount}
                                pendingRefundCount={pendingRefundCount}
                                providerAvailableCount={availableCount}
                                providerTotalCount={dashboard.providers.length}
                                monthSpendLabel={monthSpendLabel}
                                needsAttention={needsAttention}
                                envChecks={envChecks}
                                adminRole={adminRole}
                                healthScore={healthScore}
                            />

                            <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
                                <MetricCard
                                    label="Users"
                                    value={String(totalUsers)}
                                    detail={`${paidUsers} paid, ${activeSubscriptions} active subscriptions`}
                                    icon={<Users className="h-4 w-4" />}
                                />
                                <MetricCard
                                    label="Messages"
                                    value={String(todayUsage._sum.count || 0)}
                                    detail={`${monthlyUsage._sum.count || 0} this month, ${messageCount} total`}
                                    icon={<MessageSquare className="h-4 w-4" />}
                                />
                                <MetricCard
                                    label="Provider status"
                                    value={`${availableCount} / ${dashboard.providers.length}`}
                                    detail={`${limitedCount} limited, ${outageCount} outage`}
                                    icon={<Activity className="h-4 w-4" />}
                                />
                                <MetricCard
                                    label="Monthly spend"
                                    value={monthSpendLabel}
                                    detail="Estimated from reserved token budgets"
                                    icon={<WalletCards className="h-4 w-4" />}
                                />
                            </section>

                            <section className="rounded-3xl border border-zinc-800 bg-zinc-950/70 p-5">
                                <SectionHeader
                                    eyebrow="Commercial"
                                    title="Revenue and retention snapshot"
                                    description="A compact read on paid conversion, active plan mix, promotions, refunds, and subscriptions scheduled to cancel."
                                />
                                <div className="mt-5 grid gap-3 md:grid-cols-2 xl:grid-cols-5">
                                    <CommercialKpiCard
                                        label="Estimated MRR"
                                        value={estimatedMrr}
                                        detail="Calculated from active Pro and Max monthly list prices."
                                        tone="emerald"
                                    />
                                    <CommercialKpiCard
                                        label="Paid conversion"
                                        value={paidConversion}
                                        detail={`${paidUsers} active paid users out of ${totalUsers} total accounts.`}
                                        tone="blue"
                                    />
                                    <CommercialKpiCard
                                        label="Plan mix"
                                        value={`${activeProCount} / ${activeMaxCount}`}
                                        detail="Active Pro / Max subscriptions."
                                        tone="purple"
                                    />
                                    <CommercialKpiCard
                                        label="Promo redemptions"
                                        value={String(promotionRedemptions)}
                                        detail="Total redeemed promotion records in the database."
                                        tone="amber"
                                    />
                                    <CommercialKpiCard
                                        label="Churn watch"
                                        value={String(cancelAtPeriodEndCount)}
                                        detail={`Cancel at period end. Approved refund rate ${refundRate}.`}
                                        tone={cancelAtPeriodEndCount > 0 ? "amber" : "zinc"}
                                    />
                                </div>
                            </section>

                            <section className="grid gap-4 xl:grid-cols-[1.1fr_0.9fr]">
                                <div className="rounded-3xl border border-zinc-800 bg-zinc-950/70 p-5">
                                    <SectionHeader
                                        eyebrow="Needs attention"
                                        title="Launch readiness queue"
                                        description="The highest-signal items an operator should review before they become user-facing incidents."
                                    />
                                    <div className="mt-5 grid gap-3">
                                        {needsAttention.length === 0 ? (
                                            <div className="rounded-2xl border border-emerald-500/20 bg-emerald-500/10 p-4 text-sm text-emerald-200">
                                                No immediate operational issues detected.
                                            </div>
                                        ) : (
                                            needsAttention.map((item) => (
                                                <div
                                                    key={`${item.title}-${item.detail}`}
                                                    className={`rounded-2xl border p-4 ${
                                                        item.tone === "red"
                                                            ? "border-red-500/30 bg-red-500/10"
                                                            : item.tone === "amber"
                                                                ? "border-amber-500/30 bg-amber-500/10"
                                                                : item.tone === "blue"
                                                                    ? "border-blue-500/30 bg-blue-500/10"
                                                                    : "border-zinc-800 bg-zinc-900/70"
                                                    }`}
                                                >
                                                    <div className="font-black text-white">{item.title}</div>
                                                    <p className="mt-1 text-sm leading-6 text-zinc-400">{item.detail}</p>
                                                </div>
                                            ))
                                        )}
                                    </div>
                                </div>
                                <div className="rounded-3xl border border-zinc-800 bg-zinc-950/70 p-5">
                                    <SectionHeader
                                        eyebrow="System setup"
                                        title="Environment health"
                                        description="Variables that control admin access, Stripe, provider balance, and alert delivery."
                                    />
                                    <div className="mt-5 grid gap-2 text-xs text-zinc-400 sm:grid-cols-2">
                                        {[
                                            "ADMIN_EMAILS",
                                            "STRIPE_SECRET_KEY",
                                            "STRIPE_WEBHOOK_SECRET",
                                            "SLACK_WEBHOOK_URL",
                                            "PROVIDER_USAGE_SLACK_WEBHOOK_URL",
                                            "SENTRY_DSN",
                                            "OPS_ALERT_CHANNEL",
                                            "OPENAI_ADMIN_API_KEY",
                                            "ANTHROPIC_ADMIN_API_KEY",
                                            "PROVIDER_USAGE_SYNC_SECRET",
                                            "PROVIDER_OPENAI_BALANCE_USD",
                                            "CHAT_PROVIDER_OPENAI_COST_MICROUSD_PER_DAY",
                                        ].map((name) => (
                                            <span key={name} className="rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2">
                                                {name}
                                            </span>
                                        ))}
                                    </div>
                                </div>
                            </section>

                            <AdminRiskPanels
                                promoRisks={promoRiskRows}
                                slaRows={slaRows}
                                funnel={funnelMetrics}
                            />

                            <AdminApprovalsPanel />
                        </>
                    )}

                    {activeTab === "users" && (
                        <AdminUsersPanel
                            rows={initialUsersPage.users}
                            initialNextCursor={initialUsersPage.nextCursor}
                            stats={userStats}
                            currentUserId={session.user.id}
                            conversationCount={conversationCount}
                        />
                    )}

                    {activeTab === "search" && (
                        <AdminGlobalSearchPanel />
                    )}

                    {activeTab === "analytics" && (
                        <AdminProductAnalyticsPanel dashboard={productAnalyticsDashboard} />
                    )}

                    {activeTab === "platform" && (
                        <PlatformSettingsPanel settings={appSettings} />
                    )}

                    {activeTab === "billing" && (
                    <section>
                        <AdminBillingLifecyclePanel
                            activePaidUsers={paidUsers}
                            activeSubscriptions={activeSubscriptions}
                            pendingRefunds={pendingRefundCount}
                            approvedRefunds={approvedRefundCount}
                            rejectedRefunds={rejectedRefundCount}
                            cancelAtPeriodEnd={cancelAtPeriodEndCount}
                        />
                        <div className="mt-4" />
                        <BillingAdminPanel
                            plans={billingPlans}
                            promotions={billingPromotions}
                            priceCatalog={billingPricing.catalog}
                            priceCatalogUpdatedAt={billingPricing.updatedAt}
                            paidUserCount={paidUsers}
                            activeSubscriptionCount={activeSubscriptions}
                        />
                    </section>
                    )}

                    {activeTab === "refunds" && (
                    <section className="flex flex-col gap-4">
                        <AdminBillingLifecyclePanel
                            activePaidUsers={paidUsers}
                            activeSubscriptions={activeSubscriptions}
                            pendingRefunds={pendingRefundCount}
                            approvedRefunds={approvedRefundCount}
                            rejectedRefunds={rejectedRefundCount}
                            cancelAtPeriodEnd={cancelAtPeriodEndCount}
                        />
                        <RefundRequestsPanel
                            rows={refundRequestRows}
                        />
                    </section>
                    )}

                    {activeTab === "providers" && (
                    <AdminProviderTabs
                        activeIncidentCount={providerIncidentRows.filter((incident) => incident.status !== "resolved").length}
                        blockedModelCount={modelOverrides.filter((override) => override.status !== "available").length}
                        healthContent={
                            <section className="flex flex-col gap-4">
                                <div className="flex flex-wrap items-center justify-between gap-3">
                                    <SectionHeader
                                        eyebrow="Providers"
                                        title="Provider health"
                                        description="Status, key configuration, internal usage, provider usage reconciliation, fallback policy, recent errors, alert setup, and model metrics."
                                    />
                                    <div className="flex flex-wrap gap-2 text-xs">
                                        <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-3 py-1 text-emerald-300">
                                            <CheckCircle2 className="h-3.5 w-3.5" /> Available
                                        </span>
                                        <span className="inline-flex items-center gap-1 rounded-full border border-amber-500/30 bg-amber-500/10 px-3 py-1 text-amber-300">
                                            <AlertTriangle className="h-3.5 w-3.5" /> Limited
                                        </span>
                                        <span className="inline-flex items-center gap-1 rounded-full border border-red-500/30 bg-red-500/10 px-3 py-1 text-red-300">
                                            <XCircle className="h-3.5 w-3.5" /> Outage
                                        </span>
                                        <span className="inline-flex items-center gap-1 rounded-full border border-zinc-700 bg-zinc-900 px-3 py-1 text-zinc-300">
                                            <KeyRound className="h-3.5 w-3.5" /> Key
                                        </span>
                                    </div>
                                </div>
                                <AdminProviderUsageSyncPanel />
                                <AdminProviderHealthPanel
                                    initialDashboard={dashboard}
                                    canManageCredits={adminRole === "owner" || adminRole === "billing"}
                                />
                                <AdminModelMetricsPanel rows={modelMetricRows} />
                            </section>
                        }
                        operationsContent={
                            <AdminProviderOpsPanel
                                models={AVAILABLE_MODELS}
                                incidents={providerIncidentRows}
                                checks={providerCheckRows}
                            />
                        }
                        controlsContent={
                            <ModelOverridesPanel
                                models={AVAILABLE_MODELS}
                                overrides={modelOverrides}
                            />
                        }
                    />
                    )}

                    {activeTab === "infrastructure" && (
                        <AdminInfrastructurePanel
                            canManageCosts={adminRole === "owner" || adminRole === "billing"}
                        />
                    )}

                    {activeTab === "alerts" && (
                        <section className="flex flex-col gap-4">
                            <AdminAlertPolicyPanel />
                            <AdminNotificationsPanel rows={notificationRows} />
                            <AdminWebhookPanel />
                            <AdminReportsPanel />
                        </section>
                    )}

                    {activeTab === "retention" && (
                        <AdminRetentionPanel />
                    )}

                    {activeTab === "feedback" && (
                    <FeedbackInboxPanel rows={feedbackInboxRows} />
                    )}

                    {activeTab === "audit" && (
                        <AdminAuditPanel rows={auditRows} />
                    )}
                </div>
            </div>
        </main>
    );
}
