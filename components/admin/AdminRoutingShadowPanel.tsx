"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, RefreshCw, Route } from "lucide-react";
import { discardResponseBody } from "@/lib/discardResponseBody";

/**
 * The reader for `/api/admin/routing-shadow`.
 *
 * Shadow routing records what the Auto Router would have chosen beside the
 * model the user actually picked. This is where an operator sees it, and it
 * carries the same caveat the command-line report prints, in the place the
 * number is read rather than only where it is computed:
 *
 * **agreement is not a score.** ROUTE-01 grades the Router on a win-rate
 * against the fixed-model baseline. A Router that echoed the user would agree
 * every time and be worth nothing; one that is right where the user was wrong
 * shows up here as disagreement. What this measures is how much would change
 * if Auto were switched on.
 *
 * Three states it renders rather than smooths over:
 *
 *   * no runs at all — the flag is off, or nothing reached the recorder. Said
 *     plainly, because an empty dashboard reads as "nothing is wrong";
 *   * mixed rule versions — two Routers averaged into one rate describe
 *     neither, so the rates are shown under a warning rather than alone;
 *   * a null rate as an em dash rather than 0%, because zero is a claim and
 *     "nothing was compared" is not that claim.
 */

type GroupAgreement = {
    key: string;
    decided: number;
    agreed: number;
    agreementRate: number | null;
};

type ShadowReport = {
    windowDays: number;
    since: string;
    truncated: boolean;
    rows: number;
    decided: number;
    undecided: number;
    agreed: number;
    agreementRate: number | null;
    versions: {
        taskProfileVersions: string[];
        candidateFilterVersions: string[];
        selectionVersions: string[];
        selectionPolicyVersions: string[];
        mixed: boolean;
    };
    switches: Array<{ from: string; to: string; count: number }>;
    byTaskKind: GroupAgreement[];
    byPlan: GroupAgreement[];
    selectionReasons: Record<string, number>;
    rejectionReasons: Record<string, number>;
    decisionMicrosP50: number;
    decisionMicrosP95: number;
};

const num = (value: number) => value.toLocaleString("en-US");
const pct = (value: number | null) =>
    value === null ? "—" : `${(value * 100).toFixed(1)}%`;
const ms = (micros: number) => `${(micros / 1000).toFixed(1)}ms`;
const readable = (key: string) => key.replaceAll("_", " ");

const Stat = ({
    label,
    value,
    detail,
}: {
    label: string;
    value: string;
    detail?: string;
}) => (
    <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-3">
        <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-zinc-500">
            {label}
        </p>
        <p className="mt-1 text-lg font-black text-white">{value}</p>
        {detail && <p className="mt-1 text-xs leading-5 text-zinc-500">{detail}</p>}
    </div>
);

const CountList = ({
    label,
    counts,
    testId,
}: {
    label: string;
    counts: Record<string, number>;
    testId: string;
}) => {
    const entries = Object.entries(counts).sort((left, right) => right[1] - left[1]);
    return (
        <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-3">
            <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-zinc-500">
                {label}
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
                            <span className="font-bold text-white">{num(value)}</span>
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
};

const GroupTable = ({
    label,
    groups,
    testId,
}: {
    label: string;
    groups: GroupAgreement[];
    testId: string;
}) => (
    <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-3">
        <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-zinc-500">
            {label}
        </p>
        {groups.length === 0 ? (
            <p className="mt-2 text-sm text-zinc-500">Nothing decided yet.</p>
        ) : (
            <ul className="mt-2 space-y-1" data-testid={testId}>
                {groups.map((group) => (
                    <li
                        key={group.key}
                        className="flex items-baseline justify-between gap-3 text-sm"
                    >
                        <span className="text-zinc-400">{readable(group.key)}</span>
                        <span className="font-bold text-white">
                            {pct(group.agreementRate)}{" "}
                            <span className="font-normal text-zinc-500">
                                ({num(group.agreed)}/{num(group.decided)})
                            </span>
                        </span>
                    </li>
                ))}
            </ul>
        )}
    </div>
);

export function AdminRoutingShadowPanel() {
    const [report, setReport] = useState<ShadowReport | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    const load = useCallback(async () => {
        // `setLoading(true)` deliberately does not open this function: the
        // first call comes from an effect, and a synchronous state write there
        // is the cascading-render rule the console already follows in
        // AdminMemoryImportPanel. The initial state is already `true`, and a
        // refresh sets it inside the async body below.
        try {
            setLoading(true);
            setError(null);
            const response = await fetch("/api/admin/routing-shadow", {
                cache: "no-store",
            });
            if (!response.ok) {
                await discardResponseBody(response);
                throw new Error(String(response.status));
            }
            setReport((await response.json()) as ShadowReport);
        } catch {
            setError("Could not load the shadow routing report.");
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        // Deferred a tick so no state write is synchronous within the effect.
        queueMicrotask(() => void load());
    }, [load]);

    return (
        <section
            className="overflow-hidden rounded-3xl border border-zinc-800 bg-zinc-950/80 shadow-2xl shadow-black/20"
            data-testid="admin-routing-shadow-panel"
        >
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-800 bg-zinc-900/60 p-5">
                <div>
                    <div className="inline-flex items-center gap-2 rounded-full border border-sky-500/30 bg-sky-500/10 px-3 py-1 text-xs font-semibold uppercase tracking-[0.18em] text-sky-200">
                        <Route className="h-3.5 w-3.5" />
                        Shadow routing
                    </div>
                    <h2 className="mt-3 text-2xl font-black text-white">
                        What Auto would have chosen
                    </h2>
                    <p className="mt-1 max-w-2xl text-sm leading-6 text-zinc-400">
                        The Router&apos;s rules run on real turns and the decision is
                        recorded; the model the user selected is what executed.
                    </p>
                </div>
                <button
                    type="button"
                    onClick={() => void load()}
                    disabled={loading}
                    className="inline-flex items-center gap-2 rounded-xl border border-zinc-700 bg-zinc-900 px-4 py-2 text-sm font-semibold text-zinc-200 transition-colors hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-60"
                    data-testid="admin-routing-shadow-refresh"
                >
                    {loading ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                        <RefreshCw className="h-4 w-4" />
                    )}
                    Refresh
                </button>
            </div>

            <div className="space-y-4 p-5">
                {error && (
                    <p
                        className="rounded-xl border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-200"
                        data-testid="admin-routing-shadow-error"
                    >
                        {error}
                    </p>
                )}

                {report && report.rows === 0 && (
                    // An empty dashboard reads as "nothing is wrong". This says
                    // which of the two empty states it actually is.
                    <p
                        className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-3 text-sm leading-6 text-zinc-300"
                        data-testid="admin-routing-shadow-empty"
                    >
                        No shadow runs in the last {report.windowDays} days.
                        Shadow routing is off unless{" "}
                        <code className="font-mono text-xs">
                            TOMVERSE_ROUTER_SHADOW_ENABLED
                        </code>{" "}
                        is set, so this is expected until it is turned on.
                    </p>
                )}

                {report && report.rows > 0 && (
                    <>
                        {report.versions.mixed && (
                            <p
                                className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-sm leading-6 text-amber-100"
                                data-testid="admin-routing-shadow-mixed-versions"
                            >
                                This window spans more than one rule version, so the
                                rates below describe no single Router. Narrow the
                                window before drawing a conclusion.
                            </p>
                        )}
                        {report.truncated && (
                            <p className="rounded-xl border border-zinc-700 bg-zinc-900/60 p-3 text-sm text-zinc-300">
                                The row cap was reached, so this window is only
                                partly covered.
                            </p>
                        )}

                        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                            <Stat
                                label="Runs"
                                value={num(report.rows)}
                                detail={`Last ${report.windowDays} days`}
                            />
                            <Stat
                                label="Agreement"
                                value={pct(report.agreementRate)}
                                detail={`${num(report.agreed)} of ${num(report.decided)} decided`}
                            />
                            <Stat
                                label="No candidate"
                                value={num(report.undecided)}
                                detail="Nothing survived the filters"
                            />
                            <Stat
                                label="Decision p50 / p95"
                                value={`${ms(report.decisionMicrosP50)} / ${ms(report.decisionMicrosP95)}`}
                                detail="ROUTE-02 bounds p95 at 300ms"
                            />
                        </div>

                        <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-3">
                            <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-zinc-500">
                                Where Auto would move traffic
                            </p>
                            {report.switches.length === 0 ? (
                                <p className="mt-2 text-sm text-zinc-500">
                                    No disagreements in this window.
                                </p>
                            ) : (
                                <ul
                                    className="mt-2 space-y-1"
                                    data-testid="admin-routing-shadow-switches"
                                >
                                    {report.switches.map((pair) => (
                                        <li
                                            key={`${pair.from}->${pair.to}`}
                                            className="flex items-baseline justify-between gap-3 text-sm"
                                        >
                                            <span className="font-mono text-xs text-zinc-400">
                                                {pair.from} → {pair.to}
                                            </span>
                                            <span className="font-bold text-white">
                                                {num(pair.count)}
                                            </span>
                                        </li>
                                    ))}
                                </ul>
                            )}
                        </div>

                        <div className="grid gap-3 lg:grid-cols-2">
                            <GroupTable
                                label="Agreement by task kind"
                                groups={report.byTaskKind}
                                testId="admin-routing-shadow-by-task"
                            />
                            <GroupTable
                                label="Agreement by plan"
                                groups={report.byPlan}
                                testId="admin-routing-shadow-by-plan"
                            />
                            <CountList
                                label="Selection reasons"
                                counts={report.selectionReasons}
                                testId="admin-routing-shadow-selection-reasons"
                            />
                            <CountList
                                label="Models refused, by filter"
                                counts={report.rejectionReasons}
                                testId="admin-routing-shadow-rejections"
                            />
                        </div>
                    </>
                )}

                <p
                    className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-3 text-xs leading-6 text-zinc-400"
                    data-testid="admin-routing-shadow-caveat"
                >
                    Agreement is not a score. ROUTE-01 grades the Router on a
                    win-rate against the fixed-model baseline, measured on an
                    evaluation set. A Router that echoed the user would agree every
                    time and be worth nothing; one that is right where the user was
                    wrong appears here as disagreement. This measures how much would
                    change if Auto were switched on, not whether the change would be
                    an improvement.
                </p>
            </div>
        </section>
    );
}
