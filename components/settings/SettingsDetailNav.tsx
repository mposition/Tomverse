"use client";

import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { useLanguage } from "@/components/LanguageProvider";
import {
    settingsBackTarget,
    settingsEntryHierarchy,
    type SettingsHierarchy,
    type SettingsSectionId,
} from "@/lib/settingsNavigation";

/**
 * Upward navigation for a settings page.
 *
 * These pages used to offer "Back to chat", which was true of where the link
 * went and false of where the visitor had been: they arrived from the settings
 * panel, and the link skipped it. The destination is now named explicitly
 * (lib/settingsNavigation.ts) rather than taken from `router.back()` — a direct
 * visit has no history to go back to, and history is not the settings
 * hierarchy anyway. The browser's own Back button is untouched.
 *
 * ## One array, two readings
 *
 * The back link is the nearest ancestor and the trail is all of them, both
 * read off the same `SettingsHierarchy`. They were separate before — a
 * hard-coded crumb beside an independently computed href — and the two drifted
 * twice: once when profiles moved to their own tab, and again when the profile
 * editor showed "back to settings" while sitting inside a list it never
 * mentioned. A hierarchy that is data cannot drift from itself.
 *
 * There is deliberately no second link to the chat here: settings is a
 * closable panel, so leaving settings entirely is the panel's close action,
 * not a third destination competing at the top of a detail page.
 *
 * Desktop additionally gets the trail it has room for. Mobile keeps the back
 * link, which is the one control either layout needs to be usable.
 */
export function SettingsDetailNav({
    section,
    hierarchy,
    currentLabel,
    backTestId,
}: {
    /** Shorthand for a settings entry page, whose only ancestor is the panel. */
    section?: SettingsSectionId;
    /** An explicit ancestry, for a page nested below an entry page. */
    hierarchy?: SettingsHierarchy;
    /** This page's own name, as its parent calls it. */
    currentLabel: string;
    backTestId: string;
}) {
    const { t } = useLanguage();
    // One of the two is always supplied; `section` is the common case and
    // `hierarchy` is the general one. Preferring the explicit list means a
    // caller that passes both cannot get a trail that disagrees with it.
    const trail: SettingsHierarchy =
        hierarchy ?? (section ? settingsEntryHierarchy(section) : []);
    // The nearest ancestor that is actually somewhere -- not simply the last
    // crumb, which may be a naming step like the tab a row lives in.
    const parent = settingsBackTarget(trail);

    return (
        <nav
            aria-label={t("settingsNav.navLabel")}
            data-testid="settings-detail-nav"
        >
            {parent && (
                <Link
                    href={parent.href!}
                    data-testid={backTestId}
                    className="inline-flex items-center gap-1.5 rounded-lg text-sm font-semibold text-zinc-500 transition-colors hover:text-zinc-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-50 dark:hover:text-zinc-100 dark:focus-visible:ring-offset-zinc-950"
                >
                    <ArrowLeft className="h-4 w-4" aria-hidden="true" />
                    {/* The label names the destination the href actually has.
                        "Back to settings" on a page whose parent is a list is
                        the exact mismatch this component now makes
                        impossible. */}
                    {t(parent.backLabelKey!)}
                </Link>
            )}
            <ol
                data-testid="settings-breadcrumb"
                className="mt-2 hidden flex-wrap items-center gap-1.5 text-xs text-zinc-400 md:flex dark:text-zinc-500"
            >
                {trail.map((ancestor) => (
                    <li
                        key={`${ancestor.href}:${ancestor.labelKey}`}
                        className="flex items-center gap-1.5"
                    >
                        {/* A crumb is a link when it goes somewhere else, and
                            plain text when it only names where you are. A
                            crumb that reads like a link and lands on the page
                            you are already on is a control people try once. */}
                        {ancestor.href ? (
                            <Link
                                href={ancestor.href}
                                className="rounded transition-colors hover:text-zinc-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:hover:text-zinc-200"
                            >
                                {t(ancestor.labelKey)}
                            </Link>
                        ) : (
                            <span>{t(ancestor.labelKey)}</span>
                        )}
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
