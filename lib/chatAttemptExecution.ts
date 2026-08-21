/**
 * Everything a dispatch is built from, derived per attempt instead of captured
 * once.
 *
 * Step 2 of `docs/ops/tomverse-chat-auto-router-rollout.md` §9.1, first half.
 * The note there says swapping `sourceReader` and `result` is not enough, and
 * this module is the reason why in one place: the chat route's stream closure
 * holds `modelConfig`, `activeModel`, `generationSettings`,
 * `webSearchToolConfig`, `requestMaxOutputTokens`, the provider headers and
 * the model id used by settlement, the logs and the stored message. Every one
 * of those is a function of *which model is answering*, and every one of them
 * was computed once, for the primary. A fallback that reused them would send
 * the second model the first model's settings and record its answer under the
 * first model's name.
 *
 * So the unit is a plan, not a set of variables: one model in, one complete
 * dispatch out. What makes the plan trustworthy is that it is pure -- given a
 * model and the request, it computes the same thing every time and can be
 * compared against another model's plan in a test rather than in production.
 *
 * ## Why the refusals are values and not exceptions
 *
 * §6 requires a fallback candidate to pass its own compatibility filters,
 * its own actual-token check and its own manifest. On the primary those
 * refusals are the request failing, and the route raises. On a fallback
 * candidate the same refusal means "not this one" and the run has to carry on
 * to decide what happens next. A thrown `ChatAccessError` cannot express the
 * second without the caller catching an error class to make a routing
 * decision, so the plan returns the refusal and the primary path raises from
 * it.
 */

import {
    ChatAccessError,
    createChatBudget,
    isChatAccessError,
    type ChatBudget,
} from "@/lib/chatSecurity";
import { fitChatOutputToContextWindow } from "@/lib/chatContextWindow";
import { getActiveAiModel } from "@/lib/activeAiModel";
import { getModelGenerationSettings } from "@/lib/modelGenerationCompatibility";
import { getWebSearchCapability } from "@/lib/webSearchCapability";
import { getWebSearchSurchargeCredits } from "@/lib/webSearchCredits";
import {
    hasSearchPath,
    resolveAttemptSearchPath,
    type AttemptSearchPath,
    type SearchPathGap,
} from "@/lib/webSearchPath";
import {
    buildWebSearchToolConfig,
    type WebSearchToolConfig,
} from "@/lib/webSearchToolConfig";
import { perplexityUsageHeaders } from "@/lib/perplexityUsageCapture";
import type { AiModel } from "@/lib/models";
import type { WebSearchMode } from "@/lib/appDefaults";
import type { TokenEstimateBreakdown } from "@/lib/chatTokenEstimate";

/**
 * The names that must come from a plan rather than from an enclosing scope.
 *
 * A list rather than a comment because `tests/chatAttemptExecution.test.mjs`
 * reads it: the failure this guards against is not writing the wrong thing,
 * it is *forgetting* one of these when the fallback is wired up, and a
 * forgotten one bills or records the fallback as the primary.
 */
export const ATTEMPT_BOUND_FIELDS = [
    "modelConfig",
    "activeModel",
    "generationSettings",
    "webSearchToolConfig",
    "maxOutputTokens",
    "maxRetries",
    "headers",
    "budget",
    "outputBudget",
    "searchSurchargeCredits",
    "searchPath",
] as const;

export type AttemptExecutionRequest = {
    /** `"guest"` or the signed-in kind; decides the input ceiling. */
    accessKind: Parameters<typeof createChatBudget>[0];
    inputBreakdown: TokenEstimateBreakdown;
    webSearchMode: WebSearchMode | null;
    traceId: string;
    /** 0 for the primary. Keys the provider usage capture -- see below. */
    attemptIndex: number;
    /**
     * Refuse a candidate that cannot actually search.
     *
     * Off by default, because most turns do not need the web and refusing on
     * an axis the turn never used would only lose the answer. The caller turns
     * it on for a turn whose answer depended on a search -- in practice, a
     * fallback for a primary that had a search path, where the rule in
     * `docs/policy/tomverse-chat-routing.md` §10 that a fallback may not
     * silently change what the user was allowed to get reads in both
     * directions: a searching turn must not quietly continue on a model that
     * will answer from training data instead.
     *
     * `lib/autoFallbackGate.ts` already refuses to fall back at all once a
     * provider-native tool was offered, since a search has been executed and
     * surcharged by then. This covers the case that gate does not: a
     * `search-model` primary, where nothing was offered and nothing was
     * surcharged, so falling back is allowed and the search path can be lost
     * on the way.
     */
    requireSearchPath?: boolean;
};

export type AttemptExecutionPlan = {
    modelId: string;
    provider: AiModel["provider"];
    modelConfig: AiModel;
    /** The provider client bound to this model. */
    activeModel: ReturnType<typeof getActiveAiModel>;
    budget: ChatBudget;
    outputBudget: Extract<
        ReturnType<typeof fitChatOutputToContextWindow>,
        { kind: "fitted" | "unbounded" }
    >;
    /** What the request asks this model to produce, fitted to its window. */
    maxOutputTokens: number;
    nativeSearchEnabled: boolean;
    webSearchToolConfig: WebSearchToolConfig | null;
    /**
     * Whether this attempt can actually search, and why not when it cannot.
     *
     * Computed from what the plan really carries rather than from the
     * capability register alone: passing the Router's web-search filter says
     * the model *may* search, and this says whether this dispatch *will*.
     */
    searchPath: AttemptSearchPath;
    generationSettings: ReturnType<typeof getModelGenerationSettings>;
    searchSurchargeCredits: number;
    /**
     * The key this attempt's provider usage is captured under.
     *
     * Not the trace id, which is what the single-attempt path uses. Perplexity
     * buffers its response bodies per trace and the capture is destructive, so
     * two attempts under one trace id would hand the second attempt's reader
     * the first attempt's body -- or nothing, depending on which got there
     * first. The primary keeps the bare trace id so nothing about the existing
     * path changes; every later attempt gets its own.
     */
    usageCaptureKey: string;
};

export type AttemptExecutionRefusal =
    | {
          kind: "search_path_unavailable";
          modelId: string;
          /** Which half of the invariant failed. A fixed identifier. */
          gap: SearchPathGap;
      }
    | {
          kind: "context_window_exceeded";
          modelId: string;
          modelName: string;
          limitTokens: number;
      }
    | {
          kind: "budget_refused";
          modelId: string;
          /** The refusal `createChatBudget` raised, for the primary to rethrow. */
          error: ChatAccessError;
      };

export type AttemptExecutionResult =
    | { ok: true; plan: AttemptExecutionPlan }
    | { ok: false; refusal: AttemptExecutionRefusal };

export const attemptUsageCaptureKey = (traceId: string, attemptIndex: number) =>
    attemptIndex === 0 ? traceId : `${traceId}:attempt-${attemptIndex}`;

/**
 * One model's complete dispatch, or the reason it has none.
 *
 * Nothing here reads the primary's anything. That is the property under test:
 * two calls with two models must differ in every field of
 * `ATTEMPT_BOUND_FIELDS`, and a plan built for a fallback must be usable
 * without the primary's plan being in scope at all.
 */
export const planAttemptExecution = (
    modelConfig: AiModel,
    request: AttemptExecutionRequest
): AttemptExecutionResult => {
    const capability = getWebSearchCapability(modelConfig.id);
    const nativeSearchEnabled =
        request.webSearchMode === "always" && capability.support === "native";
    const searchSurchargeCredits = getWebSearchSurchargeCredits(
        request.webSearchMode ?? "off",
        capability
    );
    // Built once and read, never rebuilt: the tool configuration this attempt
    // will dispatch is the same object the search-path check is answered from,
    // so the check cannot pass for a request that carried no tools.
    const webSearchToolConfig = nativeSearchEnabled
        ? buildWebSearchToolConfig(capability)
        : null;
    const searchPath = resolveAttemptSearchPath({
        support: capability.support,
        webSearchMode: request.webSearchMode,
        toolConfigBuilt: webSearchToolConfig !== null,
        surchargeCredits: searchSurchargeCredits,
    });

    // Before the budget, deliberately. A candidate that cannot answer the
    // question is not a candidate whose price is interesting, and refusing it
    // here keeps the reason "it cannot search" rather than whatever the budget
    // would have said next.
    if (request.requireSearchPath === true && !hasSearchPath(searchPath)) {
        return {
            ok: false,
            refusal: {
                kind: "search_path_unavailable",
                modelId: modelConfig.id,
                gap: (searchPath as Extract<AttemptSearchPath, { kind: "none" }>)
                    .gap,
            },
        };
    }

    let budget: ChatBudget;
    try {
        budget = createChatBudget(
            request.accessKind,
            modelConfig,
            request.inputBreakdown,
            {
                webSearchSurchargeCredits: searchSurchargeCredits,
                nativeSearchEnabled,
            }
        );
    } catch (error) {
        // The plan cannot be built for this model. On the primary that is the
        // request failing and the caller rethrows; on a candidate it is one
        // more model that did not qualify.
        if (isChatAccessError(error)) {
            return {
                ok: false,
                refusal: { kind: "budget_refused", modelId: modelConfig.id, error },
            };
        }
        throw error;
    }

    const outputBudget = fitChatOutputToContextWindow({
        contextWindowTokens: modelConfig.contextWindowTokens,
        reservedInputTokens: budget.inputTokens,
        requestOutputCapTokens: budget.maxOutputTokens,
        providerMaxOutputTokens: budget.providerMaxOutputTokens,
    });
    if (outputBudget.kind === "exceeded") {
        return {
            ok: false,
            refusal: {
                kind: "context_window_exceeded",
                modelId: modelConfig.id,
                modelName: modelConfig.name,
                limitTokens: outputBudget.limitTokens,
            },
        };
    }

    return {
        ok: true,
        plan: {
            modelId: modelConfig.id,
            provider: modelConfig.provider,
            modelConfig,
            activeModel: getActiveAiModel(modelConfig),
            budget,
            outputBudget,
            maxOutputTokens: outputBudget.outputTokens,
            nativeSearchEnabled,
            webSearchToolConfig,
            searchPath,
            generationSettings: getModelGenerationSettings(modelConfig),
            searchSurchargeCredits,
            usageCaptureKey: attemptUsageCaptureKey(
                request.traceId,
                request.attemptIndex
            ),
        },
    };
};

/**
 * Exactly what a plan contributes to the `streamText` call, besides the model
 * and the messages.
 *
 * One function rather than a spread at the call site, because the call site is
 * where a primary-bound value would be left behind and nobody would see it: a
 * stray `...generationSettings` next to `...attemptDispatchOptions(plan)`
 * reads as harmless and sends the fallback the primary's settings.
 */
export const attemptDispatchOptions = (plan: AttemptExecutionPlan) => ({
    maxOutputTokens: plan.maxOutputTokens,
    // Zhipu's SDK retries internally on failures this application would rather
    // see and record itself.
    maxRetries: plan.provider === "zhipu" ? 0 : undefined,
    headers:
        plan.provider === "perplexity"
            ? perplexityUsageHeaders(plan.usageCaptureKey)
            : undefined,
    ...plan.generationSettings,
    ...(plan.webSearchToolConfig ?? {}),
});

/** The refusal, as the error the primary path has always raised for it. */
export const attemptRefusalError = (
    refusal: AttemptExecutionRefusal
): ChatAccessError =>
    refusal.kind === "budget_refused"
        ? refusal.error
        : refusal.kind === "search_path_unavailable"
          ? // Only reachable for a caller that asked for a search path, which
            // today is a fallback candidate -- and there a refusal is a value
            // the run carries on from, never an error anybody raises. Mapped
            // anyway so the function stays total: a refusal with no error is
            // how a third kind gets added later and silently answers 200.
            new ChatAccessError(
                503,
                "MODEL_WEB_SEARCH_UNAVAILABLE",
                "This answer needs a web search, and no available model could run one for it. Try again in a moment."
            )
        : new ChatAccessError(
              400,
              "MODEL_CONTEXT_WINDOW_EXCEEDED",
              `${refusal.modelName} holds ${refusal.limitTokens.toLocaleString(
                  "en-US"
              )} tokens of conversation and answer together, and this conversation already fills it. Start a new conversation or shorten the attachments.`
          );
