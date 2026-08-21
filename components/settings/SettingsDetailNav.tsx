"use client";

import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { useLanguage } from "@/components/LanguageProvider";
import {
    settingsSectionHref,
    type SettingsSectionId,
} from "@/lib/settingsNavigation";

/**
 * Upward navigation for a settings detail page.
 *
 * These pages used to offer "Back to chat", which was true of where the link
 * went and false of where the visitor had been: they arrived from the settings
 * panel, and the link skipped it. The destination is now the settings list
 * itself, addressed explicitly (lib/settingsNavigation.ts) rather than through
 * `router.back()` — a direct visit to the page has no history to go back to,
 * and history is not the settings hierarchy anyway. The browser's own Back
 * button is untouched and still does what it always did.
 *
 * Leaving settings entirely is a different movement and is not this
 * component's job: the route shell renders it once for every
 * /settings/** screen (components/settings/SettingsExitBar.tsx), at the other
 * end of the page and with the chat's own name on it. The two coexist by
 * design — one level up here, all the way out there — and must stay
 * distinguishable, so nothing in this nav may adopt chat-bound wording.
 *
 * Desktop additionally gets the trail it has room for; the back link is the
 * only interactive element in either layout, so the two never disagree about
 * what a control does.
 */
export function SettingsDetailNav({
    section,
    currentLabel,
    backTestId,
}: {
    section: SettingsSectionId;
    /** This page's own name, as the settings list calls it. */
    currentLabel: string;
    backTestId: string;
}) {
    const { t } = useLanguage();
    const trail = [
        t("settingsNav.settings"),
        t("settingsNav.dataAndPersonalization"),
    ];

    return (
        <nav
            aria-label={t("settingsNav.navLabel")}
            data-testid="settings-detail-nav"
        >
            <Link
                href={settingsSectionHref(section)}
                data-testid={backTestId}
                className="inline-flex items-center gap-1.5 rounded-lg text-sm font-semibold text-zinc-500 transition-colors hover:text-zinc-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-50 dark:hover:text-zinc-100 dark:focus-visible:ring-offset-zinc-950"
            >
                <ArrowLeft className="h-4 w-4" aria-hidden="true" />
                {t("settingsNav.backToSettings")}
            </Link>
            <ol
                data-testid="settings-breadcrumb"
                className="mt-2 hidden flex-wrap items-center gap-1.5 text-xs text-zinc-400 md:flex dark:text-zinc-500"
            >
                {trail.map((label) => (
                    <li key={label} className="flex items-center gap-1.5">
                        <span>{label}</span>
                        <span aria-hidden="true">/</span>
                    </li>
                ))}
                <li
                    aria-current="page"
                    className="font-semibold text-zinc-600 dark:text-zinc-300"
                >
                    {currentLabel}
                </li>
            </ol>
        </nav>
    );
}
