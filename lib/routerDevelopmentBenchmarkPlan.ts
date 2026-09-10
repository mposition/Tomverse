/** An offline development matrix, built from product functions without constructing a provider. */
import { fitChatOutputToContextWindow } from "./chatContextWindow";
import { ACTIVE_ESTIMATOR_VERSION, estimateTokenBreakdown, toReservedInputTokens } from "./chatTokenEstimate";
import { resolveModelPricing } from "./modelPricing";
import type { AiModel, ModelTier } from "./models";
import { CALL_LIMIT_PROFILE_VERSION, resolveCallLimit } from "./routerCallLimits";
import { filterRouterCandidates } from "./routerCandidates";
import { diagnoseFullCatalog, ROUTER_FULL_CATALOG_DIAGNOSTIC_VERSION } from "./routerFullCatalogDiagnostic";
import { NO_WEB_SEARCH_BACKENDS } from "./webSearchBackends";
import { getWebSearchCapability } from "./webSearchCapability";
import type { TaskProfile } from "./taskProfileCore";
import {
    benchmarkDigest, canonicalBenchmarkJson, DEVELOPMENT_GRADER_VERSION, DEVELOPMENT_LIMITS,
    isBenchmarkDigest, isBenchmarkInstant, modelInputForCase, strictBenchmarkObject,
    validateDevelopmentCorpus, type DevelopmentCorpus,
} from "./routerDevelopmentBenchmark";

export const DEVELOPMENT_PLAN_VERSION = "router-development-plan-v1";
export type DevelopmentSource = { commit: string; dirty: boolean; files: Record<string, string> };
export type DevelopmentPlanInput = {
    corpus: DevelopmentCorpus; models: readonly AiModel[]; plan: ModelTier | "Guest";
    requestedModelId: string; createdAt: string; source: DevelopmentSource;
};

export function buildDevelopmentPlan(input: DevelopmentPlanInput) {
    const corpus = validateDevelopmentCorpus(input.corpus);
    if (!isBenchmarkInstant(input.createdAt)) throw new Error("plan_created_at_invalid");
    if (!["Guest", "Free", "Pro", "Max"].includes(input.plan)) throw new Error("plan_tier_invalid");
    const source = strictBenchmarkObject(input.source, ["commit", "dirty", "files"], "source");
    if (typeof source.commit !== "string" || !/^[a-f0-9]{40}$/.test(source.commit) || typeof source.dirty !== "boolean") throw new Error("plan_source_invalid");
    if (!source.files || typeof source.files !== "object" || Array.isArray(source.files) || Object.keys(source.files).length === 0 || Object.values(source.files).some((digest) => !isBenchmarkDigest(digest))) throw new Error("plan_source_digests_invalid");
    if (!input.models.length || input.models.length > DEVELOPMENT_LIMITS.models || new Set(input.models.map((model) => model.id)).size !== input.models.length) throw new Error("plan_catalogue_size_or_duplicate_ids");
    const models = [...input.models].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    if (!models.some((model) => model.id === input.requestedModelId)) throw new Error("plan_unknown_requested_model");
    const diagnostic = diagnoseFullCatalog({
        items: [...corpus.cases].sort((a, b) => a.id < b.id ? -1 : 1).map((item) => ({ id: item.id, prompt: item.prompt })),
        models, plan: input.plan, requestedModelId: input.requestedModelId,
        searchBackendReadiness: NO_WEB_SEARCH_BACKENDS,
        catalogueSource: "lib/models.ts static catalogue; runtime registry unverified",
        now: () => Date.parse(input.createdAt),
    });
    if (diagnostic.problems.length || diagnostic.summary.consistencyProblems) throw new Error("diagnostic_product_inconsistency");
    const manifest = models.map((model) => {
        const pricing = resolveModelPricing(model, { at: Date.parse(input.createdAt) });
        const callLimit = resolveCallLimit(model, "answer");
        // resolveCallLimit has no historical clock argument. Refuse drift instead of re-pricing a saved plan.
        if (callLimit.pricingVersion !== pricing.pricingVersion || callLimit.inputUsdPerMillionTokens !== pricing.inputUsdPerMillionTokens || callLimit.outputUsdPerMillionTokens !== pricing.outputUsdPerMillionTokens) throw new Error("plan_pricing_time_mismatch");
        return {
            modelId: model.id, provider: model.provider, apiModel: model.apiModel,
            pricingApiModelId: pricing.apiModelId, enabled: model.enabled,
            publiclyListed: model.publiclyListed !== false, minimumPlan: model.minimumPlan,
            contextWindowTokens: model.contextWindowTokens ?? null,
            contextWindowSource: "caller catalogue value; provenance files frozen in source.files",
            callLimit, providerMaxOutputTokens: pricing.providerMaxOutputTokens,
            intrinsicSearch: getWebSearchCapability(model.id).support === "search-model",
        };
    });
    const rows = diagnostic.items.flatMap((item) => {
        const testCase = corpus.cases.find((candidate) => candidate.id === item.itemId)!;
        const modelInput = modelInputForCase(testCase);
        const breakdown = estimateTokenBreakdown(modelInput.prompt);
        const reservedInputTokens = toReservedInputTokens(breakdown);
        // A supplied-source fixture declares its execution needs. Keep the product's
        // inferred profile in row.router; this separate profile does not change Auto.
        const fixtureProfile: TaskProfile = {
            version: "development-fixture-requirements-v1", kind: "general", kindConfidence: "none",
            needsCurrentInformation: testCase.requirements.needsSearch,
            hasImageInput: false, hasDocumentInput: false, expectedOutputLength: "short",
            scripts: testCase.language === "ko" ? ["cjk"] : ["latin"],
            signals: ["declared_fixture_requirements"],
        };
        return item.models.map((disposition) => {
            const model = models.find((candidate) => candidate.id === disposition.modelId)!;
            const frozen = manifest.find((entry) => entry.modelId === model.id)!;
            const pricing = resolveModelPricing(model, { estimatedPromptTokens: breakdown.rawTotal, at: Date.parse(input.createdAt) });
            const fit = fitChatOutputToContextWindow({ contextWindowTokens: model.contextWindowTokens, reservedInputTokens, requestOutputCapTokens: frozen.callLimit.requestedMaxOutputTokens, providerMaxOutputTokens: pricing.providerMaxOutputTokens });
            const admission = filterRouterCandidates({ models: [model], plan: input.plan, profile: fixtureProfile, searchBackendReadiness: NO_WEB_SEARCH_BACKENDS, reservedInputTokens, requestOutputCapTokens: frozen.callLimit.requestedMaxOutputTokens });
            const reasons: string[] = [];
            if (admission.rejected[0]) reasons.push(`candidate_filter:${admission.rejected[0].reason}`);
            if (frozen.intrinsicSearch) reasons.push("benchmark:intrinsic_search_model_unsupported_v1");
            if (fit.kind === "unbounded") reasons.push("benchmark:context_window_undeclared");
            if (fit.kind === "exceeded") reasons.push("benchmark:context_exceeded");
            if (pricing.isFallbackPricing) reasons.push("benchmark:unverified_fallback_pricing");
            if (model.apiModel !== pricing.apiModelId) reasons.push("benchmark:api_identity_mismatch");
            const callConfig = {
                callRole: "answer" as const, callLimit: frozen.callLimit,
                proposedMaxOutputTokens: fit.kind === "fitted" ? fit.outputTokens : null,
                contextFit: fit.kind, contextWindowTokens: model.contextWindowTokens ?? null,
                providerMaxOutputTokens: pricing.providerMaxOutputTokens,
                tokenEstimate: { ...breakdown, reservedInputTokens, basis: "prompt_only_estimate_not_provider_tokenization" },
                priceSnapshot: {
                    pricingVersion: pricing.pricingVersion, costSource: pricing.costSource,
                    priceSource: pricing.priceSource, effectiveDate: pricing.effectiveDate,
                    processingTier: pricing.processingTier, routing: pricing.routing,
                    inputUsdPerMillionTokens: pricing.inputUsdPerMillionTokens,
                    outputUsdPerMillionTokens: pricing.outputUsdPerMillionTokens,
                    cachedInputPriceMultiplier: pricing.cachedInputPriceMultiplier,
                    cacheWriteUsdPerMillionTokens: pricing.cacheWriteUsdPerMillionTokens,
                    longContextThresholdTokens: pricing.longContextThresholdTokens,
                    reasoningTokenBilling: pricing.reasoningTokenBilling,
                },
                generationSettings: "unverified_no_provider_request_constructed",
            };
            return {
                rowId: `${testCase.id}::${model.id}`, caseId: testCase.id,
                language: testCase.language, task: testCase.task,
                modelId: model.id, provider: model.provider, apiModel: model.apiModel,
                input: modelInput, promptDigest: benchmarkDigest(modelInput.prompt),
                router: {
                    eligible: disposition.rejectionReason === null, rejectionReason: disposition.rejectionReason,
                    rank: disposition.rank, selected: item.decision.primaryModelId === model.id,
                    taskKind: item.profile.kind, needsCurrentInformation: item.profile.needsCurrentInformation,
                    originalRequestOutputCapTokens: item.caps.routerRequestOutputCapTokens,
                    originalReservedInputTokens: item.caps.routerReservedInputTokens,
                    originalInputEstimateBasis: "existing_diagnostic_utf8_bytes_divided_by_four",
                    originalFittedOutputTokens: disposition.routerOutputTokens,
                },
                benchmarkEligibility: { eligible: reasons.length === 0, reasons, basis: "declared_fixture_requirements_not_router_inference", runtimeEligibility: "unverified" },
                callConfig, callConfigDigest: benchmarkDigest(canonicalBenchmarkJson(callConfig)),
                plannedTokenCostUsdEstimate: reasons.length === 0 && fit.kind === "fitted"
                    ? (reservedInputTokens * pricing.inputUsdPerMillionTokens + fit.outputTokens * pricing.outputUsdPerMillionTokens) / 1_000_000 : null,
            };
        });
    });
    const eligibleRows = rows.filter((row) => row.benchmarkEligibility.eligible);
    const body = {
        schemaVersion: DEVELOPMENT_PLAN_VERSION, purpose: "development-only" as const,
        corpusId: corpus.corpusId, corpusDigest: benchmarkDigest(canonicalBenchmarkJson(corpus)),
        createdAt: input.createdAt, source: input.source,
        catalogueDigest: benchmarkDigest(canonicalBenchmarkJson(manifest)),
        versions: { grader: DEVELOPMENT_GRADER_VERSION, diagnostic: ROUTER_FULL_CATALOG_DIAGNOSTIC_VERSION, callLimits: CALL_LIMIT_PROFILE_VERSION, estimator: ACTIVE_ESTIMATOR_VERSION, router: diagnostic.routerVersions },
        inputs: { plan: input.plan, requestedModelId: input.requestedModelId, catalogueSource: "lib/models.ts static catalogue", searchBackendReadiness: "unverified_no_backend_assumed_ready", credits: "unverified", health: "unverified", region: "unverified", stickyState: "none" },
        models: manifest, rows,
        byCase: corpus.cases.map((item) => {
            const caseRows = rows.filter((row) => row.caseId === item.id);
            return {
                caseId: item.id, catalogueRows: caseRows.length,
                plannedCalls: caseRows.filter((row) => row.benchmarkEligibility.eligible).length,
                refusedRows: caseRows.filter((row) => !row.benchmarkEligibility.eligible).length,
                routerInferredSearch: caseRows[0]?.router.needsCurrentInformation ?? false,
                eligibilityMismatchRows: caseRows.filter((row) => row.router.eligible !== row.benchmarkEligibility.eligible).length,
                refusalReasons: [...new Set(caseRows.flatMap((row) => row.benchmarkEligibility.reasons))].sort(),
            };
        }),
        summary: {
            cases: corpus.cases.length, catalogueModels: models.length, catalogueRows: rows.length,
            plannedCalls: eligibleRows.length, refusedRows: rows.length - eligibleRows.length,
            routerInferenceMismatchCases: diagnostic.items.filter((item) => item.profile.needsCurrentInformation).map((item) => item.itemId),
            routerEligibilityMismatchRows: rows.filter((row) => row.router.eligible !== row.benchmarkEligibility.eligible).length,
            completedActualGenerations: 0, incurredProviderSpendUsd: 0,
            plannedTokenCostUsdEstimate: eligibleRows.reduce((sum, row) => sum + row.plannedTokenCostUsdEstimate!, 0),
        },
        limitations: [
            "Synthetic DEVELOPMENT FIXTURE/CANDIDATE corpus; not human-adopted ROUTE-01 evidence.",
            "Static eligibility is conditional on the specified plan; runtime registry, credits, provider budget, health, regional access and account permissions are unverified.",
            "All catalogue rows are retained. The product's original cap/filter outcome is not replaced by the proposed per-model answer cap and prompt estimate.",
            "Benchmark admission reuses the candidate filter with validated fixture requirements, not the Router's inferred search profile. Any disagreement stays visible; this is not product dispatch admission.",
            "Search, attachments and tools are unsupported in v1; intrinsic search models are retained as refused rows.",
            "The proposed cap uses resolveCallLimit(model, answer) and the product context fitter. No provider request is constructed; settings, provider versions and execution remain unverified.",
            "Token costs are estimates at the proposed output cap, not bills, spending authorization, or guaranteed maxima. Provider tokenization, wrappers, caching and execution may differ.",
            "Offline rescoring requires the same corpus, source bytes and resolved planning snapshot. Changed versions or prices are refused, never silently rerouted or repriced.",
            "No calls, quality intervals, band changes, or release verdicts are produced.",
        ],
    };
    return { ...body, planDigest: benchmarkDigest(canonicalBenchmarkJson(body)) };
}

export type DevelopmentPlan = ReturnType<typeof buildDevelopmentPlan>;

/** Conservative v1: re-derive a frozen plan only from the exact trusted source/corpus snapshot. */
export function validateDevelopmentPlan(value: unknown, input: Omit<DevelopmentPlanInput, "createdAt" | "plan" | "requestedModelId">): DevelopmentPlan {
    canonicalBenchmarkJson(value);
    const saved = strictBenchmarkObject(value, ["schemaVersion", "purpose", "corpusId", "corpusDigest", "createdAt", "source", "catalogueDigest", "versions", "inputs", "models", "rows", "byCase", "summary", "limitations", "planDigest"], "plan");
    if (saved.schemaVersion !== DEVELOPMENT_PLAN_VERSION || saved.purpose !== "development-only") throw new Error("plan_version_or_purpose");
    if (canonicalBenchmarkJson(saved.source) !== canonicalBenchmarkJson(input.source)) throw new Error("plan_source_snapshot_mismatch_use_original_checkout");
    const options = strictBenchmarkObject(saved.inputs, ["plan", "requestedModelId", "catalogueSource", "searchBackendReadiness", "credits", "health", "region", "stickyState"], "plan.inputs");
    if (typeof saved.createdAt !== "string" || typeof options.requestedModelId !== "string") throw new Error("plan_input_invalid");
    const expected = buildDevelopmentPlan({ ...input, createdAt: saved.createdAt, plan: options.plan as DevelopmentPlanInput["plan"], requestedModelId: options.requestedModelId });
    if (canonicalBenchmarkJson(saved) !== canonicalBenchmarkJson(expected)) throw new Error("plan_snapshot_mismatch");
    return expected;
}
