import "server-only";
import { randomUUID } from "node:crypto";

import { ApiSecurityError, consumeApiRateLimit, readLimitedText } from "@/lib/apiSecurity";
import {
    buildAppManagedWebSearchTool,
    type AppManagedSearchBatchResult,
    type AppManagedSearchToolResult,
} from "@/lib/appManagedWebSearchTool";
import type { AppManagedSearchSnapshot } from "@/lib/appManagedWebSearchCore";
import {
    acquireChatAccess,
    createSearchOnlyChatBudget,
    identifyChatCaller,
    isChatAccessError,
    releaseChatAccess,
    SEARCH_ONLY_CHAT_BUDGET_MODEL_ID,
    settleChatUsage,
    type ChatUsageReservation,
} from "@/lib/chatSecurity";
import {
    CODE_WEB_SEARCH_MAX_BODY_BYTES,
    CODE_WEB_SEARCH_PROTOCOL,
    codeWebSearchResponse,
    codeWebSearchSwitchOn,
    parseCodeWebSearchRequest,
    type CodeWebSearchToolInput,
} from "@/lib/codeWebSearchCore";
import { externalApiAccountAccess } from "@/lib/externalApiAccess";
import { externalApiAdmissionHook } from "@/lib/externalApiAdmission";
import { externalApiEnabled, externalApiUserAllowed } from "@/lib/externalApiCatalogCore";
import { externalApiErrorResponse, externalApiRefusal, idempotentReplay, positiveInteger } from "@/lib/externalApiInference";
import { sha256Hex } from "@/lib/externalApiKeyCore";
import { authenticateExternalApiKey } from "@/lib/externalApiKeys";
import { ProtocolError } from "@/lib/openAiChatProtocol";
import { prisma } from "@/lib/prisma";
import { resolveWebSearchBackendReadiness } from "@/lib/webSearchBackendRuntime";
import { getSearchBackendPriceProfile } from "@/lib/webSearchBackendPricing";
import { APP_MANAGED_WEB_SEARCH_CAPABILITY, appManagedSearchIsDispatchable } from "@/lib/webSearchCapability";
import { getWebSearchSurchargeCredits } from "@/lib/webSearchCredits";
import { reserveAppManagedSearchCost } from "@/lib/webSearchNativeCostReservation";

/**
 * POST /api/code/v1/web-search: the agent engine's web search, on the coding
 * API's key, ledger and receipts (docs/policy/external-api.md section 11.1).
 *
 * Money moves exactly as a Chat turn's application-managed search moves it:
 * the flat surcharge (WEB_SEARCH_SURCHARGE_CREDITS) is held through the shared
 * reservation together with the search vendor's worst case in its own bucket
 * (`search-provider:brave`), the key's cap is enforced inside that transaction,
 * and settlement charges the surcharge only when at least one backend request
 * was served -- zero searches is a full refund -- and settles the vendor's
 * bucket to the requests it served. One request is one search session of up to
 * five backend requests, the ceiling the reservation was sized on; the sixth is
 * refused by the session counter without a socket.
 *
 * Never retried here, like every external request: a request whose outcome is
 * unknown is reported, and the client asks for its receipt.
 */

/** Whether a signed-in account would be served: the switch, the API, the account list and a ready search backend. */
export const codeWebSearchOffered = (userId: string, env: NodeJS.ProcessEnv = process.env) =>
    codeWebSearchSwitchOn(env) &&
    externalApiEnabled(env) &&
    externalApiUserAllowed(env, userId) &&
    appManagedSearchIsDispatchable(APP_MANAGED_WEB_SEARCH_CAPABILITY, resolveWebSearchBackendReadiness(env));

export type CodeWebSearchRun = (
    input: CodeWebSearchToolInput,
    options: { maxQueries: number; signal: AbortSignal }
) => Promise<{ result: AppManagedSearchToolResult | AppManagedSearchBatchResult; snapshot: AppManagedSearchSnapshot }>;

/** Chat's own executor: its counter, its query checks, its result bounds and its notice. */
const runAppManagedSearch: CodeWebSearchRun = async (input, { maxQueries, signal }) => {
    const backend = APP_MANAGED_WEB_SEARCH_CAPABILITY.searchBackend!;
    const search = buildAppManagedWebSearchTool({ backend, maxQueries, signal });
    const result = await search.search(input);
    return { result, snapshot: search.session.snapshot() };
};

const unavailable = (requestId: string) =>
    externalApiErrorResponse(503, "Web search is temporarily unavailable. Nothing was searched or charged.", "web_search_unavailable", { requestId });

const recordReceipt = (requestId: string, data: { finishReason?: string | null; errorCode?: string | null }) =>
    prisma.externalApiRequest
        .update({ where: { id: requestId }, data: { ...data, completedAt: new Date() } })
        .catch((error) =>
            console.error(JSON.stringify({ event: "code_web_search_receipt_update_failed", requestId, message: String(error) }))
        );

export async function handleCodeWebSearch(request: Request, deps: { run?: CodeWebSearchRun } = {}): Promise<Response> {
    const requestId = `req_${randomUUID().replaceAll("-", "")}`;
    if (!externalApiEnabled(process.env) || !codeWebSearchSwitchOn(process.env)) {
        return externalApiErrorResponse(503, "Web search is not enabled on this Tomverse API.", "feature_unavailable", { requestId });
    }
    let leaseId: string | null = null;
    let reservation: ChatUsageReservation | null = null;
    let surcharge = 0;
    let maxQueries = 0;
    let input: CodeWebSearchToolInput | null = null;
    try {
        const key = await authenticateExternalApiKey(request.headers.get("authorization"));
        const account = await externalApiAccountAccess(key.userId);
        if (!account.allowed) return externalApiErrorResponse(403, account.message, account.code, { requestId });
        // The same request-rate guard as a generation: a search is a paid request too.
        await consumeApiRateLimit(request, key.userId, "external-api-completions", {
            minute: positiveInteger(process.env.EXTERNAL_API_REQUESTS_PER_MINUTE, 120),
            day: positiveInteger(process.env.EXTERNAL_API_REQUESTS_PER_DAY, 20_000),
        });
        const raw = await readLimitedText(request, CODE_WEB_SEARCH_MAX_BODY_BYTES);
        const parsed = parseCodeWebSearchRequest(raw);
        if (!parsed.ok) throw new ProtocolError(400, parsed.code, parsed.message, parsed.param);
        input = parsed.input;

        const requestDigest = sha256Hex(raw);
        const idempotencyHeader = request.headers.get("idempotency-key")?.trim() || null;
        if (idempotencyHeader && idempotencyHeader.length > 255) {
            throw new ProtocolError(400, "invalid_idempotency_key", "Idempotency-Key must be at most 255 characters.");
        }
        const idempotencyKeyDigest = idempotencyHeader ? sha256Hex(idempotencyHeader) : null;
        if (idempotencyKeyDigest) {
            const replay = await idempotentReplay(key.keyId, idempotencyKeyDigest, requestDigest);
            if (replay) return replay;
        }

        // The same readiness, ceiling and price every Chat surface reads. A
        // search that cannot be bounded, priced or sent is refused before any hold.
        const capability = APP_MANAGED_WEB_SEARCH_CAPABILITY;
        const readiness = resolveWebSearchBackendReadiness();
        if (!appManagedSearchIsDispatchable(capability, readiness)) return unavailable(requestId);
        const authorization = reserveAppManagedSearchCost({ capability, appManagedSearchEnabled: true });
        const profile = getSearchBackendPriceProfile(capability.searchBackend);
        surcharge = getWebSearchSurchargeCredits("always", capability, readiness);
        if (!authorization.ok || !profile || surcharge <= 0 || authorization.maxQueries <= 0) return unavailable(requestId);
        maxQueries = authorization.maxQueries;
        const budget = createSearchOnlyChatBudget({
            surchargeCredits: surcharge,
            searchBackend: {
                backend: profile.backend,
                reservedCostMicroUsd: authorization.reservedCostMicroUsd,
                costPerQueryMicroUsd: authorization.costPerQueryMicroUsd,
                maxQueries,
                pricingVersion: profile.pricingVersion,
            },
        });

        const access = identifyChatCaller(request, key.userId, account.plan.tier, {
            dailyMessageLimit: account.plan.dailyMessageLimit,
            monthlyMessageLimit: account.plan.monthlyMessageLimit,
        });
        let grant: Awaited<ReturnType<typeof acquireChatAccess>>;
        try {
            grant = await acquireChatAccess(access, budget, {
                traceId: requestId,
                source: "external_api",
                enabledTools: ["web_search"],
                withinReservationTransaction: externalApiAdmissionHook({
                    requestId,
                    keyId: key.keyId,
                    userId: key.userId,
                    modelId: SEARCH_ONLY_CHAT_BUDGET_MODEL_ID,
                    stream: false,
                    clientName: request.headers.get("user-agent")?.slice(0, 80) ?? null,
                    requestDigest,
                    idempotencyKeyDigest,
                    protocol: CODE_WEB_SEARCH_PROTOCOL,
                    surface: "coding",
                }),
            });
        } catch (error) {
            // A twin admitted together with the original gets the original's receipt.
            if (idempotencyKeyDigest && (isChatAccessError(error) || error instanceof ApiSecurityError)) {
                const replay = await idempotentReplay(key.keyId, idempotencyKeyDigest, requestDigest);
                if (replay) return replay;
            }
            throw error;
        }
        leaseId = grant.leaseId;
        reservation = grant.usageReservation;
    } catch (error) {
        const refusal = externalApiRefusal(error, requestId);
        if (refusal) return refusal;
        console.error(JSON.stringify({ event: "code_web_search_refused", requestId, message: error instanceof Error ? error.name : "unknown" }));
        return externalApiErrorResponse(500, "The request could not be processed.", "internal_error", { requestId });
    }

    // From here the reservation is held: it is settled exactly once, whatever happens.
    const controller = new AbortController();
    const onClientAbort = () => controller.abort("client_disconnected");
    request.signal?.addEventListener("abort", onClientAbort, { once: true });
    if (request.signal?.aborted) controller.abort("client_disconnected");
    let ran: Awaited<ReturnType<CodeWebSearchRun>> | null = null;
    let failure: unknown = null;
    try {
        if (!controller.signal.aborted) ran = await (deps.run ?? runAppManagedSearch)(input!, { maxQueries, signal: controller.signal });
    } catch (error) {
        failure = error;
    } finally {
        request.signal?.removeEventListener("abort", onClientAbort);
    }
    const snapshot = ran?.snapshot;
    const neverSent = !ran && !failure;
    // Ended before every request could be counted (the client left, or the run
    // threw): the user is charged nothing, as for a cancelled turn with no answer,
    // and the vendor's bucket keeps the authorized ceiling, because a request in
    // flight may have been served.
    const unobserved = !neverSent && (failure !== null || controller.signal.aborted);
    const usage = neverSent
        ? { inputTokens: 0, outputTokens: 0, usageFromProvider: true, outcome: "failed" as const,
            searchSurchargeCredits: surcharge, searchExecuted: false, searchQueryCount: 0, searchBackendRequestCount: 0 }
        : unobserved
          ? { inputTokens: 0, outputTokens: 0, usageFromProvider: true, outcome: "cancelled" as const,
              searchSurchargeCredits: surcharge, searchQueriesObserved: false }
          : { inputTokens: 0, outputTokens: 0, usageFromProvider: true,
              outcome: snapshot!.executed ? ("completed" as const) : ("failed" as const),
              searchSurchargeCredits: surcharge, searchExecuted: snapshot!.executed,
              searchQueryCount: snapshot!.succeededRequestCount, searchBackendRequestCount: snapshot!.succeededRequestCount };
    let chargedCredits: number | null = null;
    try {
        const settled = await settleChatUsage(reservation!, usage);
        chargedCredits = typeof settled.settledCredits === "number" ? settled.settledCredits : null;
    } catch (settlementError) {
        // The reservation stays held and expires into the shared reconciliation,
        // which refunds the user and keeps the vendor's authorized ceiling.
        console.error(JSON.stringify({ event: "code_web_search_settlement_failed", requestId, message: String(settlementError) }));
    }
    await recordReceipt(requestId, neverSent
        ? { errorCode: "request_cancelled" }
        : unobserved
          ? { errorCode: failure ? "search_failed" : "request_cancelled" }
          : snapshot!.executed ? { finishReason: "stop" } : { errorCode: snapshot!.failureCode ?? "search_failed" });
    if (leaseId) await releaseChatAccess(leaseId, { traceId: requestId, reason: "code_web_search_finished" }).catch(() => undefined);

    if (failure) {
        console.error(JSON.stringify({ event: "code_web_search_failed", requestId, message: failure instanceof Error ? failure.name : "unknown" }));
        return externalApiErrorResponse(500, "The search could not be completed.", "internal_error", { requestId });
    }
    if (!ran) return externalApiErrorResponse(499, "The request was cancelled.", "request_cancelled", { requestId });
    return Response.json(codeWebSearchResponse({ requestId, result: ran.result, chargedCredits }), {
        headers: { "Cache-Control": "no-store", "x-request-id": requestId },
    });
}
