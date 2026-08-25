import "server-only";

import { after } from "next/server";
import { ACTIVE_ESTIMATOR_VERSION } from "@/lib/chatTokenEstimate";
import { prisma } from "@/lib/prisma";
import {
    ROUTER_CANDIDATE_VERSION,
    filterRouterCandidates,
    type CandidateRejection,
    type RouterCandidateInput,
} from "@/lib/routerCandidates";
import { expectedTotalCostUsdByModel } from "@/lib/routerCostSignal";
import {
    ROUTER_SCORE_POLICY_VERSION,
    type RouterTieBreakSignals,
} from "@/lib/routerScorePolicy";
import {
    ROUTER_SELECTION_VERSION,
    selectRouterModel,
    type RouterStickyState,
} from "@/lib/routerSelection";
import { TASK_PROFILE_VERSION, type TaskProfile } from "@/lib/taskProfileCore";

/**
 * Shadow routing — step 3 of the rollout order, and the point at which the
 * previous slices become observable.
 *
 * The rules run on a real turn, the decision is recorded, and **the user's own
 * model selection is what executes**. That separation is the whole design:
 * `ROUTE-01` requires the Router to be non-inferior to the fixed-model
 * baseline, and the only way to argue that before switching anyone over is to
 * have the two disagree on record while only one of them is real.
 *
 * Three rules this module holds:
 *
 * **It cannot fail a request.** A shadow decision is observation. Recording it
 * runs after the response and swallows its own errors — a routing experiment
 * that can 500 a chat is not an experiment, it is an outage.
 *
 * **It cannot slow one down either.** The decision is pure and measured in
 * microseconds, but the write is not, so the caller is expected to hand this
 * to `after()`. The measured decision time is recorded so "the Router is fast
 * enough" (`ROUTE-02`) becomes a number rather than an assurance.
 *
 * **It records no request content** (routing policy §2). Labels, counts,
 * versions and model ids only. The task profile is already content-free by
 * construction; what this adds is counts of rejections by reason, never which
 * turn produced them.
 *
 * Off by default. A flag that has to be turned on is the difference between a
 * shadow rollout and a silent one.
 */

export const ROUTER_SHADOW_FLAG = "TOMVERSE_ROUTER_SHADOW_ENABLED";

export const isRouterShadowEnabled = (
    environment: Record<string, string | undefined> = process.env
) => environment[ROUTER_SHADOW_FLAG] === "true";

export type RoutingShadowInput = {
    traceId: string;
    userId?: string | null;
    subjectKey: string;
    /**
     * The conversation this decision was shadowing, and the product it ran
     * for. Both are known at the call site and were being dropped: a shadow
     * row is a routing decision about a real turn, so it belongs to that
     * turn's conversation exactly as the dispatch row does.
     *
     * Null on a turn with no conversation -- a guest has no row to read a
     * product from -- and null on a conversation written before
     * `productKey` existed, which is a fact rather than a gap:
     * `docs/policy/routing-run-product-attribution.md` §6 refuses to infer a
     * product nobody recorded.
     */
    conversationId?: string | null;
    productKey?: string | null;
    plan: RouterCandidateInput["plan"];
    profile: TaskProfile;
    /** The model the user's request actually ran on. */
    userSelectedModelId: string;
    /** The raw conversation estimate, before tool overhead. */
    estimatedInputTokens: number;
    /** What the request really sends, tool overhead included. */
    reservedInputTokens: number;
    /**
     * The application's output cap, before it is fitted to any one model's
     * window. The filters fit it per candidate; passing an already-fitted
     * figure would ask every candidate the question the user's model answered.
     */
    requestOutputCapTokens: number;
    models: RouterCandidateInput["models"];
    sticky?: RouterStickyState | null;
    unhealthyModelIds?: readonly string[];
    regionBlockedModelIds?: readonly string[];
    /** Measured tie-break signals; cost is derived when not supplied. */
    signals?: RouterTieBreakSignals;
};

export type RoutingShadowDecision = {
    mode: "shadow";
    traceId: string;
    userId: string | null;
    subjectKey: string;
    conversationId: string | null;
    productKey: string | null;
    plan: string;
    taskProfileVersion: string;
    candidateFilterVersion: string;
    selectionVersion: string;
    selectionPolicyVersion: string;
    estimatorVersion: string;
    profileKind: string;
    profileConfidence: string;
    needsCurrentInformation: boolean;
    hasImageInput: boolean;
    hasDocumentInput: boolean;
    expectedOutputLength: string;
    estimatedInputTokens: number;
    reservedInputTokens: number;
    requestOutputCapTokens: number;
    eligibleCount: number;
    rejectedByReason: Partial<Record<CandidateRejection, number>>;
    selectedModelId: string | null;
    selectionReason: string;
    selectionMargin: number;
    userSelectedModelId: string;
    decisionMicros: number;
};

/**
 * Runs the rules and returns the row that would be written.
 *
 * Separated from the write so the decision is testable without a database, and
 * so a caller that only wants to look can do so without recording anything.
 */
export function buildRoutingShadowDecision(
    input: RoutingShadowInput
): RoutingShadowDecision {
    // Microseconds from a monotonic clock: `ROUTE-02` bounds routing latency
    // at a p95 of 300ms, and a millisecond resolution would report almost
    // every decision as zero.
    const startedAt = process.hrtime();

    const candidates = filterRouterCandidates({
        models: input.models,
        plan: input.plan,
        profile: input.profile,
        reservedInputTokens: input.reservedInputTokens,
        requestOutputCapTokens: input.requestOutputCapTokens,
        unhealthyModelIds: input.unhealthyModelIds,
        regionBlockedModelIds: input.regionBlockedModelIds,
    });
    const selection = selectRouterModel({
        profile: input.profile,
        eligible: candidates.eligible,
        sticky: input.sticky ?? null,
        signals: {
            expectedTotalCostUsdByModelId: expectedTotalCostUsdByModel({
                models: input.models,
                reservedInputTokens: input.reservedInputTokens,
                requestOutputCapTokens: input.requestOutputCapTokens,
            }),
            ...input.signals,
        },
    });

    // Counts, not a list. Which models were refused is stable catalogue
    // information a reader can reconstruct; how often each reason fired is
    // what says whether a filter is doing anything.
    const rejectedByReason: Partial<Record<CandidateRejection, number>> = {};
    for (const entry of candidates.rejected) {
        rejectedByReason[entry.reason] =
            (rejectedByReason[entry.reason] ?? 0) + 1;
    }

    const elapsed = process.hrtime(startedAt);
    const decisionMicros = Math.round(elapsed[0] * 1_000_000 + elapsed[1] / 1_000);

    return {
        mode: "shadow",
        traceId: input.traceId,
        userId: input.userId ?? null,
        subjectKey: input.subjectKey,
        conversationId: input.conversationId ?? null,
        productKey: input.productKey ?? null,
        plan: input.plan,
        taskProfileVersion: TASK_PROFILE_VERSION,
        candidateFilterVersion: ROUTER_CANDIDATE_VERSION,
        selectionVersion: ROUTER_SELECTION_VERSION,
        selectionPolicyVersion: ROUTER_SCORE_POLICY_VERSION,
        estimatorVersion: ACTIVE_ESTIMATOR_VERSION,
        profileKind: input.profile.kind,
        profileConfidence: input.profile.kindConfidence,
        needsCurrentInformation: input.profile.needsCurrentInformation,
        hasImageInput: input.profile.hasImageInput,
        hasDocumentInput: input.profile.hasDocumentInput,
        expectedOutputLength: input.profile.expectedOutputLength,
        estimatedInputTokens: input.estimatedInputTokens,
        reservedInputTokens: input.reservedInputTokens,
        requestOutputCapTokens: input.requestOutputCapTokens,
        eligibleCount: candidates.eligible.length,
        rejectedByReason,
        selectedModelId: selection.selectedModelId,
        selectionReason: selection.reason,
        selectionMargin: selection.margin,
        userSelectedModelId: input.userSelectedModelId,
        decisionMicros,
    };
}

/**
 * Records one shadow decision. Never throws, and never blocks a response.
 *
 * The flag is read here rather than at the call site so there is one answer to
 * "is shadow routing on", and so a caller cannot enable it by forgetting to
 * check.
 */
export async function recordRoutingShadowRun(
    input: RoutingShadowInput,
    environment: Record<string, string | undefined> = process.env
): Promise<{ recorded: boolean }> {
    if (!isRouterShadowEnabled(environment)) return { recorded: false };
    try {
        const decision = buildRoutingShadowDecision(input);
        await prisma.routingRun.create({ data: decision });
        return { recorded: true };
    } catch (error) {
        // Content-free, like the row it failed to write.
        console.error(
            JSON.stringify({
                event: "routing_shadow_record_failed",
                errorName: error instanceof Error ? error.name : "UnknownError",
            })
        );
        return { recorded: false };
    }
}

/**
 * Hands one shadow decision to `after()`, and cannot fail the caller.
 *
 * The scheduling lives here rather than at the call site because `after()`
 * throws when there is no request scope, and a chat handler invoked outside
 * one — a direct call from an integration test, or any future path that is not
 * a Next request — would then 500 on a line whose entire purpose is
 * observation. That is the module's own first rule broken by the way it was
 * scheduled rather than by what it does, which is exactly the kind of failure
 * a call-site `try` catches only until somebody adds a second call site.
 *
 * No request scope means no recording. A detached promise would be the other
 * option and is worse: it either keeps work alive past the response or is
 * killed halfway, and neither is a measurement anyone should trust.
 */
export function scheduleRoutingShadowRun(
    buildInput: () => RoutingShadowInput,
    environment: Record<string, string | undefined> = process.env
): void {
    // Checked before scheduling as well as inside the recorder: with the flag
    // off there is nothing to schedule, and `after()` should not be touched at
    // all on the path every request takes today.
    if (!isRouterShadowEnabled(environment)) return;
    try {
        after(() => recordRoutingShadowRun(buildInput(), environment));
    } catch (error) {
        console.error(
            JSON.stringify({
                event: "routing_shadow_schedule_failed",
                errorName: error instanceof Error ? error.name : "UnknownError",
            })
        );
    }
}
