"use client";

import Link from "next/link";
import { MessageSquare } from "lucide-react";
import { useLanguage } from "@/components/LanguageProvider";
import {
    SETTINGS_RETURN_TO_CHAT_TEST_ID,
    settingsExitHref,
} from "@/lib/settingsNavigation";

/**
 * The one control that leaves the settings hierarchy.
 *
 * Every settings screen already has upward navigation, and it is deliberately
 * one level at a time: the conversation viewer goes to the import it came
 * from, that import goes to the import list, the import list goes to the
 * settings panel. That hierarchy is right and stays, but it means the way out
 * of settings costs as many clicks as the depth the visitor reached — and the
 * panel's own close button lives on the chat surface, which is the one place
 * they cannot get to. This is the missing edge: /chat from anywhere, once.
 *
 * Not an X. Settings is a full page, not a modal, so a close glyph would read
 * as "discard" or "cancel" — it would be describing an action this control
 * does not perform. A speech-bubble plus the destination's own name says where
 * it goes instead of implying what it undoes.
 *
 * The visible label shortens on narrow viewports; the accessible name does
 * not. `aria-label` carries the full phrase in every locale and at every
 * width, so a screen reader never hears a control whose name changes with the
 * window, and the short rendering stays a prefix of it (WCAG 2.5.3).
 */
export function SettingsReturnToChat() {
    const { t } = useLanguage();
    const label = t("settingsNav.backToChat");

    return (
        <Link
            href={settingsExitHref()}
            data-testid={SETTINGS_RETURN_TO_CHAT_TEST_ID}
            aria-label={label}
            className="inline-flex min-h-11 min-w-11 items-center justify-center gap-1.5 rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm font-semibold text-zinc-600 transition-colors hover:border-zinc-300 hover:bg-zinc-100 hover:text-zinc-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-50 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:border-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-100 dark:focus-visible:ring-offset-zinc-950"
        >
            <MessageSquare className="h-4 w-4 shrink-0" aria-hidden="true" />
            {/* One name, two renderings. Both are hidden from the
                accessibility tree because `aria-label` above already states
                it -- otherwise the short viewport would announce "대화" and
                the wide one "대화로 돌아가기" for the same link. */}
            <span aria-hidden="true" className="sm:hidden">
                {t("settingsNav.backToChatShort")}
            </span>
            <span aria-hidden="true" className="hidden sm:inline">
                {label}
            </span>
        </Link>
    );
}
