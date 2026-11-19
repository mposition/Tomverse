import "server-only";
import { randomUUID } from "node:crypto";
import { getUserBillingPlan } from "@/lib/billingEntitlements";
import {
    acquireChatAccess,
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
import { estimateTextTokens } from "@/lib/chatTokenEstimate";
import { ApiSecurityError, consumeApiRateLimit, readLimitedText } from "@/lib/apiSecurity";
import { externalApiAdmissionHook } from "@/lib/externalApiAdmission";
import { externalApiRunnableModels } from "@/lib/externalApiCatalog";
import { externalApiAccountAccess } from "@/lib/externalApiAccess";
import { externalApiEnabled, SMART_ADAPTIVE_MODEL_ID } from "@/lib/externalApiCatalogCore";
import { externalApiErrorResponse, idempotentReplay, positiveInteger } from "@/lib/externalApiInference";
import { authenticateExternalApiKey, ExternalApiKeyError, type AuthenticatedExternalApiKey } from "@/lib/externalApiKeys";
import { sha256Hex } from "@/lib/externalApiKeyCore";
import {
    checkForwardedHeaders,
    createSseParser,
    emptyObservation,
    relayedSseEvent,
    estimateNativeInput,
    isRecord,
    nativeProtocolEnabled,
    NativeProtocolError,
    publicUpstreamError,
    requestDigestInput,
    upstreamRefusedBeforeWork,
    type NativeObservation,
} from "@/lib/externalApiNativeCore";
import { nativeUpstreamFetch, NativeUpstreamUnavailable, type NativeUpstreamProvider } from "@/lib/externalApiNativeUpstream";
import { getRuntimeModel } from "@/lib/modelRegistry";
import { PROTOCOL_LIMITS } from "@/lib/openAiChatProtocol";
import { prisma } from "@/lib/prisma";
import { safeErrorMetadata } from "@/lib/providerErrorClassification";
import { recordModelFailure, recordModelSuccess, recordProviderFailure, recordProviderSuccess } from "@/lib/providerMonitoring";

/**
 * The native-protocol gateway: Anthropic Messages (Claude Code) and OpenAI
 * Responses (Codex), on the same key, ledger and limits as Chat Completions.
 *
 * One request is one provider generation, exactly as in
 * lib/externalApiInference.ts: the shared reservation is taken before
 * dispatch (account credits, provider budget and concurrency in
 * acquireChatAccess, the key cap and receipt in the admission hook inside the
 * same transaction), the provider is called once with no retry and no
 * fallback, and the request settles exactly once however it ends. The client
 * runs every tool; the gateway never loops.
 *
 * What differs is only the wire: the client's body is passed through after
 * the checks in lib/anthropicMessagesProtocol.ts and
 * lib/openAiResponsesProtocol.ts, and the provider's stream is relayed byte
 * for byte while it is read for usage. See docs/policy/external-api.md.
 */

type ErrorRenderer = typeof externalApiErrorResponse;
type NativeProtocol = "anthropic_messages" | "responses";

type Prepared = {
    upstreamBody: string;
    stream: boolean;
    outputLimit: number;
    outputLimitClamped: boolean;
    payload: Record<string, unknown>;
    hasCacheMarker?: boolean;
};

export type NativeProtocolSpec = {
    protocol: NativeProtocol;
    provider: NativeUpstreamProvider;
    /** Path (and allowed query) on the provider's fixed base URL. */
    upstreamPath: (request: Request) => string;
    /** The client headers the provider needs; never the client's credential. */
    upstreamHeaders: (request: Request, prepared: Prepared) => Record<string, string>;
    /** Extra response headers the client expects, e.g. Anthropic's request-id. */
    responseHeaders?: (requestId: string) => Record<string, string>;
    /** Whether an `x-api-key` header may carry the Tomverse key. */
    acceptsXApiKey?: boolean;
    render: ErrorRenderer;
    prepare: (body: unknown, model: { apiModel: string; maxOutputTokens: number }) => Prepared;
    createObserver: () => { observe(event: { event: string | null; data: string }): void; final(): NativeObservation };
    observeJson: (json: unknown) => NativeObservation;
    streamErrorEvent: (status: number, code: string, message: string) => string;
};

const NO_STORE = { "Cache-Control": "no-store" } as const;

const PROTOCOL_LABEL: Record<NativeProtocol, string> = {
    anthropic_messages: "Anthropic Messages",
    responses: "Responses",
};

export const nativeRefusal = (error: unknown, render: ErrorRenderer, requestId?: string): Response | null => {
    if (error instanceof NativeProtocolError) {
        return render(error.status, error.message, error.code, { param: error.param, requestId });
    }
    if (error instanceof ExternalApiKeyError) return render(error.status, error.message, error.code, { requestId });
    if (isChatAccessError(error)) {
        return render(error.status, error.message, error.code, {
            requestId,
            retryAfter: error.retryAfter,
            details: publicChatErrorDetails(error.details),
        });
    }
    if (error instanceof ApiSecurityError) {
        return render(error.status, error.message, error.code.toLowerCase(), { requestId, retryAfter: error.retryAfter });
    }
    return null;
};

/** The Tomverse key from `Authorization: Bearer`, or `x-api-key` where the protocol uses it. */
const credentialHeader = (request: Request, acceptsXApiKey: boolean | undefined) => {
    const authorization = request.headers.get("authorization");
    if (authorization) return authorization;
    const apiKey = acceptsXApiKey ? request.headers.get("x-api-key")?.trim() : null;
    return apiKey ? `Bearer ${apiKey}` : null;
};

/** The front door every native route shares: switches, key, allowlist, rate. */
export const authenticateNative = async (
    request: Request,
    spec: Pick<NativeProtocolSpec, "protocol" | "acceptsXApiKey">,
    bucket: "external-api-completions" | "external-api-reads"
): Promise<AuthenticatedExternalApiKey> => {
    if (!externalApiEnabled(process.env) || !nativeProtocolEnabled(process.env, spec.protocol)) {
        throw new NativeProtocolError(503, "feature_unavailable", `The Tomverse ${PROTOCOL_LABEL[spec.protocol]} API is not enabled.`);
    }
    const key = await authenticateExternalApiKey(credentialHeader(request, spec.acceptsXApiKey));
    const access = await externalApiAccountAccess(key.userId);
    if (!access.allowed) throw new NativeProtocolError(403, access.code, access.message);
    // The same per-account guards as Chat Completions: one bucket for every
    // generation protocol, so a second protocol is not a second allowance.
    await consumeApiRateLimit(
        request,
        key.userId,
        bucket,
        bucket === "external-api-completions"
            ? {
                  minute: positiveInteger(process.env.EXTERNAL_API_REQUESTS_PER_MINUTE, 120),
                  day: positiveInteger(process.env.EXTERNAL_API_REQUESTS_PER_DAY, 20_000),
              }
            : {
                  minute: positiveInteger(process.env.EXTERNAL_API_READS_PER_MINUTE, 60),
                  day: positiveInteger(process.env.EXTERNAL_API_READS_PER_DAY, 5_000),
              }
    );
    return key;
};

export const readNativeJson = async (request: Request) => {
    const raw = await readLimitedText(request, PROTOCOL_LIMITS.maxBodyBytes);
    try {
        return { raw, body: JSON.parse(raw) as unknown };
    } catch {
        throw new NativeProtocolError(400, "invalid_json", "The request body is not valid JSON.");
    }
};

type RunnableEntry = Awaited<ReturnType<typeof externalApiRunnableModels>>[number];

/**
 * The model a native request names, from the same runtime registry, plan and
 * credential filter as every other route, narrowed to the models this
 * protocol carries natively. A Tomverse id or, when it names exactly one of
 * them, the provider's own model id (Codex keys its tool behaviour on it).
 * Never Smart Adaptive: signed thinking and encrypted reasoning belong to the
 * model that produced them, so a native request is never re-routed.
 */
export const resolveNativeModel = async (protocol: NativeProtocol, plan: Parameters<typeof externalApiRunnableModels>[0], requested: unknown): Promise<RunnableEntry> => {
    if (typeof requested !== "string" || !requested) {
        throw new NativeProtocolError(400, "invalid_request", "model is required.", "model");
    }
    if (requested === SMART_ADAPTIVE_MODEL_ID) {
        throw new NativeProtocolError(
            400,
            "model_unsupported_protocol",
            `Smart Adaptive is offered on Chat Completions only. Choose a fixed model for ${PROTOCOL_LABEL[protocol]} in Tomverse Settings > API keys.`,
            "model"
        );
    }
    const runnable = await externalApiRunnableModels(plan);
    const eligible = runnable.filter((entry) => entry.capabilities.protocols.includes(protocol));
    const byId = eligible.find((entry) => entry.model.id === requested);
    if (byId) return byId;
    const byApiModel = eligible.filter((entry) => entry.model.apiModel === requested);
    if (byApiModel.length === 1) return byApiModel[0];
    if (byApiModel.length > 1) {
        throw new NativeProtocolError(
            400,
            "model_ambiguous",
            `'${requested}' names more than one Tomverse model. Use the Tomverse model id: ${byApiModel.map((entry) => entry.model.id).join(", ")}.`,
            "model"
        );
    }
    if (runnable.some((entry) => entry.model.id === requested)) {
        throw new NativeProtocolError(
            400,
            "model_unsupported_protocol",
            `The model '${requested}' is not available on ${PROTOCOL_LABEL[protocol]}. Use it through Chat Completions, or choose a compatible model.`,
            "model"
        );
    }
    if (await getRuntimeModel(requested)) {
        throw new NativeProtocolError(
            404,
            "model_unavailable",
            `The model '${requested}' is no longer offered to this key. Copy a new configuration from Tomverse Settings > API keys.`,
            "model"
        );
    }
    throw new NativeProtocolError(404, "model_not_found", `The model '${requested}' is not available to this key.`, "model");
};

const recordReceipt = (requestId: string, data: { finishReason?: string | null; errorCode?: string | null }) =>
    prisma.externalApiRequest
        .update({ where: { id: requestId }, data: { ...data, completedAt: new Date() } })
        .catch((error) =>
            console.error(JSON.stringify({ event: "external_api_receipt_update_failed", requestId, message: String(error) }))
        );

const upstreamErrorMessage = (text: string) => {
    try {
        const json = JSON.parse(text);
        if (isRecord(json) && isRecord(json.error) && typeof json.error.message === "string") return json.error.message;
    } catch {
        // Not JSON; no message to keep.
    }
    return null;
};

type Outcome = "completed" | "empty" | "cancelled" | "failed";
type RunEnd = { observation?: NativeObservation; httpStatus?: number; transportError?: unknown; providerRequestId?: string | null };
type RunError = { status: number; code: string; message: string } | null;

/**
 * One dispatched native request: keeps the reservation alive, and settles it
 * exactly once -- `finish` is memoised, so the end of the stream, a client
 * cancel and a failed read can all call it.
 */
const createNativeRun = (input: {
    requestId: string;
    model: RunnableEntry["model"];
    reservation: ChatUsageReservation;
    leaseId: string;
    controller: AbortController;
    dispose: () => void;
}) => {
    let heartbeat: ReturnType<typeof setInterval> | null = null;
    let finished: Promise<{ error: RunError; outcome: Outcome }> | null = null;

    const keepAlive = () => {
        heartbeat ??= setInterval(() => {
            void heartbeatChatAccess(input.leaseId).catch(() => undefined);
            void extendChatReservationExpiry(input.reservation.reservationId, 300).catch(() => undefined);
        }, positiveInteger(process.env.EXTERNAL_API_HEARTBEAT_MS, 60_000));
    };

    const settle = async (end: RunEnd) => {
        if (heartbeat) clearInterval(heartbeat);
        heartbeat = null;
        const observation = end.observation ?? emptyObservation();
        const aborted = input.controller.signal.aborted;
        const credentialMissing = end.transportError instanceof NativeUpstreamUnavailable;
        let outcome: Outcome;
        let error: RunError = null;
        if (aborted && !observation.terminal) {
            outcome = "cancelled";
            const timedOut = input.controller.signal.reason === "timeout";
            error = {
                status: timedOut ? 504 : 499,
                code: timedOut ? "upstream_timeout" : "request_cancelled",
                message: timedOut ? "The model did not finish in time." : "The request was cancelled.",
            };
        } else if (credentialMissing) {
            outcome = "failed";
            error = { status: 503, code: "model_unavailable", message: "This model is not available right now. Nothing was sent or charged." };
        } else if (end.httpStatus !== undefined) {
            outcome = "failed";
            error = { status: end.httpStatus, code: "upstream_error", message: "The model provider returned an error." };
        } else if (end.transportError || observation.providerError || !observation.terminal) {
            // A stream that stopped without its terminal event is a failure,
            // never a finished answer.
            outcome = "failed";
            error = { status: 502, code: "upstream_error", message: "The model provider returned an error." };
        } else {
            // Text, a tool call or reasoning alone is a complete reply.
            outcome =
                observation.outputItems > 0 || observation.producedBytes > 0 || (observation.usage?.outputTokens ?? 0) > 0
                    ? "completed"
                    : "empty";
            if (outcome === "empty") error = { status: 502, code: "empty_response", message: "The model returned no output." };
        }

        // Settlement at the existing contract: provider usage when it was
        // reported; zero only where the provider refused before doing work or
        // nothing was sent; a cancelled stream estimated on the high side from
        // what it produced; otherwise the reservation's own estimate.
        const usage = observation.usage;
        const cancelledOutputTokens = Math.max(Math.ceil(observation.producedBytes / 4), estimateTextTokens(observation.producedText));
        const refusedBeforeWork =
            credentialMissing ||
            (end.httpStatus !== undefined && upstreamRefusedBeforeWork(end.httpStatus) && observation.producedBytes === 0);
        try {
            if (usage) {
                await settleChatUsage(input.reservation, {
                    inputTokens: usage.inputTokens,
                    cachedInputTokens: usage.cachedInputTokens,
                    cacheWriteInputTokens: usage.cacheWriteInputTokens,
                    outputTokens: usage.outputTokens,
                    reasoningTokens: usage.reasoningTokens,
                    usageFromProvider: true,
                    outcome,
                });
            } else if (refusedBeforeWork) {
                await settleChatUsage(input.reservation, { inputTokens: 0, outputTokens: 0, usageFromProvider: false, outcome });
            } else if (outcome === "cancelled") {
                await settleChatUsage(input.reservation, { outputTokens: cancelledOutputTokens, usageFromProvider: false, outcome });
            } else {
                await settleChatUsage(input.reservation, { usageFromProvider: false, outcome });
            }
        } catch (settlementError) {
            // Stays `reserved` and expires into the shared reconciliation
            // sweep; nothing is retried or re-sent here.
            console.error(
                JSON.stringify({
                    event: "external_api_settlement_failed",
                    requestId: input.requestId,
                    reservationId: input.reservation.reservationId,
                    message: settlementError instanceof Error ? settlementError.message : String(settlementError),
                })
            );
        }
        void linkChatReservationProviderRequest(input.reservation.reservationId, {
            providerRequestId: end.providerRequestId ?? null,
            providerResponseId: observation.providerResponseId,
        }).catch(() => undefined);
        input.dispose();
        await releaseChatAccess(input.leaseId).catch(() => undefined);
        await recordReceipt(input.requestId, {
            finishReason: error ? null : observation.finishReason?.slice(0, 64) ?? null,
            errorCode: error?.code ?? null,
        });
        if (outcome === "completed") {
            void Promise.allSettled([recordProviderSuccess(input.model.provider), recordModelSuccess(input.model.id)]);
        } else if (outcome === "failed" && !credentialMissing && !refusedBeforeWork) {
            const meta = safeErrorMetadata(end.transportError);
            void Promise.allSettled([
                recordProviderFailure(input.model.provider, "AI_STREAM_FAILED", {
                    modelId: input.model.id,
                    phase: "stream",
                    traceId: input.requestId,
                    errorName: meta.name,
                    errorCode: meta.code,
                    httpStatus: end.httpStatus ?? meta.statusCode,
                    retryable: meta.isRetryable,
                }),
                recordModelFailure(input.model.id, input.model.provider, "AI_STREAM_FAILED"),
            ]);
        }
        return { error, outcome };
    };

    return {
        keepAlive,
        finish: (end: RunEnd) => (finished ??= settle(end)),
    };
};

/**
 * Relays the provider's stream to the client unchanged, reading it for usage.
 * Pull-based, so a slow client slows the upstream read rather than buffering
 * it. The end of the request does not wait for a pull, though: a timeout or a
 * client that leaves aborts the controller, and the abort itself settles the
 * request and closes the stream -- a client that holds the connection open
 * without reading cannot keep the reservation and the concurrency slot alive
 * past the timeout.
 */
const relayStream = (
    upstream: ReadableStream<Uint8Array>,
    spec: NativeProtocolSpec,
    run: ReturnType<typeof createNativeRun>,
    controller: AbortController,
    providerRequestId: string | null
) => {
    const reader = upstream.getReader();
    const decoder = new TextDecoder();
    const observer = spec.createObserver();
    const encoder = new TextEncoder();
    // Events are relayed as they complete, each with its own data unchanged
    // except an error event's account detail (relayedSseEvent).
    let pending: string[] = [];
    const parser = createSseParser((event) => {
        observer.observe(event);
        pending.push(relayedSseEvent(event));
    });
    const flush = (client: ReadableStreamDefaultController<Uint8Array> | null) => {
        if (!pending.length) return;
        const text = pending.join("");
        pending = [];
        client?.enqueue(encoder.encode(text));
    };
    let streamController: ReadableStreamDefaultController<Uint8Array> | null = null;
    let ended: Promise<void> | null = null;
    /** Settles once and closes the client stream once, whichever path gets here first. */
    const end = (transportError?: unknown) =>
        (ended ??= (async () => {
            controller.signal.removeEventListener("abort", onAbort);
            parser.push(decoder.decode());
            parser.end();
            const observation = observer.final();
            const result = await run.finish({ observation, transportError, providerRequestId });
            // The provider's own error event already told the client; otherwise
            // a stream that did not finish ends with one of ours, never silently.
            const tail =
                result.error && !observation.providerError && result.error.code !== "empty_response"
                    ? spec.streamErrorEvent(result.error.status, result.error.code, result.error.message)
                    : null;
            try {
                flush(streamController);
                if (tail) streamController?.enqueue(encoder.encode(tail));
                streamController?.close();
            } catch {
                // The client is already gone.
            }
        })());
    const onAbort = () => {
        void reader.cancel().catch(() => undefined);
        void end();
    };
    controller.signal.addEventListener("abort", onAbort, { once: true });
    return new ReadableStream<Uint8Array>({
        start(controllerForClient) {
            streamController = controllerForClient;
        },
        async pull(client) {
            // Reads until at least one whole event can go out: a pull that
            // enqueues nothing would not be called again for a waiting reader.
            for (;;) {
                if (ended) return;
                let chunk: ReadableStreamReadResult<Uint8Array>;
                try {
                    chunk = await reader.read();
                } catch (error) {
                    await end(controller.signal.aborted ? undefined : error);
                    return;
                }
                if (ended) return;
                if (chunk.done) {
                    await end();
                    return;
                }
                parser.push(decoder.decode(chunk.value, { stream: true }));
                if (pending.length) {
                    flush(client);
                    return;
                }
            }
        },
        async cancel() {
            controller.abort("client_disconnected");
            await end();
        },
    });
};

/** POST of one native generation request, for either protocol. */
export async function handleNativeGeneration(request: Request, spec: NativeProtocolSpec): Promise<Response> {
    const requestId = `req_${randomUUID().replaceAll("-", "")}`;
    const render = spec.render;
    let leaseId: string | null = null;
    let reservation: ChatUsageReservation | null = null;
    let dispatched = false;
    let disposeDispatch: (() => void) | null = null;
    try {
        const key = await authenticateNative(request, spec, "external-api-completions");
        const { raw, body } = await readNativeJson(request);

        const requestDigest = sha256Hex(requestDigestInput(spec.protocol, raw));
        const idempotencyHeader = request.headers.get("idempotency-key")?.trim() || null;
        if (idempotencyHeader && idempotencyHeader.length > 255) {
            throw new NativeProtocolError(400, "invalid_idempotency_key", "Idempotency-Key must be at most 255 characters.");
        }
        const idempotencyKeyDigest = idempotencyHeader ? sha256Hex(idempotencyHeader) : null;
        if (idempotencyKeyDigest) {
            const replay = await idempotentReplay(key.keyId, idempotencyKeyDigest, requestDigest, render);
            if (replay) return replay;
        }

        const plan = await getUserBillingPlan(key.userId);
        const entry = await resolveNativeModel(spec.protocol, plan.tier, isRecord(body) ? body.model : undefined);
        const { model, capabilities } = entry;
        let prepared = spec.prepare(body, { apiModel: model.apiModel, maxOutputTokens: capabilities.maxOutputTokens });

        // Everything that reaches the provider is in the estimate, including
        // tool schemas, images and opaque signed/encrypted state.
        const estimate = estimateNativeInput(prepared.payload, model.provider);
        const access = identifyChatCaller(request, key.userId, plan.tier, {
            dailyMessageLimit: plan.dailyMessageLimit,
            monthlyMessageLimit: plan.monthlyMessageLimit,
        });
        // A client cache marker means the provider may write the prompt to the
        // 5-minute cache: the write premium is reserved before dispatch and the
        // write billed at settlement (lib/anthropicPromptCaching.ts).
        const budget = createChatBudget("user", model, estimate.breakdown, {
            totalOutputTokenCap: prepared.outputLimit,
            reservationOnlyInputTokens: estimate.reservationOnlyInputTokens,
            ...(prepared.hasCacheMarker ? { promptCachePath: "external_api_messages" as const } : {}),
        });
        // The provider limit and the reserved output are one number: if the
        // pricing tier for this prompt size allows less, the request says so.
        if (budget.maxOutputTokens < prepared.outputLimit) {
            prepared = spec.prepare(body, { apiModel: model.apiModel, maxOutputTokens: budget.maxOutputTokens });
        }

        // Built and checked before anything is held: a header fetch would
        // refuse to send must be a 400 here, not a failure after the hold.
        const upstreamHeaders = checkForwardedHeaders(spec.upstreamHeaders(request, prepared));

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
                    stream: prepared.stream,
                    clientName,
                    requestDigest,
                    idempotencyKeyDigest,
                    protocol: spec.protocol,
                }),
            });
        } catch (error) {
            if (idempotencyKeyDigest && (isChatAccessError(error) || error instanceof ApiSecurityError)) {
                const replay = await idempotentReplay(key.keyId, idempotencyKeyDigest, requestDigest, render);
                if (replay) return replay;
            }
            throw error;
        }
        leaseId = grant.leaseId;
        reservation = grant.usageReservation;

        if (request.signal?.aborted) {
            throw new NativeProtocolError(499, "request_cancelled", "The request was cancelled before it was sent.");
        }
        const controller = new AbortController();
        const onClientAbort = () => controller.abort("client_disconnected");
        request.signal?.addEventListener("abort", onClientAbort, { once: true });
        const timeout = setTimeout(() => controller.abort("timeout"), positiveInteger(process.env.EXTERNAL_API_TIMEOUT_MS, 600_000));
        disposeDispatch = () => {
            clearTimeout(timeout);
            request.signal?.removeEventListener("abort", onClientAbort);
        };
        const run = createNativeRun({ requestId, model, reservation, leaseId, controller, dispose: disposeDispatch });
        const infoHeaders: Record<string, string> = {
            ...NO_STORE,
            "x-request-id": requestId,
            ...(spec.responseHeaders?.(requestId) ?? {}),
            ...(prepared.outputLimitClamped ? { "x-tomverse-output-limit": String(prepared.outputLimit) } : {}),
        };

        // From here the run owns the reservation and settles it.
        dispatched = true;
        run.keepAlive();
        let upstream: Response;
        try {
            upstream = await nativeUpstreamFetch(spec.provider, spec.upstreamPath(request), {
                body: prepared.upstreamBody,
                headers: upstreamHeaders,
                signal: controller.signal,
            });
        } catch (transportError) {
            const { error } = await run.finish({ transportError });
            const failure = error ?? { status: 502, code: "upstream_error", message: "The model provider returned an error." };
            return render(failure.status, failure.message, failure.code, { requestId });
        }
        const providerRequestId = upstream.headers.get("request-id") ?? upstream.headers.get("x-request-id");

        try {
            if (!upstream.ok) {
                const text = await upstream.text().catch(() => "");
                await run.finish({ httpStatus: upstream.status, providerRequestId });
                const shown = publicUpstreamError(upstream.status, upstreamErrorMessage(text));
                return render(shown.status, shown.message, `upstream_${shown.kind}`, { requestId });
            }
            if (prepared.stream) {
                if (!upstream.body) {
                    const { error } = await run.finish({ transportError: new Error("empty stream"), providerRequestId });
                    return render(error?.status ?? 502, error?.message ?? "The model provider returned an error.", error?.code ?? "upstream_error", { requestId });
                }
                return new Response(relayStream(upstream.body, spec, run, controller, providerRequestId), {
                    headers: {
                        ...infoHeaders,
                        "Content-Type": "text/event-stream; charset=utf-8",
                        Connection: "keep-alive",
                        "X-Accel-Buffering": "no",
                    },
                });
            }
            const text = await upstream.text();
            let json: unknown = null;
            try {
                json = JSON.parse(text);
            } catch {
                // Settled below as a failure: no terminal response.
            }
            const { error } = await run.finish({ observation: spec.observeJson(json), providerRequestId });
            if (error && error.code !== "empty_response") return render(error.status, error.message, error.code, { requestId });
            return new Response(text, { headers: { ...infoHeaders, "Content-Type": "application/json" } });
        } catch (transportError) {
            const { error } = await run.finish({ transportError, providerRequestId });
            const failure = error ?? { status: 502, code: "upstream_error", message: "The model provider returned an error." };
            return render(failure.status, failure.message, failure.code, { requestId });
        }
    } catch (error) {
        // Reached only before dispatch: after it, the run owns the reservation.
        if (reservation && !dispatched) {
            await settleChatUsage(reservation, { inputTokens: 0, outputTokens: 0, outcome: "failed" }).catch((settlementError) =>
                console.error(JSON.stringify({ event: "external_api_predispatch_refund_failed", requestId, message: String(settlementError) }))
            );
            await recordReceipt(requestId, { errorCode: "predispatch_failure" });
        }
        if (!dispatched) disposeDispatch?.();
        if (leaseId && !dispatched) await releaseChatAccess(leaseId).catch(() => undefined);
        const refusal = nativeRefusal(error, render, requestId);
        if (refusal) return refusal;
        console.error(JSON.stringify({ event: "external_api_request_failed", requestId, ...safeErrorMetadata(error) }));
        return render(500, "The request could not be processed.", "internal_error", { requestId });
    }
}

/**
 * A provider call that costs nothing and generates nothing (Anthropic's token
 * count): authenticated and rate limited like a read, with no reservation and
 * no receipt.
 */
export async function handleNativeFreeCall(
    request: Request,
    spec: Pick<NativeProtocolSpec, "protocol" | "provider" | "acceptsXApiKey" | "render" | "upstreamHeaders">,
    options: { upstreamPath: string; prepare: (body: unknown, model: { apiModel: string; maxOutputTokens: number }) => Prepared }
): Promise<Response> {
    const requestId = `req_${randomUUID().replaceAll("-", "")}`;
    try {
        const key = await authenticateNative(request, spec, "external-api-reads");
        const { body } = await readNativeJson(request);
        const plan = await getUserBillingPlan(key.userId);
        const entry = await resolveNativeModel(spec.protocol, plan.tier, isRecord(body) ? body.model : undefined);
        const prepared = options.prepare(body, { apiModel: entry.model.apiModel, maxOutputTokens: entry.capabilities.maxOutputTokens });
        const upstreamHeaders = checkForwardedHeaders(spec.upstreamHeaders(request, prepared));
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort("timeout"), 30_000);
        try {
            const upstream = await nativeUpstreamFetch(spec.provider, options.upstreamPath, {
                body: prepared.upstreamBody,
                headers: upstreamHeaders,
                signal: controller.signal,
            });
            const text = await upstream.text();
            if (!upstream.ok) {
                const shown = publicUpstreamError(upstream.status, upstreamErrorMessage(text));
                return spec.render(shown.status, shown.message, `upstream_${shown.kind}`, { requestId });
            }
            return new Response(text, { headers: { ...NO_STORE, "Content-Type": "application/json", "x-request-id": requestId } });
        } finally {
            clearTimeout(timeout);
        }
    } catch (error) {
        const refusal = nativeRefusal(error, spec.render, requestId);
        if (refusal) return refusal;
        if (error instanceof NativeUpstreamUnavailable) {
            return spec.render(503, "This model is not available right now.", "model_unavailable", { requestId });
        }
        console.error(JSON.stringify({ event: "external_api_request_failed", requestId, ...safeErrorMetadata(error) }));
        return spec.render(502, "The model provider could not be reached.", "upstream_error", { requestId });
    }
}
