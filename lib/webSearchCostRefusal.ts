import "server-only";

/**
 * The one place a native-search cost refusal is built, and the one place it is
 * recorded.
 *
 * ## Why this module exists
 *
 * `WEB_SEARCH_COST_UNBOUNDED` is the 503 a request gets when the search half of
 * its provider spend cannot be bounded. Until the OpenAI ceiling landed it was
 * effectively a Google-only path that no user reached, and it was written
 * accordingly: the error was constructed inline at four sites and left no
 * record anywhere.
 *
 * Then it started refusing the default model, and the gap showed. A user
 * reported the failure with the Trace ID the UI gave them, and that trace could
 * not be looked up:
 *
 * - the code is not in `CHAT_COST_SAFETY_CODES`, so it misses the
 *   `chat_cost_safety_rejected` log the routes emit for guardrail refusals; and
 * - the chat route throws it *before* `acquireChatAccess`, which is what writes
 *   `ChatLimitDecisionEvent` -- so `GET /api/admin/limit-decisions?traceId=`
 *   has nothing to return.
 *
 * The comment at the chat route's catch says "the existing limit-decision
 * events are the record for these". For this code that was not true, and
 * nothing said so.
 *
 * What makes it worth fixing now rather than then: the reasons this refusal can
 * carry are no longer hypothetical. `search_query_ceiling_breached` fires when a
 * provider bills more searches than the request authorized, and
 * `unpriced_search_queries` when the catalogue has no rate -- both are runtime
 * facts a client cannot see, and both look identical on screen. Distinguishing
 * them after the fact is exactly what the `scope` is for, and it was being
 * thrown away.
 */

import { ChatAccessError } from "@/lib/chatSecurity";
import { WEB_SEARCH_COST_UNBOUNDED } from "@/lib/webSearchCostRefusalCode";
import { recordChatLimitDecision } from "@/lib/chatLimitDecisions";
import { classifyChatLimitCode } from "@/lib/chatCostSafetyCore";
import type { ChatLimitDecisionPhase } from "@/lib/chatLimitDecisionCore";
import type { NativeSearchRefusal } from "@/lib/webSearchNativeCostReservation";

// Re-exported rather than declared, so the client that has to recognise this
// code and the server that raises it cannot end up naming two different
// strings. Imported as well as re-exported: this module refuses with it two
// functions below. See lib/webSearchCostRefusalCode.ts.
export { WEB_SEARCH_COST_UNBOUNDED };

/**
 * The refusal, built once.
 *
 * Every site that refuses a native search on cost calls this, so the status,
 * the code, the sentence and the `scope` cannot drift between the chat route,
 * the two pre-checks and a fallback candidate. The message says nothing about
 * which reason it was: the reason is an operational fact, and the person
 * reading the screen can act on neither an unbounded ceiling nor a breached
 * one.
 */
export const webSearchCostRefusalError = (reason: NativeSearchRefusal) =>
    new ChatAccessError(
        503,
        WEB_SEARCH_COST_UNBOUNDED,
        "Web search is temporarily unavailable for this model.",
        undefined,
        { scope: reason }
    );

/** Whether this error is the refusal above, whoever raised it. */
export const isWebSearchCostRefusal = (
    error: unknown
): error is ChatAccessError =>
    error instanceof ChatAccessError && error.code === WEB_SEARCH_COST_UNBOUNDED;

export type WebSearchCostRefusalContext = {
    traceId: string;
    phase: ChatLimitDecisionPhase;
    /** Hashed usage subject. Null when the caller was refused before identity. */
    subjectKey: string | null;
    userId?: string | null;
    /** `"Guest"` when there is no resolved plan; never guessed upwards. */
    plan?: string | null;
    /** The models this turn was refusing for, in request order. */
    models: readonly { modelId: string; provider: string }[];
    timeZone?: string | null;
};

/**
 * Records the refusal, if that is what this error is. Returns whether it did.
 *
 * Called from each route's catch rather than from the throw site: preflight
 * raises it inside a synchronous `map` over its models, and a route that has
 * already begun answering an error must not fail again while writing
 * diagnostics. `recordChatLimitDecision` never throws for the same reason.
 *
 * The per-model cost fields are zero on purpose. This refusal happens *before*
 * `createChatBudget`, so no estimate exists yet -- and zero here means "never
 * computed", not "cost nothing". Nothing downstream reads them as a price:
 * `summarizeFallbackPricingDecisions` only counts a model whose `costSource` is
 * the fallback source, so these rows add a rejection to the count by error code
 * and contribute no pricing sample.
 */
export const recordWebSearchCostRefusal = async (
    error: unknown,
    context: WebSearchCostRefusalContext
): Promise<boolean> => {
    if (!isWebSearchCostRefusal(error)) return false;
    // Not the raw details object: `scope` is the only field this refusal
    // carries, and copying the rest would put whatever a future caller attached
    // into a durable row nobody reviewed.
    const scope =
        typeof error.details?.scope === "string" ? error.details.scope : null;
    await recordChatLimitDecision({
        traceId: context.traceId,
        subjectKey: context.subjectKey ?? "unknown",
        userId: context.userId ?? null,
        plan: context.plan || "Guest",
        phase: context.phase,
        decision: "rejected",
        errorCode: error.code,
        // The one function that answers "which layer", so this row and the
        // response cannot disagree. It reads `other` today: this refusal is
        // neither an entitlement nor one of the two operational guardrail
        // codes, and moving it into that set would change what the UI tells
        // people and what the guardrail metrics count -- a product decision,
        // not an observability one.
        limitLayer: classifyChatLimitCode(error.code),
        // Which of the three reasons refused it. The whole point of the row.
        limitScope: scope,
        models: context.models.map((model) => ({
            modelId: model.modelId,
            provider: model.provider,
            estimatedInputTokens: 0,
            estimatedOutputTokens: 0,
            estimatedCostMicroUsd: 0,
            inputUsdPerMillionTokens: 0,
            outputUsdPerMillionTokens: 0,
            pricingVersion: "",
            costSource: "",
            longContextThresholdTokens: null,
        })),
        enabledTools: ["web_search"],
        timeZone: context.timeZone || "UTC",
    });
    return true;
};
