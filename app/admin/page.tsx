export const dynamic = "force-dynamic";

import Link from "next/link";
import type { ReactNode } from "react";
import { notFound, redirect } from "next/navigation";
import { getServerSession } from "next-auth/next";
import {
    Activity,
    AlertTriangle,
    ArrowRight,
    Bell,
    CheckCircle2,
    CreditCard,
    Gauge,
    KeyRound,
    LayoutDashboard,
    LifeBuoy,
    MessageSquare,
    RotateCcw,
    ShieldCheck,
    Users,
    WalletCards,
    XCircle,
} from "lucide-react";
import { authOptions } from "@/lib/auth";
import { isAdminSession } from "@/lib/adminAuth";
import { getEnabledModel } from "@/lib/models";
import { getUserChatUsageKey } from "@/lib/chatSecurity";
import { prisma } from "@/lib/prisma";
import { ModelLogo } from "@/components/chat/ModelLogo";
import { AdminOperationsPanel } from "@/components/admin/AdminOperationsPanel";
import { BillingAdminPanel } from "@/components/admin/BillingAdminPanel";
import { RefundRequestsPanel, type RefundRequestRow } from "@/components/admin/RefundRequestsPanel";
import {
    getBillingPlans,
    getBillingPromotions,
    syncBillingDefaultsToDatabase,
} from "@/lib/billingConfig";
import {
    getProviderHealthDashboard,
    type ProviderHealthRow,
    type ProviderHealthStatus,
} from "@/lib/providerMonitoring";

const money = (microUsd: number) => `$${(microUsd / 1_000_000).toFixed(2)}`;

const dateLabel = (value: string | null) => {
    if (!value) return "No success yet";
    return new Date(value).toISOString().replace("T", " ").slice(0, 16);
};

const statusCopy: Record<ProviderHealthStatus, string> = {
    available: "Available",
    limited: "Limited",
    outage: "Outage",
};

const statusClass: Record<ProviderHealthStatus, string> = {
    available: "border-emerald-500/30 bg-emerald-500/10 text-emerald-300",
    limited: "border-amber-500/30 bg-amber-500/10 text-amber-300",
    outage: "border-red-500/30 bg-red-500/10 text-red-300",
};

const budgetClass = (value: number) => {
    if (value >= 95) return "text-red-300";
    if (value >= 80) return "text-amber-300";
    if (value >= 50) return "text-sky-300";
    return "text-emerald-300";
};

const apiKeyClass = (configured: boolean) =>
    configured
        ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
        : "border-zinc-700 bg-zinc-900 text-zinc-400";

const planClass = (plan: string | null | undefined) => {
    if (plan === "Max") return "border-purple-500/30 bg-purple-500/10 text-purple-200";
    if (plan === "Pro") return "border-blue-500/30 bg-blue-500/10 text-blue-200";
    return "border-emerald-500/30 bg-emerald-500/10 text-emerald-200";
};

const dateTimeLabel = (value: Date | string | null | undefined) => {
    if (!value) return "-";
    const date = typeof value === "string" ? new Date(value) : value;
    if (Number.isNaN(date.getTime())) return "-";
    return date.toISOString().replace("T", " ").slice(0, 16);
};

const isConfigured = (value: string | undefined) =>
    typeof value === "string" && value.trim().length > 0;

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

function AdminNav() {
    const items = [
        ["overview", "Overview", LayoutDashboard],
        ["users", "Users", Users],
        ["billing", "Billing", CreditCard],
        ["refunds", "Refunds", RotateCcw],
        ["providers", "Providers", Activity],
        ["feedback", "Feedback", LifeBuoy],
    ] as const;

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
                    {items.map(([href, label, Icon]) => (
                        <a
                            key={href}
                            href={`#${href}`}
                            className="flex items-center gap-3 rounded-2xl px-3 py-2.5 text-sm font-bold text-zinc-400 transition hover:bg-zinc-900 hover:text-white"
                        >
                            <Icon className="h-4 w-4" />
                            {label}
                        </a>
                    ))}
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

function ProviderLogo({ provider }: { provider: ProviderHealthRow["provider"] }) {
    return <ModelLogo provider={provider} size="lg" className="ring-zinc-800" />;
}

function ProviderRow({ provider }: { provider: ProviderHealthRow }) {
    const fallbackModels = provider.fallback.recommendedModelIds
        .map((id) => getEnabledModel(id))
        .filter((model): model is NonNullable<typeof model> => Boolean(model))
        .map((model) => model.name);

    return (
        <section className="rounded-2xl border border-zinc-800 bg-zinc-950/70 p-5">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                <div className="flex items-start gap-4">
                    <ProviderLogo provider={provider.provider} />
                    <div>
                        <div className="flex flex-wrap items-center gap-2">
                            <h2 className="text-lg font-semibold text-white">
                                {provider.displayName}
                            </h2>
                            <span
                                className={`rounded-full border px-2.5 py-1 text-xs font-semibold ${statusClass[provider.status]}`}
                            >
                                {statusCopy[provider.status]}
                            </span>
                            <span
                                className={`rounded-full border px-2.5 py-1 text-xs font-semibold ${apiKeyClass(provider.apiKeyConfigured)}`}
                            >
                                {provider.apiKeyConfigured ? "API key set" : "API key missing"}
                            </span>
                        </div>
                        <p className="mt-2 text-sm text-zinc-400">
                            Last good response: {dateLabel(provider.lastSuccessAt)}
                        </p>
                    </div>
                </div>
                <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4 lg:min-w-[520px]">
                    <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-3">
                        <div className="text-zinc-500">Success rate</div>
                        <div className="mt-1 font-semibold text-white">
                            {provider.successRate24h === null
                                ? "No traffic"
                                : `${provider.successRate24h}%`}
                        </div>
                    </div>
                    <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-3">
                        <div className="text-zinc-500">24h calls</div>
                        <div className="mt-1 font-semibold text-white">
                            {provider.successCount24h} / {provider.failureCount24h}
                        </div>
                    </div>
                    <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-3">
                        <div className="text-zinc-500">Recent error</div>
                        <div className="mt-1 truncate font-semibold text-white">
                            {provider.recentErrorCode || "None"}
                        </div>
                    </div>
                    <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-3">
                        <div className="text-zinc-500">Budget used</div>
                        <div className={`mt-1 font-semibold ${budgetClass(provider.budgetUsagePercent)}`}>
                            {provider.budgetUsagePercent}%
                        </div>
                    </div>
                </div>
            </div>

            <div className="mt-5 grid gap-4 border-t border-zinc-800 pt-5 lg:grid-cols-3">
                <div>
                    <div className="text-xs font-semibold uppercase tracking-[0.18em] text-zinc-500">
                        Credit / Balance
                    </div>
                    <p className="mt-2 text-sm text-zinc-300">
                        {provider.balanceUsd === null
                            ? "Manual balance not set"
                            : `$${provider.balanceUsd.toFixed(2)} balance`}
                    </p>
                    <p className="mt-1 text-xs text-zinc-500">
                        Source: {provider.balanceSource}
                    </p>
                    <p className="mt-1 text-xs text-zinc-500">
                        Month usage {money(provider.monthCostMicroUsd)} of{" "}
                        {money(provider.monthBudgetMicroUsd)}
                    </p>
                    <p className="mt-1 text-xs text-zinc-500">
                        Day hard limit {money(provider.dayBudgetMicroUsd)}
                    </p>
                </div>
                <div>
                    <div className="text-xs font-semibold uppercase tracking-[0.18em] text-zinc-500">
                        Alerts
                    </div>
                    <p className="mt-2 text-sm text-zinc-300">
                        Alert threshold:{" "}
                        {provider.alertLevel === "none"
                            ? "below 50%"
                            : `${provider.alertLevel}% reached`}
                    </p>
                    <p className="mt-1 text-xs text-zinc-500">
                        Failure surge status is based on recent 24h provider errors.
                    </p>
                </div>
                <div>
                    <div className="text-xs font-semibold uppercase tracking-[0.18em] text-zinc-500">
                        Fallback Policy
                    </div>
                    <p className="mt-2 text-sm text-zinc-300">
                        {provider.fallback.reason}
                    </p>
                    <p className="mt-1 text-xs text-zinc-500">
                        {fallbackModels.join(" / ") || "No fallback model configured"}
                    </p>
                </div>
            </div>
            <div className="mt-5 grid gap-4 border-t border-zinc-800 pt-5 lg:grid-cols-2">
                <div>
                    <div className="text-xs font-semibold uppercase tracking-[0.18em] text-zinc-500">
                        Recent error log
                    </div>
                    {provider.recentErrors.length === 0 ? (
                        <p className="mt-2 text-sm text-zinc-500">No provider errors recorded today.</p>
                    ) : (
                        <div className="mt-2 space-y-2">
                            {provider.recentErrors.map((error) => (
                                <div
                                    key={`${error.code}-${error.updatedAt}`}
                                    className="flex items-center justify-between gap-3 rounded-xl border border-zinc-800 bg-zinc-900/60 px-3 py-2 text-xs"
                                >
                                    <span className="min-w-0 truncate font-semibold text-zinc-200">{error.code}</span>
                                    <span className="shrink-0 text-zinc-500">
                                        {error.count} / {dateLabel(error.updatedAt)}
                                    </span>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
                <div>
                    <div className="text-xs font-semibold uppercase tracking-[0.18em] text-zinc-500">
                        Model 5-minute incidents
                    </div>
                    {provider.modelIncidents.length === 0 ? (
                        <p className="mt-2 text-sm text-zinc-500">No model-specific incidents in the current 5-minute window.</p>
                    ) : (
                        <div className="mt-2 space-y-2">
                            {provider.modelIncidents.map((incident) => (
                                <div
                                    key={incident.modelId}
                                    className="rounded-xl border border-red-500/20 bg-red-500/10 px-3 py-2 text-xs"
                                >
                                    <div className="flex items-center justify-between gap-3">
                                        <span className="min-w-0 truncate font-semibold text-red-100">
                                            {incident.modelName}
                                        </span>
                                        <span className="shrink-0 text-red-200">
                                            {incident.failureCount5m} failures
                                        </span>
                                    </div>
                                    <p className="mt-1 truncate text-red-200/70">
                                        {incident.recentErrorCode || "UNKNOWN"} / {dateLabel(incident.updatedAt)}
                                    </p>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            </div>
            <div className="mt-5 grid gap-4 border-t border-zinc-800 pt-5 lg:grid-cols-2">
                <div>
                    <div className="text-xs font-semibold uppercase tracking-[0.18em] text-zinc-500">
                        Manual override
                    </div>
                    <p className="mt-2 text-sm leading-6 text-zinc-300">
                        Set provider balance, budget, or automatic balance lookup variables in Railway, then redeploy or restart the service.
                    </p>
                    <div className="mt-2 grid gap-2 text-xs text-zinc-500">
                        <code className="rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2">
                            PROVIDER_{provider.provider.toUpperCase()}_BALANCE_USD
                        </code>
                        <code className="rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2">
                            PROVIDER_{provider.provider.toUpperCase()}_BALANCE_URL
                        </code>
                        <code className="rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2">
                            PROVIDER_{provider.provider.toUpperCase()}_BALANCE_JSON_PATH
                        </code>
                        <code className="rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2">
                            CHAT_PROVIDER_{provider.provider.toUpperCase()}_COST_MICROUSD_PER_DAY
                        </code>
                    </div>
                </div>
                <div>
                    <div className="text-xs font-semibold uppercase tracking-[0.18em] text-zinc-500">
                        Email alert setup
                    </div>
                    <p className="mt-2 text-sm leading-6 text-zinc-300">
                        Enable email alerts with ADMIN_ALERT_EMAIL and either RESEND_API_KEY or SENDGRID_API_KEY.
                    </p>
                    <div className="mt-2 grid gap-2 text-xs text-zinc-500">
                        <code className="rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2">
                            ADMIN_ALERT_EMAIL
                        </code>
                        <code className="rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2">
                            RESEND_API_KEY or SENDGRID_API_KEY
                        </code>
                    </div>
                </div>
            </div>
        </section>
    );
}

export default async function AdminPage() {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
        redirect("/auth/signin?callbackUrl=/admin");
    }
    if (!isAdminSession(session)) {
        notFound();
    }

    await syncBillingDefaultsToDatabase();

    const now = new Date();
    const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

    const [
        dashboard,
        billingPlans,
        billingPromotions,
        totalUsers,
        paidUsers,
        activeSubscriptions,
        conversationCount,
        messageCount,
        recentUsers,
        feedbackRows,
        openFeedbackCount,
        refundRows,
        pendingRefundCount,
        todayUsage,
        monthlyUsage,
    ] = await Promise.all([
        getProviderHealthDashboard(),
        getBillingPlans(),
        getBillingPromotions(),
        prisma.user.count(),
        prisma.user.count({ where: { plan: { in: ["Pro", "Max"] } } }),
        prisma.user.count({
            where: {
                subscriptionStatus: { in: ["active", "trialing"] },
            },
        }),
        prisma.conversation.count(),
        prisma.message.count(),
        prisma.user.findMany({
            orderBy: { id: "desc" },
            take: 12,
            select: {
                id: true,
                email: true,
                name: true,
                plan: true,
                subscriptionStatus: true,
                subscriptionCurrentPeriodEnd: true,
                subscriptionBillingInterval: true,
                stripeCustomerId: true,
                _count: {
                    select: {
                        conversations: true,
                        accounts: true,
                    },
                },
            },
        }),
        prisma.feedback.findMany({
            orderBy: { createdAt: "desc" },
            take: 10,
        }),
        prisma.feedback.count({ where: { status: "open" } }),
        prisma.refundRequest.findMany({
            orderBy: { requestedAt: "desc" },
            take: 20,
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
    const recentUserUsageKeys = new Map(
        recentUsers.map((user) => [user.id, getUserChatUsageKey(user.id)])
    );
    const recentUsageRows =
        recentUserUsageKeys.size > 0
            ? await prisma.chatUsageBucket.findMany({
                  where: {
                      key: { in: Array.from(recentUserUsageKeys.values()) },
                      period: "day",
                      periodStart: dayStart,
                  },
                  select: { key: true, count: true },
              })
            : [];
    const recentUsageByKey = new Map(
        recentUsageRows.map((row) => [row.key, row.count])
    );
    const refundRequestRows: RefundRequestRow[] = refundRows.map((request) => ({
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
        requestedAt: request.requestedAt.toISOString(),
        reviewedAt: request.reviewedAt?.toISOString() || null,
    }));
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
    const envChecks = [
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
            name: "RESEND_API_KEY",
            configured: isConfigured(process.env.RESEND_API_KEY),
            description: "Required for Tomverse transactional email.",
        },
        {
            name: "BILLING_EMAIL_FROM",
            configured: isConfigured(process.env.BILLING_EMAIL_FROM),
            description: "Verified sender used for billing emails.",
        },
        {
            name: "SLACK_WEBHOOK_URL",
            configured: isConfigured(process.env.SLACK_WEBHOOK_URL),
            description: "Optional incident notification channel.",
        },
    ];

    return (
        <main className="min-h-screen bg-zinc-950 text-zinc-100">
            <div className="mx-auto grid w-full max-w-[96rem] gap-6 px-5 py-6 lg:grid-cols-[16rem_1fr] lg:px-8">
                <AdminNav />
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
                                Generated {generatedAtLabel} UTC
                            </div>
                        </div>
                    </header>

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

                    <section id="users" className="rounded-3xl border border-zinc-800 bg-zinc-950/70 p-5">
                        <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
                            <SectionHeader
                                eyebrow="Users"
                                title="Recent accounts"
                                description={`Showing latest ${recentUsers.length} users. ${conversationCount} conversations are stored across the workspace.`}
                            />
                            <span className="rounded-full border border-blue-500/30 bg-blue-500/10 px-3 py-1 text-xs font-black text-blue-200">
                                {paidUsers} paid users
                            </span>
                        </div>
                        <div className="mt-5 overflow-x-auto">
                            <table className="w-full min-w-[760px] border-separate border-spacing-y-2 text-left text-sm">
                                <thead className="text-xs uppercase tracking-[0.16em] text-zinc-500">
                                    <tr>
                                        <th className="px-3 py-2">User</th>
                                        <th className="px-3 py-2">Plan</th>
                                        <th className="px-3 py-2">Subscription</th>
                                        <th className="px-3 py-2">Usage today</th>
                                        <th className="px-3 py-2">Data</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {recentUsers.map((user) => {
                                        const userKey = getUserChatUsageKey(user.id);
                                        const usageToday = recentUsageByKey.get(userKey) || 0;
                                        return (
                                            <tr key={user.id} className="rounded-2xl bg-zinc-900/70 text-zinc-200">
                                                <td className="rounded-l-2xl px-3 py-3">
                                                    <div className="font-bold">{user.email || user.name || "No email"}</div>
                                                    <div className="mt-1 text-xs text-zinc-500">{user.id}</div>
                                                </td>
                                                <td className="px-3 py-3">
                                                    <span className={`rounded-full border px-2.5 py-1 text-xs font-black ${planClass(user.plan)}`}>
                                                        {user.plan || "Free"}
                                                    </span>
                                                </td>
                                                <td className="px-3 py-3 text-xs text-zinc-400">
                                                    <div>{user.subscriptionStatus || "none"}</div>
                                                    <div>{user.subscriptionBillingInterval || "-"}</div>
                                                    <div>{dateTimeLabel(user.subscriptionCurrentPeriodEnd)}</div>
                                                </td>
                                                <td className="px-3 py-3 text-xs text-zinc-400">
                                                    <span className="font-bold text-zinc-200">{usageToday}</span>
                                                    <span className="ml-1">messages</span>
                                                </td>
                                                <td className="rounded-r-2xl px-3 py-3 text-xs text-zinc-400">
                                                    <div>{user._count.conversations} conversations</div>
                                                    <div>{user._count.accounts} linked accounts</div>
                                                    <div>{user.stripeCustomerId ? "Stripe linked" : "No Stripe customer"}</div>
                                                </td>
                                            </tr>
                                        );
                                    })}
                                </tbody>
                            </table>
                        </div>
                    </section>

                    <section id="billing">
                        <BillingAdminPanel
                            plans={billingPlans}
                            promotions={billingPromotions}
                        />
                    </section>

                    <RefundRequestsPanel
                        rows={refundRequestRows}
                    />

                    <section id="providers" className="flex flex-col gap-4">
                        <div className="flex flex-wrap items-center justify-between gap-3">
                            <SectionHeader
                                eyebrow="Providers"
                                title="Provider health"
                                description="Status, key configuration, estimated spend, fallback policy, recent errors, and alert setup."
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
                        {dashboard.providers.map((provider) => (
                            <ProviderRow key={provider.provider} provider={provider} />
                        ))}
                    </section>

                    <section id="feedback" className="rounded-3xl border border-zinc-800 bg-zinc-950/70 p-5">
                        <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
                            <SectionHeader
                                eyebrow="Feedback"
                                title="Support inbox"
                                description="Recent user feedback submitted from the app. Trace IDs, model, plan, attachments, path, and user agent are captured for reproduction."
                            />
                            <span className="rounded-full border border-amber-500/30 bg-amber-500/10 px-3 py-1 text-xs font-black text-amber-200">
                                {openFeedbackCount} open
                            </span>
                        </div>
                        <div className="mt-5 grid gap-3">
                            {feedbackRows.length === 0 ? (
                                <div className="rounded-2xl border border-zinc-800 bg-zinc-900/70 p-5 text-sm text-zinc-400">
                                    No feedback has been submitted yet.
                                </div>
                            ) : (
                                feedbackRows.map((feedback) => (
                                    <article key={feedback.id} className="rounded-2xl border border-zinc-800 bg-zinc-900/70 p-4">
                                        <div className="flex flex-wrap items-center justify-between gap-3">
                                            <div className="flex flex-wrap items-center gap-2">
                                                <span className="rounded-full border border-blue-500/30 bg-blue-500/10 px-2.5 py-1 text-xs font-black text-blue-200">
                                                    {feedback.type}
                                                </span>
                                                <span className="rounded-full border border-zinc-700 bg-zinc-950 px-2.5 py-1 text-xs font-bold text-zinc-300">
                                                    {feedback.status}
                                                </span>
                                                <span className="text-xs text-zinc-500">{dateTimeLabel(feedback.createdAt)}</span>
                                            </div>
                                            <div className="text-xs text-zinc-500">{feedback.email || "guest"}</div>
                                        </div>
                                        <p className="mt-3 whitespace-pre-wrap text-sm leading-6 text-zinc-200">
                                            {feedback.message}
                                        </p>
                                        <div className="mt-3 grid gap-2 text-xs text-zinc-500 md:grid-cols-2 xl:grid-cols-4">
                                            <span>Trace: {feedback.traceId || "-"}</span>
                                            <span>Model: {feedback.modelId || "-"}</span>
                                            <span>Plan: {feedback.plan || "-"}</span>
                                            <span>Attachments: {feedback.attachmentCount}</span>
                                            <span className="truncate">Path: {feedback.path || "-"}</span>
                                            <span className="truncate xl:col-span-3">UA: {feedback.userAgent || "-"}</span>
                                        </div>
                                    </article>
                                ))
                            )}
                        </div>
                    </section>
                </div>
            </div>
        </main>
    );
}
