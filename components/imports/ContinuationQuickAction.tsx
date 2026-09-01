"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowRight, ChevronDown, Loader2, Lock } from "lucide-react";

import { useLanguage } from "@/components/LanguageProvider";
import { useContinuationLauncher } from "@/components/imports/useContinuationLauncher";
import { continuationPath } from "@/lib/continuationRoutes";
import {
    interpolate,
    secondaryButtonClass,
} from "@/components/imports/importFormatting";
import type { ContinuationQuickActionState } from "@/lib/continuationQuickAction";
import { continuationQuickActionState } from "@/lib/continuationQuickAction";

/**
 * The trailing action on a row of the imported-conversation list.
 *
 * Policy: docs/policy/external-conversation-continuation.md §8.
 * The list itself: components/imports/ExternalImportManagement.tsx.
 *
 * ## Why this skips the disclosure the detail card shows
 *
 * `ContinueInTomverseCard` states five things before it creates anything,
 * because that card is where somebody meets the feature. This is a row in a
 * screen the owner opened to manage their imports, beside a title they
 * imported themselves; repeating the disclosure on every row would make the
 * list unusable and would not tell them anything the card has not already told
 * them once. The disclosure stays the first-run path, and stays reachable: the
 * row's own body still opens the source.
 *
 * ## Why the creation logic is not here
 *
 * `useContinuationLauncher` owns the idempotency key, so this component and
 * the detail card cannot disagree about what a retry is. Everything below is
 * presentation and the four states.
 */

export function ContinuationQuickAction({
    externalConversationId,
    /** The source's title, for the button's accessible name. */
    sourceTitle,
    locked,
    continuationCount,
    latestContinuationId,
    continuations,
}: {
    externalConversationId: string;
    sourceTitle: string;
    locked: boolean;
    continuationCount: number;
    latestContinuationId: string | null;
    continuations: {
        conversationId: string;
        title: string | null;
        createdAt: string;
    }[];
}) {
    const { t } = useLanguage();
    const router = useRouter();
    const launcher = useContinuationLauncher({ externalConversationId });
    const [menuOpen, setMenuOpen] = useState(false);
    const menuId = useId();
    const containerRef = useRef<HTMLDivElement | null>(null);
    const triggerRef = useRef<HTMLButtonElement | null>(null);

    const state: ContinuationQuickActionState = continuationQuickActionState({
        locked,
        continuationCount,
        hasLatest: latestContinuationId != null,
    });

    // Escape, an outside click, and focus back on the trigger. A menu that
    // traps focus or leaves it on a removed node is a keyboard dead end, and
    // this one sits inside a list where the next stop matters.
    const closeMenu = useCallback((returnFocus: boolean) => {
        setMenuOpen(false);
        if (returnFocus) triggerRef.current?.focus();
    }, []);

    useEffect(() => {
        if (!menuOpen) return;
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === "Escape") {
                event.stopPropagation();
                closeMenu(true);
            }
        };
        const onPointerDown = (event: PointerEvent) => {
            if (!containerRef.current) return;
            if (containerRef.current.contains(event.target as Node)) return;
            closeMenu(false);
        };
        document.addEventListener("keydown", onKeyDown);
        document.addEventListener("pointerdown", onPointerDown);
        return () => {
            document.removeEventListener("keydown", onKeyDown);
            document.removeEventListener("pointerdown", onPointerDown);
        };
    }, [closeMenu, menuOpen]);

    const creating = launcher.status === "creating";
    const failed = launcher.status === "failed";

    // The list's existing secondary style, plus the two things it does not
    // already promise: a 44px minimum touch target, and never shrinking below
    // its content. Nothing here is hover-revealed -- an affordance that
    // appears on hover does not exist on a touch screen at all.
    const buttonClass = `${secondaryButtonClass} min-h-11 shrink-0`;

    if (state === "locked") {
        // Never unlocked from the list, and the create API is never called:
        // the password belongs to the source's own screen (§6).
        return (
            <Link
                href={`/settings/imports/conversations/${externalConversationId}`}
                className={buttonClass}
                data-testid="continuation-quick-action-locked"
                aria-label={interpolate(t("continuation.quickUnlockFor"), {
                    title: sourceTitle,
                })}
            >
                <Lock className="h-4 w-4" aria-hidden="true" />
                {t("continuation.quickUnlock")}
            </Link>
        );
    }

    if (state === "open_existing" && latestContinuationId) {
        return (
            <Link
                href={continuationPath(latestContinuationId)}
                className={buttonClass}
                data-testid="continuation-quick-action-open"
                aria-label={interpolate(t("continuation.quickOpenFor"), {
                    title: sourceTitle,
                })}
            >
                {t("continuation.quickOpen")}
                <ArrowRight className="h-4 w-4" aria-hidden="true" />
            </Link>
        );
    }

    if (state === "choose_existing") {
        return (
            <div className="relative shrink-0" ref={containerRef}>
                <button
                    type="button"
                    ref={triggerRef}
                    className={buttonClass}
                    data-testid="continuation-quick-action-menu-trigger"
                    aria-haspopup="menu"
                    aria-expanded={menuOpen}
                    aria-controls={menuOpen ? menuId : undefined}
                    aria-label={interpolate(t("continuation.quickManyFor"), {
                        count: continuationCount,
                        title: sourceTitle,
                    })}
                    onClick={() => setMenuOpen((open) => !open)}
                >
                    {interpolate(t("continuation.quickMany"), {
                        count: continuationCount,
                    })}
                    <ChevronDown className="h-4 w-4" aria-hidden="true" />
                </button>
                {menuOpen ? (
                    <div
                        id={menuId}
                        role="menu"
                        data-testid="continuation-quick-action-menu"
                        className="absolute right-0 z-20 mt-1 w-64 max-w-[min(16rem,calc(100vw-2rem))] overflow-hidden rounded-xl border border-zinc-200 bg-white py-1 shadow-lg dark:border-zinc-700 dark:bg-zinc-900"
                    >
                        {/* Opening an existing conversation only. Starting
                            another fork stays on the source's own page, so a
                            list of things to open never contains one thing
                            that creates. */}
                        {continuations.map((entry) => (
                            <button
                                key={entry.conversationId}
                                type="button"
                                role="menuitem"
                                data-testid="continuation-quick-action-menu-item"
                                className="block w-full min-h-11 px-3 py-2 text-left text-sm text-zinc-800 hover:bg-zinc-50 dark:text-zinc-100 dark:hover:bg-zinc-800"
                                onClick={() => {
                                    setMenuOpen(false);
                                    router.push(
                                        continuationPath(entry.conversationId)
                                    );
                                }}
                            >
                                <span className="block truncate font-semibold">
                                    {entry.title?.trim()
                                        ? entry.title
                                        : t("continuation.quickUntitled")}
                                </span>
                                <span className="mt-0.5 block text-xs text-zinc-500">
                                    {new Date(
                                        entry.createdAt
                                    ).toLocaleDateString()}
                                </span>
                            </button>
                        ))}
                    </div>
                ) : null}
            </div>
        );
    }

    // state === "create"
    return (
        <div className="flex shrink-0 flex-col items-end gap-1">
            <button
                type="button"
                className={buttonClass}
                data-testid="continuation-quick-action-create"
                disabled={creating}
                aria-busy={creating}
                aria-label={interpolate(
                    failed
                        ? t("continuation.quickRetryFor")
                        : t("continuation.quickStartFor"),
                    { title: sourceTitle }
                )}
                onClick={() => void launcher.start()}
            >
                {creating ? (
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                ) : null}
                {creating
                    ? t("continuation.creating")
                    : failed
                      ? t("continuation.quickRetry")
                      : t("continuation.quickStart")}
            </button>
            {failed && launcher.errorMessage ? (
                <span
                    role="status"
                    data-testid="continuation-quick-action-error"
                    className="max-w-[16rem] text-right text-xs leading-5 text-red-600 dark:text-red-300"
                >
                    {launcher.errorMessage}
                </span>
            ) : null}
        </div>
    );
}
