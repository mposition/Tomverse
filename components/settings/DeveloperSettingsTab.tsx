"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowUpRight, ChevronDown, ChevronRight } from "lucide-react";
import { useLanguage } from "@/components/LanguageProvider";
import { ApiCopyLine } from "@/components/settings/ApiCopyLine";
import { codingApiBaseUrl } from "@/lib/externalApiCodingTools";
import {
    EXTERNAL_API_PLATFORMS,
    EXTERNAL_API_PLATFORM_NAMES,
    externalApiAddresses,
    type ExternalApiGuideSurface,
} from "@/lib/externalApiAppGuides";
import { CLI_DOWNLOAD_PATH, DEVELOPERS_PATH, VSCODE_GUIDE_PATH } from "@/lib/marketingRoutes";
import { developerToolsCopy } from "@/locales/developerTools";
import { localizedPath } from "@/lib/seo";
import { settingsSectionElementId } from "@/lib/settingsNavigation";

/**
 * Settings > Developer. A summary of the one thing a developer sets up once:
 * the API key, on-demand connection addresses, and links to setup guides. The
 * keys themselves are made and revoked on /settings/api; nothing here changes
 * a key. Reads the key list the API page reads (GET /api/user/api-keys) and
 * adds no server route.
 */

type KeySummary = { state: "active" | "expired" | "revoked"; lastUsedAt: string | null };

export type DeveloperOverview =
    | { kind: "loading" }
    | { kind: "failed" }
    | { kind: "signedOut" }
    // A Free account: the API needs Pro or Max (docs/policy/external-api.md).
    | { kind: "plan" }
    | { kind: "unavailable" }
    | {
          kind: "ready";
          baseUrl: string;
          codingBaseUrl: string;
          keys: KeySummary[];
          /** Absent until the CLI package is published. */
          tomverseCli: { install: string } | null;
      };

const toOverview = (status: number, body: unknown): DeveloperOverview => {
    if (status === 401) return { kind: "signedOut" };
    const data = body as {
        enabled?: boolean;
        reason?: string;
        baseUrl?: string;
        codingBaseUrl?: string;
        keys?: KeySummary[];
        tomverseCli?: { install: string } | null;
    } | null;
    if (status < 200 || status >= 300 || !data) return { kind: "failed" };
    if (!data.enabled) return data.reason === "plan_not_eligible" ? { kind: "plan" } : { kind: "unavailable" };
    if (!data.baseUrl) return { kind: "failed" };
    return {
        kind: "ready",
        baseUrl: data.baseUrl,
        codingBaseUrl: data.codingBaseUrl ?? codingApiBaseUrl(data.baseUrl),
        keys: data.keys ?? [],
        tomverseCli: data.tomverseCli ?? null,
    };
};

const card = "rounded-2xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950/60";
const linkClass =
    "inline-flex items-center gap-1 text-sm font-semibold text-blue-600 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:text-blue-400";

const fill = (template: string, values: Record<string, string | number>) =>
    Object.entries(values).reduce((text, [key, value]) => text.replaceAll(`{${key}}`, String(value)), template);

const latest = (keys: KeySummary[]) =>
    keys.reduce<string | null>((best, entry) => (entry.lastUsedAt && (!best || entry.lastUsedAt > best) ? entry.lastUsedAt : best), null);

const toolNames = (surface: ExternalApiGuideSurface, other: string) =>
    EXTERNAL_API_PLATFORMS[surface]
        .map((platform) => (platform === "other" ? other : EXTERNAL_API_PLATFORM_NAMES[platform]))
        .join(" · ");

export function DeveloperSettingsView({
    overview,
    onUpgrade,
    onNavigate,
}: {
    overview: DeveloperOverview;
    onUpgrade?: () => void;
    onNavigate?: () => void;
}) {
    const { t, lang } = useLanguage();
    const other = t("externalApi.platformOther");
    const copy = developerToolsCopy[lang];

    const body = (() => {
        switch (overview.kind) {
            case "loading":
                return <p className="text-sm text-zinc-500">{t("externalApi.loading")}</p>;
            case "failed":
                return <p className="text-sm text-zinc-600 dark:text-zinc-300">{t("externalApi.loadFailed")}</p>;
            case "unavailable":
                return (
                    <p className={`${card} text-sm text-zinc-600 dark:text-zinc-300`} data-testid="developer-unavailable">
                        {t("externalApi.unavailable")}
                    </p>
                );
            case "signedOut":
                return (
                    <section className={card} data-testid="developer-signin">
                        <p className="text-sm text-zinc-600 dark:text-zinc-300">{t("externalApi.signInRequired")}</p>
                        <Link
                            href={`/auth/signin?callbackUrl=${encodeURIComponent("/settings/api")}`}
                            onClick={onNavigate}
                            className="mt-3 inline-flex rounded-xl bg-zinc-900 px-4 py-2 text-sm font-semibold text-white dark:bg-zinc-100 dark:text-zinc-900"
                        >
                            {t("auth.login")}
                        </Link>
                    </section>
                );
            case "plan":
                return (
                    <section className={card} data-testid="developer-plan-required">
                        <p className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{t("externalApi.developerPlanRequired")}</p>
                        <p className="mt-1 text-sm leading-6 text-zinc-500">{t("externalApi.developerFootnote")}</p>
                        <button
                            type="button"
                            data-testid="developer-upgrade"
                            onClick={onUpgrade}
                            className="mt-3 rounded-xl bg-zinc-900 px-4 py-2 text-sm font-semibold text-white dark:bg-zinc-100 dark:text-zinc-900"
                        >
                            {t("externalApi.paidPlanUpgrade")}
                        </button>
                    </section>
                );
            case "ready": {
                const active = overview.keys.filter((entry) => entry.state === "active").length;
                const lastUsed = latest(overview.keys);
                const general = externalApiAddresses(overview.baseUrl);
                const coding = externalApiAddresses(overview.codingBaseUrl);
                const tools = [
                    ...(overview.tomverseCli ? [{ id: "cli", title: "Tomverse CLI", body: copy.cli, label: copy.install, href: localizedPath(lang, CLI_DOWNLOAD_PATH) }] : []),
                    { id: "vscode", title: "Tomverse for VS Code", body: copy.editor, label: copy.guide, href: localizedPath(lang, VSCODE_GUIDE_PATH) },
                    { id: "other", title: copy.otherTitle, body: copy.other, label: copy.connect, href: "/settings/api#connect" },
                ];
                return (
                    <>
                        <section className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-blue-50 p-4 dark:bg-blue-950/30" data-testid="developer-keys">
                            <div className="min-w-0">
                                <h3 className="text-sm font-semibold">{t("externalApi.devKeysTitle")}</h3>
                                <p className="mt-1 text-xs text-zinc-600 dark:text-zinc-400" data-testid="developer-keys-summary">
                                    {active > 0 ? fill(t("externalApi.devKeysActive"), { count: active }) : t("externalApi.devKeysNone")}
                                    {" · "}
                                    {lastUsed ? fill(t("externalApi.lastUsed"), { date: new Date(lastUsed).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) }) : t("externalApi.neverUsed")}
                                </p>
                            </div>
                            <Link id={settingsSectionElementId("api-keys")} href="/settings/api" onClick={onNavigate}
                                data-testid="developer-manage-keys" className={`shrink-0 ${linkClass}`}>
                                {t("externalApi.devManageKeys")}<ChevronRight className="h-4 w-4" aria-hidden="true" />
                            </Link>
                        </section>
                        <div className="divide-y divide-zinc-200 dark:divide-zinc-800" data-testid="developer-tools">
                            {tools.map((tool) => (
                                <div key={tool.id} className="flex items-center justify-between gap-3 py-3" data-testid={`developer-${tool.id}`}>
                                    <div className="min-w-0 flex-1">
                                        <h3 className="text-sm font-semibold">{tool.title}</h3>
                                        <p className="mt-1 text-xs leading-5 text-zinc-500">{tool.body}</p>
                                    </div>
                                    <Link href={tool.href} onClick={onNavigate} data-testid={`developer-${tool.id}-guide`}
                                        className={`max-w-[40%] shrink-0 text-right text-xs ${linkClass}`}>
                                        {tool.label}<ArrowUpRight className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                                    </Link>
                                </div>
                            ))}
                        </div>
                        <details className="group border-b border-zinc-200 pb-3 dark:border-zinc-800" data-testid="developer-endpoints">
                            <summary className="flex cursor-pointer list-none items-center justify-between gap-3 rounded-lg py-2 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 [&::-webkit-details-marker]:hidden">
                                {t("externalApi.devEndpointsTitle")}
                                <ChevronDown className="mr-1 h-4 w-4 shrink-0 text-zinc-500 transition-transform group-open:rotate-180" aria-hidden="true" />
                            </summary>
                            {([["general", general, "externalApi.apiGeneral"], ["coding", coding, "externalApi.apiCoding"]] as const).map(([surface, addresses, labelKey]) => (
                                <div key={surface} className="mt-4" data-testid={`developer-endpoints-${surface}`}>
                                    <p className="text-sm font-semibold">{t(labelKey)}</p>
                                    <p className="mt-0.5 text-xs text-zinc-500">{toolNames(surface, other)}</p>
                                    <div className="mt-2 grid gap-2">
                                        <ApiCopyLine label={t("externalApi.addrOpenAi")} value={addresses.openAi} testId={`developer-endpoint-${surface}-openai`} />
                                        <ApiCopyLine label={t("externalApi.addrAnthropic")} value={addresses.anthropic} testId={`developer-endpoint-${surface}-anthropic`} />
                                    </div>
                                </div>
                            ))}
                        </details>
                        <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                            <Link href={localizedPath(lang, DEVELOPERS_PATH)} onClick={onNavigate} className={linkClass} data-testid="developer-api-docs">
                                {copy.reference}<ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
                            </Link>
                            <p className="text-zinc-500">{copy.limits}</p>
                        </div>
                    </>
                );
            }
        }
    })();

    return (
        <div className="space-y-4" data-testid="settings-developer-tab">
            <div>
                <h2 className="text-lg font-bold">{t("externalApi.developerTab")}</h2>
                <p className="mt-1 text-sm leading-6 text-zinc-500">{copy.intro}</p>
            </div>
            {body}
        </div>
    );
}

/** The tab: reads the key list once when it opens, then renders the view. */
export function DeveloperSettingsTab({ onUpgrade, onNavigate }: { onUpgrade?: () => void; onNavigate?: () => void }) {
    const [overview, setOverview] = useState<DeveloperOverview>({ kind: "loading" });
    useEffect(() => {
        let cancelled = false;
        void fetch("/api/user/api-keys", { cache: "no-store" })
            .then(async (response) => {
                // Always consume the body, on every path (lib/apiCacheControlPolicy.ts).
                const text = await response.text();
                let parsed: unknown = null;
                try {
                    parsed = text ? JSON.parse(text) : null;
                } catch {
                    parsed = null;
                }
                if (!cancelled) setOverview(toOverview(response.status, parsed));
            })
            .catch(() => {
                if (!cancelled) setOverview({ kind: "failed" });
            });
        return () => {
            cancelled = true;
        };
    }, []);
    return <DeveloperSettingsView overview={overview} onUpgrade={onUpgrade} onNavigate={onNavigate} />;
}
