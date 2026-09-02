"use client";

import { useCallback, useEffect, useId, useState } from "react";
import { ChevronDown, ChevronRight, Loader2, Lock } from "lucide-react";

import { useLanguage } from "@/components/LanguageProvider";
import {
    interpolate,
    providerLabel,
} from "@/components/imports/importFormatting";
import { discardResponseBody } from "@/lib/discardResponseBody";

/**
 * The imported half of a continued conversation, above the Tomverse timeline.
 *
 * Policy: docs/policy/external-conversation-continuation.md §5.1, §8.2.
 *
 * ## Why this is a prelude and not a screen
 *
 * A continuation used to have a workspace of its own: its own textarea, its
 * own model buttons, its own message list, no sidebar. Everything below the
 * divider was a second, thinner implementation of the chat surface, and the
 * differences were not decisions -- no attachments, no web search, no stop, no
 * retry, no IME handling anyone had checked. What is actually particular to a
 * continuation is one thing: the transcript it was started from. So that is
 * all this component is, and the Tomverse conversation under it is the
 * ordinary chat shell.
 *
 * ## Why exactly one instance
 *
 * It is rendered by the shell, above the panel row -- never inside `ChatApp`,
 * which the shell mounts once per selected model. Drawing it there would put
 * the same third-party transcript on screen N times, and §5.1 says the source
 * appears once.
 *
 * ## Why it is collapsed by default
 *
 * The panels below scroll on their own, so anything above them costs fixed
 * height on every viewport. An imported conversation can be hundreds of turns;
 * expanded by default it would push the composer off a phone screen and bury
 * the answers the user came back for. Collapsed, it is one line of provenance
 * -- which is the part that has to be visible at all times, because it is what
 * says the transcript below the divider is not Tomverse's.
 *
 * Deletion and lock are the exception: those states are short, they change
 * what the next turn will carry, and they render open.
 */

type TimelineMessage = {
    id: string;
    role: string;
    ordinal: number;
    content: string;
    sourceModelLabel: string | null;
    sourceTimestamp: string | null;
    truncated: boolean;
};

type Timeline = {
    conversationId: string;
    provider: string;
    importedAt: string;
    seed: {
        messageCount: number;
        truncatedMessageCount: number;
        omittedMessageCount: number;
    };
    source:
        | {
              status: "available";
              title: string;
              messageTotal: number;
              offset: number;
              limit: number;
              messages: TimelineMessage[];
          }
        | { status: "deleted"; deletedAt: string | null }
        | { status: "locked" };
};

const SOURCE_PAGE_SIZE = 100;

const formatDate = (iso: string) => {
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? iso : date.toISOString().slice(0, 10);
};

export function ContinuationSourcePrelude({
    conversationId,
}: {
    conversationId: string;
}) {
    const { t } = useLanguage();
    const [timeline, setTimeline] = useState<Timeline | null>(null);
    const [expanded, setExpanded] = useState(false);
    const [loadingMore, setLoadingMore] = useState(false);
    const panelId = useId();

    useEffect(() => {
        let cancelled = false;
        void (async () => {
            try {
                const response = await fetch(
                    `/api/conversations/${encodeURIComponent(conversationId)}/continuation?limit=${SOURCE_PAGE_SIZE}`,
                    { cache: "no-store" }
                );
                if (!response.ok) {
                    // A conversation with no bridge answers 404 here, and that
                    // is not an error for this component to announce: it means
                    // there is no imported half, so there is nothing to draw.
                    await discardResponseBody(response);
                    return;
                }
                const loaded = (await response.json()) as Timeline;
                if (!cancelled) setTimeline(loaded);
            } catch {
                // Same answer as a 404. The Tomverse conversation below is
                // readable either way, and a banner about a failed provenance
                // read would be noise on a screen that is working.
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [conversationId]);

    const loadMore = useCallback(async () => {
        if (!timeline || timeline.source.status !== "available") return;
        if (loadingMore) return;
        const loaded = timeline.source.messages.length;
        if (loaded >= timeline.source.messageTotal) return;
        setLoadingMore(true);
        try {
            const response = await fetch(
                `/api/conversations/${encodeURIComponent(conversationId)}/continuation?offset=${loaded}&limit=${SOURCE_PAGE_SIZE}`,
                { cache: "no-store" }
            );
            if (!response.ok) {
                await discardResponseBody(response);
                return;
            }
            const page = (await response.json()) as Timeline;
            if (page.source.status !== "available") {
                setTimeline(page);
                return;
            }
            const next = page.source;
            setTimeline((current) =>
                current && current.source.status === "available"
                    ? {
                          ...current,
                          source: {
                              ...next,
                              messages: [
                                  ...current.source.messages,
                                  ...next.messages,
                              ],
                          },
                      }
                    : page
            );
        } catch {
            // The transcript is read-only; nothing is lost by not growing it.
        } finally {
            setLoadingMore(false);
        }
    }, [conversationId, loadingMore, timeline]);

    if (!timeline) return null;

    const source = timeline.source;
    // Gone or locked: two short states that change what the next turn carries,
    // so they are said on screen rather than hidden behind a disclosure.
    const alwaysOpen = source.status !== "available";
    const isOpen = alwaysOpen || expanded;

    return (
        <section
            className="shrink-0 border-b border-zinc-200 bg-zinc-50 px-3 py-2 dark:border-zinc-800 dark:bg-zinc-900/60"
            data-testid="continuation-source-section"
            aria-label={t("continuation.sourceSectionTitle")}
        >
            <div className="mx-auto flex w-full max-w-5xl flex-wrap items-center gap-x-3 gap-y-1">
                <span className="inline-flex items-center gap-1.5 text-xs font-bold text-zinc-600 dark:text-zinc-300">
                    <Lock className="h-3.5 w-3.5" aria-hidden="true" />
                    {t("continuation.sourceSectionTitle")}
                </span>
                <span
                    className="text-xs leading-5 text-zinc-500"
                    data-testid="continuation-provenance"
                >
                    {interpolate(t("continuation.sourceSectionSubtitle"), {
                        provider: providerLabel(timeline.provider),
                        date: formatDate(timeline.importedAt),
                    })}
                </span>
                <span
                    className="text-xs leading-5 text-zinc-400"
                    data-testid="continuation-seed-summary"
                >
                    {timeline.seed.messageCount === 0
                        ? t("continuation.seedNone")
                        : interpolate(t("continuation.seedSummary"), {
                              used: timeline.seed.messageCount,
                              total:
                                  source.status === "available"
                                      ? source.messageTotal
                                      : timeline.seed.messageCount +
                                        timeline.seed.omittedMessageCount,
                          })}
                    {timeline.seed.truncatedMessageCount > 0 ? (
                        <span className="ml-1">
                            {interpolate(t("continuation.seedTruncated"), {
                                count: timeline.seed.truncatedMessageCount,
                            })}
                        </span>
                    ) : null}
                </span>
                {source.status === "available" ? (
                    <button
                        type="button"
                        className="ml-auto inline-flex min-h-11 items-center gap-1 rounded-lg px-2 text-xs font-semibold text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
                        data-testid="continuation-source-toggle"
                        aria-expanded={expanded}
                        aria-controls={expanded ? panelId : undefined}
                        onClick={() => setExpanded((open) => !open)}
                    >
                        {expanded ? (
                            <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
                        ) : (
                            <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
                        )}
                        {expanded
                            ? t("continuation.hideSource")
                            : t("continuation.showSource")}
                    </button>
                ) : null}
            </div>

            {source.status === "deleted" ? (
                <p
                    className="mx-auto mt-1 w-full max-w-5xl text-xs leading-5 text-zinc-500"
                    data-testid="continuation-source-tombstone"
                >
                    {t("continuation.sourceDeleted")}
                </p>
            ) : null}

            {source.status === "locked" ? (
                <p
                    className="mx-auto mt-1 w-full max-w-5xl text-xs leading-5 text-zinc-500"
                    data-testid="continuation-source-locked"
                >
                    {t("continuation.sourceLocked")}
                </p>
            ) : null}

            {isOpen && source.status === "available" ? (
                <div
                    id={panelId}
                    // Its own scroller, capped: the panels below must keep
                    // their height whatever the imported conversation's length
                    // (docs/ui-contracts/mobile-chat-composer.md -- the
                    // composer's row is not something another section may take).
                    className="mx-auto mt-2 max-h-[40vh] w-full max-w-5xl overflow-y-auto"
                >
                    <ol className="space-y-2">
                        {source.messages.map((message) => (
                            <li
                                key={message.id}
                                className={`rounded-xl border border-dashed p-2.5 ${
                                    message.role === "user"
                                        ? "border-zinc-300 bg-white dark:border-zinc-700 dark:bg-zinc-950/40"
                                        : "border-zinc-300 bg-zinc-100/60 dark:border-zinc-700 dark:bg-zinc-900/40"
                                }`}
                                data-testid="continuation-source-message"
                            >
                                <p className="flex flex-wrap items-center gap-2 text-[11px] font-bold uppercase tracking-wide text-zinc-400">
                                    <span>
                                        {message.role === "user"
                                            ? t("externalImport.viewerRoleUser")
                                            : t("externalImport.viewerRoleAssistant")}
                                    </span>
                                    {message.role !== "user" ? (
                                        <span
                                            className="rounded-md border border-zinc-300 px-1.5 py-0.5 text-[11px] font-bold normal-case tracking-normal text-zinc-500 dark:border-zinc-700 dark:text-zinc-400"
                                            data-testid="continuation-external-badge"
                                        >
                                            {providerLabel(timeline.provider)}
                                            {" · "}
                                            {t("continuation.externalAnswerBadge")}
                                        </span>
                                    ) : null}
                                    {message.sourceModelLabel ? (
                                        <span className="font-mono text-[11px] normal-case tracking-normal text-zinc-400">
                                            {message.sourceModelLabel}
                                        </span>
                                    ) : null}
                                </p>
                                {message.truncated ? (
                                    <p className="mt-1.5 rounded-lg border border-amber-200 bg-amber-50 px-2 py-1 text-[11px] leading-5 text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/20 dark:text-amber-200">
                                        {t("externalImport.viewerTruncatedNotice")}
                                    </p>
                                ) : null}
                                {/* Inert plain text, exactly as the read-only
                                    viewer renders it: a React text node cannot
                                    become markup. */}
                                <p className="mt-1.5 text-sm leading-6 break-words whitespace-pre-wrap text-zinc-700 dark:text-zinc-300">
                                    {message.content}
                                </p>
                            </li>
                        ))}
                    </ol>
                    {source.messages.length < source.messageTotal ? (
                        <button
                            type="button"
                            className="mt-2 inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-xl border border-zinc-200 bg-white px-4 text-sm font-semibold text-zinc-700 hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-60 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800"
                            data-testid="continuation-source-more"
                            disabled={loadingMore}
                            onClick={() => void loadMore()}
                        >
                            {loadingMore ? (
                                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                            ) : null}
                            {t("externalImport.loadMore")}
                        </button>
                    ) : null}
                </div>
            ) : null}

            <p
                className="mx-auto mt-2 w-full max-w-5xl text-[11px] font-bold uppercase tracking-wide text-zinc-400"
                data-testid="continuation-divider"
            >
                {t("continuation.divider")}
            </p>
        </section>
    );
}
