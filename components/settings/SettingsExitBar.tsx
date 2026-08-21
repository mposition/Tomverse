"use client";

import { useLanguage } from "@/components/LanguageProvider";
import { SettingsReturnToChat } from "@/components/settings/SettingsReturnToChat";

/**
 * The action strip every settings screen gets from the route shell
 * (app/(site)/(application)/settings/layout.tsx).
 *
 * Sticky, because the alternative is a control that only exists at scroll
 * position zero: the import list, the memory review and the profile editor are
 * all long enough that "go back to the chat" would otherwise mean "scroll to
 * the top first". A layout does not re-render on navigation, so this strip is
 * also physically the same element as the visitor moves deeper into settings
 * — it cannot flicker, remount or lose its scroll behaviour on the way.
 *
 * Right-aligned, and above rather than inside the page's own upward
 * navigation. The two are different movements (one level up vs. out of
 * settings entirely), and putting them at opposite ends keeps them from
 * reading as a pair of interchangeable "back" buttons.
 *
 * It is a `nav` with its own name rather than a `header`: an unnested
 * `<header>` would claim the banner landmark, and `settingsNav.navLabel`
 * already belongs to the detail pages' upward nav, so a second landmark by
 * that name would leave two "Settings navigation" entries in the landmark
 * list with no way to tell which is which.
 */
export function SettingsExitBar() {
    const { t } = useLanguage();

    return (
        <nav
            aria-label={t("settingsNav.exitNavLabel")}
            data-testid="settings-exit-bar"
            className="sticky top-0 z-30 border-b border-zinc-200/80 bg-zinc-50/95 backdrop-blur supports-[backdrop-filter]:bg-zinc-50/80 dark:border-zinc-800/80 dark:bg-zinc-950/95 dark:supports-[backdrop-filter]:bg-zinc-950/80"
        >
            <div className="mx-auto flex w-full max-w-3xl flex-wrap items-center justify-end gap-2 px-4 py-2">
                <SettingsReturnToChat />
            </div>
        </nav>
    );
}
