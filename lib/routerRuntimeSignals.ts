import "server-only";

/**
 * The Router's runtime inputs, read once and reused for a minute.
 *
 * Two questions, two sources, deliberately never merged into one number:
 *
 *   **May this model be a candidate at all?** Synthetic probes, through
 *   `lib/modelHealthRollup.ts`. A model the health path calls `unavailable` is
 *   excluded by the hard filter; a `degraded` one stays a candidate and loses
 *   tie-breaks; `unknown` -- which covers the twenty enabled models nothing
 *   probes -- is not a reason to exclude anything. Uncertainty is not a
 *   verdict.
 *
 *   **Which surviving candidate should win?** Real dispatch outcomes, through
 *   `lib/routerSignalCore.ts`: success rate and time to first token, over one
 *   window, on one definition of success.
 *
 * ## What is actually populated today
 *
 * Neither source covers the catalogue, and this module reports that honestly
 * rather than filling gaps:
 *
 *   - `getProbeModelFor` probes one model per provider, so roughly ten of the
 *     thirty enabled models have probe evidence and Perplexity has none.
 *   - `RoutingAttempt` is only written when `ROUTING_DISPATCH_INSTRUMENTATION`
 *     is `observe` or `enforce`, and it defaults to `off`. Until it is on, the
 *     success-rate and TTFT maps are empty and their criteria abstain on every
 *     turn -- which is the same decision the Router made before this module
 *     existed, reached deliberately instead of by omission.
 *
 * ## Never on the request's critical path more than once a minute
 *
 * `ROUTE-02` bounds the whole routing decision at a p95 of 300ms, and these
 * are two aggregate queries. They run at most once per
 * `ROUTER_SIGNAL_SNAPSHOT_TTL_MS` per process, and a read that fails returns
 * the empty snapshot rather than throwing: a routing input that cannot be
 * fetched is unknown, and unknown already has a defined meaning everywhere
 * downstream. A chat turn must not fail because a telemetry query did.
 */

import { AVAILABLE_MODELS } from "@/lib/models";
import {
    PROBE_FRESHNESS_WINDOW_MS,
    rollUpModelHealth,
} from "@/lib/modelHealthRollup";
import { prisma } from "@/lib/prisma";
import { evaluateProviderFailureHealth } from "@/lib/providerHealthPolicyCore";
import {
    ROUTER_SIGNAL_SNAPSHOT_TTL_MS,
    ROUTER_SIGNAL_WINDOW_MS,
    ROUTER_SUCCESS_RATE_MIN_OBSERVATIONS,
    ROUTER_TTFT_MIN_OBSERVATIONS,
    type RouterTieBreakSignals,
} from "@/lib/routerScorePolicy";
import {
    summariseDispatchSignals,
    toTieBreakSignalMaps,
    type DispatchObservation,
} from "@/lib/routerSignalCore";

export type RouterRuntimeSignals = {
    /** Hard filter input: confirmed unavailable, and confirmed recently. */
    unhealthyModelIds: readonly string[];
    /** Tie-break inputs, including the degraded set. */
    signals: RouterTieBreakSignals;
    /** When this was computed, so a caller can say how old its inputs were. */
    computedAt: Date;
    /** How many models each source actually had something to say about. */
    coverage: {
        probedModels: number;
        successRateModels: number;
        ttftModels: number;
    };
};

const EMPTY: Omit<RouterRuntimeSignals, "computedAt"> = {
    unhealthyModelIds: [],
    signals: {},
    coverage: { probedModels: 0, successRateModels: 0, ttftModels: 0 },
};

let cached: RouterRuntimeSignals | null = null;
let inFlight: Promise<RouterRuntimeSignals> | null = null;

/**
 * Probe rows for the window, grouped per model, with a provider verdict
 * derived from the same rows.
 *
 * The verdict uses `evaluateProviderFailureHealth` -- the function
 * `rollUpModelHealth` already applies at the model grain, and the one that
 * defines what a failure rate has to reach before it is an outage. One
 * definition at two grains, which is what that module's comment asks for, and
 * no second set of thresholds to drift.
 *
 * What this deliberately does not read is the public status page's merged
 * verdict. That one folds in real-traffic heartbeats and operator-declared
 * incidents, and it needs a bucket-derived `internalStatus` this path does not
 * compute; passing a placeholder for it would assert a verdict nothing here
 * reached. The cost is a blind spot with a name: a provider failing real
 * traffic while its probes pass is not excluded here. It is not invisible
 * either -- that shows up as the model's own dispatch success rate, in the
 * tie-break, which is the signal built from exactly that traffic.
 */
const readProbeHealth = async (now: Date) => {
    const since = new Date(now.getTime() - ROUTER_SIGNAL_WINDOW_MS);
    const probes = await prisma.providerProbeResult.findMany({
        where: { completedAt: { gte: since } },
        orderBy: { completedAt: "asc" },
        select: {
            provider: true,
            modelId: true,
            success: true,
            completedAt: true,
            latencyMs: true,
        },
    });

    const probesByProvider = new Map<string, { success: boolean }[]>();
    for (const probe of probes) {
        const rows = probesByProvider.get(probe.provider) ?? [];
        rows.push({ success: probe.success });
        probesByProvider.set(probe.provider, rows);
    }
    const verdictByProvider = new Map<string, { outage: boolean; limited: boolean }>();
    for (const [provider, rows] of probesByProvider) {
        let trailingSuccesses = 0;
        for (let index = rows.length - 1; index >= 0; index -= 1) {
            if (!rows[index].success) break;
            trailingSuccesses += 1;
        }
        const health = evaluateProviderFailureHealth({
            successCount: rows.filter((row) => row.success).length,
            failureCount: rows.filter((row) => !row.success).length,
            // Recovery hysteresis is this function's own, already: a trailing
            // run of successes clears an outage or a degradation rather than
            // leaving a provider excluded until the window rolls past the
            // failures. A second recovery rule here would be a second policy.
            consecutiveSuccesses: trailingSuccesses,
        });
        verdictByProvider.set(provider, {
            outage: health.outage,
            limited: health.limited,
        });
    }

    const observationsByModel = new Map<
        string,
        { provider: string; rows: { success: boolean; completedAt: Date; latencyMs: number | null }[] }
    >();
    for (const probe of probes) {
        const entry = observationsByModel.get(probe.modelId) ?? {
            provider: probe.provider,
            rows: [],
        };
        entry.rows.push({
            success: probe.success,
            completedAt: probe.completedAt,
            latencyMs: probe.latencyMs,
        });
        observationsByModel.set(probe.modelId, entry);
    }

    const unhealthyModelIds: string[] = [];
    const degradedModelIds: string[] = [];
    for (const [modelId, entry] of observationsByModel) {
        const rollup = rollUpModelHealth({
            modelId,
            provider: entry.provider,
            providerVerdict: verdictByProvider.get(entry.provider) ?? {
                outage: false,
                limited: false,
            },
            observations: entry.rows,
            now,
        });
        // A verdict is only honoured while the evidence behind it is fresh.
        // The rollup already answers `unknown` for stale probes, but a
        // provider-level outage short-circuits ahead of that check, so the
        // freshness is asserted here too: an old failure must not exclude a
        // model forever, and "we have not looked lately" is not "it is down".
        const evidenceIsFresh =
            rollup.lastProbeAt !== null &&
            now.getTime() - rollup.lastProbeAt.getTime() <= PROBE_FRESHNESS_WINDOW_MS;
        if (!evidenceIsFresh) continue;
        if (rollup.status === "unavailable") unhealthyModelIds.push(modelId);
        if (rollup.status === "degraded") degradedModelIds.push(modelId);
    }

    return {
        unhealthyModelIds,
        degradedModelIds,
        probedModels: observationsByModel.size,
    };
};

/** Dispatch outcomes for the window, as the pure core wants them. */
const readDispatchSignals = async (now: Date) => {
    const since = new Date(now.getTime() - ROUTER_SIGNAL_WINDOW_MS);
    const attempts = await prisma.routingAttempt.findMany({
        where: { createdAt: { gte: since } },
        select: {
            modelId: true,
            outcome: true,
            dispatchedAt: true,
            firstVisibleTokenAt: true,
        },
    });

    const observations: DispatchObservation[] = attempts.map((attempt) => ({
        modelId: attempt.modelId,
        outcome: attempt.outcome,
        ttftMs:
            attempt.dispatchedAt && attempt.firstVisibleTokenAt
                ? attempt.firstVisibleTokenAt.getTime() - attempt.dispatchedAt.getTime()
                : null,
    }));

    const summarised = summariseDispatchSignals(observations, {
        minSuccessObservations: ROUTER_SUCCESS_RATE_MIN_OBSERVATIONS,
        minTtftObservations: ROUTER_TTFT_MIN_OBSERVATIONS,
    });
    return toTieBreakSignalMaps(summarised);
};

const compute = async (now: Date): Promise<RouterRuntimeSignals> => {
    const [health, dispatch] = await Promise.all([
        readProbeHealth(now),
        readDispatchSignals(now),
    ]);

    const knownModelIds = new Set<string>(AVAILABLE_MODELS.map((model) => model.id));
    // A model id the catalogue no longer has cannot be routed to, so it cannot
    // usefully be excluded or ranked either. Dropping it here keeps a retired
    // id out of a decision record that would then name a model nothing can
    // resolve.
    const keep = (ids: readonly string[]) => ids.filter((id) => knownModelIds.has(id));

    return {
        unhealthyModelIds: keep(health.unhealthyModelIds),
        signals: {
            recentSuccessRateByModelId: dispatch.recentSuccessRateByModelId,
            ttftP95MsByModelId: dispatch.ttftP95MsByModelId,
            degradedModelIds: keep(health.degradedModelIds),
        },
        computedAt: now,
        coverage: {
            probedModels: health.probedModels,
            successRateModels: Object.keys(dispatch.recentSuccessRateByModelId).length,
            ttftModels: Object.keys(dispatch.ttftP95MsByModelId).length,
        },
    };
};

/**
 * The current snapshot, computed at most once per TTL per process.
 *
 * Concurrent callers share one in-flight read rather than each starting their
 * own: the first turn after a cold start would otherwise run as many identical
 * aggregate queries as there are simultaneous requests.
 */
export const getRouterRuntimeSignals = async (
    now: Date = new Date()
): Promise<RouterRuntimeSignals> => {
    if (
        cached &&
        now.getTime() - cached.computedAt.getTime() < ROUTER_SIGNAL_SNAPSHOT_TTL_MS
    ) {
        return cached;
    }
    if (inFlight) return inFlight;

    inFlight = compute(now)
        .then((snapshot) => {
            cached = snapshot;
            return snapshot;
        })
        .catch((error) => {
            // Content-free, and non-fatal by design: a routing input that
            // could not be read is unknown, and every criterion downstream
            // already knows what to do with unknown.
            console.error(
                JSON.stringify({
                    event: "router_runtime_signals_read_failed",
                    errorName: error instanceof Error ? error.name : "UnknownError",
                })
            );
            const empty = { ...EMPTY, computedAt: now };
            cached = empty;
            return empty;
        })
        .finally(() => {
            inFlight = null;
        });

    return inFlight;
};

/** Test seam: forget the cached snapshot. */
export const resetRouterRuntimeSignalsCache = () => {
    cached = null;
    inFlight = null;
};
