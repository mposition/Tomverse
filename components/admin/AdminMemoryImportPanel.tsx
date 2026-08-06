"use client";

import { useCallback, useEffect, useState } from "react";
import { Brain, Loader2, RefreshCw } from "lucide-react";

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
    followupProxy: {
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
    const entries = Object.entries(counts).sort(([left], [right]) =>
        left < right ? -1 : 1
    );
    return (
        <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-3">
            <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-zinc-500">
                {title}
            </p>
            {entries.length === 0 ? (
                <p className="mt-2 text-sm text-zinc-500">None in this window.</p>
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
            const memoryData = (await memoryResponse.json().catch(() => null)) as
                | MemoryReport
                | { error?: string }
                | null;
            if (!memoryResponse.ok || !memoryData || "error" in memoryData) {
                throw new Error(
                    (memoryData && "error" in memoryData && memoryData.error) ||
                        "Failed to load the memory report."
                );
            }
            setMemory(memoryData as MemoryReport);
            // The import report is secondary: its absence must not blank the
            // memory half, so it is read but never throws.
            const importData = importResponse.ok
                ? ((await importResponse.json().catch(() => null)) as ImportReport)
                : null;
            setImports(importData);
        } catch (loadError) {
            setError(
                loadError instanceof Error
                    ? loadError.message
                    : "Failed to load the memory report."
            );
        } finally {
            setIsLoading(false);
        }
    }, []);

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
                        Import &amp; memory
                    </div>
                    <h2 className="mt-3 text-2xl font-black text-white">
                        Review outcomes and extraction runs
                    </h2>
                    <p className="mt-2 max-w-3xl text-sm leading-6 text-zinc-400">
                        Content-free counts and rates only (docs/policy/
                        external-conversation-import-and-memory.md §22). Statements,
                        evidence, titles and ids are excluded at the query layer, so
                        nothing here can carry them.
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
                    Refresh
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
                            label="Memories"
                            value={String(memory.memories.total)}
                            detail={`${memory.memories.userAuthored} written by hand · last ${memory.windowDays}d`}
                        />
                        <Stat
                            label="Approved of decided"
                            value={rate(memory.memories.approvalRate)}
                            detail={`rejected ${rate(memory.memories.rejectionRate)} · edited before approval ${rate(memory.memories.editedRate)}`}
                        />
                        <Stat
                            label="Sensitive share"
                            value={rate(memory.memories.sensitiveRate)}
                            detail="always excluded from bulk approval"
                        />
                        <Stat
                            label="Extraction runs"
                            value={String(memory.runs.total)}
                            detail={
                                memory.runs.byPair.length === 0
                                    ? "no approved pair has run yet"
                                    : `${memory.runs.byPair.length} pair(s)`
                            }
                        />
                    </div>

                    <div className="grid gap-3 md:grid-cols-3">
                        <CountList
                            title="Memories by status"
                            counts={memory.memories.byStatus}
                            testId="admin-memory-status-list"
                        />
                        <CountList
                            title="Runs by status"
                            counts={memory.runs.byStatus}
                            testId="admin-memory-run-status-list"
                        />
                        <CountList
                            title="Counters (window)"
                            counts={memory.counters}
                            testId="admin-memory-counter-list"
                        />
                    </div>

                    <section
                        className="rounded-xl border border-zinc-800 p-4"
                        data-testid="admin-memory-followup-proxy"
                    >
                        <h3 className="text-sm font-semibold text-zinc-200">
                            Follow-up and regenerate proxy
                        </h3>
                        {/* §22 requires this to be labelled as a proxy where
                            it is read, not only where it is computed. A
                            follow-up is not a complaint — people ask second
                            questions because the first answer was good. Only
                            the difference between the arms carries a signal,
                            and even that is indirect. */}
                        <p className="mt-1 text-xs leading-5 text-zinc-500">
                            A proxy, not a measurement of answer quality. A
                            follow-up often means the answer was useful. Read
                            the difference between the two arms, never either
                            rate on its own, and never as a re-ask rate.
                        </p>
                        <div className="mt-3 grid gap-3 md:grid-cols-2">
                            <Stat
                                label="Follow-up within 120s"
                                value={`${rate(memory.followupProxy.memory.followupRate)} vs ${rate(memory.followupProxy.plain.followupRate)}`}
                                detail={`memory-shaped (${memory.followupProxy.memory.answers}) vs other answers (${memory.followupProxy.plain.answers}) · difference ${rate(memory.followupProxy.followupDifference)}`}
                            />
                            <Stat
                                label="Regenerate within 120s"
                                value={`${rate(memory.followupProxy.memory.regenerateRate)} vs ${rate(memory.followupProxy.plain.regenerateRate)}`}
                                detail={`difference ${rate(memory.followupProxy.regenerateDifference)}`}
                            />
                        </div>
                    </section>

                    {memory.runs.byPair.length > 0 && (
                        <div className="overflow-x-auto rounded-xl border border-zinc-800">
                            <table className="w-full min-w-[36rem] text-left text-sm">
                                <thead className="bg-zinc-900/60 text-[11px] uppercase tracking-[0.14em] text-zinc-500">
                                    <tr>
                                        <th className="px-3 py-2">Pair</th>
                                        <th className="px-3 py-2">Runs</th>
                                        <th className="px-3 py-2">Completed</th>
                                        <th className="px-3 py-2">Failed</th>
                                        <th className="px-3 py-2">Cancelled</th>
                                        <th className="px-3 py-2">Failure rate</th>
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
                            Not measured yet
                        </p>
                        <p className="mt-1 text-xs leading-5 text-amber-200/70">
                            These §22 metrics have no source in this build. They are
                            listed rather than shown as zero, because a zero would read
                            as &ldquo;nothing is happening&rdquo;.
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
                                ? "The window hit the row cap; narrow it for exact figures."
                                : "Some memory tables are not migrated in this environment."}
                        </p>
                    )}

                    {imports === null && (
                        <p className="text-xs text-zinc-500" data-testid="admin-import-missing">
                            The import report is unavailable in this environment; the
                            memory figures above are unaffected.
                        </p>
                    )}
                </div>
            )}
        </section>
    );
}
