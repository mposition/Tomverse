export const dynamic = "force-dynamic";

import Link from "next/link";
import type { ReactNode } from "react";
import { notFound, redirect } from "next/navigation";
import { getServerSession } from "next-auth/next";
import { Activity, AlertTriangle, ArrowRight, Bell, CheckCircle2, Gauge, KeyRound, ShieldCheck, WalletCards, XCircle } from "lucide-react";
import { authOptions } from "@/lib/auth";
import { isAdminSession } from "@/lib/adminAuth";
import { getEnabledModel } from "@/lib/models";
import { ModelLogo } from "@/components/chat/ModelLogo";
import { BillingAdminPanel } from "@/components/admin/BillingAdminPanel";
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
                        Manual override
                    </div>
                    <p className="mt-2 text-sm leading-6 text-zinc-300">
                        Set provider balance and budget variables in Railway, then redeploy or restart the service.
                    </p>
                    <div className="mt-2 grid gap-2 text-xs text-zinc-500">
                        <code className="rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2">
                            PROVIDER_{provider.provider.toUpperCase()}_BALANCE_USD
                        </code>
                        <code className="rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2">
                            CHAT_PROVIDER_{provider.provider.toUpperCase()}_COST_MICROUSD_PER_DAY
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

    const [dashboard, billingPlans, billingPromotions] = await Promise.all([
        getProviderHealthDashboard(),
        getBillingPlans(),
        getBillingPromotions(),
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

    return (
        <main className="min-h-screen bg-zinc-950 text-zinc-100">
            <div className="mx-auto flex w-full max-w-7xl flex-col gap-8 px-5 py-8 lg:px-8">
                <header className="flex flex-col gap-5 border-b border-zinc-800 pb-8 lg:flex-row lg:items-end lg:justify-between">
                    <div>
                        <div className="inline-flex items-center gap-2 rounded-full border border-blue-500/30 bg-blue-500/10 px-3 py-1 text-xs font-semibold uppercase tracking-[0.18em] text-blue-200">
                            <ShieldCheck className="h-3.5 w-3.5" />
                            Admin only
                        </div>
                        <h1 className="mt-5 text-3xl font-semibold tracking-tight text-white sm:text-4xl">
                            Provider Operations
                        </h1>
                        <p className="mt-3 max-w-3xl text-sm leading-6 text-zinc-400">
                            Monitor provider health, key configuration, estimated spend,
                            fallback policy, and launch-critical hard limits from one
                            restricted console.
                        </p>
                    </div>
                    <div className="flex flex-wrap gap-2 text-sm">
                        <Link
                            href="/chat"
                            className="inline-flex items-center gap-2 rounded-xl border border-zinc-800 px-4 py-2 font-semibold text-zinc-200 hover:border-zinc-700 hover:bg-zinc-900"
                        >
                            Open app <ArrowRight className="h-4 w-4" />
                        </Link>
                    </div>
                </header>

                <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
                    <MetricCard
                        label="Provider status"
                        value={`${availableCount} / ${dashboard.providers.length}`}
                        detail={`${limitedCount} limited, ${outageCount} outage`}
                        icon={<Activity className="h-4 w-4" />}
                    />
                    <MetricCard
                        label="Monthly spend"
                        value={money(monthSpend)}
                        detail="Estimated from reserved token budgets"
                        icon={<WalletCards className="h-4 w-4" />}
                    />
                    <MetricCard
                        label="Tier limits"
                        value="Free / Pro / Max"
                        detail={`${dashboard.tierLimits.Free} / ${dashboard.tierLimits.Pro} / ${dashboard.tierLimits.Max}`}
                        icon={<Gauge className="h-4 w-4" />}
                    />
                    <MetricCard
                        label="Alert channels"
                        value={[
                            dashboard.notificationChannels.email ? "Email" : null,
                            dashboard.notificationChannels.slack ? "Slack" : null,
                            dashboard.notificationChannels.discord ? "Discord" : null,
                        ]
                            .filter(Boolean)
                            .join(" / ") || "Not set"}
                        detail="50%, 80%, 95% budget thresholds"
                        icon={<Bell className="h-4 w-4" />}
                    />
                </section>

                <section className="rounded-2xl border border-zinc-800 bg-zinc-950/70 p-5">
                    <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                        <div>
                            <h2 className="text-lg font-semibold text-white">
                                Required environment variables
                            </h2>
                            <p className="mt-1 text-sm text-zinc-400">
                                Admin access and provider limits are controlled by Railway
                                variables.
                            </p>
                        </div>
                        <div className="grid gap-2 text-xs text-zinc-400 sm:grid-cols-2 lg:grid-cols-4">
                            <span className="rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2">
                                ADMIN_EMAILS
                            </span>
                            <span className="rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2">
                                PROVIDER_OPENAI_BALANCE_USD
                            </span>
                            <span className="rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2">
                                CHAT_PROVIDER_OPENAI_COST_MICROUSD_PER_DAY
                            </span>
                            <span className="rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2">
                                SLACK_WEBHOOK_URL
                            </span>
                            <span className="rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2">
                                STRIPE_SECRET_KEY
                            </span>
                            <span className="rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2">
                                STRIPE_WEBHOOK_SECRET
                            </span>
                        </div>
                    </div>
                </section>

                <BillingAdminPanel
                    plans={billingPlans}
                    promotions={billingPromotions}
                />

                <section className="flex flex-col gap-4">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                        <div>
                            <h2 className="text-xl font-semibold text-white">
                                Provider Health
                            </h2>
                            <p className="mt-1 text-sm text-zinc-400">
                                Generated at {dashboard.generatedAt.replace("T", " ").slice(0, 16)} UTC
                            </p>
                        </div>
                        <div className="flex gap-2 text-xs">
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
            </div>
        </main>
    );
}
