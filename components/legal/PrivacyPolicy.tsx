"use client";

import Link from "next/link";
import { ArrowLeft, BarChart3, Database, FileUp, Scale, Send, ShieldCheck, Share2, UserRound } from "lucide-react";
import { useLanguage } from "@/components/LanguageProvider";
import {
    MarketingFooter,
    MarketingHeader,
} from "@/components/marketing/MarketingChrome";

const sections = [
    ["collectedTitle", "collected", UserRound],
    ["purposeTitle", "purpose", Database],
    ["providersTitle", "providers", Send],
    ["attachmentsTitle", "attachments", FileUp],
    ["analyticsTitle", "analytics", BarChart3],
    ["retentionTitle", "retention", Database],
    ["sharingTitle", "sharing", Share2],
    ["rightsTitle", "rights", Scale],
    ["securityTitle", "security", ShieldCheck],
    ["changesTitle", "changes", Scale],
] as const;

export function PrivacyPolicy() {
    const { t, lang } = useLanguage();
    const localizedContentAvailable = lang === "en" || lang === "ko" || lang === "zh";

    return (
        <main className="min-h-screen overflow-y-auto bg-white text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100">
            <MarketingHeader
                maxWidth="max-w-4xl"
                localizedContentAvailable={localizedContentAvailable}
            />

            <article
                lang={localizedContentAvailable ? lang : "en"}
                className="mx-auto max-w-4xl px-5 py-12"
            >
                <div className="border-b border-zinc-200 pb-8 dark:border-zinc-800">
                    <h1 className="text-3xl font-bold">{t("privacyPolicy.title")}</h1>
                    <p className="mt-2 text-sm text-zinc-500">{t("privacyPolicy.effective")}</p>
                    <p className="mt-6 max-w-3xl text-base leading-7 text-zinc-600 dark:text-zinc-300">
                        {t("privacyPolicy.intro")}
                    </p>
                </div>

                <div className="divide-y divide-zinc-200 dark:divide-zinc-800">
                    {sections.map(([titleKey, bodyKey, Icon]) => (
                        <section
                            key={titleKey}
                            className="grid gap-4 py-7 md:grid-cols-[180px_1fr]"
                        >
                            <h2 className="flex items-center gap-2 text-sm font-semibold">
                                <Icon className="h-4 w-4 text-blue-500" />
                                {t(`privacyPolicy.${titleKey}`)}
                            </h2>
                            <p className="text-sm leading-7 text-zinc-600 dark:text-zinc-300">
                                {t(`privacyPolicy.${bodyKey}`)}
                            </p>
                        </section>
                    ))}
                </div>

                <Link
                    href="/"
                    className="mt-8 inline-flex items-center gap-2 rounded-md bg-zinc-900 px-4 py-2.5 text-sm font-semibold text-white hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white"
                >
                    <ArrowLeft className="h-4 w-4" />
                    {t("privacyPolicy.back")}
                </Link>
            </article>
            <MarketingFooter maxWidth="max-w-4xl" />
        </main>
    );
}
