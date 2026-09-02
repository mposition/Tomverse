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

/**
 * How many imported turns the preview shows before "show all".
 *
 * The most recent ones, which are also the end of the window the seed is
 * drawn from -- so the preview is the part of the transcript the next answer
 * will actually be reasoning over.
 */
const SOURCE_PREVIEW_COUNT = 6;

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
    /**
     * Open, and open on arrival.
     *
     * The first version defaulted to closed, which was the wrong trade for the
     * state this screen is in most often: somebody has just started a
     * continuation, there is no Tomverse turn yet, and the only thing on the
     * page is the conversation they came here to continue. Closed, that page
     * said "Imported conversation · read-only" and showed nothing -- the
     * transcript the whole feature is about was behind a control in the
     * corner. It stays bounded instead: a preview of the most recent turns,
     * with the rest one press away.
     */
    const [expanded, setExpanded] = useState(true);
    /** Whether the owner asked past the preview to the whole transcript. */
    const [showingAll, setShowingAll] = useState(false);
    const [loadingMore, setLoadingMore] = useState(false);
    const panelId = useId();
    const headingId = useId();

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
    const sourceTitle =
        source.status === "available" && source.title.trim()
            ? source.title
            : t("continuation.quickUntitled");
    // Gone or locked: two short states that change what the next turn carries,
    // so they are said on screen rather than behind a disclosure, and neither
    // offers one.
    const canDisclose = source.status === "available";
    const messages = canDisclose ? source.messages : [];
    /*
      What the preview shows: the most recent turns, which are also the end of
      the window the seed is taken from. A short imported conversation is
      shown whole -- hiding six messages behind a control would be the closed
      default again, in a different shape.
    */
    const previewed =
        showingAll || messages.length <= SOURCE_PREVIEW_COUNT
            ? messages
            : messages.slice(-SOURCE_PREVIEW_COUNT);
    const hasMoreThanPreview =
        canDisclose &&
        (source.messageTotal > previewed.length ||
            messages.length > previewed.length);

    return (
        <div className="shrink-0" data-testid="continuation-prelude">
            <section
                className="border-b border-zinc-200 bg-zinc-50 px-3 py-2 dark:border-zinc-800 dark:bg-zinc-900/60"
                data-testid="continuation-source-section"
                aria-labelledby={headingId}
            >
                <div className="mx-auto flex w-full max-w-5xl flex-wrap items-center gap-x-3 gap-y-1">
                    <h2
                        id={headingId}
                        className="inline-flex items-center gap-1.5 text-xs font-bold text-zinc-600 dark:text-zinc-300"
                    >
                        <Lock className="h-3.5 w-3.5" aria-hidden="true" />
                        {t("continuation.sourceSectionTitle")}
                    </h2>
                    <span
                        className="text-xs leading-5 text-zinc-500"
                        data-testid="continuation-provenance"
                    >
                        {interpolate(t("continuation.sourceSectionSubtitle"), {
                            provider: providerLabel(timeline.provider),
                            date: formatDate(timeline.importedAt),
                        })}
                    </span>
                    {canDisclose ? (
                        <span
                            className="text-xs leading-5 text-zinc-500"
                            data-testid="continuation-source-count"
                        >
                            {interpolate(t("continuation.sourceMessageCount"), {
                                count: source.messageTotal,
                            })}
                        </span>
                    ) : null}
                    <span
                        className="text-xs leading-5 text-zinc-400"
                        data-testid="continuation-seed-summary"
                    >
                        {timeline.seed.messageCount === 0
                            ? t("continuation.seedNone")
                            : interpolate(t("continuation.seedSummary"), {
                                  used: timeline.seed.messageCount,
                              })}
                        {timeline.seed.truncatedMessageCount > 0 ? (
                            <span className="ml-1">
                                {interpolate(t("continuation.seedTruncated"), {
                                    count: timeline.seed.truncatedMessageCount,
                                })}
                            </span>
                        ) : null}
                    </span>
                    {canDisclose ? (
                        <button
                            type="button"
                            className="ml-auto inline-flex min-h-11 items-center gap-1 rounded-lg px-2 text-xs font-semibold text-zinc-600 hover:bg-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:text-zinc-300 dark:hover:bg-zinc-800"
                            data-testid="continuation-source-toggle"
                            aria-expanded={expanded}
                            aria-controls={panelId}
                            // The title, so a screen reader hears which
                            // imported conversation this control belongs to
                            // rather than "show" repeated down the page.
                            aria-label={interpolate(
                                expanded
                                    ? t("continuation.hideSourceFor")
                                    : t("continuation.showSourceFor"),
                                { title: sourceTitle }
                            )}
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

                <div
                    id={panelId}
                    hidden={!canDisclose || !expanded}
                    // Its own scroller, capped: the panels below must keep
                    // their height whatever the imported conversation's length,
                    // and the composer must stay reachable
                    // (docs/ui-contracts/mobile-chat-composer.md).
                    className="mx-auto mt-2 max-h-[34vh] w-full max-w-5xl overflow-y-auto"
                >
                    <ol className="space-y-2">
                        {previewed.map((message) => (
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
                    {hasMoreThanPreview ? (
                        <div className="mt-2 flex flex-wrap items-center gap-2">
                            <span
                                className="text-[11px] leading-5 text-zinc-400"
                                data-testid="continuation-source-preview-notice"
                            >
                                {interpolate(
                                    t("continuation.sourcePreviewNotice"),
                                    { count: previewed.length }
                                )}
                            </span>
                            <button
                                type="button"
                                className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-zinc-200 bg-white px-3 text-sm font-semibold text-zinc-700 hover:bg-zinc-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:cursor-not-allowed disabled:opacity-60 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800"
                                data-testid="continuation-source-more"
                                disabled={loadingMore}
                                aria-label={interpolate(
                                    t("continuation.showAllMessagesFor"),
                                    {
                                        count:
                                            canDisclose
                                                ? source.messageTotal
                                                : previewed.length,
                                        title: sourceTitle,
                                    }
                                )}
                                onClick={() => {
                                    setShowingAll(true);
                                    void loadMore();
                                }}
                            >
                                {loadingMore ? (
                                    <Loader2
                                        className="h-4 w-4 animate-spin"
                                        aria-hidden="true"
                                    />
                                ) : null}
                                {interpolate(t("continuation.showAllMessages"), {
                                    count: canDisclose
                                        ? source.messageTotal
                                        : previewed.length,
                                })}
                            </button>
                        </div>
                    ) : null}
                </div>
            </section>

            {/*
              The boundary, as a separator in the timeline rather than a line of
              small print above it.

              `role="separator"` with a name is what makes it a boundary to a
              screen reader as well as to the eye, and it renders in every
              state -- a deleted or locked source still has Tomverse messages
              under it, and the line between "somebody else's words" and "ours"
              is exactly what must not disappear when the source does.
            */}
            <div
                role="separator"
                aria-label={t("continuation.divider")}
                className="mx-auto flex w-full max-w-5xl items-center gap-3 px-3 py-2"
                data-testid="continuation-divider"
            >
                <span
                    aria-hidden="true"
                    className="h-px flex-1 bg-zinc-300 dark:bg-zinc-700"
                />
                <span className="text-[11px] font-bold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                    {t("continuation.divider")}
                </span>
                <span
                    aria-hidden="true"
                    className="h-px flex-1 bg-zinc-300 dark:bg-zinc-700"
                />
            </div>
        </div>
    );
}
