"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import { discardResponseBody } from "@/lib/discardResponseBody";
import { adminIntlLocale, type AdminLocale } from "@/lib/adminLocale";
import { adminRoutingShadowMessages } from "@/lib/adminMessages/routingShadow";
import { useAdminLocale, useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import { adminFetch } from "@/lib/adminFetch";
import type { autoRoutingRuntimeReadback } from "@/lib/autoRoutingRuntimeReadback";
import { AdminKpiCard } from "@/components/admin/ui/AdminKpiCard";
import { AdminStateBlock } from "@/components/admin/ui/AdminStateBlock";
import { AdminStatusChip } from "@/components/admin/ui/AdminStatusChip";
import { AdminTechInfo } from "@/components/admin/ui/AdminTechInfo";
import { AdminTile } from "@/components/admin/ui/AdminTile";

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

export type GroupAgreement = {
    key: string;
    decided: number;
    agreed: number;
    agreementRate: number | null;
};

export type ShadowReport = {
    runtime?: ReturnType<typeof autoRoutingRuntimeReadback>;
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

export function AdminRoutingRuntimeReadback({ runtime, messages }: {
    runtime: ShadowReport["runtime"];
    messages: typeof adminRoutingShadowMessages.en.runtime;
}) {
    // Project only the documented fields, even if a future response adds more.
    const limited = runtime?.limitedRelease;
    const snapshot = runtime && {
        observedAt: runtime.observedAt,
        build: {
            environment: runtime.build.environment,
            commitSha: runtime.build.commitSha,
            shortCommitSha: runtime.build.shortCommitSha,
            builtAt: runtime.build.builtAt,
            deploymentId: runtime.build.deploymentId,
            deploymentStartedAt: runtime.build.deploymentStartedAt,
            deployedAt: runtime.build.deployedAt,
            deploymentStatus: runtime.build.deploymentStatus,
        },
        readiness: {
            version: runtime.readiness.version,
            ready: runtime.readiness.ready,
            outstanding: runtime.readiness.outstanding,
            problems: runtime.readiness.problems,
        },
        shadowEnabled: runtime.shadowEnabled,
        dispatchInstrumentationMode: runtime.dispatchInstrumentationMode,
        manifestKeyringConfigured: runtime.manifestKeyringConfigured,
        limitedRelease: limited && (limited.admitted ? {
            admitted: true,
            exceptionId: limited.exceptionId,
            version: limited.version,
            evidenceRef: limited.evidenceRef,
            approvedBy: limited.approvedBy,
            approvedAt: limited.approvedAt,
            expiresAt: limited.expiresAt,
            evaluatedImplementationCommit: limited.evaluatedImplementationCommit,
            servingCommitSha: limited.servingCommitSha,
            targetEnvironmentId: limited.targetEnvironmentId,
            targetServiceId: limited.targetServiceId,
            rolloutPercent: limited.rolloutPercent,
            eligiblePlans: limited.eligiblePlans,
        } : { admitted: false, reason: limited.reason }),
        rollout: runtime.rollout && {
            uiEnabled: runtime.rollout.uiEnabled,
            killSwitch: runtime.rollout.killSwitch,
            percent: runtime.rollout.percent,
            eligiblePlans: runtime.rollout.eligiblePlans,
            cohortSaltConfigured: runtime.rollout.cohortSaltConfigured,
        },
    };

    return (
        <div className="flex flex-col gap-2 rounded-xl border border-zinc-800 p-3" data-testid="admin-routing-runtime-readback">
            <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-sm font-bold text-zinc-200">{messages.title}</h3>
                {snapshot ? (
                    <AdminStatusChip tone={snapshot.readiness.ready ? "ok" : "warn"}>
                        {snapshot.readiness.ready ? messages.ready : messages.notReady}
                    </AdminStatusChip>
                ) : (
                    <AdminStatusChip tone="unknown" />
                )}
            </div>
            <p className="text-xs leading-6 text-zinc-400">
                {snapshot ? messages.caveat : messages.unavailable}
            </p>
            {snapshot && (
                <AdminTechInfo summary={snapshot.build.shortCommitSha}>
                    <pre className="max-h-[32rem] overflow-auto whitespace-pre-wrap break-all leading-6" data-testid="admin-routing-runtime-snapshot">
                        {JSON.stringify(snapshot, null, 2)}
                    </pre>
                </AdminTechInfo>
            )}
        </div>
    );
}

const num = (value: number, locale: AdminLocale) =>
    value.toLocaleString(adminIntlLocale(locale));
const pct = (value: number | null) =>
    value === null ? "—" : `${(value * 100).toFixed(1)}%`;
const ms = (micros: number) => `${(micros / 1000).toFixed(1)}ms`;
const readable = (key: string) => key.replaceAll("_", " ");

const CountList = ({
    label,
    counts,
    testId,
}: {
    label: string;
    counts: Record<string, number>;
    testId: string;
}) => {
    const m = useAdminMessages(adminRoutingShadowMessages);
    const { locale } = useAdminLocale();
    const entries = Object.entries(counts).sort((left, right) => right[1] - left[1]);
    return (
        <AdminTile title={label}>
            {entries.length === 0 ? (
                <p className="text-sm text-zinc-500">{m.groups.noneInWindow}</p>
            ) : (
                <ul className="flex flex-col" data-testid={testId}>
                    {entries.map(([key, value]) => (
                        <li
                            key={key}
                            className="flex items-baseline justify-between gap-3 border-t border-zinc-800 py-2 text-sm first:border-t-0"
                        >
                            <span className="text-zinc-400">{readable(key)}</span>
                            <span className="font-bold text-white">{num(value, locale)}</span>
                        </li>
                    ))}
                </ul>
            )}
        </AdminTile>
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
}) => {
    const m = useAdminMessages(adminRoutingShadowMessages);
    const { locale } = useAdminLocale();
    return (
        <AdminTile title={label}>
            {groups.length === 0 ? (
                <p className="text-sm text-zinc-500">{m.groups.nothingDecided}</p>
            ) : (
                <ul className="flex flex-col" data-testid={testId}>
                    {groups.map((group) => (
                        <li
                            key={group.key}
                            className="flex items-baseline justify-between gap-3 border-t border-zinc-800 py-2 text-sm first:border-t-0"
                        >
                            <span className="text-zinc-400">{readable(group.key)}</span>
                            <span className="font-bold text-white">
                                {pct(group.agreementRate)}{" "}
                                <span className="font-normal text-zinc-500">
                                    ({num(group.agreed, locale)}/{num(group.decided, locale)})
                                </span>
                            </span>
                        </li>
                    ))}
                </ul>
            )}
        </AdminTile>
    );
};

export function AdminRoutingShadowPanel() {
    const m = useAdminMessages(adminRoutingShadowMessages);
    const { locale } = useAdminLocale();
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
            const response = await adminFetch("/api/admin/routing-shadow", {
                cache: "no-store",
            });
            if (!response.ok) {
                await discardResponseBody(response);
                throw new Error(String(response.status));
            }
            setReport((await response.json()) as ShadowReport);
        } catch {
            setError(m.loadFailed);
        } finally {
            setLoading(false);
        }
    }, [m]);

    useEffect(() => {
        // Deferred a tick so no state write is synchronous within the effect.
        queueMicrotask(() => void load());
    }, [load]);

    return (
        <div className="flex min-w-0 flex-col gap-4" data-testid="admin-routing-shadow-panel">
            <AdminTile
                title={m.title}
                description={m.description}
                action={
                    <button
                        type="button"
                        onClick={() => void load()}
                        disabled={loading}
                        className="inline-flex min-h-9 items-center gap-2 rounded-xl border border-zinc-700 bg-zinc-900 px-3 text-xs font-bold text-zinc-100 hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-60"
                        data-testid="admin-routing-shadow-refresh"
                    >
                        {loading ? (
                            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                        ) : (
                            <RefreshCw className="h-4 w-4" aria-hidden />
                        )}
                        {m.refresh}
                    </button>
                }
            >
                {report && <AdminRoutingRuntimeReadback runtime={report.runtime} messages={m.runtime} />}
                {/* A failed read is an alert with a retry, never an empty report. */}
                {error && (
                    <div data-testid="admin-routing-shadow-error">
                        <AdminStateBlock kind="error" title={error} onRetry={() => void load()} />
                    </div>
                )}
                {loading && !report && !error && <AdminStateBlock kind="loading" />}

                {report && report.rows === 0 && (
                    // An empty dashboard reads as "nothing is wrong". This says
                    // which of the two empty states it actually is.
                    <p
                        className="rounded-xl border border-dashed border-zinc-700 p-3 text-sm leading-6 text-zinc-300"
                        data-testid="admin-routing-shadow-empty"
                    >
                        {m.emptyBefore(report.windowDays)}{" "}
                        <code className="font-mono text-xs">
                            TOMVERSE_ROUTER_SHADOW_ENABLED
                        </code>{" "}
                        {m.emptyAfter}
                    </p>
                )}

                {report && report.rows > 0 && report.versions.mixed && (
                    <p
                        className="rounded-xl bg-amber-500/10 p-3 text-sm leading-6 text-amber-200"
                        data-testid="admin-routing-shadow-mixed-versions"
                    >
                        {m.mixedVersions}
                    </p>
                )}
                {report && report.rows > 0 && report.truncated && (
                    <p className="rounded-xl border border-zinc-700 p-3 text-sm text-zinc-300">
                        {m.truncated}
                    </p>
                )}
            </AdminTile>

            {report && report.rows > 0 && (
                <>
                    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                        <AdminKpiCard
                            label={m.stats.runs}
                            value={num(report.rows, locale)}
                            detail={m.stats.lastDays(report.windowDays)}
                        />
                        <AdminKpiCard
                            label={m.stats.agreement}
                            value={pct(report.agreementRate)}
                            detail={m.stats.agreedOfDecided(num(report.agreed, locale), num(report.decided, locale))}
                        />
                        <AdminKpiCard
                            label={m.stats.noCandidate}
                            value={num(report.undecided, locale)}
                            detail={m.stats.noCandidateDetail}
                        />
                        <AdminKpiCard
                            label={m.stats.decisionLatency}
                            value={`${ms(report.decisionMicrosP50)} / ${ms(report.decisionMicrosP95)}`}
                            detail={m.stats.decisionLatencyDetail}
                        />
                    </div>

                    <AdminTile title={m.switches.title}>
                        {report.switches.length === 0 ? (
                            <p className="text-sm text-zinc-500">{m.switches.none}</p>
                        ) : (
                            <ul className="flex flex-col" data-testid="admin-routing-shadow-switches">
                                {report.switches.map((pair) => (
                                    <li
                                        key={`${pair.from}->${pair.to}`}
                                        className="flex items-baseline justify-between gap-3 border-t border-zinc-800 py-2 text-sm first:border-t-0"
                                    >
                                        <span className="font-mono text-xs text-zinc-400">
                                            {pair.from} → {pair.to}
                                        </span>
                                        <span className="font-bold text-white">
                                            {num(pair.count, locale)}
                                        </span>
                                    </li>
                                ))}
                            </ul>
                        )}
                    </AdminTile>

                    <div className="grid gap-4 lg:grid-cols-2">
                        <GroupTable
                            label={m.groups.byTaskKind}
                            groups={report.byTaskKind}
                            testId="admin-routing-shadow-by-task"
                        />
                        <GroupTable
                            label={m.groups.byPlan}
                            groups={report.byPlan}
                            testId="admin-routing-shadow-by-plan"
                        />
                        <CountList
                            label={m.groups.selectionReasons}
                            counts={report.selectionReasons}
                            testId="admin-routing-shadow-selection-reasons"
                        />
                        <CountList
                            label={m.groups.rejections}
                            counts={report.rejectionReasons}
                            testId="admin-routing-shadow-rejections"
                        />
                    </div>
                </>
            )}

            <p
                className="rounded-xl border border-zinc-800 p-3 text-xs leading-6 text-zinc-400"
                data-testid="admin-routing-shadow-caveat"
            >
                {m.caveat}
            </p>
        </div>
    );
}
