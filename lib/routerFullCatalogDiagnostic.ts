/**
 * What the Router would do with the whole catalogue, item by item, offline.
 *
 * ## What this is for
 *
 * The product's decision (`lib/routerDecision.ts`) answers "which model serves
 * this turn". It records the eligible set, every rejection with a reason, the
 * winner and the criterion that separated the top two. It does not say, for
 * each model that was not chosen, why *that* model lost; it does not say
 * whether the choice rested on any quality evidence at all; and it does not
 * compare the output cap it routed under with the one dispatch will actually
 * apply. Those are the questions somebody improving the Router has to ask
 * before they can tell whether the whole catalogue is really being
 * considered, and this module answers them.
 *
 * ## What this is not
 *
 * Not a second router. Every disposition here comes from the product's own
 * functions, called with the product's own inputs: `decideRouterModel` makes
 * the decision, `filterRouterCandidates` and `selectRouterModel` are called
 * again only to *explain* it, and `consistency` records whether the
 * explanation agrees with the decision. A disagreement is reported, never
 * reconciled -- a diagnostic that patched over a difference between itself
 * and the product would be describing a Router the product does not run.
 *
 * Not an evaluation. An unmeasured model is reported as unmeasured: its band
 * is whatever the score policy says (neutral, today, for every cell), and
 * nothing here moves a band, invents an interval or promotes a model. The
 * evidence columns exist to make the absence of evidence legible, which is a
 * different thing from filling it.
 *
 * ## Inputs the product has that this does not
 *
 * The product routes over the runtime registry's rows, with health exclusions
 * and measured tie-break signals read from the database, under the account's
 * plan and credits, with the conversation's sticky state. This runs over
 * whatever catalogue the caller passes -- the static one, usually -- with no
 * sticky state and only the signals the caller supplies. Every one of those
 * differences is a way the product's answer can differ from this one, and
 * `DiagnosticReport.inputs` records which values were used so a reader can
 * tell what the answer is conditional on.
 *
 * Pure. No I/O, no clock unless injected, no network, no model call.
 */

import { autoFallbackScope, type FallbackScope } from "@/lib/autoFallbackGate";
import { fitChatOutputToContextWindow } from "@/lib/chatContextWindow";
import { toReservedInputTokens } from "@/lib/chatTokenEstimate";
import { resolveModelPricing } from "@/lib/modelPricing";
import type { AiModel, AiProvider, ModelTier } from "@/lib/models";
import {
    filterRouterCandidates,
    type CandidateRejection,
    type RouterCandidate,
} from "@/lib/routerCandidates";
import { expectedTotalCostUsdByModel } from "@/lib/routerCostSignal";
import {
    decideRouterModel,
    ROUTER_VERSIONS,
    type RouterDecision,
    type RouterVersions,
} from "@/lib/routerDecision";
import {
    getRouterScoreCell,
    isRouterScoreSnapshotModel,
    NEUTRAL_QUALITY_BAND,
    rankingKindFor,
    ROUTER_TIE_BREAK_ORDER,
    type RouterQualityBand,
    type RouterTieBreakCriterion,
    type RouterTieBreakSignals,
} from "@/lib/routerScorePolicy";
import { selectRouterModel, type SelectionReason } from "@/lib/routerSelection";
import { decideFallback, MAX_MODEL_FALLBACKS, type FallbackDecision } from "@/lib/routingFallbackPolicy";
import type { TaskKind, TaskProfile } from "@/lib/taskProfileCore";
import type { WebSearchBackendReadiness } from "@/lib/webSearchBackends";

/** Bump with any change to the shape of the report or how a row is derived. */
export const ROUTER_FULL_CATALOG_DIAGNOSTIC_VERSION = "router-full-catalog-diagnostic-v3";

/** One request to diagnose. The shape `EvalSetItem` already has, and no more. */
export type DiagnosticItem = {
    id: string;
    stratum?: string;
    cell?: string;
    prompt: string;
    attachments?: readonly { mediaType?: string }[];
    webSearchRequested?: boolean;
};

export type DiagnosticInput = {
    items: readonly DiagnosticItem[];
    /** The whole catalogue, disabled and unlisted models included. */
    models: readonly AiModel[];
    plan: ModelTier | "Guest";
    /**
     * The model whose output cap the Router routes under.
     *
     * The product resolves `requestOutputCapTokens` from the model the user
     * had selected *before* Auto ran (`app/api/chat/route.ts`, the
     * `selectAutoModel` call), and the candidate filter fits that one figure
     * to every candidate's window. It is an input here for the same reason:
     * the diagnostic has to route under the cap the product would, and
     * report what changes when dispatch then budgets the chosen model under
     * its own.
     */
    requestedModelId: string;
    searchBackendReadiness: WebSearchBackendReadiness;
    unhealthyModelIds?: readonly string[];
    regionBlockedModelIds?: readonly string[];
    availableCredits?: number;
    creditsByModelId?: Readonly<Record<string, number>>;
    signals?: RouterTieBreakSignals;
    /**
     * The environment the fallback gate reads its flag from. Defaults to an
     * empty one, which is the shipped state: `AUTO_ROUTER_FALLBACK_ENABLED`
     * unset, so no fallback executes. `fallback.scopeIfFlagOn` is computed
     * under the flag regardless, so the report shows both what would happen
     * today and what would happen once the flag is turned on.
     */
    fallbackEnvironment?: Record<string, string | undefined>;
    /** Where the catalogue came from, for the record. */
    catalogueSource?: string;
    now?: () => number;
};

export type QualityEvidenceStatus =
    /** The score policy holds no approved record for this (model, task). */
    | "no_evidence"
    /** An approved record moved this cell off neutral. */
    | "approved_evidence";

/**
 * The failure the fallback question is asked about. `decideFallback` decides
 * on what happened to the primary, and offline nothing has happened, so the
 * diagnostic asks the one question the fallback path exists for: the primary
 * failed at the provider before any token was shown, with none of §7's
 * excluded answers. Every other failure shape terminates by policy, and a
 * report that picked one of those would be reporting that fallback is
 * refused, which is true and useless.
 */
export const FALLBACK_FAILURE_HYPOTHESIS = {
    outcome: "failed_pre_token",
    failureLayer: "provider",
    providerRefusal: null,
    visibleTokenEmitted: false,
    passThroughUsed: false,
    rerouteCount: 0,
} as const;

/** `decideFallback`'s own answer under the hypothesis, recorded as given. */
export type FallbackDecisionRecord = {
    version: string;
    action: FallbackDecision["action"];
    modelId: string | null;
    reason: string | null;
};

/**
 * Whether a turn could reach a fallback, as far as can be decided offline,
 * in the product's own order (`app/api/chat/route.ts`, `attemptFallback`):
 * the gate (`autoFallbackScope`), then `decideFallback` under the stated
 * hypothesis, then the one candidate it names fitted under dispatch's cap
 * the way `planAttemptExecution` fits it. `refusal` names the step that
 * said no: `gate:<reason>`, `decision:<reason>`, or
 * `candidate_context_window_exceeded`.
 *
 * `planAttemptExecution` itself is not called: it builds the provider client
 * and the credit budget for a real dispatch, which an offline report has no
 * account, credentials or reservation for. Its refusals that depend on
 * those, and the two runtime checks the route makes around it, are listed
 * in `unverifiedConditions` on every reachable answer, so `reachable: true`
 * reads as "nothing decidable offline refused it" and not as a promise.
 */
export type FallbackReachability =
    | {
          reachable: true;
          modelId: string;
          dispatchFit: "fitted" | "unbounded";
          dispatchOutputTokens: number | null;
          /**
           * Never "executable": whether the fallback would run is decided
           * by the pre-dispatch check on a real request, against the
           * conditions listed below, which this report cannot see.
           */
          execution: "unverified";
          unverifiedConditions: readonly string[];
      }
    | { reachable: false; refusal: string };

export const FALLBACK_UNVERIFIED_CONDITIONS: readonly string[] = [
    "search_path_unavailable: planAttemptExecution refuses a candidate that cannot search when the primary's turn had a search path; the request's web-search mode is not an input here",
    "budget_refused: createChatBudget and reserveTurnSearchCost need the account's credits and the provider budget",
    "candidate_unavailable: the runtime registry row's enabled and catalogDeleted state; this report reads the catalogue passed in",
    "no_provider_hold: the primary's provider reservation for this turn",
];

export type ModelDisposition = {
    modelId: string;
    provider: AiProvider;
    apiModel: string;
    enabled: boolean;
    publiclyListed: boolean;
    minimumPlan: AiModel["minimumPlan"];
    contextWindowTokens: number | null;
    /** Enrolled in `ROUTER_SCORE_SNAPSHOT`. Absence is unmeasured, not bad. */
    inScoreSnapshot: boolean;
    disposition: "primary" | "fallback_candidate" | "rejected";
    /** The first hard filter it failed, or null when it was eligible. */
    rejectionReason: CandidateRejection | null;
    /** 1-based position in the Router's ranking; null when rejected. */
    rank: number | null;
    /** Output room the Router computed for it; null when rejected. */
    routerOutputTokens: number | null;
    quality: {
        band: RouterQualityBand;
        evidenceRef: string | null;
        qualityCi95Lower: number | null;
        status: QualityEvidenceStatus;
    };
    /** The cost figure the tie-break compared, from the pricing registry. */
    expectedTotalCostUsd: number | null;
    /**
     * How this model compares with the primary, head to head, using the
     * product's own comparator. Null for the primary itself and for rejected
     * models. `wouldBeatPrimary` is true when the pairwise call picks this
     * model over the primary -- possible only if the tie-break's epsilons
     * make the order non-transitive, and reported rather than hidden when it
     * happens.
     */
    versusPrimary: {
        decidedBy: RouterTieBreakCriterion;
        marginBands: number;
        wouldBeatPrimary: boolean;
    } | null;
};

export type CapReconciliation = {
    /** What the Router routed every candidate under. */
    routerRequestOutputCapTokens: number;
    routerReservedInputTokens: number;
    /** The primary's own figures, as dispatch will resolve them. */
    primary: {
        modelId: string;
        routerOutputTokens: number;
        dispatchRequestOutputCapTokens: number;
        dispatchProviderMaxOutputTokens: number | null;
        dispatchReservedInputTokens: number;
        dispatchOutputTokens: number | null;
        dispatchFit: "fitted" | "unbounded" | "exceeded";
        outputCapDiffers: boolean;
        reservedInputDiffers: boolean;
    } | null;
    /**
     * What the offline reservation does not model: dispatch adds a search
     * tool's input overhead and prices under the account's access kind.
     * Stated so the `dispatchReservedInputTokens` figure is read as a floor.
     */
    notModelled: readonly string[];
};

export type ItemDiagnostic = {
    itemId: string;
    stratum: string | null;
    cell: string | null;
    profile: {
        version: string;
        kind: TaskKind;
        kindConfidence: TaskProfile["kindConfidence"];
        /** The snapshot column that actually ranked this item. */
        rankingKind: TaskKind;
        needsCurrentInformation: boolean;
        hasImageInput: boolean;
        hasDocumentInput: boolean;
        expectedOutputLength: TaskProfile["expectedOutputLength"];
        signals: readonly string[];
    };
    decision: {
        outcome: RouterDecision["outcome"];
        primaryModelId: string | null;
        selectionReason: SelectionReason;
        decidedBy: RouterTieBreakCriterion | null;
        marginBands: number;
        rankedModelIds: readonly string[];
        fallbackCandidateModelIds: readonly string[];
    };
    /** Every model in the catalogue, in catalogue order. */
    models: readonly ModelDisposition[];
    fallback: {
        /** Best first, from the Router; what docs/policy/tomverse-chat-routing.md §7 may try. */
        rankedCandidateModelIds: readonly string[];
        /** How many of those a turn may actually fall back to. */
        maxModelFallbacks: number;
        scopeAsDeployed: FallbackScope;
        scopeIfFlagOn: FallbackScope;
        /**
         * The candidate `decideFallback` would name -- the first ranked one --
         * re-fitted under dispatch's own cap the way `planAttemptExecution`
         * will. Null when there is none. Whether a turn could reach it is the
         * next two fields' question, not this one's: a candidate the gate
         * refuses, or one dispatch cannot fit, is still listed here.
         */
        firstCandidate: {
            modelId: string;
            dispatchFit: "fitted" | "unbounded" | "exceeded";
            dispatchOutputTokens: number | null;
        } | null;
        /**
         * `decideFallback`'s own answer, called with the product's function
         * under `FALLBACK_FAILURE_HYPOTHESIS` and the Router's ranked
         * candidates. The product tries the one candidate it names and no
         * other (`MAX_MODEL_FALLBACKS`).
         */
        decision: FallbackDecisionRecord;
        /**
         * Whether a turn could reach a fallback as deployed, as far as can be
         * decided offline: gate, decision, dispatch fit, in the product's
         * order. A refusal at any step is the turn ending on the primary's
         * failure, and `refusal` names the step.
         */
        reachableAsDeployed: FallbackReachability;
        /** The same question with `AUTO_ROUTER_FALLBACK_ENABLED` turned on. */
        reachableIfFlagOn: FallbackReachability;
        /**
         * What the product decides at runtime that this cannot: the
         * hypothesis the decision was asked under, and the refusals only a
         * real dispatch can raise. Stated so the two answers above are read
         * as necessary conditions, not a promise.
         */
        notModelled: readonly string[];
    };
    caps: CapReconciliation;
    evidence: {
        rankingKind: TaskKind;
        eligibleWithEvidence: readonly string[];
        eligibleWithoutEvidence: readonly string[];
        /** True when no quality evidence touched the choice. */
        decidedWithoutQualityEvidence: boolean;
    };
    consistency: {
        agreesWithProduct: boolean;
        problems: readonly string[];
    };
};

export type ImprovementCandidate = {
    /** Fixed identifier, never prose derived from a prompt. */
    kind:
        | "context_window_undeclared"
        | "never_eligible"
        | "eligible_never_primary"
        | "no_quality_evidence_for_kind"
        | "decided_by_tie_break"
        | "web_search_capability_gap"
        | "output_cap_mismatch"
        | "pairwise_inversion"
        | "fallback_candidate_does_not_fit";
    modelIds: readonly string[];
    taskKinds: readonly TaskKind[];
    itemCount: number;
    detail: string;
};

export type DiagnosticReport = {
    version: string;
    routerVersions: RouterVersions;
    inputs: {
        catalogueSource: string;
        catalogueModelCount: number;
        enabledModelCount: number;
        itemCount: number;
        plan: ModelTier | "Guest";
        requestedModelId: string;
        routerRequestOutputCapTokens: number;
        searchBackendReadiness: WebSearchBackendReadiness;
        signalsSupplied: readonly (keyof RouterTieBreakSignals)[];
        unhealthyModelIds: readonly string[];
        stickyState: "none";
        fallbackFlagAsDeployed: "on" | "off";
    };
    items: readonly ItemDiagnostic[];
    summary: {
        primaryCounts: Readonly<Record<string, number>>;
        primaryCountsByKind: Readonly<Record<TaskKind, Readonly<Record<string, number>>>>;
        decidedByCounts: Readonly<Record<RouterTieBreakCriterion | "none", number>>;
        rejectionCounts: Readonly<Record<CandidateRejection, number>>;
        /** Models never eligible on any item, with every reason they were refused for. */
        neverEligible: readonly { modelId: string; reasons: readonly CandidateRejection[] }[];
        eligibleNeverPrimary: readonly string[];
        evidenceCells: { withEvidence: number; total: number };
        outputCapMismatchItems: number;
        consistencyProblems: number;
        pairwiseInversions: number;
        fallbackScopeAsDeployed: Readonly<Record<string, number>>;
        /** Items by `reachable` or by the refusal that stopped them, as deployed. */
        fallbackReachableAsDeployed: Readonly<Record<string, number>>;
        /** The same with the flag on. */
        fallbackReachableIfFlagOn: Readonly<Record<string, number>>;
    };
    improvementCandidates: readonly ImprovementCandidate[];
    /** Anything that stops this report being read as the product's answer. */
    problems: readonly string[];
};

const versionOf = (): RouterVersions => ROUTER_VERSIONS;

const qualityFor = (modelId: string, kind: TaskKind) => {
    const cell = getRouterScoreCell(modelId, kind);
    return {
        band: cell.qualityBand,
        evidenceRef: cell.evidenceRef,
        qualityCi95Lower: cell.qualityCi95Lower,
        status: (cell.evidenceRef === null ? "no_evidence" : "approved_evidence") as QualityEvidenceStatus,
    };
};

const sameList = (left: readonly string[], right: readonly string[]) =>
    left.length === right.length && left.every((value, index) => value === right[index]);

/** `decideFallback`, asked the product's question under the stated hypothesis. */
export const fallbackDecisionFor = (primaryModelId: string, rankedCandidateModelIds: readonly string[]): FallbackDecisionRecord => {
    const decision = decideFallback({
        attempt: {
            modelId: primaryModelId,
            outcome: FALLBACK_FAILURE_HYPOTHESIS.outcome,
            failureLayer: FALLBACK_FAILURE_HYPOTHESIS.failureLayer,
            providerRefusal: FALLBACK_FAILURE_HYPOTHESIS.providerRefusal,
        },
        run: {
            passThroughUsed: FALLBACK_FAILURE_HYPOTHESIS.passThroughUsed,
            rerouteCount: FALLBACK_FAILURE_HYPOTHESIS.rerouteCount,
            visibleTokenEmitted: FALLBACK_FAILURE_HYPOTHESIS.visibleTokenEmitted,
        },
        nextCandidateModelIds: rankedCandidateModelIds,
    });
    return {
        version: decision.version,
        action: decision.action,
        modelId: decision.action === "terminate" ? null : decision.modelId,
        reason: decision.action === "terminate" ? decision.reason : null,
    };
};

/**
 * Whether a turn could reach a fallback, in the product's own order
 * (`app/api/chat/route.ts`, `attemptFallback`): the gate first, then the
 * decision, then dispatch fitting the one candidate the decision names.
 * `candidate` is that candidate as dispatch would fit it, or null when the
 * decision named none. The refusals only a real dispatch can raise are
 * carried on every reachable answer.
 */
export const fallbackReachabilityFor = (
    scope: FallbackScope,
    decision: FallbackDecisionRecord,
    candidate: ItemDiagnostic["fallback"]["firstCandidate"]
): FallbackReachability => {
    if (!scope.allowed) return { reachable: false, refusal: `gate:${scope.reason}` };
    if (decision.action !== "fallback") return { reachable: false, refusal: `decision:${decision.reason ?? decision.action}` };
    if (!candidate || candidate.modelId !== decision.modelId) {
        return { reachable: false, refusal: `decision:${decision.modelId} is not the candidate dispatch was asked to fit` };
    }
    if (candidate.dispatchFit === "exceeded") {
        return { reachable: false, refusal: "candidate_context_window_exceeded" };
    }
    return {
        reachable: true,
        modelId: candidate.modelId,
        dispatchFit: candidate.dispatchFit,
        dispatchOutputTokens: candidate.dispatchOutputTokens,
        execution: "unverified",
        unverifiedConditions: FALLBACK_UNVERIFIED_CONDITIONS,
    };
};

const diagnoseItem = (item: DiagnosticItem, input: DiagnosticInput, requestOutputCapTokens: number): ItemDiagnostic => {
    const reservedInputTokens = Math.max(1, Math.ceil(Buffer.byteLength(item.prompt, "utf8") / 4));
    const attachments = (item.attachments ?? []).map((attachment) => ({ mediaType: attachment.mediaType }));
    const routerInput = {
        text: item.prompt,
        attachments,
        webSearchRequested: item.webSearchRequested === true,
        models: input.models,
        plan: input.plan,
        searchBackendReadiness: input.searchBackendReadiness,
        reservedInputTokens,
        requestOutputCapTokens,
        unhealthyModelIds: input.unhealthyModelIds,
        regionBlockedModelIds: input.regionBlockedModelIds,
        availableCredits: input.availableCredits,
        creditsByModelId: input.creditsByModelId,
        signals: input.signals,
        sticky: null,
    };

    // The product's decision. Everything below explains it and nothing below
    // replaces it.
    const decision = decideRouterModel(routerInput, input.now ?? Date.now);
    const profile = decision.profile;
    const rankingKind = rankingKindFor(profile);

    // The explanation: the same filter and the same selector, called again
    // with the same inputs, so per-model detail the decision does not carry
    // (each candidate's output room, each loser's head-to-head) can be read
    // off. `consistency` says whether they agreed.
    const candidates = filterRouterCandidates({
        models: input.models,
        plan: input.plan,
        profile,
        searchBackendReadiness: input.searchBackendReadiness,
        reservedInputTokens,
        requestOutputCapTokens,
        unhealthyModelIds: input.unhealthyModelIds,
        regionBlockedModelIds: input.regionBlockedModelIds,
        availableCredits: input.availableCredits,
        creditsByModelId: input.creditsByModelId,
    });
    const signals: RouterTieBreakSignals = {
        expectedTotalCostUsdByModelId: expectedTotalCostUsdByModel({
            models: input.models,
            reservedInputTokens,
            requestOutputCapTokens,
        }),
        ...input.signals,
    };
    const selection = selectRouterModel({ profile, eligible: candidates.eligible, sticky: null, signals });

    const problems: string[] = [];
    const record = decision.record;
    if (!sameList(record.eligibleModelIds, candidates.eligible.map((candidate) => candidate.modelId))) {
        problems.push("the explanation's eligible set differs from the decision's");
    }
    const recordRejections = record.rejections.map((entry) => `${entry.modelId}:${entry.reason}`);
    const explainRejections = candidates.rejected.map((entry) => `${entry.modelId}:${entry.reason}`);
    if (!sameList(recordRejections, explainRejections)) {
        problems.push("the explanation's rejections differ from the decision's");
    }
    if (selection.selectedModelId !== record.selectedModelId) {
        problems.push(
            `the explanation selected ${selection.selectedModelId ?? "nothing"} and the decision ${record.selectedModelId ?? "nothing"}`
        );
    }
    if (selection.decidedBy !== record.selectionDecidedBy) {
        problems.push("the explanation and the decision name different deciding criteria");
    }

    const primaryModelId = decision.outcome === "selected" ? decision.modelId : null;
    const rankedModelIds = selection.rankedModelIds;
    const rankOf = new Map(rankedModelIds.map((modelId, index) => [modelId, index + 1]));
    const candidateOf = new Map(candidates.eligible.map((candidate) => [candidate.modelId, candidate]));
    const rejectionOf = new Map(candidates.rejected.map((entry) => [entry.modelId, entry.reason]));
    const primaryCandidate = primaryModelId ? candidateOf.get(primaryModelId) ?? null : null;

    const versus = (candidate: RouterCandidate): ModelDisposition["versusPrimary"] => {
        if (!primaryCandidate || candidate.modelId === primaryCandidate.modelId) return null;
        const pair = selectRouterModel({
            profile,
            eligible: [primaryCandidate, candidate],
            sticky: null,
            signals,
        });
        return {
            decidedBy: pair.decidedBy ?? "model_id",
            marginBands: pair.margin,
            wouldBeatPrimary: pair.selectedModelId === candidate.modelId,
        };
    };

    const models: ModelDisposition[] = input.models.map((model) => {
        const candidate = candidateOf.get(model.id) ?? null;
        const rejection = rejectionOf.get(model.id) ?? null;
        if (candidate === null && rejection === null) {
            problems.push(`${model.id} is neither eligible nor rejected, so the filter did not see it`);
        }
        return {
            modelId: model.id,
            provider: model.provider,
            apiModel: model.apiModel,
            enabled: model.enabled,
            publiclyListed: model.publiclyListed !== false,
            minimumPlan: model.minimumPlan,
            contextWindowTokens: model.contextWindowTokens ?? null,
            inScoreSnapshot: isRouterScoreSnapshotModel(model.id),
            disposition:
                model.id === primaryModelId ? "primary" : candidate ? "fallback_candidate" : "rejected",
            rejectionReason: rejection,
            rank: rankOf.get(model.id) ?? null,
            routerOutputTokens: candidate?.outputTokens ?? null,
            quality: qualityFor(model.id, rankingKind),
            expectedTotalCostUsd: signals.expectedTotalCostUsdByModelId?.[model.id] ?? null,
            versusPrimary: candidate ? versus(candidate) : null,
        };
    });

    // Dispatch fits the chosen model under *its own* pricing cap and the
    // provider's verified ceiling, with the reservation the estimator makes.
    // The Router fitted it under the requested model's cap with the raw
    // estimate. Both figures are reported; neither is corrected.
    const dispatchFitFor = (modelId: string) => {
        const model = input.models.find((entry) => entry.id === modelId);
        if (!model) return null;
        const pricing = resolveModelPricing(model, { estimatedPromptTokens: reservedInputTokens });
        const dispatchReservedInputTokens = toReservedInputTokens(reservedInputTokens);
        const fit = fitChatOutputToContextWindow({
            contextWindowTokens: model.contextWindowTokens,
            reservedInputTokens: dispatchReservedInputTokens,
            requestOutputCapTokens: pricing.maxOutputTokens,
            providerMaxOutputTokens: pricing.providerMaxOutputTokens,
        });
        return {
            pricing,
            dispatchReservedInputTokens,
            fit: fit.kind,
            outputTokens: fit.kind === "fitted" ? fit.outputTokens : null,
        };
    };

    const primaryDispatch = primaryModelId ? dispatchFitFor(primaryModelId) : null;
    const caps: CapReconciliation = {
        routerRequestOutputCapTokens: requestOutputCapTokens,
        routerReservedInputTokens: reservedInputTokens,
        primary:
            primaryModelId && primaryCandidate && primaryDispatch
                ? {
                      modelId: primaryModelId,
                      routerOutputTokens: primaryCandidate.outputTokens,
                      dispatchRequestOutputCapTokens: primaryDispatch.pricing.maxOutputTokens,
                      dispatchProviderMaxOutputTokens: primaryDispatch.pricing.providerMaxOutputTokens,
                      dispatchReservedInputTokens: primaryDispatch.dispatchReservedInputTokens,
                      dispatchOutputTokens: primaryDispatch.outputTokens,
                      dispatchFit: primaryDispatch.fit,
                      outputCapDiffers:
                          primaryDispatch.pricing.maxOutputTokens !== requestOutputCapTokens ||
                          primaryDispatch.outputTokens !== primaryCandidate.outputTokens,
                      reservedInputDiffers:
                          primaryDispatch.dispatchReservedInputTokens !== reservedInputTokens,
                  }
                : null,
        notModelled: [
            "search tool input overhead (estimateToolInputTokenOverhead)",
            "access-kind pricing and credit reservation (createChatBudget)",
            "runtime registry rows in place of the static catalogue",
        ],
    };

    const fallbackCandidateModelIds =
        decision.outcome === "selected" ? decision.fallbackCandidateModelIds : [];
    const scopeInput = {
        routed: decision.outcome === "selected",
        isGuest: input.plan === "Guest",
        toolsOffered: false,
        nativeSearchEnabled: profile.needsCurrentInformation,
        appManagedSearchEnabled: false,
        deepResearch: false,
        hasAttachments: attachments.length > 0,
        candidateCount: fallbackCandidateModelIds.length,
    };
    const scopeAsDeployed = autoFallbackScope({ ...scopeInput, environment: input.fallbackEnvironment ?? {} });
    const scopeIfFlagOn = autoFallbackScope({
        ...scopeInput,
        environment: { ...(input.fallbackEnvironment ?? {}), AUTO_ROUTER_FALLBACK_ENABLED: "on" },
    });
    // The product's own decision function, asked under the stated hypothesis
    // with the Router's ranked candidates. Dispatch is then asked to fit the
    // one candidate it names (or, when it names none, the one the Router
    // ranked next, so the report still shows what was there).
    const fallbackDecision = fallbackDecisionFor(primaryModelId ?? "(no primary)", fallbackCandidateModelIds);
    const firstFallback = fallbackDecision.modelId ?? fallbackCandidateModelIds[0] ?? null;
    const firstFallbackFit = firstFallback ? dispatchFitFor(firstFallback) : null;
    const firstCandidate =
        firstFallback && firstFallbackFit
            ? {
                  modelId: firstFallback,
                  dispatchFit: firstFallbackFit.fit,
                  dispatchOutputTokens: firstFallbackFit.outputTokens,
              }
            : null;

    const eligibleIds = candidates.eligible.map((candidate) => candidate.modelId);
    const eligibleWithEvidence = eligibleIds.filter(
        (modelId) => getRouterScoreCell(modelId, rankingKind).evidenceRef !== null
    );

    return {
        itemId: item.id,
        stratum: item.stratum ?? null,
        cell: item.cell ?? null,
        profile: {
            version: profile.version,
            kind: profile.kind,
            kindConfidence: profile.kindConfidence,
            rankingKind,
            needsCurrentInformation: profile.needsCurrentInformation,
            hasImageInput: profile.hasImageInput,
            hasDocumentInput: profile.hasDocumentInput,
            expectedOutputLength: profile.expectedOutputLength,
            signals: profile.signals,
        },
        decision: {
            outcome: decision.outcome,
            primaryModelId,
            selectionReason: record.selectionReason,
            decidedBy: record.selectionDecidedBy,
            marginBands: record.selectionMargin,
            rankedModelIds,
            fallbackCandidateModelIds,
        },
        models,
        fallback: {
            rankedCandidateModelIds: fallbackCandidateModelIds,
            maxModelFallbacks: MAX_MODEL_FALLBACKS,
            scopeAsDeployed,
            scopeIfFlagOn,
            firstCandidate,
            decision: fallbackDecision,
            reachableAsDeployed: fallbackReachabilityFor(scopeAsDeployed, fallbackDecision, firstCandidate),
            reachableIfFlagOn: fallbackReachabilityFor(scopeIfFlagOn, fallbackDecision, firstCandidate),
            notModelled: [
                `the decision is asked under one hypothesis: the primary failed ${FALLBACK_FAILURE_HYPOTHESIS.outcome} at the ${FALLBACK_FAILURE_HYPOTHESIS.failureLayer} layer with no provider refusal and no visible token; any other failure shape terminates by policy`,
                ...FALLBACK_UNVERIFIED_CONDITIONS,
            ],
        },
        caps,
        evidence: {
            rankingKind,
            eligibleWithEvidence,
            eligibleWithoutEvidence: eligibleIds.filter((modelId) => !eligibleWithEvidence.includes(modelId)),
            decidedWithoutQualityEvidence:
                eligibleWithEvidence.length === 0 || record.selectionDecidedBy !== "quality_band",
        },
        consistency: { agreesWithProduct: problems.length === 0, problems },
    };
};

const count = <K extends string>(keys: Iterable<K>): Record<K, number> => {
    const counts = {} as Record<K, number>;
    for (const key of keys) counts[key] = (counts[key] ?? 0) + 1;
    return counts;
};

export const diagnoseFullCatalog = (input: DiagnosticInput): DiagnosticReport => {
    const problems: string[] = [];
    const requestedModel = input.models.find((model) => model.id === input.requestedModelId);
    if (!requestedModel) {
        throw new Error(
            `requestedModelId ${input.requestedModelId} is not in the catalogue, so there is no cap to route under.`
        );
    }
    // The same resolution the chat route makes before Auto runs.
    const requestOutputCapTokens = resolveModelPricing(requestedModel).maxOutputTokens;

    const items = input.items.map((item) => diagnoseItem(item, input, requestOutputCapTokens));

    const primaryIds = items.flatMap((item) => (item.decision.primaryModelId ? [item.decision.primaryModelId] : []));
    const primaryCounts = count(primaryIds);
    const primaryCountsByKind = {} as Record<TaskKind, Record<string, number>>;
    for (const item of items) {
        if (!item.decision.primaryModelId) continue;
        const byModel = (primaryCountsByKind[item.profile.rankingKind] ??= {});
        byModel[item.decision.primaryModelId] = (byModel[item.decision.primaryModelId] ?? 0) + 1;
    }
    const decidedByCounts = count(items.map((item) => item.decision.decidedBy ?? "none"));
    const rejectionCounts = count(
        items.flatMap((item) =>
            item.models.flatMap((model) => (model.rejectionReason ? [model.rejectionReason] : []))
        )
    );

    const everEligible = new Set<string>();
    const reasonsByModel = new Map<string, Set<CandidateRejection>>();
    for (const item of items) {
        for (const model of item.models) {
            if (model.rejectionReason === null) everEligible.add(model.modelId);
            else {
                const reasons = reasonsByModel.get(model.modelId) ?? new Set();
                reasons.add(model.rejectionReason);
                reasonsByModel.set(model.modelId, reasons);
            }
        }
    }
    const neverEligible = input.models
        .filter((model) => !everEligible.has(model.id))
        .map((model) => ({
            modelId: model.id,
            reasons: [...(reasonsByModel.get(model.id) ?? [])].sort(),
        }));
    const eligibleNeverPrimary = [...everEligible].filter((modelId) => !(modelId in primaryCounts)).sort();

    const kindsSeen = [...new Set(items.map((item) => item.profile.rankingKind))].sort();
    const evidenceTotal = input.models.filter((model) => model.enabled).length * kindsSeen.length;
    let evidenceWith = 0;
    for (const model of input.models) {
        if (!model.enabled) continue;
        for (const kind of kindsSeen) {
            if (getRouterScoreCell(model.id, kind).evidenceRef !== null) evidenceWith += 1;
        }
    }

    const outputCapMismatchItems = items.filter((item) => item.caps.primary?.outputCapDiffers).length;
    const consistencyProblems = items.filter((item) => !item.consistency.agreesWithProduct).length;
    const pairwiseInversions = items.reduce(
        (sum, item) => sum + item.models.filter((model) => model.versusPrimary?.wouldBeatPrimary).length,
        0
    );
    for (const item of items) {
        for (const problem of item.consistency.problems) problems.push(`${item.itemId}: ${problem}`);
    }
    const fallbackScopeAsDeployed = count(
        items.map((item) => (item.fallback.scopeAsDeployed.allowed ? "allowed" : item.fallback.scopeAsDeployed.reason))
    );
    const reachableKey = (answer: FallbackReachability) => (answer.reachable ? "reachable" : answer.refusal);
    const fallbackReachableAsDeployed = count(items.map((item) => reachableKey(item.fallback.reachableAsDeployed)));
    const fallbackReachableIfFlagOn = count(items.map((item) => reachableKey(item.fallback.reachableIfFlagOn)));

    const improvementCandidates: ImprovementCandidate[] = [];
    const undeclared = input.models
        .filter((model) => model.enabled && !model.contextWindowTokens)
        .map((model) => model.id);
    if (undeclared.length > 0) {
        improvementCandidates.push({
            kind: "context_window_undeclared",
            modelIds: undeclared,
            taskKinds: kindsSeen,
            itemCount: items.length,
            detail:
                "enabled but declares no context window in this catalogue, so the Router refuses it on every " +
                "item (context_window_undeclared). Declaring the window is what makes it reachable; nothing " +
                "about its quality is known either way.",
        });
    }
    const neverEligibleOther = neverEligible.filter(
        (entry) => !undeclared.includes(entry.modelId) && input.models.find((m) => m.id === entry.modelId)?.enabled
    );
    if (neverEligibleOther.length > 0) {
        improvementCandidates.push({
            kind: "never_eligible",
            modelIds: neverEligibleOther.map((entry) => entry.modelId),
            taskKinds: kindsSeen,
            itemCount: items.length,
            detail:
                "enabled and never eligible on any item, for: " +
                neverEligibleOther.map((entry) => `${entry.modelId} (${entry.reasons.join(", ")})`).join("; "),
        });
    }
    if (eligibleNeverPrimary.length > 0) {
        improvementCandidates.push({
            kind: "eligible_never_primary",
            modelIds: eligibleNeverPrimary,
            taskKinds: kindsSeen,
            itemCount: items.length,
            detail:
                "passed every hard filter on at least one item and was never chosen. With every quality band " +
                "neutral, the tie-break decides, and these lose it; a comparative evaluation on the kinds they " +
                "are eligible for is what could change that, and nothing else should.",
        });
    }
    for (const kind of kindsSeen) {
        const eligibleForKind = new Set(
            items
                .filter((item) => item.profile.rankingKind === kind)
                .flatMap((item) => item.evidence.eligibleWithoutEvidence)
        );
        if (eligibleForKind.size > 0) {
            improvementCandidates.push({
                kind: "no_quality_evidence_for_kind",
                modelIds: [...eligibleForKind].sort(),
                taskKinds: [kind],
                itemCount: items.filter((item) => item.profile.rankingKind === kind).length,
                detail: `eligible for ${kind} items with no approved quality evidence for that kind.`,
            });
        }
        const tieBreakItems = items.filter(
            (item) =>
                item.profile.rankingKind === kind &&
                item.decision.decidedBy !== null &&
                item.decision.decidedBy !== "quality_band"
        );
        if (tieBreakItems.length > 0) {
            const criteria = [...new Set(tieBreakItems.map((item) => item.decision.decidedBy))];
            improvementCandidates.push({
                kind: "decided_by_tie_break",
                modelIds: [...new Set(tieBreakItems.flatMap((item) => item.decision.primaryModelId ?? []))].sort(),
                taskKinds: [kind],
                itemCount: tieBreakItems.length,
                detail: `${kind}: the primary was separated from the runner-up by ${criteria.join(", ")}, not by quality.`,
            });
        }
    }
    const searchGap = new Set(
        items.flatMap((item) =>
            item.models
                .filter(
                    (model) =>
                        model.rejectionReason === "web_search_unverified" ||
                        model.rejectionReason === "web_search_cost_unbounded"
                )
                .map((model) => model.modelId)
        )
    );
    if (searchGap.size > 0) {
        improvementCandidates.push({
            kind: "web_search_capability_gap",
            modelIds: [...searchGap].sort(),
            taskKinds: kindsSeen,
            itemCount: items.filter((item) => item.profile.needsCurrentInformation).length,
            detail:
                "refused on current-information items because search support is unverified or its cost cannot " +
                "be bounded. Verifying the register entry, or a backend credential, is what would admit them.",
        });
    }
    if (outputCapMismatchItems > 0) {
        improvementCandidates.push({
            kind: "output_cap_mismatch",
            modelIds: [
                ...new Set(items.filter((item) => item.caps.primary?.outputCapDiffers).map((item) => item.caps.primary!.modelId)),
            ].sort(),
            taskKinds: kindsSeen,
            itemCount: outputCapMismatchItems,
            detail:
                `the Router fitted candidates under ${input.requestedModelId}'s cap (${requestOutputCapTokens}) and ` +
                "dispatch will budget the primary under its own. The candidate set was decided under one number and " +
                "the answer is sized under another.",
        });
    }
    if (pairwiseInversions > 0) {
        improvementCandidates.push({
            kind: "pairwise_inversion",
            modelIds: [
                ...new Set(
                    items.flatMap((item) =>
                        item.models.filter((model) => model.versusPrimary?.wouldBeatPrimary).map((model) => model.modelId)
                    )
                ),
            ].sort(),
            taskKinds: kindsSeen,
            itemCount: pairwiseInversions,
            detail:
                "beats the primary head to head under the product's comparator but ranked below it in the sort. " +
                "The tie-break's epsilons make the order non-transitive on these inputs.",
        });
    }

    const doesNotFit = items.filter(
        (item) =>
            !item.fallback.reachableIfFlagOn.reachable &&
            item.fallback.reachableIfFlagOn.refusal === "candidate_context_window_exceeded"
    );
    if (doesNotFit.length > 0) {
        improvementCandidates.push({
            kind: "fallback_candidate_does_not_fit",
            modelIds: [...new Set(doesNotFit.flatMap((item) => item.fallback.firstCandidate?.modelId ?? []))].sort(),
            taskKinds: [...new Set(doesNotFit.map((item) => item.profile.rankingKind))].sort(),
            itemCount: doesNotFit.length,
            detail:
                "named as the fallback candidate by the Router, which fitted it with the raw input estimate, and " +
                "refused by dispatch, which reserves the widened one; with the flag on the turn would end on the " +
                "primary's failure. The candidate list was decided under one reservation and the attempt under " +
                "another.",
        });
    }

    return {
        version: ROUTER_FULL_CATALOG_DIAGNOSTIC_VERSION,
        routerVersions: versionOf(),
        inputs: {
            catalogueSource: input.catalogueSource ?? "caller-supplied",
            catalogueModelCount: input.models.length,
            enabledModelCount: input.models.filter((model) => model.enabled).length,
            itemCount: items.length,
            plan: input.plan,
            requestedModelId: input.requestedModelId,
            routerRequestOutputCapTokens: requestOutputCapTokens,
            searchBackendReadiness: input.searchBackendReadiness,
            signalsSupplied: Object.keys(input.signals ?? {}) as (keyof RouterTieBreakSignals)[],
            unhealthyModelIds: input.unhealthyModelIds ?? [],
            stickyState: "none",
            fallbackFlagAsDeployed:
                (input.fallbackEnvironment ?? {}).AUTO_ROUTER_FALLBACK_ENABLED === "on" ? "on" : "off",
        },
        items,
        summary: {
            primaryCounts,
            primaryCountsByKind,
            decidedByCounts: decidedByCounts as Record<RouterTieBreakCriterion | "none", number>,
            rejectionCounts: rejectionCounts as Record<CandidateRejection, number>,
            neverEligible,
            eligibleNeverPrimary,
            evidenceCells: { withEvidence: evidenceWith, total: evidenceTotal },
            outputCapMismatchItems,
            consistencyProblems,
            pairwiseInversions,
            fallbackScopeAsDeployed,
            fallbackReachableAsDeployed,
            fallbackReachableIfFlagOn,
        },
        improvementCandidates,
        problems,
    };
};

/** The tie-break order, re-exported so a report can print the policy it read. */
export const TIE_BREAK_ORDER = ROUTER_TIE_BREAK_ORDER;
export const NEUTRAL_BAND = NEUTRAL_QUALITY_BAND;
