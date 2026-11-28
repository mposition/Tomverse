import "server-only";
import { randomUUID } from "node:crypto";

import { consumeApiRateLimit, readLimitedText } from "@/lib/apiSecurity";
import { externalApiAccountAccess } from "@/lib/externalApiAccess";
import { authenticateExternalApiCaller, callerScope } from "@/lib/externalApiCaller";
import { externalApiRunnableModels } from "@/lib/externalApiCatalog";
import { externalApiEnabled } from "@/lib/externalApiCatalogCore";
import { externalApiErrorResponse, externalApiRefusal, positiveInteger } from "@/lib/externalApiInference";
import { sha256Hex } from "@/lib/externalApiKeyCore";
import { decodeImageDataUrl } from "@/lib/openAiChatProtocol";
import {
    ROUTE_ONLY_EVENT,
    ROUTE_ONLY_MAX_BODY_BYTES,
    ROUTE_ONLY_RATE_SCOPE,
    parseRouteOnlyRequest,
    routeOnlyAnswer,
    routeOnlySwitchOn,
} from "@/lib/externalApiRouteOnlyCore";
import { routeSmartAdaptive, smartAdaptiveCandidates, smartAdaptiveRouterAllowed } from "@/lib/externalApiSmartAdaptive";

/**
 * POST /api/code/v1/route: which model Smart Adaptive would pick for a request,
 * and whether the provider's CLI on the person's PC or the Tomverse API runs
 * it (owner decision 2026-11-28, docs/policy/external-api.md section 5.3).
 *
 * It only chooses. Nothing is run, reserved, charged or receipted: no
 * admission, no credit reservation, no provider call for the task. The router
 * call, when the gate allows one, is Smart Adaptive's own (the provider
 * operational budget, never the person's credits), so the abuse this route can
 * be used for is calling it without ever running anything. That is bounded by
 * its own request-rate bucket per account, and by the same router gate as every
 * Smart Adaptive request (smartAdaptiveRouterAllowed): a closed gate picks the
 * default model with no router call.
 *
 * The choice is made once, for a new task: the last message must be the
 * person's. A tool round is never routed here, because the CLI that runs the
 * task keeps its model for the whole task and the server never sees its tool
 * calls, so a later round routed afresh could move a running task elsewhere.
 * A model is recommended only if it can take the request (its window, images
 * and features); otherwise the answer says none fits. Nothing is remembered for
 * the conversation either: that memory is written only once admission accepted
 * a request on a model, and a free choice is not an admitted request.
 *
 * The decision is logged as ids, counts and the model, never the request text.
 */

/** Each step's real implementation by default; a test replaces the ones that would reach the database or a provider. */
export type RouteOnlyDeps = {
    authenticate?: typeof authenticateExternalApiCaller;
    accountAccess?: typeof externalApiAccountAccess;
    rateLimit?: typeof consumeApiRateLimit;
    runnable?: typeof externalApiRunnableModels;
    routerAllowed?: typeof smartAdaptiveRouterAllowed;
};

const NO_STORE = { "Cache-Control": "no-store" } as const;

export async function handleCodeRouteOnly(request: Request, deps: RouteOnlyDeps = {}): Promise<Response> {
    const requestId = `req_${randomUUID().replaceAll("-", "")}`;
    if (!externalApiEnabled(process.env) || !routeOnlySwitchOn(process.env)) {
        return externalApiErrorResponse(503, "Route-only choice is not enabled on this Tomverse API.", "feature_unavailable", { requestId });
    }
    try {
        // The caller is read exactly as every coding route reads it (tests/externalApiBoundary.test.mjs).
        const caller = deps.authenticate ? await deps.authenticate(request) : await authenticateExternalApiCaller(request);
        const account = await (deps.accountAccess ?? externalApiAccountAccess)(caller.userId);
        if (!account.allowed) return externalApiErrorResponse(403, account.message, account.code, { requestId });
        // A choice costs the person no credits, so this is the bound on it: per
        // account, whichever key or Desktop session asks.
        await (deps.rateLimit ?? consumeApiRateLimit)(request, caller.userId, ROUTE_ONLY_RATE_SCOPE, {
            minute: positiveInteger(process.env.EXTERNAL_API_ROUTE_ONLY_PER_MINUTE, 30),
            day: positiveInteger(process.env.EXTERNAL_API_ROUTE_ONLY_PER_DAY, 3_000),
        });

        const raw = await readLimitedText(request, ROUTE_ONLY_MAX_BODY_BYTES);
        const { request: completion, localClis } = parseRouteOnlyRequest(raw);
        if (completion.messages.at(-1)?.role !== "user") {
            return externalApiErrorResponse(400, "The route-only choice is made for a new task: the last message must be the person's.", "invalid_request", { requestId });
        }
        // Images are checked as the completions route converts them (inline data URLs of a supported type and size), so a
        // request that route would refuse is refused here too rather than given a model.
        completion.messages.forEach((message, index) => {
            if (message.role !== "user" || !Array.isArray(message.content)) return;
            message.content.forEach((part, at) => {
                if (part.type === "image_url") decodeImageDataUrl(part.image_url.url, `messages[${index}].content[${at}].image_url.url`);
            });
        });

        const runnable = await (deps.runnable ?? externalApiRunnableModels)(account.plan.tier, { surface: "coding", smartAdaptive: true });
        const routerAllowed = deps.routerAllowed ?? smartAdaptiveRouterAllowed;
        const routed = await routeSmartAdaptive({
            request: completion,
            runnable,
            keyId: callerScope(caller),
            userId: caller.userId,
            requestId,
            routerAllowed: () => routerAllowed({ keyId: callerScope(caller), creditCap: caller.creditCap }),
            idempotencyKeyDigest: null,
            requestDigest: sha256Hex(raw),
            userAgent: request.headers.get("user-agent"),
            logProtocol: "route_only",
        });
        if (!routed) {
            return externalApiErrorResponse(404, "No coding model is available to this account.", "model_not_found", { requestId });
        }
        // The completions route lets a model that cannot take the request refuse it after the pick; nothing does here, so a
        // pick outside the fitting candidates (a window too small, images, a feature) is answered as no fit, not recommended.
        if (!smartAdaptiveCandidates(completion, runnable).some((entry) => entry.model.id === routed.entry.model.id)) {
            return externalApiErrorResponse(400, "No coding model available to this account can take this request.", "unsupported_request", { requestId });
        }
        const answer = routeOnlyAnswer(routed.entry, routed.routedBy, localClis);
        console.info(
            JSON.stringify({
                event: ROUTE_ONLY_EVENT,
                requestId,
                source: caller.source,
                routedBy: answer.routedBy,
                modelId: answer.model,
                provider: answer.provider,
                execution: answer.execution,
                localCliCount: localClis.length,
            })
        );
        return Response.json(answer, { headers: { ...NO_STORE, "x-request-id": requestId } });
    } catch (error) {
        const refusal = externalApiRefusal(error, requestId);
        if (refusal) return refusal;
        console.error(JSON.stringify({ event: "external_api_route_only_failed", requestId, message: error instanceof Error ? error.name : "unknown" }));
        return externalApiErrorResponse(500, "The request could not be processed.", "internal_error", { requestId });
    }
}
