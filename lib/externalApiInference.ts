import "server-only";
import { randomUUID } from "node:crypto";
import {
    APICallError,
    InvalidPromptError,
    jsonSchema,
    stepCountIs,
    streamText,
    tool,
    UnsupportedFunctionalityError,
    type ModelMessage,
    type ToolSet,
} from "ai";
import { getActiveAiModel } from "@/lib/activeAiModel";
import { estimateImageInputTokens, readImageDimensions } from "@/lib/chatImageInputTokens";
import { estimateNativeAttachmentTokens } from "@/lib/chatAttachmentTokens";
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
import { atLeastOneToken, createTokenEstimateAccumulator, estimateTextTokens } from "@/lib/chatTokenEstimate";
import { ApiSecurityError, consumeApiRateLimit, readLimitedText } from "@/lib/apiSecurity";
import { externalApiAccountAccess } from "@/lib/externalApiAccess";
import { externalApiChannelFor, externalApiEnabled, SMART_ADAPTIVE_MODEL_ID } from "@/lib/externalApiCatalogCore";
import { getRuntimeModel } from "@/lib/modelRegistry";
import { noteSmartAdaptiveRefusal, rememberSmartAdaptiveToolCalls, routeSmartAdaptive, smartAdaptiveRouterAllowed } from "@/lib/externalApiSmartAdaptive";
import { externalApiRunnableModels } from "@/lib/externalApiCatalog";
import { externalApiAdmissionHook } from "@/lib/externalApiAdmission";
import { pickRequestedModel } from "@/lib/externalApiProtocols";
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
/**
 * Raised by the SDK or the provider adapter while building the request, so
 * nothing was sent: the request shape is one this provider cannot carry.
 */
const refusedBeforeDispatch = (error: unknown) =>
    InvalidPromptError.isInstance(error) || UnsupportedFunctionalityError.isInstance(error);

type StreamPart = { type: string; [key: string]: unknown };
const LIFECYCLE_PARTS = new Set(["start", "start-step"]);

/**
 * Reads the SDK stream up to its first part that is not lifecycle
 * bookkeeping, and hands back a replay of everything from the start. Used to
 * see whether the request was refused before it was sent, before an HTTP
 * status is committed.
 */
const peekFirstPart = async (source: AsyncIterable<StreamPart>) => {
    const iterator = source[Symbol.asyncIterator]();
    const buffered: StreamPart[] = [];
    let finished = false;
    let thrown: { error: unknown } | null = null;
    try {
        for (;;) {
            const next = await iterator.next();
            if (next.done) {
                finished = true;
                break;
            }
            buffered.push(next.value);
            if (!LIFECYCLE_PARTS.has(next.value.type)) break;
        }
    } catch (error) {
        thrown = { error };
    }
    const first = buffered.at(-1);
    const refused = thrown
        ? refusedBeforeDispatch(thrown.error)
        : first?.type === "error" && refusedBeforeDispatch(first.error);
    const replay: AsyncIterable<StreamPart> = {
        async *[Symbol.asyncIterator]() {
            yield* buffered;
            if (thrown) throw thrown.error;
            if (finished) return;
            for (;;) {
                const next = await iterator.next();
                if (next.done) return;
                yield next.value;
            }
        },
    };
    return { refusedBeforeDispatch: refused, replay };
};

const providerRefused = (error: unknown) =>
    refusedBeforeDispatch(error) ||
    (APICallError.isInstance(error) &&
    typeof error.statusCode === "number" &&
    error.statusCode >= 400 &&
    error.statusCode < 500 &&
    error.statusCode !== 408);

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
        const account = await externalApiAccountAccess(key.userId);
        if (!account.allowed) return externalApiErrorResponse(403, account.message, account.code, { requestId });
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

        // Before anything is routed or reserved: a replay is answered as the
        // original was, with no second router call.
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

        const { plan } = account;
        // The tomverse CLI's channel, or the API's (read only while the coding
        // catalogue's external channels are switched on).
        // Smart Adaptive's pool also holds the classes only it routes to
        // (frontier, apex); a model named directly comes from the narrower list.
        const runnable = await externalApiRunnableModels(plan.tier, {
            channel: externalApiChannelFor(request.headers.get("user-agent")),
            smartAdaptive: parsed.model === SMART_ADAPTIVE_MODEL_ID,
        });
        // Smart Adaptive: Tomverse picks one of the runnable models, and the
        // response says which one answered (the `model` field and a header).
        let routedHeaders: Record<string, string> = {};
        // Remembers the routed model for the conversation once admission accepts it.
        let rememberRouted: (() => void) | undefined;
        let routing: { routedBy: "router" | "continued" | "default"; held: boolean; conversation: string } | undefined;
        // A Tomverse id, or the provider's own id for exactly one offered model.
        const picked = parsed.model === SMART_ADAPTIVE_MODEL_ID ? null : pickRequestedModel(runnable, parsed.model);
        if (picked && "ambiguous" in picked) {
            throw new ProtocolError(
                400,
                "model_ambiguous",
                `'${parsed.model}' names more than one Tomverse model. Use the Tomverse model id: ${picked.ambiguous.map((candidate) => candidate.model.id).join(", ")}.`,
                "model"
            );
        }
        let entry = picked?.entry;
        if (parsed.model === SMART_ADAPTIVE_MODEL_ID && runnable.length > 0) {
            const routed = await routeSmartAdaptive({
                request: parsed,
                runnable,
                keyId: key.keyId,
                userId: key.userId,
                requestId,
                routerAllowed: () => smartAdaptiveRouterAllowed(key),
                idempotencyKeyDigest,
                requestDigest,
                userAgent: request.headers.get("user-agent"),
            });
            entry = routed.entry;
            rememberRouted = routed.remember;
            routing = { routedBy: routed.routedBy, held: routed.held ?? false, conversation: routed.conversationDigest };
            routedHeaders = { "x-tomverse-routed-model": entry.model.id, "x-tomverse-routed-by": routed.routedBy };
        }
        if (!entry) {
            // A model the catalogue knows but no longer offers here is most
            // often a client configuration copied before it was retired.
            if (parsed.model !== SMART_ADAPTIVE_MODEL_ID && (await getRuntimeModel(parsed.model))) {
                throw new ProtocolError(
                    404,
                    "model_unavailable",
                    `The model '${parsed.model}' is no longer offered to this key. Use '${SMART_ADAPTIVE_MODEL_ID}', or copy a new configuration from Tomverse Settings > API keys.`,
                    "model"
                );
            }
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
        // Provider-specific options the central compatibility layer derives
        // (e.g. a reasoning profile); never taken from the request.
        const { temperature: _temperature, providerOptions: _providerOptions, ...otherSettings } = settings;
        void _temperature;
        void _providerOptions;
        // Sampling knobs follow the central compatibility layer: a model that
        // takes a temperature (including one registered as reasoning "none")
        // takes top_p and the penalties too. For a model that takes none of
        // them they are left out of the call rather than refused, because
        // coding clients send them on every request (VS Code always sends a
        // temperature) and a reasoning model would otherwise be unusable from
        // them. What was left out is named in a response header.
        const samplingAllowed =
            getModelGenerationSettings(model, { temperature: 1 }).temperature !== undefined;
        const ignoredParameters: string[] = [
            ...(samplingAllowed
                ? []
                : (["temperature", "top_p", "frequency_penalty", "presence_penalty"] as const).filter(
                      (param) => parsed[param] != null
                  )),
            ...(parsed.reasoning?.summary != null ? ["reasoning.summary"] : []),
        ];
        const infoHeaders: Record<string, string> = {
            ...routedHeaders,
            ...(ignoredParameters.length ? { "x-tomverse-ignored-parameters": ignoredParameters.join(", ") } : {}),
        };
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

        // Everything that reaches the provider is in the estimate: the whole
        // history, tool schemas, tool calls and results, and each image.
        const estimate = createTokenEstimateAccumulator();
        for (const segment of converted.textSegments) estimate.addText(segment);
        estimate.addTokens(4 * converted.messages.length);
        let measuredImageTokens = 0;
        for (const image of converted.images) {
            const tokens = estimateImageInputTokens(model.provider, readImageDimensions(image.bytes));
            measuredImageTokens += tokens;
            estimate.addTokens(tokens);
        }
        // As in Chat (app/api/chat/route.ts): the measured image size counts
        // against the input limit, and the rest of the flat per-image
        // allowance is added to the reservation only, so an image costs the
        // same credits and provider hold here as it does in Chat.
        const reservationOnlyInputTokens = Math.max(
            0,
            estimateNativeAttachmentTokens(converted.images.length) - measuredImageTokens
        );
        const access = identifyChatCaller(request, key.userId, plan.tier, {
            dailyMessageLimit: plan.dailyMessageLimit,
            monthlyMessageLimit: plan.monthlyMessageLimit,
        });
        // The output limit sent to the provider and the output the
        // reservation prices are always the same number. With no limit from
        // the client that is the model's maximum, reserved in full -- never a
        // smaller typical reservation with a larger provider limit.
        const budget = createChatBudget("user", model, atLeastOneToken(estimate.breakdown()), {
            totalOutputTokenCap: options.requestedOutputTokens ?? capabilities.maxOutputTokens,
            reservationOnlyInputTokens,
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
                    routing,
                }),
            });
        } catch (error) {
            // A twin that passed the pre-check together with the original can
            // be refused by any admission layer -- the shared credit allowance
            // or concurrency the original just took, the key cap, or the
            // duplicate check itself. Whichever it was, if the original is now
            // recorded under this key, the twin is that request: it gets the
            // original's receipt, not the refusal.
            if (idempotencyKeyDigest && (isChatAccessError(error) || error instanceof ApiSecurityError)) {
                const replay = await idempotentReplay(key.keyId, idempotencyKeyDigest, requestDigest);
                if (replay) return replay;
            }
            // Admission refused: hold off further router calls for this key a
            // while, since the next requests would most likely be refused too.
            if (parsed.model === SMART_ADAPTIVE_MODEL_ID && isChatAccessError(error)) noteSmartAdaptiveRefusal(key.keyId);
            throw error;
        }
        leaseId = grant.leaseId;
        reservation = grant.usageReservation;
        rememberRouted?.();

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
            customTools: converted.customTools,
            // Smart Adaptive: the round answering these calls goes to this model.
            onToolCalls:
                parsed.model === SMART_ADAPTIVE_MODEL_ID
                    ? (ids) => rememberSmartAdaptiveToolCalls(key.keyId, model.id, ids)
                    : undefined,
        });
        const result = streamText({
            // The SDK's default onError logs the raw error object, and provider
            // errors can carry request and response bodies. Content-free only.
            onError: logStreamErrorWithoutContent({ traceId: requestId, modelId: model.id }),
            // Off for this call: Sentry's AI SDK tracing-channel subscriber
            // takes a reader on the model's stream and swaps in a tapped copy
            // on an object the SDK does not read back, so the SDK then pipes
            // the locked original and every streamed reply fails with
            // "ReadableStream is locked" (seen from Cursor on dev, reproduced
            // locally with Sentry on). With telemetry off the SDK skips the
            // channel; Sentry still reports errors, only the AI spans go.
            telemetry: { isEnabled: false },
            model: getActiveAiModel(model),
            messages: converted.messages as ModelMessage[],
            ...(converted.tools.length ? { tools } : {}),
            ...(converted.toolChoice ? { toolChoice: converted.toolChoice } : {}),
            ...(settings.temperature !== undefined ? { temperature: settings.temperature } : {}),
            ...(samplingAllowed && parsed.top_p != null ? { topP: parsed.top_p } : {}),
            ...(samplingAllowed && parsed.frequency_penalty != null ? { frequencyPenalty: parsed.frequency_penalty } : {}),
            ...(samplingAllowed && parsed.presence_penalty != null ? { presencePenalty: parsed.presence_penalty } : {}),
            ...(options.stop ? { stopSequences: options.stop } : {}),
            ...otherSettings,
            ...(providerOptions ? { providerOptions: providerOptions as never } : {}),
            maxOutputTokens: budget.maxOutputTokens,
            maxRetries: 0,
            stopWhen: stepCountIs(1),
            // System and developer messages stay where the client put them;
            // the provider adapter decides how its API carries them.
            allowSystemInMessages: true,
            abortSignal: controller.signal,
        });

        handedToStream = true;
        if (options.stream) {
            // The HTTP status is decided after the first real stream part, so a
            // request the SDK or adapter refused before sending gets a 400 like
            // the non-streaming path, not a 200 with an error event.
            // The wait for the first part can be long (a model that thinks
            // before it streams); the slot and the reservation are kept alive
            // through it, exactly as during the stream itself.
            run.keepAlive();
            const peeked = await peekFirstPart(result.fullStream as AsyncIterable<StreamPart>);
            if (peeked.refusedBeforeDispatch) {
                await run.consume(peeked.replay, () => undefined);
                const refusedFinal = run.final();
                const refusedError = refusedFinal.error ?? {
                    status: 400,
                    code: "unsupported_request",
                    message: "This model's provider cannot accept this request as sent. Nothing was sent or charged.",
                };
                return externalApiErrorResponse(refusedError.status, refusedError.message, refusedError.code, { requestId });
            }
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
                    try {
                        await run.consume(peeked.replay, (chunk) => write(sseData(chunk)));
                        const final = run.final();
                        if (final.error) {
                            // Never a clean [DONE] after a failure: the client must
                            // be able to tell an interrupted answer from a finished one.
                            write(sseData(openAiError(final.error.message, final.error.code, "server_error")));
                        } else {
                            write(SSE_DONE);
                        }
                    } catch (unexpected) {
                        // The run settles inside consume; this only keeps an
                        // unexpected throw from leaving the client's stream open.
                        console.error(JSON.stringify({ event: "external_api_stream_failed", requestId, ...safeErrorMetadata(unexpected) }));
                        write(sseData(openAiError("The request could not be completed.", "internal_error", "server_error")));
                    } finally {
                        try {
                            streamController.close();
                        } catch {
                            // Already cancelled by the client.
                        }
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
                    ...infoHeaders,
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
            { headers: { ...NO_STORE, "x-request-id": requestId, ...infoHeaders } }
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
        if (refusedBeforeDispatch(error)) {
            return externalApiErrorResponse(
                400,
                "This model's provider cannot accept this request as sent. Nothing was sent or charged.",
                "unsupported_request",
                { requestId }
            );
        }
        console.error(JSON.stringify({ event: "external_api_request_failed", requestId, ...safeErrorMetadata(error) }));
        return externalApiErrorResponse(500, "The request could not be processed.", "internal_error", { requestId });
    }
}

type ErrorRenderer = typeof externalApiErrorResponse;

/**
 * The receipt for an Idempotency-Key this key already used, or null. Shared
 * by every protocol; `render` gives the answer that protocol's error shape.
 */
export const idempotentReplay = async (
    keyId: string,
    idempotencyKeyDigest: string,
    requestDigest: string,
    render: ErrorRenderer = externalApiErrorResponse
) => {
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
        return render(
            422,
            "This Idempotency-Key was already used with a different request body.",
            "idempotency_key_reused",
            { requestId: existing.id }
        );
    }
    // The original is not re-sent and its output is not stored, so the answer
    // is a receipt: what happened to the request this key names.
    const inFlight = existing.reservation.status === "reserved";
    return render(
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
    toolCalls: { id: string; name: string; arguments: string; custom?: boolean; complete: boolean }[];
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
    customTools: ReadonlySet<string>;
    /** Told each tool call's id as the call is completed, before it is sent on. */
    onToolCalls?: (ids: string[]) => void;
}) => {
    const translator = createChunkTranslator(
        {
            id: input.completionId,
            created: input.created,
            model: input.model.id,
        },
        input.customTools
    );
    let sdkFinishReason: string | undefined;
    let usage: UsageView | null = null;
    let usageFromProvider = false;
    let cacheWriteInputTokens: number | undefined;
    let streamError: unknown = null;
    let aborted = false;
    let final: RunFinal | null = null;
    let heartbeat: ReturnType<typeof setInterval> | null = null;

    /**
     * Keeps the concurrency slot and the reservation alive while the request
     * is with the provider. Started once the dispatch has begun -- by the
     * streaming path before it waits for the first part, otherwise by
     * consume -- and always cleared by consume, which every dispatched path
     * reaches, so no interval outlives its reservation.
     */
    const keepAlive = () => {
        heartbeat ??= setInterval(() => {
            void heartbeatChatAccess(input.leaseId).catch(() => undefined);
            void extendChatReservationExpiry(input.reservation.reservationId, 300).catch(() => undefined);
        }, positiveInteger(process.env.EXTERNAL_API_HEARTBEAT_MS, 60_000));
    };

    const consume = async (
        parts: AsyncIterable<{ type: string; [key: string]: unknown }>,
        emit: (chunk: unknown) => void
    ) => {
        keepAlive();
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
                        // Cache reads and writes are read together: a write
                        // billed as plain input would be charged at 1.0x.
                        const cache = {
                            cachedInputTokens: total.inputTokenDetails?.cacheReadTokens,
                            cacheWriteInputTokens: total.inputTokenDetails?.cacheWriteTokens,
                        };
                        usage = {
                            inputTokens: total.inputTokens,
                            outputTokens: total.outputTokens,
                            cachedInputTokens: cache.cachedInputTokens,
                            reasoningTokens: total.outputTokenDetails?.reasoningTokens,
                        };
                        cacheWriteInputTokens = cache.cacheWriteInputTokens;
                    }
                    continue;
                }
                // Remembered before the call reaches the client: a client can
                // run the tool and send its round as soon as it sees the call.
                if (part.type === "tool-call" && typeof part.toolCallId === "string") {
                    input.onToolCalls?.([part.toolCallId]);
                }
                for (const chunk of translator.translate(part)) emit(chunk);
            }
        } catch (error) {
            if (input.controller.signal.aborted) aborted = true;
            else streamError = error;
        }
        if (heartbeat) clearInterval(heartbeat);
        heartbeat = null;
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
        } else if (streamError && refusedBeforeDispatch(streamError)) {
            outcome = "failed";
            error = {
                status: 400,
                code: "unsupported_request",
                message: "This model's provider cannot accept this request as sent. Nothing was sent or charged.",
            };
        } else if (streamError) {
            outcome = "failed";
            error = { status: 502, code: "upstream_error", message: "The model provider returned an error." };
        } else {
            // A reply that is only tool calls, or only reasoning (the client
            // has already received it as reasoning_content, e.g. a model that
            // spent its whole output limit thinking), is a complete reply.
            outcome =
                collected.text.length > 0 || sawToolCalls || collected.reasoning.length > 0 ? "completed" : "empty";
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
        // Reasoning is billed as output too; a stream cut off mid-thought has
        // produced it even when no answer text arrived.
        const producedText = [collected.text, collected.reasoning, ...collected.toolCalls.map((call) => call.arguments)].join("");
        const outputBytes = Buffer.byteLength(producedText, "utf8");
        // A cancelled stream without provider usage is estimated on the high
        // side: the script-aware estimator (dense for Korean, CJK and code)
        // or bytes/4, whichever is larger, so a short-looking reply that was
        // really over the pro-rata threshold is not refunded in full.
        const cancelledOutputTokens = Math.max(Math.ceil(outputBytes / 4), estimateTextTokens(producedText));
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
                ? { outputTokens: cancelledOutputTokens, usageFromProvider: false }
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
        } else if (outcome === "failed" && !refusedBeforeDispatch(streamError)) {
            // A refusal built before dispatch is local, not a provider fault.
            // Everything else is a provider call failure, recorded under the
            // registered provider-call root so provider health counts it.
            const meta = safeErrorMetadata(streamError);
            void Promise.allSettled([
                recordProviderFailure(input.model.provider, "AI_STREAM_FAILED", {
                    modelId: input.model.id,
                    phase: "stream",
                    traceId: input.requestId,
                    errorName: meta.name,
                    errorCode: meta.code,
                    httpStatus: meta.statusCode,
                    retryable: meta.isRetryable,
                }),
                recordModelFailure(input.model.id, input.model.provider, "AI_STREAM_FAILED"),
            ]);
        }
        final = { ...collected, finishReason, usage, error };
    };

    return {
        keepAlive,
        consume,
        final: (): RunFinal => {
            if (!final) throw new Error("External API run read before it finished.");
            return final;
        },
    };
};

export { ChatAccessError };
