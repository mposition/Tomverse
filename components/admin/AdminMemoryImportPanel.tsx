"use client";

import { useCallback, useEffect, useState } from "react";
import { Brain, Loader2, RefreshCw } from "lucide-react";

import { useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import { adminMemoryImportMessages } from "@/lib/adminMessages/memoryImport";
import { discardResponseBody } from "@/lib/discardResponseBody";

/**
 * The reader for the import and memory observability APIs (§22).
 *
 * Both reports have existed without one: `/api/admin/external-imports` since
 * Release A and `/api/admin/memory` since the memory metrics landed. A metric
 * nobody reads is not a metric, so this panel is the other half of both.
 *
 * Two things it deliberately renders rather than hides:
 *
 *   * the `unavailable` list — a metric with no source is shown as unmeasured,
 *     with its reason, because a zero and "nothing measures this" look
 *     identical on a dashboard and mean opposite things;
 *   * `null` rates as an em dash rather than 0%, for the same reason.
 *
 * Everything here is a count, a rate or a closed enum label. Neither endpoint
 * can return content — that is enforced at their query layers, not here.
 */

type Unavailable = ReadonlyArray<{ metric: string; reason: string }>;

type MemoryReport = {
    windowDays: number;
    memoriesUnavailable: boolean;
    runsUnavailable: boolean;
    truncated: boolean;
    memories: {
        total: number;
        byStatus: Record<string, number>;
        approvalRate: number | null;
        rejectionRate: number | null;
        editedRate: number | null;
        sensitiveRate: number | null;
        userAuthored: number;
    };
    runs: {
        total: number;
        byStatus: Record<string, number>;
        byPair: Array<{
            extractionModelId: string;
            promptVersion: string;
            runs: number;
            completed: number;
            failed: number;
            cancelled: number;
            failureRate: number | null;
        }>;
    };
    /**
     * Optional because a reader must survive a report that does not carry it.
     * This section arrived after the endpoint shipped, and reading it
     * unconditionally turned a missing object into a TypeError during render —
     * which the error boundary answers by replacing the entire Admin Console
     * with "Something went wrong". A monitoring surface is what somebody opens
     * when something is already wrong; it does not get to be the second thing
     * that breaks.
     */
    followupProxy?: {
        memory: FollowupArm;
        plain: FollowupArm;
        followupDifference: number | null;
        regenerateDifference: number | null;
    };
    counters: Record<string, number>;
    unavailable: Unavailable;
};

type FollowupArm = {
    answers: number;
    followups: number;
    regenerates: number;
    followupRate: number | null;
    regenerateRate: number | null;
};

type ImportReport = {
    windowDays?: number;
    [key: string]: unknown;
};

/** Null means "no denominator", which is not the same as zero. */
const rate = (value: number | null | undefined) =>
    value === null || value === undefined
        ? "—"
        : `${Math.round(value * 1000) / 10}%`;

const readable = (key: string) => key.replaceAll("_", " ");

function Stat({
    label,
    value,
    detail,
}: {
    label: string;
    value: string;
    detail?: string;
}) {
    return (
        <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-3">
            <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-zinc-500">
                {label}
            </p>
            <p className="mt-1 text-lg font-black text-white">{value}</p>
            {detail && <p className="mt-1 text-xs leading-5 text-zinc-500">{detail}</p>}
        </div>
    );
}

function CountList({
    title,
    counts,
    testId,
}: {
    title: string;
    counts: Record<string, number>;
    testId: string;
}) {
    const m = useAdminMessages(adminMemoryImportMessages);
    const entries = Object.entries(counts).sort(([left], [right]) =>
        left < right ? -1 : 1
    );
    return (
        <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-3">
            <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-zinc-500">
                {title}
            </p>
            {entries.length === 0 ? (
                <p className="mt-2 text-sm text-zinc-500">{m.noneInWindow}</p>
            ) : (
                <ul className="mt-2 space-y-1" data-testid={testId}>
                    {entries.map(([key, value]) => (
                        <li
                            key={key}
                            className="flex items-baseline justify-between gap-3 text-sm"
                        >
                            <span className="text-zinc-400">{readable(key)}</span>
                            <span className="font-bold text-white">{value}</span>
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
}

export function AdminMemoryImportPanel() {
    const m = useAdminMessages(adminMemoryImportMessages);
    const loadFailed = m.loadFailed;
    const [memory, setMemory] = useState<MemoryReport | null>(null);
    const [imports, setImports] = useState<ImportReport | null>(null);
    const [error, setError] = useState<string | null>(null);
    // Starts true: the mount effect loads immediately, and writing it there
    // synchronously would be a set-state-in-effect violation.
    const [isLoading, setIsLoading] = useState(true);

    const load = useCallback(async () => {
        try {
            const [memoryResponse, importResponse] = await Promise.all([
                fetch("/api/admin/memory", { cache: "no-store" }),
                fetch("/api/admin/external-imports", { cache: "no-store" }),
            ]);
            setError(null);
            // The import report is secondary: its absence must not blank the
            // memory half, so it is read but never throws. It is read *first*
            // because the memory branch below throws: leaving this body unread
            // on that path holds the request open for the life of the page
            // (see lib/apiCacheControlPolicy.ts), and a refused import report
            // did the same on its own.
            let importData: ImportReport | null = null;
            if (importResponse.ok) {
                importData = (await importResponse
                    .json()
                    .catch(() => null)) as ImportReport;
            } else {
                await discardResponseBody(importResponse);
            }
            const memoryData = (await memoryResponse.json().catch(() => null)) as
                | MemoryReport
                | { error?: string }
                | null;
            if (!memoryResponse.ok || !memoryData || "error" in memoryData) {
                throw new Error(
                    (memoryData && "error" in memoryData && memoryData.error) ||
                        loadFailed
                );
            }
            setMemory(memoryData as MemoryReport);
            setImports(importData);
        } catch (loadError) {
            setError(
                loadError instanceof Error
                    ? loadError.message
                    : loadFailed
            );
        } finally {
            setIsLoading(false);
        }
    }, [loadFailed]);

    useEffect(() => {
        // Deferred a tick so no state write is synchronous within the effect.
        queueMicrotask(() => void load());
    }, [load]);

    return (
        <section
            data-testid="admin-memory-import-panel"
            className="overflow-hidden rounded-3xl border border-zinc-800 bg-zinc-950/80 shadow-2xl shadow-black/20"
        >
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-800 bg-zinc-900/60 p-5">
                <div>
                    <div className="inline-flex items-center gap-2 rounded-full border border-teal-500/30 bg-teal-500/10 px-3 py-1 text-xs font-semibold uppercase tracking-[0.18em] text-teal-200">
                        <Brain className="h-3.5 w-3.5" />
                        {m.eyebrow}
                    </div>
                    <h2 className="mt-3 text-2xl font-black text-white">
                        {m.title}
                    </h2>
                    <p className="mt-2 max-w-3xl text-sm leading-6 text-zinc-400">
                        {m.description}
                    </p>
                </div>
                <button
                    type="button"
                    onClick={() => {
                        setIsLoading(true);
                        void load();
                    }}
                    disabled={isLoading}
                    className="inline-flex items-center gap-2 rounded-xl border border-zinc-700 px-4 py-2 text-sm font-bold text-zinc-200 hover:bg-zinc-900 disabled:cursor-not-allowed disabled:opacity-60"
                >
                    {isLoading ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                        <RefreshCw className="h-4 w-4" />
                    )}
                    {m.refresh}
                </button>
            </div>

            {error && (
                <p
                    className="border-b border-red-900/50 bg-red-950/30 px-5 py-3 text-sm font-semibold text-red-300"
                    data-testid="admin-memory-error"
                >
                    {error}
                </p>
            )}

            {memory && (
                <div className="grid gap-5 p-5">
                    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                        <Stat
                            label={m.memories}
                            value={String(memory.memories.total)}
                            detail={m.memoriesDetail(memory.memories.userAuthored, memory.windowDays)}
                        />
                        <Stat
                            label={m.approvedOfDecided}
                            value={rate(memory.memories.approvalRate)}
                            detail={m.approvedDetail(rate(memory.memories.rejectionRate), rate(memory.memories.editedRate))}
                        />
                        <Stat
                            label={m.sensitiveShare}
                            value={rate(memory.memories.sensitiveRate)}
                            detail={m.sensitiveDetail}
                        />
                        <Stat
                            label={m.extractionRuns}
                            value={String(memory.runs.total)}
                            detail={
                                memory.runs.byPair.length === 0
                                    ? m.noPairRun
                                    : m.pairCount(memory.runs.byPair.length)
                            }
                        />
                    </div>

                    <div className="grid gap-3 md:grid-cols-3">
                        <CountList
                            title={m.memoriesByStatus}
                            counts={memory.memories.byStatus}
                            testId="admin-memory-status-list"
                        />
                        <CountList
                            title={m.runsByStatus}
                            counts={memory.runs.byStatus}
                            testId="admin-memory-run-status-list"
                        />
                        <CountList
                            title={m.counters}
                            counts={memory.counters}
                            testId="admin-memory-counter-list"
                        />
                    </div>

                    <section
                        className="rounded-xl border border-zinc-800 p-4"
                        data-testid="admin-memory-followup-proxy"
                    >
                        <h3 className="text-sm font-semibold text-zinc-200">
                            {m.followupTitle}
                        </h3>
                        {/* §22 requires this to be labelled as a proxy where
                            it is read, not only where it is computed. A
                            follow-up is not a complaint — people ask second
                            questions because the first answer was good. Only
                            the difference between the arms carries a signal,
                            and even that is indirect. */}
                        <p className="mt-1 text-xs leading-5 text-zinc-500">
                            {m.followupNote}
                        </p>
                        {memory.followupProxy ? (
                            <div className="mt-3 grid gap-3 md:grid-cols-2">
                                <Stat
                                    label={m.followupWithin}
                                    value={m.versus(rate(memory.followupProxy.memory.followupRate), rate(memory.followupProxy.plain.followupRate))}
                                    detail={m.followupDetail(memory.followupProxy.memory.answers, memory.followupProxy.plain.answers, rate(memory.followupProxy.followupDifference))}
                                />
                                <Stat
                                    label={m.regenerateWithin}
                                    value={m.versus(rate(memory.followupProxy.memory.regenerateRate), rate(memory.followupProxy.plain.regenerateRate))}
                                    detail={m.regenerateDetail(rate(memory.followupProxy.regenerateDifference))}
                                />
                            </div>
                        ) : (
                            /* Named as absent rather than drawn as zero — the
                               same rule §22 states for every other metric this
                               panel cannot supply. Two arms of "0% vs 0%" would
                               read as a measured result showing no difference,
                               which is the one conclusion the data does not
                               support. */
                            <p
                                className="mt-3 text-xs leading-5 text-amber-300"
                                data-testid="admin-memory-followup-proxy-unavailable"
                            >
                                {m.followupUnavailable}
                            </p>
                        )}
                    </section>

                    {memory.runs.byPair.length > 0 && (
                        <div className="overflow-x-auto rounded-xl border border-zinc-800">
                            <table className="w-full min-w-[36rem] text-left text-sm">
                                <thead className="bg-zinc-900/60 text-[11px] uppercase tracking-[0.14em] text-zinc-500">
                                    <tr>
                                        <th className="px-3 py-2">{m.pair}</th>
                                        <th className="px-3 py-2">{m.runs}</th>
                                        <th className="px-3 py-2">{m.completed}</th>
                                        <th className="px-3 py-2">{m.failed}</th>
                                        <th className="px-3 py-2">{m.cancelled}</th>
                                        <th className="px-3 py-2">{m.failureRate}</th>
                                    </tr>
                                </thead>
                                <tbody data-testid="admin-memory-pair-rows">
                                    {memory.runs.byPair.map((pair) => (
                                        <tr
                                            key={`${pair.extractionModelId}:${pair.promptVersion}`}
                                            className="border-t border-zinc-800"
                                        >
                                            <td className="px-3 py-2 font-mono text-xs text-zinc-300">
                                                {pair.extractionModelId} ·{" "}
                                                {pair.promptVersion}
                                            </td>
                                            <td className="px-3 py-2 text-white">
                                                {pair.runs}
                                            </td>
                                            <td className="px-3 py-2 text-zinc-300">
                                                {pair.completed}
                                            </td>
                                            <td className="px-3 py-2 text-zinc-300">
                                                {pair.failed}
                                            </td>
                                            <td className="px-3 py-2 text-zinc-300">
                                                {pair.cancelled}
                                            </td>
                                            <td className="px-3 py-2 font-bold text-white">
                                                {rate(pair.failureRate)}
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    )}

                    <div
                        className="rounded-xl border border-amber-900/40 bg-amber-950/20 p-3"
                        data-testid="admin-memory-unavailable"
                    >
                        <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-amber-300/80">
                            {m.notMeasuredTitle}
                        </p>
                        <p className="mt-1 text-xs leading-5 text-amber-200/70">
                            {m.notMeasuredNote}
                        </p>
                        <ul className="mt-2 space-y-1 text-xs leading-5">
                            {memory.unavailable.map((entry) => (
                                <li key={entry.metric} className="text-zinc-400">
                                    <span className="font-semibold text-zinc-200">
                                        {readable(entry.metric)}
                                    </span>{" "}
                                    — {entry.reason}
                                </li>
                            ))}
                        </ul>
                    </div>

                    {(memory.truncated ||
                        memory.memoriesUnavailable ||
                        memory.runsUnavailable) && (
                        <p
                            className="text-xs font-semibold text-amber-300"
                            data-testid="admin-memory-caveat"
                        >
                            {memory.truncated
                                ? m.truncated
                                : m.notMigrated}
                        </p>
                    )}

                    {imports === null && (
                        <p className="text-xs text-zinc-500" data-testid="admin-import-missing">
                            {m.importMissing}
                        </p>
                    )}
                </div>
            )}
        </section>
    );
}
