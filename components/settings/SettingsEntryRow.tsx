"use client";

import Link from "next/link";
import { ChevronRight, type LucideIcon } from "lucide-react";
import {
    settingsSectionElementId,
    type SettingsSectionId,
} from "@/lib/settingsNavigation";

/**
 * One navigation row in the settings list.
 *
 * Replaces the stacked full-width cards the Data tab used to give each
 * feature. Two cards in a row read as two unrelated destinations of equal
 * weight; the tab has five other sections, and the two that lead somewhere
 * else were the loudest things on it. A row keeps the three things a settings
 * list owes the reader — name, what it does, where it stands — while making it
 * obvious at a glance that they are siblings under one group.
 *
 * The whole row is the link, which is why the accessible name is stated
 * explicitly: `aria-labelledby` names the row and its purpose ("Account
 * memory, Manage memory"), and the description and status ride along in
 * `aria-describedby` instead of running into the name. The link carries the
 * DOM id too, so restoring a row from a detail page (scroll + focus) has a
 * single target.
 */
export function SettingsEntryRow({
    section,
    href,
    icon: Icon,
    title,
    description,
    status,
    actionLabel,
    onNavigate,
    testId,
    linkTestId,
}: {
    section: SettingsSectionId;
    href: string;
    icon: LucideIcon;
    title: string;
    description: string;
    /** Current state of the feature; omitted while it is still unknown. */
    status?: string | null;
    /** Names the destination's purpose. Never a generic "Open settings". */
    actionLabel: string;
    onNavigate?: () => void;
    testId: string;
    linkTestId: string;
}) {
    const elementId = settingsSectionElementId(section);
    const titleId = `${elementId}-title`;
    const actionId = `${elementId}-action`;
    const descriptionId = `${elementId}-description`;
    const statusId = `${elementId}-status`;

    return (
        <div
            data-testid={testId}
            className="border-b border-zinc-200 last:border-b-0 dark:border-zinc-800"
        >
            <Link
                id={elementId}
                href={href}
                onClick={onNavigate}
                data-testid={linkTestId}
                aria-labelledby={`${titleId} ${actionId}`}
                aria-describedby={
                    status ? `${descriptionId} ${statusId}` : descriptionId
                }
                // Wrapping rather than squeezing: below ~320px of row width the
                // action drops to its own line instead of shaving the
                // description into a two-word column.
                className="flex w-full flex-wrap items-start gap-x-3 gap-y-2 rounded-xl px-3 py-3 text-left transition-colors hover:bg-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-50 dark:hover:bg-zinc-900 dark:focus-visible:ring-offset-zinc-950"
            >
                <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-white text-zinc-500 ring-1 ring-zinc-200 dark:bg-zinc-900 dark:text-zinc-400 dark:ring-zinc-800">
                    <Icon className="h-4 w-4" aria-hidden="true" />
                </span>
                <span className="min-w-[11rem] flex-1">
                    <span
                        id={titleId}
                        className="block text-sm font-bold text-zinc-900 dark:text-zinc-100"
                    >
                        {title}
                    </span>
                    <span
                        id={descriptionId}
                        className="mt-0.5 block text-sm leading-6 text-zinc-500"
                    >
                        {description}
                    </span>
                    {status ? (
                        <span
                            id={statusId}
                            data-testid={`${testId}-status`}
                            className="mt-1 block text-xs font-semibold text-zinc-500"
                        >
                            {status}
                        </span>
                    ) : null}
                </span>
                <span className="ml-auto mt-1 flex shrink-0 items-center gap-1 whitespace-nowrap text-sm font-semibold text-zinc-600 dark:text-zinc-300">
                    <span id={actionId}>{actionLabel}</span>
                    <ChevronRight className="h-4 w-4" aria-hidden="true" />
                </span>
            </Link>
        </div>
    );
}
