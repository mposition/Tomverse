"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, Loader2 } from "lucide-react";
import { useLanguage } from "@/components/LanguageProvider";
import { interpolate } from "@/components/imports/importFormatting";
import { runProgress, type RunProgress } from "@/lib/memoryExtractionLaunch";
import { discardResponseBody } from "@/lib/discardResponseBody";

/**
 * /settings/memory/runs/[runId] — one run's progress (policy §11, §21).
 *
 * A run is durable, so this screen is a view of server state and never a
 * driver of it: closing the tab does not stop the run, and reopening the page
 * shows the same progress. Polling therefore stops the moment the run reaches
 * a terminal status rather than running forever in a background tab.
 *
 * Cancellation is two presses, like every other irreversible control here. The
 * server keeps whatever chunks already finished (§11 deterministic release),
 * so the copy says that instead of implying the work is thrown away.
 */

const POLL_INTERVAL_MS = 5000;

const sectionClass =
    "rounded-2xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950/60";

const secondaryButtonClass =
    "inline-flex items-center justify-center gap-2 rounded-xl border border-zinc-200 bg-white px-4 py-2.5 text-sm font-semibold text-zinc-700 transition-colors hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-60 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800";

type RunRow = {
    id: string;
    status: string;
    extractionModelId: string;
    promptVersion: string;
    chunkTotal: number;
    chunkCompleted: number;
    createdAt: string;
    completedAt: string | null;
    stalled?: boolean;
};

type RunState =
    | { kind: "loading" }
    | { kind: "ready"; run: RunRow; progress: RunProgress }
    | { kind: "missing" };

/**
 * A stalled run keeps its `running` status, so the note is chosen from the
 * progress rather than from the status: "still working" is the one thing this
 * screen must not say while nobody is working on it.
 */
const noteKey = (progress: RunProgress) => {
    if (progress.stalled) return "memoryExtraction.runStalledNote";
    const status = progress.status;
    return `memoryExtraction.run${status.charAt(0).toUpperCase()}${status.slice(1)}Note`;
};

export function MemoryExtractionRunStatus({ runId }: { runId: string }) {
    const { t } = useLanguage();
    const [state, setState] = useState<RunState>({ kind: "loading" });
    const [cancelArmed, setCancelArmed] = useState(false);
    const [cancelling, setCancelling] = useState(false);
    const pollingRef = useRef(true);

    const load = useCallback(async () => {
        try {
            const response = await fetch(
                `/api/memories/extraction-runs/${encodeURIComponent(runId)}`,
                { cache: "no-store" }
            );
            if (!response.ok) {
                await discardResponseBody(response);
                // 404 and a disabled flag land in the same place: there is
                // nothing to show, and the page says so rather than spinning.
                setState({ kind: "missing" });
                pollingRef.current = false;
                return;
            }
            const run = (await response.json()) as RunRow;
            const progress = runProgress(run);
            pollingRef.current = progress.polling;
            setState({ kind: "ready", run, progress });
        } catch {
            // A transport blip is not a missing run; keep the last view and
            // let the next poll correct it.
        }
    }, [runId]);

    useEffect(() => {
        queueMicrotask(() => {
            void load();
        });
        const timer = setInterval(() => {
            if (pollingRef.current) void load();
        }, POLL_INTERVAL_MS);
        return () => clearInterval(timer);
    }, [load]);

    const cancel = async () => {
        if (!cancelArmed) {
            setCancelArmed(true);
            return;
        }
        setCancelling(true);
        try {
            await fetch(
                `/api/memories/extraction-runs/${encodeURIComponent(runId)}/cancel`,
                { method: "POST" }
            ).then(discardResponseBody);
        } catch {
            // The reload below reports whatever actually happened.
        } finally {
            setCancelling(false);
            setCancelArmed(false);
            await load();
        }
    };

    return (
        <div className="mx-auto w-full max-w-3xl px-4 py-8">
            <Link
                href="/settings/memory"
                className="inline-flex items-center gap-1.5 text-sm font-medium text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
                data-testid="memory-extraction-run-back"
            >
                <ArrowLeft className="h-4 w-4" />
                {t("memoryExtraction.runBack")}
            </Link>

            <h1 className="mt-4 text-xl font-semibold">
                {t("memoryExtraction.runTitle")}
            </h1>

            {state.kind === "loading" ? (
                <Loader2 className="mt-6 h-5 w-5 animate-spin text-zinc-400" />
            ) : state.kind === "missing" ? (
                <p
                    className="mt-6 text-sm text-zinc-600 dark:text-zinc-400"
                    data-testid="memory-extraction-run-missing"
                >
                    {t("memoryExtraction.runNotFound")}
                </p>
            ) : (
                <section
                    className={`${sectionClass} mt-6`}
                    data-testid="memory-extraction-run-card"
                >
                    <p
                        className="text-sm font-semibold"
                        data-testid="memory-extraction-run-status"
                    >
                        {t(`memoryExtraction.status.${state.progress.status}`)}
                    </p>

                    <div
                        className="mt-3 h-2 w-full overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800"
                        role="progressbar"
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-valuenow={state.progress.percent}
                        aria-label={t("memoryExtraction.runTitle")}
                    >
                        <div
                            className="h-full rounded-full bg-blue-600 transition-[width]"
                            style={{ width: `${state.progress.percent}%` }}
                        />
                    </div>
                    <p
                        className="mt-2 text-sm text-zinc-600 dark:text-zinc-400"
                        data-testid="memory-extraction-run-progress"
                    >
                        {interpolate(t("memoryExtraction.runProgress"), {
                            completed: state.run.chunkCompleted,
                            total: state.run.chunkTotal,
                        })}
                    </p>

                    <p
                        className="mt-3 text-sm text-zinc-600 dark:text-zinc-400"
                        data-testid="memory-extraction-run-note"
                        data-stalled={state.progress.stalled ? "true" : "false"}
                    >
                        {t(noteKey(state.progress))}
                    </p>

                    <dl className="mt-4 space-y-1 text-xs text-zinc-500 dark:text-zinc-400">
                        <div className="flex gap-2">
                            <dt>{t("memoryExtraction.runModel")}</dt>
                            <dd className="font-mono">
                                {state.run.extractionModelId}
                            </dd>
                        </div>
                        <div>
                            {interpolate(t("memoryExtraction.runStarted"), {
                                date: new Date(
                                    state.run.createdAt
                                ).toLocaleString(),
                            })}
                        </div>
                        {state.run.completedAt ? (
                            <div>
                                {interpolate(t("memoryExtraction.runFinished"), {
                                    date: new Date(
                                        state.run.completedAt
                                    ).toLocaleString(),
                                })}
                            </div>
                        ) : null}
                    </dl>

                    <div className="mt-4 flex flex-wrap gap-2">
                        {state.progress.cancellable ? (
                            <button
                                type="button"
                                className={secondaryButtonClass}
                                data-testid="memory-extraction-run-cancel"
                                disabled={cancelling}
                                onClick={() => void cancel()}
                            >
                                {cancelling ? (
                                    <Loader2 className="h-4 w-4 animate-spin" />
                                ) : null}
                                {cancelling
                                    ? t("memoryExtraction.cancelling")
                                    : cancelArmed
                                      ? t("memoryExtraction.cancelArmed")
                                      : t("memoryExtraction.cancel")}
                            </button>
                        ) : null}
                        <Link
                            href="/settings/memory"
                            className={secondaryButtonClass}
                            data-testid="memory-extraction-run-review"
                        >
                            {t("memoryExtraction.runReview")}
                        </Link>
                    </div>
                </section>
            )}
        </div>
    );
}
