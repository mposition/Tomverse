"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, Lock, Sparkles } from "lucide-react";
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
    withoutLockedSelection,
    type ExtractionPairChoice,
    type LaunchEstimate,
} from "@/lib/memoryExtractionLaunch";
import { discardResponseBody } from "@/lib/discardResponseBody";
import { importedConversationTitle } from "@/components/imports/importedConversationTitle";

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
    /** `null` for a locked snapshot: the server does not send its title. */
    title: string | null;
    importedAt?: string;
    messageCount: number;
    contentBytes: number;
    /**
     * The server has always sent this; the row type used to drop it, which is
     * how a locked snapshot came to be selectable here. A locked snapshot
     * cannot be sent to a provider
     * (docs/policy/external-conversation-import-and-memory.md §7.1).
     */
    locked?: boolean;
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
    | "budget"
    | "locked";

const errorKey = (error: LaunchError) =>
    error === "estimate_changed"
        ? "memoryExtraction.errorEstimateChanged"
        : error === "pair_unavailable"
          ? "memoryExtraction.errorPairUnavailable"
          : error === "budget"
            ? "memoryExtraction.errorBudget"
            : error === "locked"
              ? "memoryExtraction.errorLocked"
              : "memoryExtraction.errorGeneric";

const failureToError = (status: number, code: string | null): LaunchError => {
    if (code === "MEMORY_ESTIMATE_CHANGED") return "estimate_changed";
    if (code === "MEMORY_EXTRACTION_PAIR_UNAVAILABLE") return "pair_unavailable";
    // The server's answer when a selected snapshot is locked -- the same 423
    // every other surface gives a locked snapshot
    // (docs/policy/external-conversation-import-and-memory.md §21). It reaches
    // here when the lock happened after the list loaded, or on a page the user
    // never scrolled to. Without its own branch it read as "something went
    // wrong, try again", and trying again gets the same answer.
    if (status === 423 || code === "CONVERSATION_LOCKED") return "locked";
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
                if (cancelled || !response.ok) {
                    await discardResponseBody(response);
                    if (cancelled) return;
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
                if (cancelled || !response.ok) {
                    await discardResponseBody(response);
                    return;
                }
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
                await discardResponseBody(response);
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
            // A row can be selected and then locked in another tab. Dropped
            // from the selection here rather than left checked behind a
            // disabled box, where it would be the one choice the user could
            // not undo.
            setSelectedIds((current) => {
                const kept = withoutLockedSelection(current, body.conversations);
                return kept === current ? current : [...kept];
            });
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

    const lockedConversationIds = useMemo(
        () => rows.filter((row) => row.locked).map((row) => row.id),
        [rows]
    );

    const launchInput = {
        featureEnabled: pairsState.kind !== "unavailable",
        availablePairs: pairRows,
        selectedPair,
        selectedConversationIds: selectedIds,
        activeRunId,
        busy,
        lockedConversationIds,
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
                    .then((result) =>
        result.ok ? result.json() : discardResponseBody(result).then(() => null)
      )
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
                                                    // "All visible" means all
                                                    // that can be chosen: a
                                                    // locked row is visible
                                                    // and cannot be.
                                                    ...rows
                                                        .filter((row) => !row.locked)
                                                        .map((row) => row.id),
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
                                    {rows.map((row) =>
                                        row.locked ? (
                                        /*
                                          A locked row is shown, not hidden:
                                          this is the user's own list of
                                          imports, and a row that vanished
                                          would be unexplained and would put
                                          the count out of step with the total.
                                          It is disabled rather than merely
                                          unselected, says why, and offers the
                                          way out -- a control that only
                                          refuses reads as broken.

                                          A `div` with sibling controls rather
                                          than the `label` the other rows use:
                                          a link inside a label is one
                                          interactive element inside another.
                                        */
                                        <li key={row.id}>
                                            <div
                                                className="flex items-start gap-2 rounded-lg px-2 py-1.5 text-sm"
                                                data-testid="memory-extraction-conversation-row"
                                                data-locked="true"
                                            >
                                                <input
                                                    type="checkbox"
                                                    className="mt-1"
                                                    checked={false}
                                                    disabled
                                                    aria-label={importedConversationTitle(row, t)}
                                                    aria-describedby={`memory-extraction-locked-${row.id}`}
                                                    readOnly
                                                />
                                                <span className="min-w-0 flex-1">
                                                    <span className="flex min-w-0 items-center gap-1.5">
                                                        <span className="truncate font-medium text-zinc-500 dark:text-zinc-400">
                                                            {importedConversationTitle(row, t)}
                                                        </span>
                                                        <span
                                                            className="inline-flex shrink-0 items-center gap-1 rounded-md bg-zinc-100 px-1.5 py-0.5 text-xs font-semibold text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300"
                                                            data-testid="memory-extraction-conversation-locked"
                                                        >
                                                            <Lock className="h-3 w-3" aria-hidden="true" />
                                                            {t("externalImport.lockedBadge")}
                                                        </span>
                                                    </span>
                                                    <span
                                                        id={`memory-extraction-locked-${row.id}`}
                                                        className="block text-xs text-zinc-500 dark:text-zinc-400"
                                                    >
                                                        {t("memoryExtraction.lockedRowHint")}
                                                    </span>
                                                </span>
                                                <Link
                                                    href={`/settings/imports/conversations/${encodeURIComponent(row.id)}`}
                                                    className={`${smallButtonClass} shrink-0`}
                                                    aria-label={interpolate(
                                                        t("externalImport.quickUnlockFor"),
                                                        { title: importedConversationTitle(row, t) }
                                                    )}
                                                    data-testid="memory-extraction-conversation-unlock"
                                                >
                                                    {t("externalImport.quickUnlock")}
                                                </Link>
                                            </div>
                                        </li>
                                        ) : (
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
                                                        {importedConversationTitle(row, t)}
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
                                        )
                                    )}
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
                                canEstimate.reason === "locked_selection" ? (
                                    // Normally unreachable -- a page that
                                    // arrives drops locked rows from the
                                    // selection -- but the gate can still say
                                    // it, and a gate that blocks silently is a
                                    // button that does nothing.
                                    <p
                                        className="text-xs font-semibold text-red-600 dark:text-red-400"
                                        data-testid="memory-extraction-selection-locked"
                                    >
                                        {t("memoryExtraction.errorLocked")}
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
