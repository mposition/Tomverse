"use client";

import Link from "next/link";
import { useLanguage } from "@/components/LanguageProvider";
import { developerToolsCopy } from "@/locales/developerTools";

/** Native extension setup; separate from VS Code's compatible-provider guide. */
export function TomverseVscodeGuide() {
    const { lang, t } = useLanguage();
    const copy = developerToolsCopy[lang];
    return (
        <section className="chapter scroll-mt-24" id="tomverse-vscode" aria-labelledby="tomverse-vscode-title" data-testid="tomverse-vscode-guide">
            <div className="wrap">
                <div className="rounded-2xl border border-[#31343f] bg-[#1c1e25] p-6 sm:p-8">
                    <h2 id="tomverse-vscode-title" className="text-2xl font-bold">Tomverse for VS Code</h2>
                    <p className="mt-2 text-sm text-[#b0b2bc]">{copy.preview}</p>
                    <ol className="my-6 list-decimal space-y-3 pl-5 text-sm leading-6 text-[#dcdde3]">
                        {[copy.installStep, copy.keyStep, copy.taskStep].map((step) => <li key={step}>{step}</li>)}
                    </ol>
                    <p className="mb-5 text-xs leading-5 text-[#b0b2bc]">{copy.scope}</p>
                    <Link href="/settings/api" className="inline-flex rounded-lg text-sm font-semibold text-[#5b8dff] underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-blue-400">
                        {t("externalApi.devManageKeys")}
                    </Link>
                </div>
            </div>
        </section>
    );
}
