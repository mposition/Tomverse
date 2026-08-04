"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, Sparkles } from "lucide-react";
import { useLanguage } from "@/components/LanguageProvider";
import {
    formatBytes,
    interpolate,
    providerLabel,
} from "@/components/imports/importFormatting";
import {
    MEMORY_EXTRACTION_MAX_SELECTION,
    estimateGate,
    pairSignature,
    runProgress,
    selectionSignature,
    startGate,
    summarizeSelection,
    type ExtractionPairChoice,
    type LaunchEstimate,
} from "@/lib/memoryExtractionLaunch";

/**
 * The §11 pre-run confirmation, as a screen (policy §21, slice B4).
 *
 * Three things the server insists on, made visible before the request rather
 * than after it:
 *
 *   * only an approved (model, promptVersion) pair may run, so an account
 *     with none is told that instead of being given a button (§12.4);
 *   * one run per account, so an open run replaces the start control with a
 *     link to it rather than producing a 409 (§3);
 *   * the credits the user agrees to are the credits shown, so changing the
 *     selection invalidates the estimate here — the server would answer 409
 *     MEMORY_ESTIMATE_CHANGED, and a stale number on screen is the bug that
 *     error exists to catch.
 *
 * The policy itself is in lib/memoryExtractionLaunch.ts and is tested without
 * a browser; this file is the wiring.
 */

const PAGE_SIZE = 50;

const sectionClass =
    "rounded-2xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950/60";

const primaryButtonClass =
    "inline-flex items-center justify-center gap-2 rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60";

const secondaryButtonClass =
    "inline-flex items-center justify-center gap-2 rounded-xl border border-zinc-200 bg-white px-4 py-2.5 text-sm font-semibold text-zinc-700 transition-colors hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-60 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800";

const smallButtonClass =
    "inline-flex items-center justify-center gap-1.5 rounded-lg border border-zinc-200 bg-white px-2.5 py-1.5 text-xs font-semibold text-zinc-700 transition-colors hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-60 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800";

type ConversationRow = {
    id: string;
    provider: string;
    title: string;
    messageCount: number;
    contentBytes: number;
};

type PairsState =
    | { kind: "loading" }
    | { kind: "ready"; pairs: ExtractionPairChoice[] }
    | { kind: "unavailable" };

type ListState =
    | { kind: "loading" }
    | { kind: "ready"; rows: ConversationRow[]; total: number }
    | { kind: "unavailable" };

type PairRow = ExtractionPairChoice & {
    modelName: string;
    creditsPerChunk: number;
};

type RunSummary = {
    id: string;
    status: string;
    chunkTotal: number;
    chunkCompleted: number;
    createdAt: string;
};

type LaunchError =
    | "generic"
    | "estimate_changed"
    | "pair_unavailable"
    | "budget";

const errorKey = (error: LaunchError) =>
    error === "estimate_changed"
        ? "memoryExtraction.errorEstimateChanged"
        : error === "pair_unavailable"
          ? "memoryExtraction.errorPairUnavailable"
          : error === "budget"
            ? "memoryExtraction.errorBudget"
            : "memoryExtraction.errorGeneric";

const failureToError = (status: number, code: string | null): LaunchError => {
    if (code === "MEMORY_ESTIMATE_CHANGED") return "estimate_changed";
    if (code === "MEMORY_EXTRACTION_PAIR_UNAVAILABLE") return "pair_unavailable";
    if (status === 503) return "budget";
    return "generic";
};

export function MemoryExtractionLauncher() {
    const { t } = useLanguage();
    const router = useRouter();

    const [pairsState, setPairsState] = useState<PairsState>({ kind: "loading" });
    const [pairRows, setPairRows] = useState<PairRow[]>([]);
    const [selectedPairKey, setSelectedPairKey] = useState<string>("");
    const [listState, setListState] = useState<ListState>({ kind: "loading" });
    const [loadingMore, setLoadingMore] = useState(false);
    const [selectedIds, setSelectedIds] = useState<string[]>([]);
    const [activeRunId, setActiveRunId] = useState<string | null>(null);
    const [recentRuns, setRecentRuns] = useState<RunSummary[]>([]);
    const [estimate, setEstimate] = useState<LaunchEstimate | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<LaunchError | null>(null);

    useEffect(() => {
        let cancelled = false;
        void (async () => {
            try {
                const response = await fetch("/api/memories/extraction-models", {
                    cache: "no-store",
                });
                if (cancelled) return;
                if (!response.ok) {
                    setPairsState({ kind: "unavailable" });
                    return;
                }
                const body = (await response.json()) as { pairs: PairRow[] };
                if (cancelled) return;
                setPairRows(body.pairs);
                setPairsState({ kind: "ready", pairs: body.pairs });
                setSelectedPairKey(
                    body.pairs.length > 0 ? pairSignature(body.pairs[0]) : ""
                );
            } catch {
                if (!cancelled) setPairsState({ kind: "unavailable" });
            }
        })();
        return () => {
            cancelled = true;
        };
    }, []);

    useEffect(() => {
        let cancelled = false;
        void (async () => {
            try {
                const response = await fetch("/api/memories/extraction-runs", {
                    cache: "no-store",
                });
                if (cancelled || !response.ok) return;
                const body = (await response.json()) as {
                    activeRunId: string | null;
                    runs?: RunSummary[];
                };
                if (cancelled) return;
                setActiveRunId(body.activeRunId);
                setRecentRuns(body.runs ?? []);
            } catch {
                // An unknown active run only costs a 409 on start, which the
                // error line already explains.
            }
        })();
        return () => {
            cancelled = true;
        };
    }, []);

    const loadConversations = useCallback(async (offset: number) => {
        try {
            const response = await fetch(
                `/api/external-conversations?offset=${offset}&limit=${PAGE_SIZE}`,
                { cache: "no-store" }
            );
            if (!response.ok) {
                setListState((current) =>
                    current.kind === "ready"
                        ? current
                        : { kind: "unavailable" }
                );
                return;
            }
            const body = (await response.json()) as {
                total: number;
                conversations: ConversationRow[];
            };
            setListState((current) => ({
                kind: "ready",
                total: body.total,
                rows:
                    offset === 0 || current.kind !== "ready"
                        ? body.conversations
                        : [...current.rows, ...body.conversations],
            }));
        } catch {
            setListState((current) =>
                current.kind === "ready" ? current : { kind: "unavailable" }
            );
        }
    }, []);

    useEffect(() => {
        queueMicrotask(() => {
            void loadConversations(0);
        });
    }, [loadConversations]);

    const selectedPair = useMemo(
        () =>
            pairRows.find((pair) => pairSignature(pair) === selectedPairKey) ??
            null,
        [pairRows, selectedPairKey]
    );

    const rows = useMemo(
        () => (listState.kind === "ready" ? listState.rows : []),
        [listState]
    );
    const summary = useMemo(
        () => summarizeSelection(rows, selectedIds),
        [rows, selectedIds]
    );

    const launchInput = {
        featureEnabled: pairsState.kind !== "unavailable",
        availablePairs: pairRows,
        selectedPair,
        selectedConversationIds: selectedIds,
        activeRunId,
        busy,
    };
    const canEstimate = estimateGate(launchInput);
    const canStart = startGate({ ...launchInput, estimate });

    // Changing either input does not clear the estimate: the stale figure stays
    // on screen with a "check again" line, because silently blanking the number
    // the user was reading is how a re-price goes unnoticed.
    const estimateStale =
        !canStart.allow && canStart.reason === "estimate_stale";

    const toggle = (id: string) => {
        setSelectedIds((current) =>
            current.includes(id)
                ? current.filter((candidate) => candidate !== id)
                : [...current, id]
        );
        setError(null);
    };

    const runEstimate = async () => {
        if (!canEstimate.allow || !selectedPair) return;
        setBusy(true);
        setError(null);
        try {
            const response = await fetch("/api/memories/extraction-runs", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    extractionModelId: selectedPair.extractionModelId,
                    promptVersion: selectedPair.promptVersion,
                    selectedConversationIds: selectedIds,
                    estimateOnly: true,
                }),
            });
            const body = (await response.json().catch(() => null)) as {
                chunkCount?: number;
                estimatedCredits?: number;
                conversationCount?: number;
                code?: string;
            } | null;
            if (!response.ok || !body || body.chunkCount === undefined) {
                setError(failureToError(response.status, body?.code ?? null));
                return;
            }
            setEstimate({
                selection: selectionSignature(selectedIds),
                pair: pairSignature(selectedPair),
                chunkCount: body.chunkCount,
                conversationCount: body.conversationCount ?? selectedIds.length,
                estimatedCredits: body.estimatedCredits ?? 0,
            });
        } catch {
            setError("generic");
        } finally {
            setBusy(false);
        }
    };

    const startRun = async () => {
        if (!canStart.allow || !selectedPair) return;
        setBusy(true);
        setError(null);
        try {
            const response = await fetch("/api/memories/extraction-runs", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    extractionModelId: selectedPair.extractionModelId,
                    promptVersion: selectedPair.promptVersion,
                    selectedConversationIds: selectedIds,
                    confirmedCredits: canStart.credits,
                }),
            });
            const body = (await response.json().catch(() => null)) as {
                runId?: string;
                code?: string;
            } | null;
            if (response.status === 409 && body?.code === "MEMORY_EXTRACTION_ALREADY_RUNNING") {
                // Someone else's tab won the race. Re-read rather than guess.
                const runs = await fetch("/api/memories/extraction-runs", {
                    cache: "no-store",
                })
                    .then((result) => (result.ok ? result.json() : null))
                    .catch(() => null);
                setActiveRunId(
                    (runs as { activeRunId?: string } | null)?.activeRunId ?? null
                );
                return;
            }
            if (!response.ok || !body?.runId) {
                setError(failureToError(response.status, body?.code ?? null));
                if (body?.code === "MEMORY_ESTIMATE_CHANGED") setEstimate(null);
                return;
            }
            router.push(`/settings/memory/runs/${body.runId}`);
        } catch {
            setError("generic");
        } finally {
            setBusy(false);
        }
    };

    if (pairsState.kind === "loading") {
        return (
            <section className={sectionClass} data-testid="memory-extraction-launcher">
                <Loader2 className="h-4 w-4 animate-spin text-zinc-400" />
            </section>
        );
    }
    if (pairsState.kind === "unavailable") {
        // The memory rollout flag is off. The review page already explains
        // that; a second notice here would only repeat it.
        return null;
    }

    const noPair = pairRows.length === 0;

    return (
        <section className={sectionClass} data-testid="memory-extraction-launcher">
            <h2 className="text-base font-semibold">
                {t("memoryExtraction.launchTitle")}
            </h2>
            <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
                {t("memoryExtraction.launchDescription")}
            </p>

            {noPair ? (
                <div
                    className="mt-4 rounded-xl border border-zinc-200 bg-zinc-50 p-3 text-sm dark:border-zinc-800 dark:bg-zinc-900/60"
                    data-testid="memory-extraction-no-pair"
                >
                    <p className="font-semibold">
                        {t("memoryExtraction.modelUnavailable")}
                    </p>
                    <p className="mt-1 text-zinc-600 dark:text-zinc-400">
                        {t("memoryExtraction.modelUnavailableDescription")}
                    </p>
                </div>
            ) : activeRunId ? (
                <div
                    className="mt-4 flex flex-wrap items-center gap-3 rounded-xl border border-zinc-200 bg-zinc-50 p-3 text-sm dark:border-zinc-800 dark:bg-zinc-900/60"
                    data-testid="memory-extraction-active-run"
                >
                    <span>{t("memoryExtraction.runInProgress")}</span>
                    <Link
                        href={`/settings/memory/runs/${activeRunId}`}
                        className={smallButtonClass}
                        data-testid="memory-extraction-active-run-link"
                    >
                        {t("memoryExtraction.runInProgressOpen")}
                    </Link>
                </div>
            ) : (
                <>
                    <fieldset className="mt-4">
                        <legend className="text-sm font-semibold">
                            {t("memoryExtraction.modelTitle")}
                        </legend>
                        <div className="mt-2 space-y-2">
                            {pairRows.map((pair) => {
                                const key = pairSignature(pair);
                                return (
                                    <label
                                        key={key}
                                        className="flex items-center gap-2 text-sm"
                                        data-testid="memory-extraction-model-option"
                                    >
                                        <input
                                            type="radio"
                                            name="memory-extraction-model"
                                            value={key}
                                            checked={selectedPairKey === key}
                                            onChange={() => {
                                                setSelectedPairKey(key);
                                                setError(null);
                                            }}
                                        />
                                        <span className="font-medium">
                                            {pair.modelName}
                                        </span>
                                        <span className="text-zinc-500 dark:text-zinc-400">
                                            {interpolate(
                                                t("memoryExtraction.modelCredits"),
                                                { credits: pair.creditsPerChunk }
                                            )}
                                        </span>
                                    </label>
                                );
                            })}
                        </div>
                    </fieldset>

                    <div className="mt-4">
                        <h3 className="text-sm font-semibold">
                            {t("memoryExtraction.conversationsTitle")}
                        </h3>
                        <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
                            {t("memoryExtraction.conversationsDescription")}
                        </p>

                        {listState.kind === "loading" ? (
                            <Loader2 className="mt-3 h-4 w-4 animate-spin text-zinc-400" />
                        ) : rows.length === 0 ? (
                            <div
                                className="mt-3 text-sm text-zinc-600 dark:text-zinc-400"
                                data-testid="memory-extraction-conversations-empty"
                            >
                                <p>{t("memoryExtraction.conversationsEmpty")}</p>
                                <Link
                                    href="/settings/imports/new"
                                    className={`${smallButtonClass} mt-2`}
                                >
                                    {t("memoryExtraction.conversationsEmptyCta")}
                                </Link>
                            </div>
                        ) : (
                            <>
                                <div className="mt-3 flex flex-wrap gap-2">
                                    <button
                                        type="button"
                                        className={smallButtonClass}
                                        data-testid="memory-extraction-select-visible"
                                        onClick={() => {
                                            setSelectedIds((current) => [
                                                ...new Set([
                                                    ...current,
                                                    ...rows.map((row) => row.id),
                                                ]),
                                            ]);
                                            setError(null);
                                        }}
                                    >
                                        {t("memoryExtraction.selectAllVisible")}
                                    </button>
                                    <button
                                        type="button"
                                        className={smallButtonClass}
                                        data-testid="memory-extraction-clear-selection"
                                        onClick={() => {
                                            setSelectedIds([]);
                                            setError(null);
                                        }}
                                    >
                                        {t("memoryExtraction.clearSelection")}
                                    </button>
                                </div>

                                <ul className="mt-3 max-h-80 space-y-1 overflow-y-auto">
                                    {rows.map((row) => (
                                        <li key={row.id}>
                                            <label
                                                className="flex items-start gap-2 rounded-lg px-2 py-1.5 text-sm hover:bg-zinc-50 dark:hover:bg-zinc-900"
                                                data-testid="memory-extraction-conversation-row"
                                            >
                                                <input
                                                    type="checkbox"
                                                    className="mt-1"
                                                    checked={selectedIds.includes(
                                                        row.id
                                                    )}
                                                    onChange={() => toggle(row.id)}
                                                />
                                                <span className="min-w-0">
                                                    <span className="block truncate font-medium">
                                                        {row.title}
                                                    </span>
                                                    <span className="block text-xs text-zinc-500 dark:text-zinc-400">
                                                        {providerLabel(row.provider)}
                                                        {" · "}
                                                        {interpolate(
                                                            t(
                                                                "memoryExtraction.conversationMeta"
                                                            ),
                                                            {
                                                                messages:
                                                                    row.messageCount,
                                                                size: formatBytes(
                                                                    row.contentBytes
                                                                ),
                                                            }
                                                        )}
                                                    </span>
                                                </span>
                                            </label>
                                        </li>
                                    ))}
                                </ul>

                                {listState.kind === "ready" &&
                                rows.length < listState.total ? (
                                    <button
                                        type="button"
                                        className={`${smallButtonClass} mt-2`}
                                        data-testid="memory-extraction-load-more"
                                        disabled={loadingMore}
                                        onClick={async () => {
                                            setLoadingMore(true);
                                            await loadConversations(rows.length);
                                            setLoadingMore(false);
                                        }}
                                    >
                                        {t("memoryExtraction.loadMore")}
                                    </button>
                                ) : null}

                                <p
                                    className="mt-3 text-sm font-medium"
                                    data-testid="memory-extraction-selection-summary"
                                >
                                    {interpolate(
                                        t("memoryExtraction.selectionSummary"),
                                        {
                                            count: summary.count,
                                            size: formatBytes(summary.contentBytes),
                                        }
                                    )}
                                </p>
                                {summary.hiddenCount > 0 ? (
                                    <p
                                        className="text-xs text-zinc-500 dark:text-zinc-400"
                                        data-testid="memory-extraction-selection-hidden"
                                    >
                                        {interpolate(
                                            t("memoryExtraction.selectionHidden"),
                                            { count: summary.hiddenCount }
                                        )}
                                    </p>
                                ) : null}
                                {!canEstimate.allow &&
                                canEstimate.reason === "selection_too_large" ? (
                                    <p
                                        className="text-xs font-semibold text-red-600 dark:text-red-400"
                                        data-testid="memory-extraction-selection-too-large"
                                    >
                                        {interpolate(
                                            t("memoryExtraction.selectionTooLarge"),
                                            {
                                                max: MEMORY_EXTRACTION_MAX_SELECTION,
                                            }
                                        )}
                                    </p>
                                ) : null}
                            </>
                        )}
                    </div>

                    <div className="mt-4 flex flex-wrap items-center gap-2">
                        <button
                            type="button"
                            className={secondaryButtonClass}
                            data-testid="memory-extraction-estimate"
                            disabled={!canEstimate.allow}
                            onClick={() => void runEstimate()}
                        >
                            {busy && !estimate ? (
                                <Loader2 className="h-4 w-4 animate-spin" />
                            ) : null}
                            {t("memoryExtraction.estimate")}
                        </button>
                        {estimate ? (
                            <button
                                type="button"
                                className={primaryButtonClass}
                                data-testid="memory-extraction-start"
                                disabled={!canStart.allow}
                                onClick={() => void startRun()}
                            >
                                {busy ? (
                                    <Loader2 className="h-4 w-4 animate-spin" />
                                ) : (
                                    <Sparkles className="h-4 w-4" />
                                )}
                                {interpolate(t("memoryExtraction.start"), {
                                    credits: estimate.estimatedCredits,
                                })}
                            </button>
                        ) : null}
                    </div>

                    {estimate ? (
                        <div
                            className="mt-3 rounded-xl border border-zinc-200 bg-zinc-50 p-3 text-sm dark:border-zinc-800 dark:bg-zinc-900/60"
                            data-testid="memory-extraction-estimate-result"
                        >
                            <p className="font-semibold">
                                {interpolate(
                                    t("memoryExtraction.estimateResult"),
                                    {
                                        chunks: estimate.chunkCount,
                                        credits: estimate.estimatedCredits,
                                    }
                                )}
                            </p>
                            <p className="mt-1 text-zinc-600 dark:text-zinc-400">
                                {interpolate(
                                    t("memoryExtraction.estimateDescription"),
                                    {
                                        conversations: estimate.conversationCount,
                                        chunks: estimate.chunkCount,
                                    }
                                )}
                            </p>
                            {estimateStale ? (
                                <p
                                    className="mt-1 font-semibold text-amber-700 dark:text-amber-400"
                                    data-testid="memory-extraction-estimate-stale"
                                >
                                    {t("memoryExtraction.estimateStale")}
                                </p>
                            ) : null}
                        </div>
                    ) : null}

                    {error ? (
                        <p
                            className="mt-3 text-sm font-semibold text-red-600 dark:text-red-400"
                            data-testid="memory-extraction-error"
                        >
                            {t(errorKey(error))}
                        </p>
                    ) : null}
                </>
            )}

            {/* A finished run's page is otherwise unreachable: the launcher
                only links the open one, and the review queue links memories
                rather than the run that produced them. */}
            {recentRuns.length > 0 ? (
                <div className="mt-5" data-testid="memory-extraction-recent-runs">
                    <h3 className="text-sm font-semibold">
                        {t("memoryExtraction.recentRunsTitle")}
                    </h3>
                    <ul className="mt-2 space-y-1">
                        {recentRuns.map((run) => (
                            <li
                                key={run.id}
                                className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm"
                                data-testid="memory-extraction-recent-run"
                            >
                                <span className="font-medium">
                                    {t(
                                        `memoryExtraction.status.${runProgress(run).status}`
                                    )}
                                </span>
                                <span className="text-xs text-zinc-500 dark:text-zinc-400">
                                    {interpolate(
                                        t("memoryExtraction.runProgress"),
                                        {
                                            completed: run.chunkCompleted,
                                            total: run.chunkTotal,
                                        }
                                    )}
                                </span>
                                <span className="text-xs text-zinc-500 dark:text-zinc-400">
                                    {new Date(run.createdAt).toLocaleDateString()}
                                </span>
                                <Link
                                    href={`/settings/memory/runs/${run.id}`}
                                    className="text-xs font-semibold text-blue-600 hover:underline dark:text-blue-400"
                                >
                                    {t("memoryExtraction.recentRunOpen")}
                                </Link>
                            </li>
                        ))}
                    </ul>
                </div>
            ) : null}
        </section>
    );
}
