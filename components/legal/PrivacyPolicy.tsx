"use client";

import Link from "next/link";
import { ArrowLeft, BarChart3, Database, FileUp, Scale, Send, ShieldCheck, Share2, UserRound } from "lucide-react";
import { useLanguage } from "@/components/LanguageProvider";

const sections = [
    ["collectedTitle", "collected", UserRound],
    ["purposeTitle", "purpose", Database],
    ["providersTitle", "providers", Send],
    ["privateTitle", "private", ShieldCheck],
    ["attachmentsTitle", "attachments", FileUp],
    ["analyticsTitle", "analytics", BarChart3],
    ["retentionTitle", "retention", Database],
    ["sharingTitle", "sharing", Share2],
    ["rightsTitle", "rights", Scale],
    ["securityTitle", "security", ShieldCheck],
    ["changesTitle", "changes", Scale],
] as const;

export function PrivacyPolicy() {
    const { t, lang, setLang } = useLanguage();

    return (
        <main className="min-h-screen overflow-y-auto bg-white text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100">
            <header className="border-b border-zinc-200 dark:border-zinc-800">
                <div className="mx-auto flex max-w-4xl items-center justify-between gap-4 px-5 py-4">
                    <Link
                        href="/"
                        className="inline-flex items-center gap-2 text-sm font-medium text-zinc-600 hover:text-zinc-950 dark:text-zinc-300 dark:hover:text-white"
                    >
                        <ArrowLeft className="h-4 w-4" />
                        Tomverse
                    </Link>
                    <div className="flex rounded-md border border-zinc-200 p-0.5 dark:border-zinc-700">
                        {(["en", "ko", "zh"] as const).map((language) => (
                            <button
                                key={language}
                                type="button"
                                onClick={() => setLang(language)}
                                className={`rounded px-2.5 py-1 text-xs font-medium ${
                                    lang === language
                                        ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900"
                                        : "text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-white"
                                }`}
                            >
                                {language.toUpperCase()}
                            </button>
                        ))}
                    </div>
                </div>
            </header>

            <article className="mx-auto max-w-4xl px-5 py-12">
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
        </main>
    );
}
