import "server-only";
import { randomUUID } from "node:crypto";
import { APICallError, jsonSchema, stepCountIs, streamText, tool, type ModelMessage, type ToolSet } from "ai";
import { getActiveAiModel } from "@/lib/activeAiModel";
import { getUserBillingPlan } from "@/lib/billingEntitlements";
import { estimateImageInputTokens, readImageDimensions } from "@/lib/chatImageInputTokens";
import {
    acquireChatAccess,
    ChatAccessError,
    createChatBudget,
    extendChatReservationExpiry,
    heartbeatChatAccess,
    identifyChatCaller,
    isChatAccessError,
    linkChatReservationProviderRequest,
    publicChatErrorDetails,
    releaseChatAccess,
    settleChatUsage,
    type ChatUsageReservation,
} from "@/lib/chatSecurity";
import { atLeastOneToken, createTokenEstimateAccumulator } from "@/lib/chatTokenEstimate";
import { ApiSecurityError, consumeApiRateLimit, readLimitedText } from "@/lib/apiSecurity";
import {
    externalApiEnabled,
    externalApiUserAllowed,
} from "@/lib/externalApiCatalogCore";
import { externalApiRunnableModels } from "@/lib/externalApiCatalog";
import { externalApiAdmissionHook } from "@/lib/externalApiAdmission";
import { authenticateExternalApiKey, ExternalApiKeyError } from "@/lib/externalApiKeys";
import { sha256Hex } from "@/lib/externalApiKeyCore";
import { getModelGenerationSettings } from "@/lib/modelGenerationCompatibility";
import {
    buildChatCompletion,
    buildUsageChunk,
    convertChatCompletionRequest,
    createChunkTranslator,
    openAiError,
    parseChatCompletionRequest,
    PROTOCOL_LIMITS,
    ProtocolError,
    resolveRequestOptions,
    SSE_DONE,
    sseData,
    toOpenAiFinishReason,
    type UsageView,
} from "@/lib/openAiChatProtocol";
import { prisma } from "@/lib/prisma";
import { logStreamErrorWithoutContent, safeErrorMetadata } from "@/lib/providerErrorClassification";
import {
    recordModelFailure,
    recordModelSuccess,
    recordProviderFailure,
    recordProviderSuccess,
} from "@/lib/providerMonitoring";

/**
 * POST /api/v1/chat/completions.
 *
 * One external request is one provider generation. The server never runs a
 * client tool and never loops: a tool call goes back to the client, and the
 * client's next request with the result is a new request, a new reservation
 * and a new receipt. No automatic fallback, no SDK retry -- a request whose
 * outcome is unknown is never sent again (docs/policy/external-api.md).
 *
 * Money moves only through the shared reservation: acquireChatAccess holds the
 * account's plan and purchased credits (and the provider cost budget) before
 * dispatch, the admission hook enforces the key's own cap inside that same
 * transaction, and settleChatUsage settles at the existing contract.
 */

const NO_STORE = { "Cache-Control": "no-store" } as const;

export const positiveInteger = (value: string | undefined, fallback: number) => {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
};

const errorType = (status: number) =>
    status === 401
        ? "authentication_error"
        : status === 403
          ? "permission_error"
          : status === 404
            ? "not_found_error"
            : status === 429
              ? "rate_limit_error"
              : status >= 500
                ? "server_error"
                : "invalid_request_error";

export const externalApiErrorResponse = (
    status: number,
    message: string,
    code: string,
    extra?: { param?: string | null; requestId?: string; retryAfter?: number; details?: Record<string, unknown> }
) => {
    const headers = new Headers({ ...NO_STORE, "Content-Type": "application/json" });
    if (extra?.requestId) headers.set("x-request-id", extra.requestId);
    if (extra?.retryAfter) headers.set("Retry-After", String(extra.retryAfter));
    const body = openAiError(message, code, errorType(status), extra?.param ?? null);
    return new Response(
        JSON.stringify(extra?.details ? { ...body, tomverse: extra.details } : body),
        { status, headers }
    );
};

/** Any refusal raised before dispatch, as an OpenAI-shaped error. */
export const externalApiRefusal = (error: unknown, requestId?: string): Response | null => {
    if (error instanceof ProtocolError) {
        return externalApiErrorResponse(error.status, error.message, error.code, { param: error.param, requestId });
    }
    if (error instanceof ExternalApiKeyError) {
        return externalApiErrorResponse(error.status, error.message, error.code, { requestId });
    }
    if (isChatAccessError(error)) {
        return externalApiErrorResponse(error.status, error.message, error.code, {
            requestId,
            retryAfter: error.retryAfter,
            details: publicChatErrorDetails(error.details),
        });
    }
    if (error instanceof ApiSecurityError) {
        return externalApiErrorResponse(error.status, error.message, error.code.toLowerCase(), {
            requestId,
            retryAfter: error.retryAfter,
        });
    }
    return null;
};

type Outcome = "completed" | "empty" | "cancelled" | "failed";

/**
 * Whether the provider refused the request before doing any work -- a 4xx
 * other than a timeout, which is evidence it billed nothing. A 5xx or 408
 * may come after the provider processed the request, so its cost is
 * unknown and stays at the reservation's estimate.
 */
const providerRefused = (error: unknown) =>
    APICallError.isInstance(error) &&
    typeof error.statusCode === "number" &&
    error.statusCode >= 400 &&
    error.statusCode < 500 &&
    error.statusCode !== 408;

const recordReceipt = (requestId: string, data: { finishReason?: string | null; errorCode?: string | null }) =>
    prisma.externalApiRequest
        .update({
            where: { id: requestId },
            data: { ...data, completedAt: new Date() },
        })
        .catch((error) =>
            console.error(JSON.stringify({ event: "external_api_receipt_update_failed", requestId, message: String(error) }))
        );

export async function handleChatCompletions(request: Request): Promise<Response> {
    const requestId = `req_${randomUUID().replaceAll("-", "")}`;
    if (!externalApiEnabled(process.env)) {
        return externalApiErrorResponse(503, "The Tomverse API is not enabled.", "feature_unavailable", { requestId });
    }

    let leaseId: string | null = null;
    let reservation: ChatUsageReservation | null = null;
    let handedToStream = false;
    let disposeDispatch: (() => void) | null = null;
    try {
        const key = await authenticateExternalApiKey(request.headers.get("authorization"));
        if (!externalApiUserAllowed(process.env, key.userId)) {
            return externalApiErrorResponse(403, "The Tomverse API is not enabled for this account.", "account_not_enabled", { requestId });
        }
        // An abuse guard on request rate, generous and per account: credits,
        // the key cap and concurrency are what bound what an account can use.
        await consumeApiRateLimit(request, key.userId, "external-api-completions", {
            minute: positiveInteger(process.env.EXTERNAL_API_REQUESTS_PER_MINUTE, 120),
            day: positiveInteger(process.env.EXTERNAL_API_REQUESTS_PER_DAY, 20_000),
        });

        const raw = await readLimitedText(request, PROTOCOL_LIMITS.maxBodyBytes);
        let body: unknown;
        try {
            body = JSON.parse(raw);
        } catch {
            throw new ProtocolError(400, "invalid_json", "The request body is not valid JSON.");
        }
        const parsed = parseChatCompletionRequest(body);

        const plan = await getUserBillingPlan(key.userId);
        const runnable = await externalApiRunnableModels(plan.tier);
        const entry = runnable.find((candidate) => candidate.capabilities.id === parsed.model);
        if (!entry) {
            throw new ProtocolError(404, "model_not_found", `The model '${parsed.model}' is not available to this key.`, "model");
        }
        const { model, capabilities } = entry;
        const view = {
            id: model.id,
            provider: model.provider,
            vision: capabilities.vision,
            reasoning: capabilities.reasoning,
            maxOutputTokens: capabilities.maxOutputTokens,
        };
        const options = resolveRequestOptions(parsed, view);
        const converted = convertChatCompletionRequest(parsed, view);

        const settings = getModelGenerationSettings(model, {
            temperature: parsed.temperature ?? undefined,
        });
        if (parsed.temperature != null && settings.temperature === undefined) {
            throw new ProtocolError(400, "unsupported_parameter", "temperature is not supported for this model.", "temperature");
        }
        // Provider-specific options the central compatibility layer derives
        // (e.g. a reasoning profile); never taken from the request.
        const { temperature: _temperature, providerOptions: _providerOptions, ...otherSettings } = settings;
        void _temperature;
        void _providerOptions;
        // Sampling knobs follow the central compatibility layer: a model that
        // takes a temperature (including one registered as reasoning "none")
        // takes top_p and the penalties too.
        const samplingAllowed =
            getModelGenerationSettings(model, { temperature: 1 }).temperature !== undefined;
        for (const param of ["top_p", "frequency_penalty", "presence_penalty"] as const) {
            if (parsed[param] != null && !samplingAllowed) {
                throw new ProtocolError(400, "unsupported_parameter", `${param} is not supported for this model.`, param);
            }
        }
        // The API is stateless, and OpenAI's Responses API stores requests by
        // default -- so every OpenAI call says store: false explicitly,
        // whatever the client sent.
        const baseOptions = (settings.providerOptions ?? {}) as Record<string, Record<string, unknown>>;
        const providerOptions =
            model.provider === "openai"
                ? {
                      ...baseOptions,
                      openai: {
                          ...(baseOptions.openai ?? {}),
                          store: false,
                          ...(parsed.reasoning_effort != null ? { reasoningEffort: parsed.reasoning_effort } : {}),
                      },
                  }
                : settings.providerOptions;

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

        // Everything that reaches the provider is in the estimate: the whole
        // history, tool schemas, tool calls and results, and each image.
        const estimate = createTokenEstimateAccumulator();
        for (const segment of converted.textSegments) estimate.addText(segment);
        estimate.addTokens(4 * converted.messages.length);
        for (const image of converted.images) {
            estimate.addTokens(estimateImageInputTokens(model.provider, readImageDimensions(image.bytes)));
        }
        const access = identifyChatCaller(request, key.userId, plan.tier, {
            dailyMessageLimit: plan.dailyMessageLimit,
            monthlyMessageLimit: plan.monthlyMessageLimit,
        });
        const budget = createChatBudget("user", model, atLeastOneToken(estimate.breakdown()), {
            ...(options.requestedOutputTokens !== null
                ? { totalOutputTokenCap: options.requestedOutputTokens }
                : {}),
        });

        const clientName = request.headers.get("user-agent")?.slice(0, 80) ?? null;
        let grant: Awaited<ReturnType<typeof acquireChatAccess>>;
        try {
            grant = await acquireChatAccess(access, budget, {
                traceId: requestId,
                source: "external_api",
                withinReservationTransaction: externalApiAdmissionHook({
                    requestId,
                    keyId: key.keyId,
                    userId: key.userId,
                    modelId: model.id,
                    stream: options.stream,
                    clientName,
                    requestDigest,
                    idempotencyKeyDigest,
                }),
            });
        } catch (error) {
            if (isChatAccessError(error) && error.code === "idempotency_key_in_use" && idempotencyKeyDigest) {
                const replay = await idempotentReplay(key.keyId, idempotencyKeyDigest, requestDigest);
                if (replay) return replay;
            }
            throw error;
        }
        leaseId = grant.leaseId;
        reservation = grant.usageReservation;

        const tools: ToolSet = Object.fromEntries(
            converted.tools.map((definition) => [
                definition.name,
                tool({
                    description: definition.description,
                    inputSchema: jsonSchema(definition.parameters as Parameters<typeof jsonSchema>[0]),
                    ...(definition.strict !== undefined ? { strict: definition.strict } : {}),
                }),
            ])
        );

        // A client that left while the request was being authenticated, read
        // and reserved has already fired its abort event; a listener added now
        // would never hear it. Checked here, before anything is dispatched, so
        // the hold is refunded and the provider is never called.
        if (request.signal?.aborted) {
            throw new ProtocolError(499, "request_cancelled", "The request was cancelled before it was sent.");
        }
        const controller = new AbortController();
        const onClientAbort = () => controller.abort("client_disconnected");
        request.signal?.addEventListener("abort", onClientAbort, { once: true });
        const timeout = setTimeout(
            () => controller.abort("timeout"),
            positiveInteger(process.env.EXTERNAL_API_TIMEOUT_MS, 600_000)
        );
        disposeDispatch = () => {
            clearTimeout(timeout);
            request.signal?.removeEventListener("abort", onClientAbort);
        };

        // No side effects until consume() starts: if streamText throws below,
        // the catch still owns the reservation and refunds it.
        const run = createRun({
            requestId,
            model,
            reservation,
            leaseId,
            controller,
            created: Math.floor(Date.now() / 1000),
            completionId: `chatcmpl-${requestId.slice(4)}`,
            includeUsage: options.includeUsage,
            dispose: disposeDispatch,
        });
        const result = streamText({
            // The SDK's default onError logs the raw error object, and provider
            // errors can carry request and response bodies. Content-free only.
            onError: logStreamErrorWithoutContent({ traceId: requestId, modelId: model.id }),
            model: getActiveAiModel(model),
            messages: converted.messages as ModelMessage[],
            ...(converted.tools.length ? { tools } : {}),
            ...(converted.toolChoice ? { toolChoice: converted.toolChoice } : {}),
            ...(settings.temperature !== undefined ? { temperature: settings.temperature } : {}),
            ...(parsed.top_p != null ? { topP: parsed.top_p } : {}),
            ...(parsed.frequency_penalty != null ? { frequencyPenalty: parsed.frequency_penalty } : {}),
            ...(parsed.presence_penalty != null ? { presencePenalty: parsed.presence_penalty } : {}),
            ...(options.stop ? { stopSequences: options.stop } : {}),
            ...otherSettings,
            ...(providerOptions ? { providerOptions: providerOptions as never } : {}),
            maxOutputTokens: budget.maxOutputTokens,
            maxRetries: 0,
            stopWhen: stepCountIs(1),
            abortSignal: controller.signal,
        });

        handedToStream = true;
        if (options.stream) {
            const encoder = new TextEncoder();
            const stream = new ReadableStream<Uint8Array>({
                async start(streamController) {
                    const write = (text: string) => {
                        try {
                            streamController.enqueue(encoder.encode(text));
                        } catch {
                            // The client went away; the run still settles.
                        }
                    };
                    await run.consume(result.fullStream as AsyncIterable<{ type: string; [key: string]: unknown }>, (chunk) =>
                        write(sseData(chunk))
                    );
                    const final = run.final();
                    if (final.error) {
                        // Never a clean [DONE] after a failure: the client must
                        // be able to tell an interrupted answer from a finished one.
                        write(sseData(openAiError(final.error.message, final.error.code, "server_error")));
                    } else {
                        write(SSE_DONE);
                    }
                    try {
                        streamController.close();
                    } catch {
                        // Already cancelled by the client.
                    }
                },
                cancel() {
                    controller.abort("client_disconnected");
                },
            });
            return new Response(stream, {
                headers: {
                    ...NO_STORE,
                    "Content-Type": "text/event-stream; charset=utf-8",
                    Connection: "keep-alive",
                    "X-Accel-Buffering": "no",
                    "x-request-id": requestId,
                },
            });
        }

        await run.consume(result.fullStream as AsyncIterable<{ type: string; [key: string]: unknown }>, () => undefined);
        const final = run.final();
        if (final.error) {
            return externalApiErrorResponse(final.error.status, final.error.message, final.error.code, { requestId });
        }
        return Response.json(
            buildChatCompletion({
                id: `chatcmpl-${requestId.slice(4)}`,
                created: Math.floor(Date.now() / 1000),
                model: model.id,
                text: final.text,
                reasoning: final.reasoning,
                // Only calls the provider finished; a call cut off by the output
                // limit is reported through finish_reason "length" instead.
                toolCalls: final.toolCalls.filter((call) => call.complete),
                finishReason: final.finishReason,
                usage: final.usage,
                tomverse: { request_id: requestId },
            }),
            { headers: { ...NO_STORE, "x-request-id": requestId } }
        );
    } catch (error) {
        // Reached only before the provider was called: anything later is
        // handled by the run, which owns the reservation from then on.
        if (reservation && !handedToStream) {
            await settleChatUsage(reservation, { inputTokens: 0, outputTokens: 0, outcome: "failed" }).catch(
                (settlementError) =>
                    console.error(JSON.stringify({ event: "external_api_predispatch_refund_failed", requestId, message: String(settlementError) }))
            );
            await recordReceipt(requestId, { errorCode: "predispatch_failure" });
        }
        if (!handedToStream) disposeDispatch?.();
        if (leaseId && !handedToStream) await releaseChatAccess(leaseId).catch(() => undefined);
        const refusal = externalApiRefusal(error, requestId);
        if (refusal) return refusal;
        console.error(JSON.stringify({ event: "external_api_request_failed", requestId, ...safeErrorMetadata(error) }));
        return externalApiErrorResponse(500, "The request could not be processed.", "internal_error", { requestId });
    }
}

const idempotentReplay = async (keyId: string, idempotencyKeyDigest: string, requestDigest: string) => {
    const existing = await prisma.externalApiRequest.findUnique({
        where: { keyId_idempotencyKeyDigest: { keyId, idempotencyKeyDigest } },
        select: {
            id: true,
            requestDigest: true,
            finishReason: true,
            errorCode: true,
            completedAt: true,
            reservation: { select: { status: true, outcome: true, settledCredits: true } },
        },
    });
    if (!existing) return null;
    if (existing.requestDigest !== requestDigest) {
        return externalApiErrorResponse(
            422,
            "This Idempotency-Key was already used with a different request body.",
            "idempotency_key_reused",
            { requestId: existing.id }
        );
    }
    // The original is not re-sent and its output is not stored, so the answer
    // is a receipt: what happened to the request this key names.
    const inFlight = existing.reservation.status === "reserved";
    return externalApiErrorResponse(
        409,
        inFlight
            ? "A request with this Idempotency-Key is still in progress or its outcome is not yet known. It was not sent again."
            : "A request with this Idempotency-Key already completed. It was not sent again; its output is not stored.",
        inFlight ? "idempotent_request_in_progress" : "idempotent_request_completed",
        {
            requestId: existing.id,
            details: {
                request_id: existing.id,
                status: inFlight ? "held" : existing.reservation.status,
                outcome: existing.reservation.outcome,
                finish_reason: existing.finishReason,
                charged_credits: inFlight ? null : existing.reservation.settledCredits,
            },
        }
    );
};

type RunFinal = {
    text: string;
    reasoning: string;
    toolCalls: { id: string; name: string; arguments: string; complete: boolean }[];
    finishReason: ReturnType<typeof toOpenAiFinishReason>;
    usage: UsageView | null;
    error: { status: number; code: string; message: string } | null;
};

/**
 * The life of one dispatched request: translate the stream, keep the
 * reservation alive, and settle exactly once whatever way it ends.
 */
const createRun = (input: {
    requestId: string;
    model: Awaited<ReturnType<typeof externalApiRunnableModels>>[number]["model"];
    reservation: ChatUsageReservation;
    leaseId: string;
    controller: AbortController;
    created: number;
    completionId: string;
    includeUsage: boolean;
    dispose: () => void;
}) => {
    const translator = createChunkTranslator({
        id: input.completionId,
        created: input.created,
        model: input.model.id,
    });
    let sdkFinishReason: string | undefined;
    let usage: UsageView | null = null;
    let usageFromProvider = false;
    let cacheWriteInputTokens: number | undefined;
    let streamError: unknown = null;
    let aborted = false;
    let final: RunFinal | null = null;

    const consume = async (
        parts: AsyncIterable<{ type: string; [key: string]: unknown }>,
        emit: (chunk: unknown) => void
    ) => {
        // Started here, not when the run is created, so a dispatch that never
        // began cannot leave an interval extending a reservation nobody owns.
        // Cleared on every path out of this function, below.
        const heartbeat = setInterval(() => {
            void heartbeatChatAccess(input.leaseId).catch(() => undefined);
            void extendChatReservationExpiry(input.reservation.reservationId, 300).catch(() => undefined);
        }, 60_000);
        try {
            for await (const part of parts) {
                if (part.type === "error") {
                    streamError = part.error;
                    continue;
                }
                if (part.type === "abort") {
                    aborted = true;
                    continue;
                }
                if (part.type === "finish-step") {
                    const response = part.response as { id?: string; headers?: Record<string, string> } | undefined;
                    void linkChatReservationProviderRequest(input.reservation.reservationId, {
                        providerRequestId: response?.headers?.["x-request-id"] ?? response?.headers?.["request-id"] ?? null,
                        providerResponseId: response?.id ?? null,
                    }).catch(() => undefined);
                    continue;
                }
                if (part.type === "finish") {
                    sdkFinishReason = String(part.finishReason ?? "");
                    const total = part.totalUsage as
                        | {
                              inputTokens?: number;
                              outputTokens?: number;
                              inputTokenDetails?: { cacheReadTokens?: number; cacheWriteTokens?: number };
                              outputTokenDetails?: { reasoningTokens?: number };
                          }
                        | undefined;
                    if (total && Number.isSafeInteger(total.inputTokens) && Number.isSafeInteger(total.outputTokens)) {
                        usageFromProvider = true;
                        usage = {
                            inputTokens: total.inputTokens,
                            outputTokens: total.outputTokens,
                            cachedInputTokens: total.inputTokenDetails?.cacheReadTokens,
                            reasoningTokens: total.outputTokenDetails?.reasoningTokens,
                        };
                        cacheWriteInputTokens = total.inputTokenDetails?.cacheWriteTokens;
                    }
                    continue;
                }
                for (const chunk of translator.translate(part)) emit(chunk);
            }
        } catch (error) {
            if (input.controller.signal.aborted) aborted = true;
            else streamError = error;
        }
        clearInterval(heartbeat);
        if (input.controller.signal.aborted) aborted = true;

        const collected = translator.collected();
        const sawToolCalls = collected.toolCalls.length > 0;
        const finishReason = toOpenAiFinishReason(sdkFinishReason, sawToolCalls);
        let outcome: Outcome;
        let error: RunFinal["error"] = null;
        if (aborted) {
            outcome = "cancelled";
            const reason = input.controller.signal.reason;
            error = {
                status: reason === "timeout" ? 504 : 499,
                code: reason === "timeout" ? "upstream_timeout" : "request_cancelled",
                message: reason === "timeout" ? "The model did not finish in time." : "The request was cancelled.",
            };
        } else if (streamError) {
            outcome = "failed";
            error = { status: 502, code: "upstream_error", message: "The model provider returned an error." };
        } else {
            // A reply that is only tool calls is a complete reply.
            outcome = collected.text.length > 0 || sawToolCalls ? "completed" : "empty";
            // A provider content filter that blocked the whole reply is a
            // normal finish (content_filter), not a provider failure. Nothing
            // was produced, so nothing is charged.
            if (outcome === "empty" && finishReason !== "content_filter") {
                error = { status: 502, code: "empty_response", message: "The model returned no output." };
            }
        }

        if (!error) {
            emit(translator.finish(finishReason));
            if (input.includeUsage) {
                emit(buildUsageChunk({ id: input.completionId, created: input.created, model: input.model.id }, usage));
            }
        }

        // Settlement: provider usage when it was reported. When it was not,
        // nothing here is zero by assumption -- the reservation's own estimate
        // prices the provider side (undefined tokens), except where the
        // provider refused with an HTTP status before producing anything.
        const outputBytes =
            Buffer.byteLength(collected.text, "utf8") +
            // Reasoning is billed as output too; a stream cut off mid-thought
            // has produced it even when no answer text arrived.
            Buffer.byteLength(collected.reasoning, "utf8") +
            collected.toolCalls.reduce((total, call) => total + Buffer.byteLength(call.arguments, "utf8"), 0);
        const observedUsage = usage as UsageView | null;
        const turnUsage = usageFromProvider && observedUsage
            ? {
                  inputTokens: observedUsage.inputTokens,
                  cachedInputTokens: observedUsage.cachedInputTokens,
                  cacheWriteInputTokens,
                  outputTokens: observedUsage.outputTokens,
                  reasoningTokens: observedUsage.reasoningTokens,
                  usageFromProvider: true,
              }
            : outcome === "failed" && outputBytes === 0 && providerRefused(streamError)
              ? { inputTokens: 0, outputTokens: 0, usageFromProvider: false }
              : outcome === "cancelled"
                ? { outputTokens: Math.ceil(outputBytes / 4), usageFromProvider: false }
                : { usageFromProvider: false };
        try {
            await settleChatUsage(input.reservation, { ...turnUsage, outcome });
        } catch (settlementError) {
            // The reservation stays `reserved` and expires into the shared
            // reconciliation sweep; nothing is retried here.
            console.error(
                JSON.stringify({
                    event: "external_api_settlement_failed",
                    requestId: input.requestId,
                    reservationId: input.reservation.reservationId,
                    message: settlementError instanceof Error ? settlementError.message : String(settlementError),
                })
            );
        }
        input.dispose();
        await releaseChatAccess(input.leaseId).catch(() => undefined);
        await recordReceipt(input.requestId, {
            finishReason: error ? null : finishReason,
            errorCode: error?.code ?? null,
        });
        if (outcome === "completed") {
            void Promise.allSettled([recordProviderSuccess(input.model.provider), recordModelSuccess(input.model.id)]);
        } else if (outcome === "failed") {
            const meta = safeErrorMetadata(streamError);
            void Promise.allSettled([
                recordProviderFailure(input.model.provider, "EXTERNAL_API_FAILED", {
                    modelId: input.model.id,
                    phase: "stream",
                    traceId: input.requestId,
                    errorName: meta.name,
                    errorCode: meta.code,
                    httpStatus: meta.statusCode,
                    retryable: meta.isRetryable,
                }),
                recordModelFailure(input.model.id, input.model.provider, "EXTERNAL_API_FAILED"),
            ]);
        }
        final = { ...collected, finishReason, usage, error };
    };

    return {
        consume,
        final: (): RunFinal => {
            if (!final) throw new Error("External API run read before it finished.");
            return final;
        },
    };
};

export { ChatAccessError };
