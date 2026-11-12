"use client";
import { useEffect, useRef, useState } from "react";
import { BookOpen, ChevronRight, CircleAlert, X } from "lucide-react";
import {
    MAX_PASSAGES,
    PASSAGE_LENGTH,
    slicePassage,
    type Passage,
} from "@/lib/continuationPassages";
import { useLanguage } from "@/components/LanguageProvider";
import {
    interpolate,
    providerLabel,
} from "@/components/imports/importFormatting";
import type { ContinuationSource } from "./useContinuationSource";

export function ContinuationPassageCard({
    source,
    chosen,
    onChoose,
}: {
    source: ContinuationSource;
    chosen: Passage[];
    onChoose: (value: Passage[]) => void;
}) {
    const { t } = useLanguage();
    const dialog = useRef<HTMLDialogElement>(null);
    const [draft, setDraft] = useState<Passage[]>([]);
    const [positions, setPositions] = useState<Record<number, number>>({});
    const timeline = source.timeline;
    useEffect(() => {
        if (timeline?.source.status !== "available") dialog.current?.close();
    }, [timeline?.source.status]);
    useEffect(() => {
        if (timeline?.source.status !== "available") return;
        const url = new URL(window.location.href);
        if (url.searchParams.get("pickSource") !== "1") return;
        url.searchParams.delete("pickSource");
        window.history.replaceState(window.history.state, "", url);
        dialog.current?.showModal();
    }, [timeline?.conversationId, timeline?.source.status]);
    if (!timeline || timeline.source.status !== "available") return null;
    const { messages, title, messageTotal } = timeline.source;
    const count = chosen.length || timeline.seed.messageCount;
    return (
        <aside
            data-testid="continuation-context"
            className="mx-auto my-3 w-full max-w-2xl rounded-2xl border border-zinc-200 bg-zinc-50 p-4 text-sm dark:border-zinc-700 dark:bg-zinc-900"
        >
            <strong className="flex items-center gap-2">
                {count ? <BookOpen size={18} /> : <CircleAlert size={18} />}
                {interpolate(
                    t(
                        chosen.length
                            ? "journey.chosen"
                            : count
                              ? "journey.auto"
                              : "journey.empty",
                    ),
                    { count },
                )}
            </strong>
            <p className="mt-1 text-xs leading-5 text-zinc-600 dark:text-zinc-300">
                {interpolate(
                    t(count ? "journey.contextHint" : "journey.emptyHint"),
                    { count: messageTotal },
                )}
            </p>
            <button
                type="button"
                className="inline-flex min-h-11 items-center gap-2 font-semibold text-blue-600 dark:text-blue-300"
                onClick={() => {
                    dialog.current?.showModal();
                }}
            >
                {t("journey.pickSource")} <ChevronRight size={15} />
            </button>
            <dialog
                ref={dialog}
                onToggle={event => {
                    if (!event.currentTarget.open) return;
                    setDraft(chosen);
                    setPositions(Object.fromEntries(chosen.map(p => [p.ordinal, p.start])));
                }}
                aria-label={t("journey.pickSource")}
                className="fixed inset-0 m-auto max-h-[90dvh] w-[min(38rem,96vw)] max-w-full rounded-2xl border border-zinc-300 bg-white p-0 text-zinc-900 backdrop:bg-black/45 dark:bg-zinc-950 dark:text-zinc-100"
            >
                <div className="flex max-h-[89dvh] flex-col">
                    <header className="flex items-start justify-between gap-2 border-b border-zinc-200 p-4">
                        <div>
                            <h2 className="text-xl font-bold">
                                {t("journey.pickSource")}
                            </h2>
                            <p className="mt-1 text-xs">
                                {title} · {providerLabel(timeline.provider)} ·{" "}
                                {interpolate(
                                    t("externalImport.messagesCount"),
                                    { count: messageTotal },
                                )}
                            </p>
                        </div>
                        <button
                            aria-label={t("externalImport.cancel")}
                            onClick={() => dialog.current?.close()}
                            className="min-h-11 min-w-11"
                        >
                            <X size={20} />
                        </button>
                    </header>
                    <div className="min-h-0 space-y-2 overflow-auto p-4">
                        <p className="pb-2 text-sm">{t("journey.pickHelp")}</p>
                        {source.hasMore && (
                            <button
                                onClick={source.loadMore}
                                disabled={source.loadingMore}
                            >
                                {t("journey.older")}
                            </button>
                        )}
                        {messages
                            .filter(
                                (m) =>
                                    (m.role === "user" ||
                                        m.role === "assistant") &&
                                    m.content.trim(),
                            )
                            .map((m) => {
                                const picked = draft.find(
                                    (p) => p.ordinal === m.ordinal,
                                );
                                const last = Math.max(
                                    0,
                                    m.content.length - PASSAGE_LENGTH,
                                );
                                const start = Math.min(
                                    last,
                                    positions[m.ordinal] ??
                                        picked?.start ??
                                        last,
                                );
                                const end = Math.min(
                                    m.content.length,
                                    start + PASSAGE_LENGTH,
                                );
                                const part = { ordinal: m.ordinal, start, end };
                                return (
                                    <div
                                        key={m.id}
                                        className="rounded-xl border border-zinc-200 p-3 dark:border-zinc-700"
                                    >
                                        <label className="flex cursor-pointer items-start gap-3">
                                            <input
                                                type="checkbox"
                                                className="mt-1"
                                                checked={!!picked}
                                                disabled={
                                                    !picked &&
                                                    draft.length >= MAX_PASSAGES
                                                }
                                                onChange={() =>
                                                    setDraft((d) =>
                                                        picked
                                                            ? d.filter(
                                                                  (p) =>
                                                                      p.ordinal !==
                                                                      m.ordinal,
                                                              )
                                                            : [...d, part],
                                                    )
                                                }
                                            />
                                            <span className="min-w-0">
                                                <strong className="text-xs">
                                                    {m.role === "assistant"
                                                        ? providerLabel(
                                                              timeline.provider,
                                                          )
                                                        : t("journey.you")}{" "}
                                                    · {m.ordinal + 1}
                                                </strong>
                                                <span className="mt-1 block whitespace-pre-wrap break-words text-sm">
                                                    {start > 0 && "…"}
                                                    {slicePassage(
                                                        m.content,
                                                        start,
                                                        end,
                                                    )}
                                                    {end < m.content.length &&
                                                        "…"}
                                                </span>
                                            </span>
                                        </label>
                                        {last > 0 && (
                                            <div className="mt-2 flex gap-3 text-xs">
                                                {[-1, 1].map((dir) => (
                                                    <button
                                                        key={dir}
                                                        disabled={
                                                            dir < 0
                                                                ? start === 0
                                                                : start === last
                                                        }
                                                        className="min-h-11 font-semibold text-blue-600 disabled:opacity-40"
                                                        onClick={() => {
                                                            const next =
                                                                Math.min(
                                                                    last,
                                                                    Math.max(
                                                                        0,
                                                                        start +
                                                                            dir *
                                                                                PASSAGE_LENGTH,
                                                                    ),
                                                                );
                                                            setPositions(
                                                                (v) => ({
                                                                    ...v,
                                                                    [m.ordinal]:
                                                                        next,
                                                                }),
                                                            );
                                                            if (picked)
                                                                setDraft((d) =>
                                                                    d.map(
                                                                        (p) =>
                                                                            p.ordinal ===
                                                                            m.ordinal
                                                                                ? {
                                                                                      ordinal:
                                                                                          m.ordinal,
                                                                                      start: next,
                                                                                      end: Math.min(
                                                                                          m
                                                                                              .content
                                                                                              .length,
                                                                                          next +
                                                                                              PASSAGE_LENGTH,
                                                                                      ),
                                                                                  }
                                                                                : p,
                                                                    ),
                                                                );
                                                        }}
                                                    >
                                                        {t(
                                                            dir < 0
                                                                ? "journey.previousPart"
                                                                : "journey.nextPart",
                                                        )}
                                                    </button>
                                                ))}
                                            </div>
                                        )}
                                    </div>
                                );
                            })}
                        {source.newerCount > 0 && (
                            <button
                                onClick={source.loadNewer}
                                disabled={source.loadingNewer}
                            >
                                {t("journey.newer")}
                            </button>
                        )}
                    </div>
                    <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-zinc-200 p-4">
                        <span aria-live="polite">
                            {interpolate(t("journey.selected"), {
                                count: draft.length,
                            })}
                        </span>
                        <button
                            className="min-h-11 rounded-xl bg-blue-600 px-4 text-sm font-semibold text-white"
                            onClick={() => {
                                onChoose(draft);
                                dialog.current?.close();
                            }}
                        >
                            {t(
                                draft.length
                                    ? "journey.useChosen"
                                    : "journey.useAuto",
                            )}
                        </button>
                    </footer>
                </div>
            </dialog>
        </aside>
    );
}
