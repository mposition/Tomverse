import { streamText, type FilePart, type ModelMessage } from "ai";
import { APP_DEFAULTS } from "@/lib/appDefaults";
import {
    buildAttachmentPromptText,
    type ExtractedAttachment,
} from "@/lib/attachmentContextPrompt";
import { createHash, randomUUID } from "node:crypto";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import {
    createR2UploadUrl,
    deleteR2Object,
    readR2Object,
    validateR2ObjectMetadata,
    writeR2Object,
} from "@/lib/r2";
import { conversationKindNotSupportedResponse, isChatConversationKind } from "@/lib/conversationKindGuard";
import { prisma } from "@/lib/prisma";
import {
    AVAILABLE_MODELS,
    modelSupportsImageInput,
    modelSupportsNativePdfInput,
    type AiModel,
} from "@/lib/models";
import { buildTaskProfile } from "@/lib/taskProfileCore";
import { scheduleRoutingShadowRun } from "@/lib/routingShadow";
import { selectAutoModel } from "@/lib/autoModelSelection";
import { decideAutoCohort } from "@/lib/autoCohort";
import { stickyStateAfterRoutedTurn } from "@/lib/conversationSelectionMode";
import {
    attachmentTokensForModel,
    measureTurnAttachments,
    preflightInputEstimate,
    profileTextFor,
    turnCarriesAttachments,
} from "@/lib/autoDispatchPreflight";
import { resolveModelPricing } from "@/lib/modelPricing";
import {
    authoriseDispatch,
    beginInstrumentedDispatch,
    beginRetryAttempt,
    recordFallbackRecovery,
    completeInstrumentedDispatch,
    recordDispatched,
    type DispatchInstrumentation,
} from "@/lib/routingDispatchInstrumentation";
import { getRuntimeModels } from "@/lib/modelRegistry";
import { getActiveAiModel } from "@/lib/activeAiModel";
import {
    getModelGenerationSettings,
    hasUnsupportedGeminiPrefill,
} from "@/lib/modelGenerationCompatibility";
import { getWebSearchCapability } from "@/lib/webSearchCapability";
import { getWebSearchSurchargeCredits } from "@/lib/webSearchCredits";
import { buildWebSearchToolConfig, WEB_SEARCH_TOOL_NAMES } from "@/lib/webSearchToolConfig";
import { normalizeWebSearchExecution } from "@/lib/webSearchExecutionNormalizer";
import { buildChatStreamTrailerChunk } from "@/lib/webSearchStreamTrailer";
import { resolveChatCompletionOutcome } from "@tomverse/chat-core";
import { ERROR_REPORT_TOKEN_HEADER } from "@/lib/errorReportContract";
import { issueChatErrorReportGrant } from "@/lib/traceErrorEvidence";
import {
    consumePerplexityResponseCapture,
    consumePerplexityUsage,
    discardPerplexityUsage,
    perplexityUsageHeaders,
} from "@/lib/perplexityUsageCapture";
import type { PerplexityResponseCapture } from "@/lib/perplexityResponseCore";
import {
    DEEP_RESEARCH_DEPTH_PARAMS,
    describeDeepResearchMessages,
    PerplexityDeepResearchMessageError,
    submitDeepResearchJob,
} from "@/lib/perplexityDeepResearch";
import { assertModelRuntimeAvailable } from "@/lib/modelAvailability";
import { parseOfficeSafely } from "@/lib/officeSecurity";
import {
    extractPdfTextSafely,
    normalizeImageSafely,
    validatePdfSafely,
} from "@/lib/mediaSecurity";
import {
    extractPdfTextWithMistralOcr,
    MISTRAL_OCR_COST_MICRO_USD_PER_PAGE,
} from "@/lib/mistralOcr";
import { recordInternalProviderUsage } from "@/lib/providerUsageAccounting";
import {
    parseProviderResponseMessages,
    providerContextText,
    serializeProviderResponseMessages,
} from "@/lib/messageProviderContext";
import {
    BoundedBufferError,
    readResponseToBuffer,
} from "@/lib/boundedBuffer";
import {
    acquireChatAccess,
    assertModelAccess,
    assertChatRequestSize,
    ChatAccessError,
    chatErrorResponse,
    createChatBudget,
    getChatBudgetReservedCostMicroUsd,
    identifyChatCaller,
    linkChatReservationProviderRequest,
    readChatJsonBody,
    heartbeatChatAccess,
    leaseHeartbeatIntervalMs,
    releaseChatAccess,
    resolveLeaseTtlSeconds,
    settleChatUsage,
    transferProviderBudgetForFallback,
    type ChatUsageReservation,
    validateChatPayload,
} from "@/lib/chatSecurity";
import {
    attemptDispatchOptions,
    planAttemptExecution,
} from "@/lib/chatAttemptExecution";
import {
    autoFallbackScope,
    type FallbackScopeRefusal,
} from "@/lib/autoFallbackGate";
import type {
    AttemptPriceSnapshot,
    AttemptUsage,
} from "@/lib/chatMultiAttemptSettlement";
import {
    decideFallback,
    recoveryAfterFallback,
} from "@/lib/routingFallbackPolicy";
import { classifyStreamFailure } from "@/lib/routingStreamFailure";
import {
    FAULT_INJECTION_HEADER,
    decideFaultInjection,
    faultedReader,
} from "@/lib/routingFaultInjection";
import { resolveDeploymentEnvironment } from "@/lib/deploymentEnvironment";
import { buildRoutingRetryChunk } from "@/lib/routingRetrySignal";
import {
    conversationLockedResponse,
    hasConversationUnlockGrant,
} from "@/lib/conversationLock";
import {
    notifyProviderBudgetIfNeeded,
    recordModelFailure,
    recordModelSuccess,
    recordProviderFailure,
    recordProviderSuccess,
} from "@/lib/providerMonitoring";
import { observeServedProcessingTier } from "@/lib/servedProcessingTier";
import { z } from "zod";
import {
    apiSecurityResponse,
    assertMessageCapacity,
    consumeApiRateLimit,
    readLimitedJson,
    reserveDailyUploadBytes,
} from "@/lib/apiSecurity";
import { ensureGuestVerified } from "@/lib/turnstile";
import {
    effectivePlanModelLimit,
    featureNotIncludedResponse,
    getUserBillingPlan,
} from "@/lib/billingEntitlements";
import { getOperationalFeatureFlags } from "@/lib/appSettings";
import { estimateNativeAttachmentTokens } from "@/lib/chatAttachmentTokens";
import {
    getGuestAttachmentSecret,
    guestAttachmentPrefix,
    isOwnGuestAttachmentKey,
    GUEST_ATTACHMENT_TYPES,
    GUEST_MAX_ATTACHMENT_BYTES,
    GUEST_MAX_ATTACHMENTS_PER_MESSAGE,
} from "@/lib/guestAttachments";
import { isChatCostSafetyCode } from "@/lib/chatCostSafetyCore";
import {
    chatLeaseAcquired,
    chatLeaseReleased,
    chatLeaseStreamPublished,
    chatLeaseTakenByStream,
    chatLeaseToReleaseOnUnwind,
    NO_CHAT_LEASE,
    type ChatLeaseOwnership,
} from "@/lib/chatLeaseOwnershipCore";
import { estimatePromptTokens } from "@/lib/chatTokenEstimate";
import { fitChatOutputToContextWindow } from "@/lib/chatContextWindow";
import {
    ACTIVE_ESTIMATOR_VERSION,
    createTokenEstimateAccumulator,
    getCalibration,
} from "@/lib/chatTokenEstimate";
import { createShadowAccumulator } from "@/lib/tokenEstimateShadow";
import {
    isTokenEstimateShadowEnabled,
    recordShadowReservation,
    SHADOW_CANDIDATE_ESTIMATOR_VERSION,
} from "@/lib/tokenEstimateShadowRecorder";
import { buildChatMemoryContext } from "@/lib/chatMemoryContext";
import { latestUserPromptText } from "@/lib/chatMemoryContextCore";
import {
    consumeContextBundle,
    verifyChatContextBundle,
} from "@/lib/chatContextBundleService";
import { recordMemoryCounter } from "@/lib/memoryMetrics";
import { injectedTokenBucket } from "@/lib/memoryMetricsCore";
import {
    providerDiagnosticCode,
    safeErrorMessage,
    safeErrorMetadata,
} from "@/lib/providerErrorClassification";

const MAX_ATTACHMENTS = 5;
// Every request resends the full conversation history (including past
// attachments, which get re-fetched from R2 and re-parsed on every turn), so
// this is a generous safety ceiling on total reprocessing cost, not a
// per-message limit — see MAX_ATTACHMENTS for the per-send cap.
const MAX_CONVERSATION_ATTACHMENTS = 30;
// Guests resend their whole local history on every turn too, so this bounds
// how much ephemeral storage one guest chat can force the server to re-read.
// Far below the account ceiling on purpose: a guest chat is a trial, not an
// archive.
const GUEST_MAX_CONVERSATION_ATTACHMENTS = 5;
const MAX_ATTACHMENT_SIZE = 10 * 1024 * 1024;
const MAX_TOTAL_ATTACHMENT_SIZE = 25 * 1024 * 1024;
const MAX_EXTRACTED_ATTACHMENT_CHARACTERS = 300_000;
const MAX_STORED_MESSAGE_CHARACTERS = 100_000;
type IncomingAttachment = {
    name?: unknown;
    mediaType?: unknown;
    objectKey?: unknown;
    data?: unknown;
    kind?: unknown;
};

const parseStoredModelIds = (value: unknown) => {
    let parsed = value;
    for (let index = 0; index < 2 && typeof parsed === "string"; index += 1) {
        try {
            parsed = JSON.parse(parsed);
        } catch {
            return [];
        }
    }
    return Array.isArray(parsed)
        ? parsed.filter((item): item is string => typeof item === "string")
        : [];
};

const isClosedStreamControllerError = (error: unknown) => {
    const metadata = safeErrorMetadata(error);
    return (
        metadata.code === "ERR_INVALID_STATE" &&
        safeErrorMessage(error)?.toLowerCase().includes("controller is already closed") ===
            true
    );
};

const logRequestError = (
    event: string,
    traceId: string,
    error: unknown,
    modelId?: string,
    // Non-sensitive request shape only (roles, counts). Never message content.
    details?: Record<string, unknown>
) => {
    console.error(
        JSON.stringify({
            event,
            traceId,
            modelId,
            ...safeErrorMetadata(error),
            ...details,
        })
    );
};

const tracedJsonError = (
    error: string,
    code: string,
    status: number,
    traceId: string,
    details?: Record<string, unknown>,
    grantContext?: {
        phase?: string;
        provider?: string | null;
        modelId?: string | null;
        error?: unknown;
    }
) => {
    // Central error-report grant issuance for this route's JSON errors. The
    // traceId here is always this route's own randomUUID (server_generated);
    // the grant signs it so the feedback endpoint can tell a genuine server
    // error report from a typed-in trace string. Header-only on purpose: the
    // body contract stays byte-identical for existing consumers.
    const grant = issueChatErrorReportGrant({
        traceId,
        routeClass: "chat",
        errorCode: code,
        httpStatus: status,
        ...(grantContext || {}),
    });
    return new Response(JSON.stringify({ error, code, traceId, ...(details ? { details } : {}) }), {
        status,
        headers: {
            "Content-Type": "application/json",
            "X-Request-ID": traceId,
            ...(grant.errorReportToken
                ? { [ERROR_REPORT_TOKEN_HEADER]: grant.errorReportToken }
                : {}),
        },
    });
};
const OFFICE_ATTACHMENT_TYPES = new Set([
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "application/vnd.oasis.opendocument.text",
    "application/vnd.oasis.opendocument.spreadsheet",
    "application/vnd.oasis.opendocument.presentation",
]);
const IMAGE_ATTACHMENT_TYPES = new Set([
    "image/png",
    "image/jpeg",
    "image/webp",
]);
const BINARY_ATTACHMENT_TYPES = new Set([
    ...IMAGE_ATTACHMENT_TYPES,
    "application/pdf",
    ...OFFICE_ATTACHMENT_TYPES,
]);
const isImageAttachmentType = (
    mediaType: string
): mediaType is "image/png" | "image/jpeg" | "image/webp" =>
    IMAGE_ATTACHMENT_TYPES.has(mediaType);
const GOOGLE_EXPORT_TYPES: Record<
    string,
    { mediaType: string; extension: string; kind: "file" | "text" }
> = {
    "application/vnd.google-apps.document": {
        mediaType: "text/plain",
        extension: "txt",
        kind: "text",
    },
    "application/vnd.google-apps.spreadsheet": {
        mediaType:
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        extension: "xlsx",
        kind: "file",
    },
    "application/vnd.google-apps.presentation": {
        mediaType:
            "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        extension: "pptx",
        kind: "file",
    },
};
const ALLOWED_ATTACHMENT_TYPES = new Set([
    "image/png",
    "image/jpeg",
    "image/webp",
    "application/pdf",
    "text/plain",
    "text/markdown",
    "text/csv",
    "application/json",
    ...OFFICE_ATTACHMENT_TYPES,
]);
const uploadPreparationSchema = z.union([
    z
        .object({
            action: z.literal("google-drive-import"),
            fileId: z.string().regex(/^[A-Za-z0-9_-]+$/).max(256),
            name: z.string().trim().min(1).max(120),
            mediaType: z.string().refine((value) => !!GOOGLE_EXPORT_TYPES[value]),
            accessToken: z.string().min(1).max(4096),
        })
        .strict(),
    z
        .object({
            action: z.undefined().optional(),
            name: z.string().trim().min(1).max(120),
            mediaType: z
                .string()
                .refine((value) => ALLOWED_ATTACHMENT_TYPES.has(value)),
            size: z.number().int().positive().max(MAX_ATTACHMENT_SIZE),
        })
        .strict(),
]);
const deleteAttachmentSchema = z
    .object({
        key: z.string().min(1).max(512),
    })
    .strict();
const finalizeAttachmentSchema = z
    .object({
        key: z.string().min(1).max(512),
        mediaType: z.string().refine((value) => ALLOWED_ATTACHMENT_TYPES.has(value)),
        size: z.number().int().positive().max(MAX_ATTACHMENT_SIZE),
    })
    .strict();

const sanitizeFilename = (filename: string) => {
    const safe = filename
        .normalize("NFKC")
        .replace(/[^\p{L}\p{N}._-]+/gu, "-")
        .replace(/^-+|-+$/g, "")
        .slice(-120);

    return safe || "attachment";
};

const createAttachmentKey = (email: string, name: string) => {
    const userHash = createHash("sha256")
        .update(email.toLowerCase())
        .digest("hex")
        .slice(0, 20);
    const date = new Date().toISOString().slice(0, 10);
    return `attachments/${userHash}/${date}/${randomUUID()}-${sanitizeFilename(name)}`;
};

export async function GET() {
    const session = await getServerSession(authOptions);
    if (!session?.user?.email || !session.user.id) {
        return Response.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (!(await getOperationalFeatureFlags()).attachmentsEnabled) {
        return Response.json(
            { error: "Attachments are temporarily disabled for operational maintenance." },
            { status: 503 }
        );
    }
    const billingPlan = await getUserBillingPlan(session.user.id);
    if (!billingPlan.allowAttachments) {
        return featureNotIncludedResponse("attachments");
    }

    const clientId = process.env.GOOGLE_ID;
    const apiKey = process.env.NEXT_PUBLIC_GOOGLE_API_KEY;
    const appId = process.env.NEXT_PUBLIC_GOOGLE_CLOUD_PROJECT_NUMBER;
    if (!clientId || !apiKey || !appId) {
        return Response.json(
            { error: "Google Picker is not configured." },
            { status: 503 }
        );
    }

    return Response.json({ clientId, apiKey, appId });
}

export async function PUT(req: Request) {
    const session = await getServerSession(authOptions);
    const userId = session?.user?.id;
    if (!session?.user?.email || !userId) {
        return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    try {
        if (!(await getOperationalFeatureFlags()).attachmentsEnabled) {
            return Response.json(
                { error: "Attachments are temporarily disabled for operational maintenance." },
                { status: 503 }
            );
        }
        const billingPlan = await getUserBillingPlan(userId);
        if (!billingPlan.allowAttachments) {
            return featureNotIncludedResponse("attachments");
        }
        await consumeApiRateLimit(req, userId, "upload-prepare", {
            minute: 10,
            day: 200,
        });
        const body = await readLimitedJson(
            req,
            16 * 1024,
            uploadPreparationSchema
        );
        if (body.action === "google-drive-import") {
            const fileId = body.fileId;
            const name = body.name;
            const sourceMediaType = body.mediaType;
            const accessToken = body.accessToken;
            const exportType = GOOGLE_EXPORT_TYPES[sourceMediaType];

            if (
                !exportType ||
                !name ||
                !/^[A-Za-z0-9_-]+$/.test(fileId) ||
                !accessToken ||
                accessToken.length > 4096
            ) {
                return Response.json(
                    { error: "Invalid Google Drive file." },
                    { status: 400 }
                );
            }

            const exportUrl = new URL(
                `https://www.googleapis.com/drive/v3/files/${fileId}/export`
            );
            exportUrl.searchParams.set("mimeType", exportType.mediaType);
            const exportResponse = await fetch(exportUrl, {
                headers: { Authorization: `Bearer ${accessToken}` },
                cache: "no-store",
            });
            if (!exportResponse.ok) {
                return Response.json(
                    { error: "Google Drive export failed." },
                    { status: exportResponse.status === 401 ? 401 : 502 }
                );
            }

            let exportedFile: Buffer;
            try {
                exportedFile = await readResponseToBuffer(
                    exportResponse,
                    MAX_ATTACHMENT_SIZE
                );
            } catch (error) {
                if (error instanceof BoundedBufferError) {
                    return Response.json(
                        { error: "Exported file is too large." },
                        { status: 400 }
                    );
                }
                throw error;
            }
            if (
                exportedFile.byteLength === 0 ||
                exportedFile.byteLength > MAX_ATTACHMENT_SIZE
            ) {
                return Response.json(
                    { error: "Exported file is empty or too large." },
                    { status: 400 }
                );
            }

            const baseName =
                name.replace(/\.(gdoc|gsheet|gslides)$/i, "") || "google-file";
            const exportedName = `${baseName}.${exportType.extension}`;
            const key = createAttachmentKey(
                session.user.email,
                exportedName
            );
            await reserveDailyUploadBytes(userId, exportedFile.byteLength);
            await writeR2Object(
                key,
                exportedFile,
                exportType.mediaType
            );
            await validateR2ObjectMetadata(key, {
                maxBytes: MAX_ATTACHMENT_SIZE,
                expectedContentType: exportType.mediaType,
                expectedSize: exportedFile.byteLength,
            });

            return Response.json({
                key,
                name: exportedName,
                mediaType: exportType.mediaType,
                size: exportedFile.byteLength,
                kind: exportType.kind,
            });
        }

        const name = body.name;
        const mediaType = body.mediaType;
        const size = body.size;

        if (!name || !ALLOWED_ATTACHMENT_TYPES.has(mediaType)) {
            return Response.json(
                { error: "Unsupported attachment." },
                { status: 400 }
            );
        }
        if (!Number.isFinite(size) || size <= 0 || size > MAX_ATTACHMENT_SIZE) {
            return Response.json(
                { error: "Attachment is too large." },
                { status: 400 }
            );
        }

        const key = createAttachmentKey(session.user.email, name);
        await reserveDailyUploadBytes(userId, size);
        const uploadUrl = await createR2UploadUrl(key, mediaType, size);

        return Response.json({
            key,
            uploadUrl,
            uploadHeaders: {
                "Content-Type": mediaType,
            },
        });
    } catch (error) {
        const securityResponse = apiSecurityResponse(error);
        if (securityResponse) return securityResponse;
        console.error("R2 upload URL creation failed:", error);
        return Response.json(
            { error: "Failed to prepare attachment upload." },
            { status: 500 }
        );
    }
}

export async function PATCH(req: Request) {
    const session = await getServerSession(authOptions);
    const userId = session?.user?.id;
    if (!session?.user?.email || !userId) {
        return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    try {
        if (!(await getOperationalFeatureFlags()).attachmentsEnabled) {
            return Response.json(
                { error: "Attachments are temporarily disabled for operational maintenance." },
                { status: 503 }
            );
        }
        const billingPlan = await getUserBillingPlan(userId);
        if (!billingPlan.allowAttachments) {
            return featureNotIncludedResponse("attachments");
        }
        await consumeApiRateLimit(req, userId, "upload-finalize", {
            minute: 20,
            day: 300,
        });
        const { key, mediaType, size } = await readLimitedJson(
            req,
            8 * 1024,
            finalizeAttachmentSchema
        );
        const userPrefix = `attachments/${createHash("sha256")
            .update(session.user.email.toLowerCase())
            .digest("hex")
            .slice(0, 20)}/`;

        if (!key.startsWith(userPrefix)) {
            return Response.json({ error: "Forbidden" }, { status: 403 });
        }

        const validated = await validateR2ObjectMetadata(key, {
            maxBytes: MAX_ATTACHMENT_SIZE,
            expectedContentType: mediaType,
            expectedSize: size,
        });

        return Response.json({
            key,
            mediaType,
            size: validated.size,
        });
    } catch (error) {
        const securityResponse = apiSecurityResponse(error);
        if (securityResponse) return securityResponse;
        if (error instanceof BoundedBufferError) {
            return Response.json(
                { error: "Uploaded attachment failed validation." },
                { status: 400 }
            );
        }

        console.error("R2 attachment finalization failed:", error);
        return Response.json(
            { error: "Failed to finalize attachment upload." },
            { status: 500 }
        );
    }
}

export async function DELETE(req: Request) {
    const session = await getServerSession(authOptions);
    const userId = (session?.user as { id?: string } | undefined)?.id;
    if (!session?.user?.email || !userId) {
        return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    try {
        await consumeApiRateLimit(req, userId, "attachment-delete", {
            minute: 30,
            day: 500,
        });
        const { key } = await readLimitedJson(
            req,
            4 * 1024,
            deleteAttachmentSchema
        );
        const userPrefix = `attachments/${createHash("sha256")
            .update(session.user.email.toLowerCase())
            .digest("hex")
            .slice(0, 20)}/`;

        if (!key.startsWith(userPrefix)) {
            return Response.json({ error: "Forbidden" }, { status: 403 });
        }

        await deleteR2Object(key);
        return new Response(null, { status: 204 });
    } catch (error) {
        const securityResponse = apiSecurityResponse(error);
        if (securityResponse) return securityResponse;

        console.error("R2 attachment deletion failed:", error);
        return Response.json(
            { error: "Failed to delete attachment." },
            { status: 500 }
        );
    }
}

export async function POST(req: Request) {
    const traceId = randomUUID();
    // Filled in the moment ensureGuestVerified() passes a fresh token. Every
    // response that leaves this handler afterwards -- the streaming success,
    // the deep-research handoff, and every later 4xx/5xx (rate limit,
    // concurrency, credits, provider budget) -- must carry the grant cookie.
    // Appending it here, on whatever Response the inner handler produced, is
    // what guarantees no return path can forget it: a guest whose challenge
    // was accepted must never be asked to solve another one just because the
    // request then failed a different gate. Verification failures never set
    // this (ensureGuestVerified throws before assigning), so a rejected token
    // still earns nothing.
    const verificationGrant: { setCookie?: string } = {};
    const response = await handleChatPost(req, traceId, verificationGrant);
    if (verificationGrant.setCookie) {
        try {
            // append, not set: the response may already carry the guest
            // identity cookie (accessGrant.setCookie below), and both must
            // survive.
            response.headers.append("Set-Cookie", verificationGrant.setCookie);
        } catch (error) {
            // This is the last statement standing between a finished response
            // and its caller, and it is outside the handler's try -- so a
            // throw here does not just lose the answer, it drops a stream that
            // is still holding a concurrency slot, with nothing left to
            // release it but the fifteen-minute reconciliation. The grant is
            // built by the server from a signed token, so a value `Headers`
            // refuses is a bug rather than a condition; the cost of that bug
            // must not be the caller's answer and their slot. They solve one
            // more challenge instead, and this line is how anyone finds out.
            logRequestError("chat_verification_grant_cookie_rejected", traceId, error);
        }
    }
    return response;
}

async function handleChatPost(
    req: Request,
    traceId: string,
    verificationGrant: { setCookie?: string }
): Promise<Response> {
    // Who holds the concurrency slot right now. The failure path at the bottom
    // asks this rather than a boolean, because "the request no longer holds it"
    // covers both a clean handoff to the stream and a stream that was built and
    // never published -- and only the second is a slot nobody will free.
    let leaseOwnership: ChatLeaseOwnership = NO_CHAT_LEASE;
    // Declared out here so the failure path can stop the renewal timer even
    // when the stream was never built: an interval left running would keep
    // renewing a lease no request owns any more.
    let stopLeaseHeartbeat: (() => void) | null = null;
    let usageReservation: ChatUsageReservation | null = null;
    // Hoisted so the outer catch can close the attempt. A provider that
    // refuses the call leaves an attempt that was prepared and never
    // dispatched, and an attempt stuck at `pending` is one the reliability
    // numbers cannot classify.
    let dispatchRecord: DispatchInstrumentation = null;
    // The model this request tried to run, for the outer failure path.
    //
    // Set to the requested id as soon as one is parsed, so a failure before
    // routing still names something, then narrowed to the effective model once
    // the Router has decided. Provider health is only meaningful about the
    // model that was actually going to be called: pairing the requested id
    // with the effective provider -- which is what this used to do on a routed
    // turn -- credits an outage to a model nobody dispatched.
    let dispatchModelIdForLog: string | undefined;
    let dispatchProviderForLog: AiModel["provider"] | undefined;
    try {
        assertChatRequestSize(req);
        const session = await getServerSession(authOptions);
        const body = await readChatJsonBody(req);
        const {
            messages,
            modelId,
            conversationId,
            assistantMessageId,
            turnstileToken,
            deepResearchDepth,
            webSearchMode,
            admissionToken,
            contextBundle,
        } = validateChatPayload(body);
        const requestedModelId = modelId || APP_DEFAULTS.defaultModelId;
        // Auto's inputs, gathered before the model is resolved because the
        // model is what Auto decides. The plan is carried forward to the
        // access check below so this is not a second query.
        const accountPlan = session?.user?.id
            ? await getUserBillingPlan(session.user.id)
            : null;
        // §8.1 invariant 1: the conversation's stored mode, read from the row
        // the ownership check loads below. Null for a request with no
        // conversation, which inherits the account default like `inherit`.
        let conversationMemoryMode: string | null = null;
        dispatchModelIdForLog = requestedModelId;
        const runtimeModels = await getRuntimeModels({ includeCatalogDeleted: true });
        const runtimeModelMap = new Map(runtimeModels.map((model) => [model.id, model]));
        const catalogModel = runtimeModelMap.get(requestedModelId);
        if (catalogModel && !catalogModel.enabled) {
            const replacementCandidate = catalogModel.replacementModelId
                ? runtimeModelMap.get(catalogModel.replacementModelId)
                : undefined;
            // Only name a replacement the user could actually go and pick.
            // A retirement that points at a delisted or disabled model is a
            // dead end, so in that case the message stays generic.
            const replacement =
                replacementCandidate?.enabled &&
                replacementCandidate.publiclyListed !== false &&
                !replacementCandidate.catalogDeleted
                    ? replacementCandidate
                    : undefined;
            return tracedJsonError(
                replacement
                    ? `${catalogModel.name} is no longer available. Please select ${replacement.name}.`
                    : `${catalogModel.name} is no longer available. Please select another model.`,
                "MODEL_RETIRED",
                410,
                traceId,
                // The client renders its own localized sentence, so it needs
                // the replacement as data rather than inside English prose --
                // the copy used to hard-code one model name for every
                // retirement, which named the wrong model the moment a second
                // model was retired onto a different successor.
                replacement
                    ? {
                          replacementModelId: replacement.id,
                          replacementModelName: replacement.name,
                      }
                    : undefined
            );
        }
        const requestedModelConfig =
            catalogModel?.enabled && !catalogModel.catalogDeleted ? catalogModel : undefined;
        if (!requestedModelConfig) {
            return tracedJsonError(
                "Unknown or disabled model.",
                "MODEL_NOT_AVAILABLE",
                400,
                traceId
            );
        }

        // ---- Auto routing (routing policy §5; delivery plan step 4) -------
        //
        // Placed here, after the retirement check on the model the user asked
        // for and before anything downstream binds to a model. Everything past
        // this line -- the Gemini prefill rule, admin availability, the web
        // search capability, the provider-context restore, the attachment
        // shaping, the credit budget, the window fit and the manifest -- then
        // runs against the model that actually answers, with no second pass
        // and nothing checked against a model that was never dispatched.
        //
        // The retirement branch above deliberately still speaks about the
        // requested model: a user whose chosen model was retired is told so,
        // rather than having Auto quietly paper over it.
        // The caller's own attachment scope, derived from their signed identity
        // rather than compared against anything in the request, so a crafted
        // objectKey can only ever resolve inside it. Hoisted above the routing
        // probe below, which measures attachment sizes and must obey the same
        // rule: a probe that measured any key would be an object-size oracle
        // over the whole bucket.
        const ownAttachmentPrefix = session?.user?.email
            ? `attachments/${createHash("sha256")
                .update(session.user.email.toLowerCase())
                .digest("hex")
                .slice(0, 20)}/`
            : null;
        // Only read when the cohort would admit this account. `decideAutoCohort`
        // costs nothing -- the plan is already in hand and readiness is read
        // from memory -- so while the rollout is off this query never runs and
        // the chat path pays nothing for a feature nobody has.
        const autoCohort = decideAutoCohort({
            subjectKey: session?.user?.id ?? "",
            isGuest: !session?.user?.id,
            plan: accountPlan?.tier ?? null,
        });
        const conversationRouting =
            autoCohort.eligible && conversationId && session?.user?.id
                ? await prisma.conversation.findFirst({
                      // The owner is in the `where`, not checked afterwards,
                      // so this cannot read another account's mode. The real
                      // ownership check still runs below and still answers 403;
                      // a miss here simply reads as "not an Auto conversation".
                      where: { id: conversationId, userId: session.user.id },
                      select: {
                          selectionMode: true,
                          routerModelId: true,
                          routerChallengerTurns: true,
                      },
                  })
                : null;
        // Measured, not declared. A size the client stated is a claim, and an
        // understated one would steer the Router to a model whose window the
        // real content does not fit -- leaving the user with a context-window
        // error for a model they did not choose. Skipped entirely when the
        // cohort would refuse anyway, so a turn nobody routes pays for no HEAD
        // requests.
        const measuredAttachments =
            autoCohort.eligible && turnCarriesAttachments(messages)
                ? await measureTurnAttachments(messages, ownAttachmentPrefix)
                : ({ measurable: true, descriptors: [] } as const);
        const autoSelection = selectAutoModel({
            requestedModelId,
            conversation: conversationRouting,
            subjectKey: session?.user?.id ?? "",
            isGuest: !session?.user?.id,
            plan: accountPlan?.tier ?? null,
            attachmentsUnmeasurable: !measuredAttachments.measurable,
            attachmentTokensFor: measuredAttachments.measurable
                ? attachmentTokensForModel(measuredAttachments.descriptors)
                : undefined,
            text: profileTextFor(messages),
            // The profiler reads these to set hasImageInput / hasDocumentInput,
            // which is what stops an image turn being routed to a model that
            // cannot see one. Media types only -- no name, no bytes.
            attachments: measuredAttachments.measurable
                ? measuredAttachments.descriptors.map((descriptor) => ({
                      mediaType: descriptor.mediaType,
                  }))
                : [],
            webSearchRequested: webSearchMode === "always",
            // Runtime models, not the static catalogue: a model an operator has
            // disabled must not be chosen and then refused two lines later by
            // `assertModelRuntimeAvailable`.
            models: runtimeModels.filter(
                (model) => model.enabled && !model.catalogDeleted
            ),
            reservedInputTokens: preflightInputEstimate(messages).estimatedInputTokens,
            // The unfitted application cap. The filters fit it to each model's
            // own window; a figure already fitted to the requested model's
            // window would bias every other candidate against it.
            requestOutputCapTokens: resolveModelPricing(requestedModelConfig)
                .maxOutputTokens,
        });
        const effectiveModelId = autoSelection.routed
            ? autoSelection.modelId
            : requestedModelId;
        if (autoSelection.routed) {
            console.info(JSON.stringify({
                event: "chat_auto_routed",
                traceId,
                conversationId,
                requestedModelId,
                selectedModelId: effectiveModelId,
                selectionReason: autoSelection.record.selectionReason,
                routerVersion: autoSelection.versions.decision,
                timestamp: new Date().toISOString(),
            }));
        }
        const routedCatalogModel = autoSelection.routed
            ? runtimeModelMap.get(effectiveModelId)
            : requestedModelConfig;
        // The Router only ever considers runtime models that are enabled and
        // not catalogue-deleted, so a miss here means the Router returned
        // something outside the list it was given. Falling back to the
        // requested model keeps the answer, and the log says it happened --
        // silently answering from a model nobody chose is the one outcome
        // worse than either.
        if (autoSelection.routed && !routedCatalogModel) {
            console.error(JSON.stringify({
                event: "chat_auto_routed_model_missing",
                traceId,
                selectedModelId: effectiveModelId,
                timestamp: new Date().toISOString(),
            }));
        }
        const modelConfig = routedCatalogModel?.enabled && !routedCatalogModel.catalogDeleted
            ? routedCatalogModel
            : requestedModelConfig;
        if (hasUnsupportedGeminiPrefill(modelConfig, messages)) {
            return tracedJsonError(
                "Gemini 3.6 and later requests must end with a user message.",
                "GEMINI_PREFILLED_MODEL_TURN_UNSUPPORTED",
                400,
                traceId
            );
        }
        // The model that will answer, not the one that was asked for: Auto's
        // choice passes the same operational gate as a manual one.
        const adminModelAccess = await assertModelRuntimeAvailable(modelConfig.id);
        if (!adminModelAccess.allowed) {
            return tracedJsonError(
                adminModelAccess.reason || "This model is temporarily unavailable.",
                "MODEL_TEMPORARILY_UNAVAILABLE",
                503,
                traceId
            );
        }
        dispatchProviderForLog = modelConfig.provider;
        dispatchModelIdForLog = modelConfig.id;
        // webSearchMode === "always" only ever enables a model's OWN
        // provider-native search tool when its exact catalog id is
        // confirmed-supported -- it never adds or swaps in a different
        // model (see lib/webSearchCapability.ts for the support matrix).
        const webSearchCapability = getWebSearchCapability(modelConfig.id);
        const webSearchRequested = webSearchMode === "always";
        const nativeSearchEnabled =
            webSearchRequested && webSearchCapability.support === "native";
        const requestAttachments = messages.flatMap((message) =>
            Array.isArray(message.attachments)
                ? (message.attachments as IncomingAttachment[])
                : []
        );
        const latestMessage = messages[messages.length - 1];
        const latestMessageAttachmentCount = Array.isArray(
            latestMessage?.attachments
        )
            ? latestMessage.attachments.length
            : 0;
        if (latestMessageAttachmentCount > MAX_ATTACHMENTS) {
            throw new ChatAccessError(
                413,
                "TOO_MANY_ATTACHMENTS",
                "A chat request can contain at most 5 attachments."
            );
        }
        if (requestAttachments.length > MAX_CONVERSATION_ATTACHMENTS) {
            throw new ChatAccessError(
                413,
                "TOO_MANY_CONVERSATION_ATTACHMENTS",
                "This conversation has reached its attachment limit. Start a new chat to attach more files."
            );
        }
        const objectKeys = new Set<string>();
        for (const attachment of requestAttachments) {
            const hasObjectKey = typeof attachment?.objectKey === "string";
            const hasInlineData = typeof attachment?.data === "string";
            if (hasInlineData) {
                throw new ChatAccessError(
                    400,
                    "INLINE_ATTACHMENT_FORBIDDEN",
                    "Attachments must be uploaded before sending."
                );
            }
            if (hasObjectKey) {
                const objectKey = attachment.objectKey as string;
                if (objectKeys.has(objectKey)) {
                    throw new ChatAccessError(
                        400,
                        "DUPLICATE_ATTACHMENT_OBJECT",
                        "Duplicate attachment objects are not allowed."
                    );
                }
                objectKeys.add(objectKey);
            }
        }
        if (objectKeys.size > MAX_CONVERSATION_ATTACHMENTS) {
            throw new ChatAccessError(
                413,
                "TOO_MANY_ATTACHMENT_OBJECTS",
                "This conversation has reached its attachment limit. Start a new chat to attach more files."
            );
        }
        // Resolved before the model, because Auto needs the plan to decide
        // whether this account is routed at all. Reused here rather than
        // fetched twice.
        const billingPlan = accountPlan;
        const userPlan = billingPlan?.tier;
        const access = identifyChatCaller(
            req,
            session?.user?.id,
            userPlan,
            billingPlan
                ? {
                      dailyMessageLimit: billingPlan.dailyMessageLimit,
                      monthlyMessageLimit: billingPlan.monthlyMessageLimit,
                  }
                : undefined
        );
        // Attachments are gated per access kind rather than by "is there a
        // session". A guest may send one ephemeral file per message, uploaded
        // through /api/chat/guest-attachment and already validated and parsed
        // there; an account keeps the durable, plan-gated flow unchanged.
        if (requestAttachments.length > 0) {
            if (!(await getOperationalFeatureFlags()).attachmentsEnabled) {
                return tracedJsonError(
                    "Attachments are temporarily disabled for operational maintenance.",
                    "ATTACHMENTS_DISABLED_BY_ADMIN",
                    503,
                    traceId
                );
            }
            if (access.kind === "guest") {
                if (
                    latestMessageAttachmentCount >
                    GUEST_MAX_ATTACHMENTS_PER_MESSAGE
                ) {
                    throw new ChatAccessError(
                        413,
                        "GUEST_TOO_MANY_ATTACHMENTS",
                        "Guests can attach one file per message. Sign in to send more."
                    );
                }
                if (
                    requestAttachments.length >
                    GUEST_MAX_CONVERSATION_ATTACHMENTS
                ) {
                    throw new ChatAccessError(
                        413,
                        "GUEST_TOO_MANY_CONVERSATION_ATTACHMENTS",
                        "This guest chat has reached its file limit. Sign in to keep attaching files."
                    );
                }
            } else if (!billingPlan?.allowAttachments) {
                return featureNotIncludedResponse("attachments");
            }
        }
        assertModelAccess(access, modelConfig);
        if (access.kind === "guest") {
            verificationGrant.setCookie = await ensureGuestVerified(
                req,
                turnstileToken,
                "guest_chat",
                { traceId }
            );
        }
        if (conversationId && assistantMessageId) {
            if (!session?.user?.id) {
                return tracedJsonError(
                    "Authentication required.",
                    "AUTHENTICATION_REQUIRED",
                    401,
                    traceId
                );
            }
            const conversation = await prisma.conversation.findUnique({
                where: { id: conversationId },
                select: {
                    userId: true,
                    password: true,
                    selectedModels: true,
                    kind: true,
                    memoryMode: true,
                },
            });
            conversationMemoryMode = conversation?.memoryMode ?? null;
            if (!conversation || conversation.userId !== session.user.id) {
                return tracedJsonError(
                    "Conversation access denied.",
                    "CONVERSATION_FORBIDDEN",
                    403,
                    traceId
                );
            }
            if (
                !hasConversationUnlockGrant(
                    req,
                    session.user.id,
                    conversationId,
                    conversation.password
                )
            ) {
                return conversationLockedResponse();
            }
            // Image conversations never accept chat messages; their model
            // comes from the image generation layer, not selectedModels.
            // See docs/policy/image-generation.md section 1.
            if (!isChatConversationKind(conversation.kind)) {
                return conversationKindNotSupportedResponse();
            }
            const selectedConversationModels = Array.from(
                new Set(parseStoredModelIds(conversation.selectedModels))
            )
                .filter((selectedModelId) => {
                    const selectedModel = runtimeModelMap.get(selectedModelId);
                    return selectedModel?.enabled && !selectedModel.catalogDeleted;
                })
                .slice(0, APP_DEFAULTS.maxSelectedModels);
            const maxModels = billingPlan
                ? effectivePlanModelLimit(billingPlan)
                : 1;
            if (selectedConversationModels.length > maxModels) {
                return tracedJsonError(
                    `Your plan allows up to ${maxModels} models per conversation.`,
                    "PLAN_MODEL_LIMIT_EXCEEDED",
                    403,
                    traceId
                );
            }
            // Skipped on a routed turn, and only there. The check exists to
            // stop a client asking for a model the conversation does not have
            // selected; in Auto the user selected no model for this turn, the
            // server did, and `selectedModels` is the manual list it is not
            // choosing from.
            if (
                !autoSelection.routed &&
                selectedConversationModels.length > 0 &&
                !selectedConversationModels.includes(requestedModelId)
            ) {
                console.warn(JSON.stringify({
                    event: "chat_model_selection_denied",
                    code: "MODEL_NOT_SELECTED",
                    status: 403,
                    traceId,
                    conversationId,
                    requestedModelId,
                    selectedModelIds: selectedConversationModels,
                    timestamp: new Date().toISOString(),
                }));
                return tracedJsonError(
                    "The requested model is not selected for this conversation.",
                    "MODEL_NOT_SELECTED",
                    403,
                    traceId
                );
            }
        }
        const userObjectPrefix = ownAttachmentPrefix;
        // One guest's storage scope, derived from their own signed identity.
        // Computed here rather than compared against a value from the request,
        // so a crafted objectKey can only ever resolve inside the caller's own
        // prefix -- there is nothing to guess and nothing to enumerate.
        const guestObjectPrefix =
            access.kind === "guest"
                ? guestAttachmentPrefix(
                      access.subjectKey,
                      getGuestAttachmentSecret()
                  )
                : null;

        const activeModel = getActiveAiModel(modelConfig);
        let estimatedInputTokens = 0;
        let totalAttachmentBytes = 0;
        let totalExtractedCharacters = 0;
        let totalImageCount = 0;
        let totalBase64ImagePayloadBytes = 0;
        // Shared with the composer estimate and the comparison preflight so a
        // Korean conversation is not reserved several times too small here and
        // correctly elsewhere -- see lib/chatTokenEstimate.ts.
        //
        // The shadow accumulator hangs off this alias rather than off each call
        // site: every text-derived contribution to estimatedInputTokens already
        // passes through here, so one wrapper captures them all and none can be
        // forgotten later. It only observes -- the returned value is unchanged.
        const shadowAccumulator = isTokenEstimateShadowEnabled()
            ? createShadowAccumulator({
                  controlVersion: ACTIVE_ESTIMATOR_VERSION,
                  candidateVersion: SHADOW_CANDIDATE_ESTIMATOR_VERSION,
              })
            : null;
        // The segment-level companion to `estimatedInputTokens`. The number is
        // what the rest of this handler reads; the breakdown is what the
        // reservation needs, because the calibration widens each character
        // segment by its own margin and a bare total has thrown that mix away.
        // Both are fed from this one alias so neither can drift from the other
        // -- `tests/chatBudgetBreakdown.test.mjs` pins that they agree.
        const inputEstimate = createTokenEstimateAccumulator();
        const estimateTextTokens = (text: string) => {
            shadowAccumulator?.add(text);
            const raw = estimatePromptTokens(text);
            // The per-piece floor is a minimum, not a prediction: an empty
            // message still costs the provider its role framing. It is counted
            // as an opaque token so no tokenizer margin is applied to it.
            if (raw > 0) inputEstimate.addText(text);
            else inputEstimate.addTokens(1);
            return Math.max(1, raw);
        };

        const providerContextQueues = new Map<string, ModelMessage[][]>();
        if (
            conversationId &&
            session?.user?.id &&
            modelConfig.reasoning !== undefined
        ) {
            try {
                const storedContexts =
                    await prisma.messageProviderContext.findMany({
                        where: {
                            // Reasoning traces belong to the model that
                            // produced them. On a turn Auto routed elsewhere
                            // there is nothing stored for the new model, so
                            // nothing is restored -- which is correct: another
                            // model's reasoning is not this model's context.
                            modelId: modelConfig.id,
                            message: { conversationId },
                        },
                        orderBy: { createdAt: "asc" },
                        select: {
                            responseMessages: true,
                            message: { select: { content: true } },
                        },
                    });
                for (const stored of storedContexts) {
                    const restored = parseProviderResponseMessages(
                        stored.responseMessages
                    );
                    if (!restored) continue;
                    const queue =
                        providerContextQueues.get(stored.message.content) || [];
                    queue.push(restored);
                    providerContextQueues.set(stored.message.content, queue);
                }
            } catch (error) {
                // Provider context improves reasoning continuity but must not
                // make an otherwise valid conversation unreadable if the
                // private side table is temporarily unavailable.
                logRequestError(
                    "provider_context_load_failed",
                    traceId,
                    error,
                    requestedModelId
                );
            }
        }

        // The §10 context bundle: what memory this request may carry, and
        // proof that it is the same context the request was priced against.
        //
        // No bundle means no memory, and that is not a degraded fallback: a
        // request whose price did not include a memory block must not send
        // one, or the user is charged for one prompt and shown another. It is
        // also the ordinary path today — injection stays off until §12.4's
        // procedure has been completed, so nothing issues a bundle and this
        // whole branch is skipped.
        let memorySystemPrompt: string | null = null;
        let memoryUsedCount = 0;
        // §22 attribution, written onto the answer rather than counted.
        //
        // The day counters beside this already report the injection *ratio*.
        // What they cannot report is which answer carried memory, and the
        // follow-up proxy is a comparison between the answers memory shaped
        // and the ones it did not — so it needs the fact per answer. Null
        // while no bundle accompanies the request, which is what "memory was
        // not possible here" means; §8.1 invariant 4 permits the used count
        // and forbids the context itself, which is never written.
        let memoryAttribution: {
            memoryUsedCount: number;
            memoryTokens: number;
        } | null = null;
        if (session?.user?.id) {
            // §22's injection denominator. Recorded before the bundle branch
            // so it counts every authenticated request, including the ones
            // that carry no bundle — the share of requests that had no memory
            // to inject is the thing the ratio is for.
            void recordMemoryCounter("chat_memory_eligible");
        }
        if (contextBundle && session?.user?.id) {
            void recordMemoryCounter("context_bundle_presented");
            // Built here rather than trusted from the bundle: staleness is
            // decided by recomputing, and a bundle that asserted its own
            // freshness would be exactly as trustworthy as the client holding
            // it (§10). The query is the raw prompt, the same text the
            // preparation step scored — not the attachment-augmented message
            // assembled below, which would retrieve differently.
            const memoryContext = await buildChatMemoryContext({
                userId: session.user.id,
                query: latestUserPromptText(messages),
                // §8.1 invariant 1: this conversation's own mode decides, with
                // `inherit` falling back to the account default. Read here
                // rather than trusted from the client, and read on the chat
                // side as well as the preflight side so a mode changed between
                // the two is caught by the freshness check instead of being
                // priced one way and sent the other.
                conversationMode: conversationMemoryMode,
            });
            const verification = verifyChatContextBundle(contextBundle, {
                subjectKey: session.user.id,
                conversationId: conversationId ?? null,
                modelId: requestedModelId,
                currentFingerprint: memoryContext.fingerprint,
            });
            if (!verification.ok) {
                // Two different failures with two different meanings. Drift is
                // expected and recoverable — the user approved a memory while
                // the send was in flight — so it names the recovery. Everything
                // else is a token that never described this request: a bad
                // signature, another subject, a model that was not priced. That
                // is a client defect or tampering, and answering it with
                // "re-preflight" would invite a retry loop against a token that
                // can never pass.
                const drifted =
                    verification.reason === "stale" ||
                    verification.reason === "expired";
                // Awaited rather than fired and forgotten: the response is
                // about to be returned, and a refusal that is never counted
                // is exactly the observation §22 wants. One upsert, on a path
                // that is rare by construction.
                await recordMemoryCounter(
                    drifted ? "context_bundle_stale" : "context_bundle_rejected"
                );
                return drifted
                    ? tracedJsonError(
                          "The conversation context changed while this message was being sent.",
                          "CHAT_CONTEXT_BUNDLE_STALE",
                          409,
                          traceId,
                          { requiresPreflight: true }
                      )
                    : tracedJsonError(
                          "Invalid chat context.",
                          "INVALID_CONTEXT_BUNDLE",
                          400,
                          traceId
                      );
            }
            const consumption = await consumeContextBundle({
                bundleId: verification.payload.bundleId,
                modelId: requestedModelId,
                userId: session.user.id,
                expiresAt: new Date(verification.payload.expiresAtMs),
            });
            if (!consumption.consumed) {
                // A replay, not drift — but the recovery is the same one, and
                // §18's code table is settled: this request cannot establish
                // that its context was priced, and a fresh preparation is what
                // fixes it. Reusing the code keeps one client path instead of
                // adding a second that would do the same thing.
                //
                // Counted apart from staleness even so: the user-facing code
                // is shared, but "the context drifted" and "this bundle was
                // presented twice" are different operational facts, and only
                // the first belongs in the stale ratio.
                await recordMemoryCounter("context_bundle_replayed");
                return tracedJsonError(
                    "The conversation context changed while this message was being sent.",
                    "CHAT_CONTEXT_BUNDLE_STALE",
                    409,
                    traceId,
                    { requiresPreflight: true }
                );
            }
            memorySystemPrompt = memoryContext.prompt.text;
            memoryUsedCount = memoryContext.prompt.usedCount;
            memoryAttribution = {
                memoryUsedCount,
                memoryTokens: verification.payload.memoryTokens,
            };
            if (memorySystemPrompt) {
                // A bundle that passed but selected nothing is not an
                // injection: no block reaches the prompt, so counting it would
                // report memory as used on a request the model never saw it in.
                void recordMemoryCounter("chat_memory_injected");
                if (memoryContext.truncatedByBudget) {
                    void recordMemoryCounter("injected_context_truncated");
                }
                // The priced figure, not a fresh estimate, so the bucket
                // describes the same block the reservation was taken against.
                const bucket = injectedTokenBucket(
                    verification.payload.memoryTokens
                );
                if (bucket) void recordMemoryCounter(bucket);
            }
            // The figure that was reserved against, not a fresh estimate: the
            // two agree here by construction, and if they ever stop agreeing
            // the user should be billed the number they were quoted.
            estimatedInputTokens += verification.payload.memoryTokens;
            // Quoted, not re-estimated -- so it enters as an opaque count.
            inputEstimate.addTokens(verification.payload.memoryTokens);
        }

        // §9.1 places the memory block above the conversation and below the
        // safety policy, so it is the first message and the rules that govern
        // reading it are stated inside it, before the memories themselves.
        const formattedMessages: ModelMessage[] = memorySystemPrompt
            ? [{ role: "system", content: memorySystemPrompt }]
            : [];
        for (const msg of messages) {
            if (msg.role === "assistant") {
                const content = String(msg.content ?? "");
                const preserved = providerContextQueues.get(content)?.shift();
                if (preserved) {
                    estimatedInputTokens += estimateTextTokens(
                        providerContextText(preserved)
                    );
                    formattedMessages.push(...preserved);
                    continue;
                }
                estimatedInputTokens += estimateTextTokens(content);
                formattedMessages.push({ role: "assistant", content });
                continue;
            }

            const attachments = (
                Array.isArray(msg.attachments) ? msg.attachments : []
            ) as IncomingAttachment[];
            const textAttachments: ExtractedAttachment[] = [];
            const fileParts: FilePart[] = [];

            for (const attachment of attachments) {
                if (
                    !attachment ||
                    typeof attachment.name !== "string" ||
                    typeof attachment.mediaType !== "string" ||
                    !ALLOWED_ATTACHMENT_TYPES.has(attachment.mediaType)
                ) {
                    throw new Error("Unsupported attachment.");
                }
                if (
                    (BINARY_ATTACHMENT_TYPES.has(attachment.mediaType) &&
                        attachment.kind !== "file") ||
                    (!BINARY_ATTACHMENT_TYPES.has(attachment.mediaType) &&
                        attachment.kind !== "text")
                ) {
                    throw new ChatAccessError(
                        400,
                        "INVALID_ATTACHMENT_KIND",
                        "The attachment kind does not match its media type."
                    );
                }

                let attachmentData: string;
                let attachmentBytes: number;
                let attachmentBuffer: Buffer | undefined;
                let extractedPdfText: string | undefined;
                let pdfFilePartBuffer: Buffer | undefined;

                const isGuestObject =
                    typeof attachment.objectKey === "string" &&
                    Boolean(guestObjectPrefix) &&
                    isOwnGuestAttachmentKey(
                        attachment.objectKey,
                        access.subjectKey,
                        getGuestAttachmentSecret()
                    );
                if (isGuestObject && !GUEST_ATTACHMENT_TYPES[attachment.mediaType]) {
                    throw new ChatAccessError(
                        400,
                        "GUEST_ATTACHMENT_UNSUPPORTED_TYPE",
                        "This file type cannot be attached as a guest."
                    );
                }
                const attachmentSizeLimit = isGuestObject
                    ? GUEST_MAX_ATTACHMENT_BYTES
                    : MAX_ATTACHMENT_SIZE;

                if (typeof attachment.objectKey === "string") {
                    const isOwnUserObject =
                        Boolean(userObjectPrefix) &&
                        attachment.objectKey.startsWith(userObjectPrefix!);
                    if (!isOwnUserObject && !isGuestObject) {
                        throw new Error("Attachment access denied.");
                    }

                    try {
                        attachmentBuffer = await readR2Object(
                            attachment.objectKey,
                            {
                                maxBytes: attachmentSizeLimit,
                                expectedContentType: attachment.mediaType,
                            }
                        );
                    } catch (error) {
                        // A guest object is ephemeral by design, so "gone" is
                        // an ordinary outcome (the TTL sweep took it), not a
                        // server fault. Say so instead of returning a 500 the
                        // user cannot act on.
                        if (isGuestObject) {
                            logRequestError(
                                "guest_attachment_unavailable",
                                traceId,
                                error,
                                requestedModelId
                            );
                            throw new ChatAccessError(
                                410,
                                "GUEST_ATTACHMENT_EXPIRED",
                                "The attached file is no longer available. Attach it again, or sign in to keep files with your chat."
                            );
                        }
                        throw error;
                    }
                    attachmentBytes = attachmentBuffer.byteLength;
                    attachmentData =
                        attachment.kind === "text"
                            ? attachmentBuffer.toString("utf8")
                            : attachmentBuffer.toString("base64");
                } else {
                    throw new Error("Attachment data is missing.");
                }

                if (attachmentBytes > attachmentSizeLimit) {
                    throw new ChatAccessError(
                        413,
                        "ATTACHMENT_TOO_LARGE",
                        "An attachment exceeds the per-file size limit."
                    );
                }

                if (isImageAttachmentType(attachment.mediaType)) {
                    if (!modelSupportsImageInput(modelConfig)) {
                        throw new ChatAccessError(
                            400,
                            "ATTACHMENT_MODEL_UNSUPPORTED",
                            `${modelConfig.name} does not support image input. Choose an image-capable model or retry without attachments.`
                        );
                    }
                    try {
                        attachmentBuffer = await normalizeImageSafely(
                            attachmentBuffer ||
                                Buffer.from(attachmentData, "base64"),
                            attachment.mediaType,
                            MAX_ATTACHMENT_SIZE
                        );
                    } catch {
                        throw new ChatAccessError(
                            400,
                            "INVALID_IMAGE_ATTACHMENT",
                            "The attached image is invalid or unsupported."
                        );
                    }
                    attachmentBytes = attachmentBuffer.byteLength;
                    attachmentData = attachmentBuffer.toString("base64");
                    totalImageCount += 1;
                    totalBase64ImagePayloadBytes += Buffer.byteLength(
                        attachmentData,
                        "utf8"
                    );
                    const imageCapabilities = modelConfig.inputCapabilities;
                    if (
                        imageCapabilities?.maxImages &&
                        totalImageCount > imageCapabilities.maxImages
                    ) {
                        throw new ChatAccessError(
                            400,
                            "ATTACHMENT_MODEL_IMAGE_LIMIT",
                            `${modelConfig.name} accepts up to ${imageCapabilities.maxImages} images per request.`
                        );
                    }
                    if (
                        imageCapabilities?.maxBase64ImagePayloadBytes &&
                        totalBase64ImagePayloadBytes >
                            imageCapabilities.maxBase64ImagePayloadBytes
                    ) {
                        throw new ChatAccessError(
                            413,
                            "ATTACHMENT_MODEL_IMAGE_PAYLOAD_TOO_LARGE",
                            `${modelConfig.name} accepts up to 4 MB of base64 image data per request. Use a smaller image.`
                        );
                    }
                } else if (attachment.mediaType === "application/pdf") {
                    const pdfBuffer =
                        attachmentBuffer || Buffer.from(attachmentData, "base64");
                    const remainingCharacters =
                        MAX_EXTRACTED_ATTACHMENT_CHARACTERS -
                        totalExtractedCharacters;
                    if (remainingCharacters <= 64) {
                        throw new ChatAccessError(
                            413,
                            "ATTACHMENT_TEXT_TOO_LARGE",
                            "Extracted attachment text exceeds the request limit."
                        );
                    }
                    let pdfValidated = false;
                    try {
                        extractedPdfText = await extractPdfTextSafely(
                            pdfBuffer,
                            remainingCharacters - 64
                        );
                    } catch (error) {
                        logRequestError(
                            "pdf_text_extraction_failed",
                            traceId,
                            error,
                            requestedModelId
                        );
                        try {
                            await validatePdfSafely(pdfBuffer);
                            pdfValidated = true;
                        } catch {
                            throw new ChatAccessError(
                                400,
                                "INVALID_PDF_ATTACHMENT",
                                "The attached PDF is invalid or unsupported."
                            );
                        }
                    }

                    // Scanned or image-only PDFs have no local text layer.
                    // Validate them before leaving the process, then use OCR 4
                    // as a backend conversion model. It is never exposed in
                    // the Insight model picker and never consumes user model
                    // credits; its page cost is recorded as internal usage.
                    if (!extractedPdfText) {
                        if (!pdfValidated) {
                            try {
                                await validatePdfSafely(pdfBuffer);
                                pdfValidated = true;
                            } catch {
                                throw new ChatAccessError(
                                    400,
                                    "INVALID_PDF_ATTACHMENT",
                                    "The attached PDF is invalid or unsupported."
                                );
                            }
                        }

                        try {
                            const ocrResult = await extractPdfTextWithMistralOcr(
                                pdfBuffer,
                                remainingCharacters - 64
                            );
                            if (ocrResult?.text) {
                                extractedPdfText = ocrResult.text;
                            }
                            if (ocrResult) {
                                const ocrCostMicroUsd =
                                    ocrResult.pageCount *
                                    MISTRAL_OCR_COST_MICRO_USD_PER_PAGE;
                                await recordInternalProviderUsage({
                                    provider: "mistral",
                                    modelId: ocrResult.modelId,
                                    inputTokens: 0,
                                    cachedInputTokens: 0,
                                    outputTokens: 0,
                                    estimatedCostMicroUsd: ocrCostMicroUsd,
                                    uncachedInputCostMicroUsd: ocrCostMicroUsd,
                                    cachedInputCostMicroUsd: 0,
                                    outputCostMicroUsd: 0,
                                    source: "ocr",
                                }).catch((error) => {
                                    logRequestError(
                                        "mistral_ocr_usage_record_failed",
                                        traceId,
                                        error,
                                        requestedModelId
                                    );
                                });
                                console.info(
                                    JSON.stringify({
                                        event: "mistral_ocr_completed",
                                        traceId,
                                        backendModelId: ocrResult.modelId,
                                        pageCount: ocrResult.pageCount,
                                        attachmentBytes: pdfBuffer.byteLength,
                                        timestamp: new Date().toISOString(),
                                    })
                                );
                            }
                        } catch (error) {
                            logRequestError(
                                "mistral_ocr_failed",
                                traceId,
                                error,
                                requestedModelId
                            );
                            if (!modelSupportsNativePdfInput(modelConfig)) {
                                throw new ChatAccessError(
                                    502,
                                    "PDF_OCR_UNAVAILABLE",
                                    "The document text service is temporarily unavailable. Try again shortly or choose a model with native PDF support."
                                );
                            }
                        }
                    }

                    if (!extractedPdfText) {
                        if (modelSupportsNativePdfInput(modelConfig)) {
                            pdfFilePartBuffer = pdfBuffer;
                        } else {
                            throw new ChatAccessError(
                                400,
                                "PDF_TEXT_UNREADABLE",
                                "The attached PDF does not contain readable text."
                            );
                        }
                    }
                }

                totalAttachmentBytes += attachmentBytes;
                if (totalAttachmentBytes > MAX_TOTAL_ATTACHMENT_SIZE) {
                    throw new ChatAccessError(
                        413,
                        "ATTACHMENT_TOTAL_TOO_LARGE",
                        "Attachments exceed the total request size limit."
                    );
                }

                if (attachment.mediaType === "application/pdf") {
                    if (pdfFilePartBuffer) {
                        fileParts.push({
                            type: "file",
                            data: {
                                type: "data",
                                data: new Uint8Array(pdfFilePartBuffer),
                            },
                            mediaType: attachment.mediaType,
                            filename: attachment.name,
                        });
                    } else {
                        const pdfText = extractedPdfText || "";
                        totalExtractedCharacters += pdfText.length;
                        if (
                            totalExtractedCharacters >
                            MAX_EXTRACTED_ATTACHMENT_CHARACTERS
                        ) {
                            throw new ChatAccessError(
                                413,
                                "ATTACHMENT_TEXT_TOO_LARGE",
                                "Extracted attachment text exceeds the request limit."
                            );
                        }

                        textAttachments.push({
                            name: attachment.name,
                            kind: "PDF file",
                            text: pdfText,
                        });
                    }
                } else if (OFFICE_ATTACHMENT_TYPES.has(attachment.mediaType)) {
                    const officeBuffer =
                        attachmentBuffer || Buffer.from(attachmentData, "base64");
                    const remainingCharacters =
                        MAX_EXTRACTED_ATTACHMENT_CHARACTERS -
                        totalExtractedCharacters;
                    if (remainingCharacters <= 64) {
                        throw new ChatAccessError(
                            413,
                            "ATTACHMENT_TEXT_TOO_LARGE",
                            "Extracted attachment text exceeds the request limit."
                        );
                    }
                    const extractedText = await parseOfficeSafely(
                        officeBuffer,
                        attachment.mediaType,
                        remainingCharacters - 64
                    );

                    if (!extractedText) {
                        throw new Error(`No readable text found in ${attachment.name}.`);
                    }
                    totalExtractedCharacters += extractedText.length;
                    if (
                        totalExtractedCharacters >
                        MAX_EXTRACTED_ATTACHMENT_CHARACTERS
                    ) {
                        throw new ChatAccessError(
                            413,
                            "ATTACHMENT_TEXT_TOO_LARGE",
                            "Extracted attachment text exceeds the request limit."
                        );
                    }

                    textAttachments.push({
                        name: attachment.name,
                        kind: "office file",
                        text: extractedText,
                    });
                } else if (attachment.kind === "text") {
                    totalExtractedCharacters += attachmentData.length;
                    if (
                        totalExtractedCharacters >
                        MAX_EXTRACTED_ATTACHMENT_CHARACTERS
                    ) {
                        throw new ChatAccessError(
                            413,
                            "ATTACHMENT_TEXT_TOO_LARGE",
                            "Extracted attachment text exceeds the request limit."
                        );
                    }
                    textAttachments.push({
                        name: attachment.name,
                        kind: "file",
                        text: attachmentData,
                    });
                } else {
                    const binaryData =
                        attachmentBuffer || Buffer.from(attachmentData, "base64");
                    fileParts.push({
                        type: "file",
                        data: {
                            type: "data",
                            data: new Uint8Array(binaryData),
                        },
                        mediaType: attachment.mediaType,
                        filename: attachment.name,
                    });
                }
            }

            const hasUnsupportedFilePart = fileParts.some((part) =>
                isImageAttachmentType(part.mediaType)
                    ? !modelSupportsImageInput(modelConfig)
                    : part.mediaType === "application/pdf"
                      ? !modelSupportsNativePdfInput(modelConfig)
                      : true
            );
            if (hasUnsupportedFilePart) {
                throw new ChatAccessError(
                    400,
                    "ATTACHMENT_MODEL_UNSUPPORTED",
                    `${modelConfig.name} does not support this attachment type. Choose a compatible model or retry without attachments.`
                );
            }

            if (textAttachments.length === 0 && fileParts.length === 0) {
                const content = String(msg.content ?? "");
                estimatedInputTokens += estimateTextTokens(content);
                formattedMessages.push({ role: "user", content });
                continue;
            }

            // Extracted file text is data the user did not write, so it is
            // fenced and the rules are stated once before it -- the same
            // treatment lib/memoryContextPrompt.ts gives account memory, for
            // the same reason. Built before the estimate below so the
            // reservation is taken against the bytes actually sent.
            const text = buildAttachmentPromptText({
                userText: String(msg.content ?? ""),
                attachments: textAttachments,
            });
            const nativeAttachmentTokens = estimateNativeAttachmentTokens(
                fileParts.length
            );
            // Not text: a per-part allowance for what the provider will charge
            // for the attachment itself.
            inputEstimate.addTokens(nativeAttachmentTokens);
            estimatedInputTokens +=
                estimateTextTokens(text) + nativeAttachmentTokens;

            formattedMessages.push({
                role: "user",
                content: [
                    { type: "text", text: text || "Please analyze the attached file." },
                    ...fileParts,
                ],
            });
        }
        const budget = createChatBudget(
            access.kind,
            modelConfig,
            inputEstimate.breakdown(),
            {
                webSearchSurchargeCredits: getWebSearchSurchargeCredits(
                    webSearchMode ?? "off",
                    webSearchCapability
                ),
                nativeSearchEnabled,
            }
        );
        // `budget.inputTokens`, not the raw estimate: what this guard has to
        // bound is what the request really sends, and a provider-native search
        // adds 6,400 input tokens on top of the conversation (6,000 of
        // retrieved result text, 400 of tool definition). Comparing the raw
        // estimate let a searching turn sit that far over the very limit this
        // exists to protect, and the request then failed at the provider --
        // after a credit reservation and a dispatched call -- instead of here,
        // for free. It is also the figure the reservation is sized on, so the
        // two now agree about how big this turn is
        // (docs/ops/tomverse-chat-context-window-rollout.md).
        //
        // That figure is clamped to the plan's input ceiling, so a request over
        // *that* limit was already refused by `createChatBudget` with
        // CHAT_INPUT_TOKEN_LIMIT before reaching here.
        const outputBudget = fitChatOutputToContextWindow({
            contextWindowTokens: modelConfig.contextWindowTokens,
            reservedInputTokens: budget.inputTokens,
            requestOutputCapTokens: budget.maxOutputTokens,
            providerMaxOutputTokens: budget.providerMaxOutputTokens,
        });
        if (outputBudget.kind === "exceeded") {
            throw new ChatAccessError(
                400,
                "MODEL_CONTEXT_WINDOW_EXCEEDED",
                `${modelConfig.name} holds ${outputBudget.limitTokens.toLocaleString("en-US")} tokens of conversation and answer together, and this conversation already fills it. Start a new conversation or shorten the attachments.`
            );
        }
        // What the request actually asks the model to produce: the application
        // cap, lowered to the provider's own ceiling and to the room the window
        // has left. The credit and cost reservation deliberately keeps the
        // unfitted figure -- over-reserving is refunded at settlement, and
        // reserving less than the answer might cost protects nothing.
        const requestMaxOutputTokens = outputBudget.outputTokens;
        // Shadow routing (docs/policy/tomverse-chat-delivery-plan.md §6 step 3).
        // The Router's rules run on this turn and the decision is recorded; the
        // model the user selected is what executes. Handed to `after()` and
        // never awaited: an experiment that can delay or fail a chat is not an
        // experiment. Off unless TOMVERSE_ROUTER_SHADOW_ENABLED says otherwise.
        // Shadow records what Auto *would* have chosen while the user's model
        // runs. On a turn Auto actually routed there is nothing hypothetical
        // left to record, and a row here would enter the same decision twice
        // -- once as a shadow prediction and once as the real run -- into
        // metrics that read the two as independent.
        if (!autoSelection.routed) scheduleRoutingShadowRun(() => {
            const lastUserTurn = [...formattedMessages]
                .reverse()
                .find((message) => message.role === "user");
            const parts = Array.isArray(lastUserTurn?.content)
                ? lastUserTurn.content
                : [];
            const profileText =
                typeof lastUserTurn?.content === "string"
                    ? lastUserTurn.content
                    : parts
                          .filter((part) => part.type === "text")
                          .map((part) => ("text" in part ? part.text : ""))
                          .join("\n");
            return {
                traceId,
                userId: access.userId ?? null,
                subjectKey: access.subjectKey,
                // A signed-in account with no resolved plan reads as Guest
                // rather than as a paid one: the filters use this to decide
                // what the account may reach, and guessing upwards would let a
                // shadow decision consider a model the person cannot use.
                plan: access.kind === "guest" ? "Guest" : (access.plan ?? "Free"),
                profile: buildTaskProfile({
                    text: profileText,
                    attachments: parts
                        .filter((part) => part.type === "file")
                        .map((part) => ({
                            mediaType:
                                "mediaType" in part ? part.mediaType : undefined,
                        })),
                    webSearchRequested: nativeSearchEnabled,
                }),
                userSelectedModelId: modelConfig.id,
                estimatedInputTokens,
                reservedInputTokens: budget.inputTokens,
                // The unfitted cap on purpose: the filters fit it to each
                // candidate's own window, and handing them the figure already
                // fitted to the user's model would bias every other candidate.
                requestOutputCapTokens: budget.maxOutputTokens,
                models: AVAILABLE_MODELS,
            };
        });
        const accessGrant = await acquireChatAccess(access, budget, {
            traceId,
            source: "chat",
            enabledTools: nativeSearchEnabled ? ["web_search"] : [],
            // Comparison runs arrive with a slot already reserved for this
            // model by the aggregate preflight. Without it the three panels of
            // one comparison would each race for a slot, and a run could be
            // admitted in part.
            admissionToken,
        });
        leaseOwnership = chatLeaseAcquired(accessGrant.leaseId);
        usageReservation = accessGrant.usageReservation;
        // Shadow only, and awaited so the settlement update cannot race the
        // insert it depends on. The recorder is inert unless the flag is set
        // and swallows its own failures, so this cannot fail a paid request.
        if (shadowAccumulator?.hasText) {
            await recordShadowReservation({
                attemptId: usageReservation.reservationId,
                modelId: modelConfig.id,
                providerId: modelConfig.provider,
                controlRawEstimatedInputTokens: estimatedInputTokens,
                candidateRawEstimatedInputTokens:
                    shadowAccumulator.candidateTotalFrom(estimatedInputTokens),
                reservedInputTokens: budget.inputTokens,
                tokenizerFamily: getCalibration(ACTIVE_ESTIMATOR_VERSION).family,
                ...shadowAccumulator.snapshot(),
            });
        }
        try {
            await notifyProviderBudgetIfNeeded(modelConfig.provider);
        } catch (error) {
            logRequestError(
                "provider_budget_alert_failed",
                traceId,
                error,
                requestedModelId
            );
        }

        // Perplexity's "sonar-deep-research" model doesn't stream like every
        // other model here -- it's a submit-then-poll async job that can run
        // well past 30 minutes. Submit it, persist a "pending" message + job
        // row, and hand off polling to the client (app/api/chat/deep-research/
        // status) instead of holding this request or the 120s concurrency
        // lease open for the job's lifetime.
        if (modelConfig.usageClass === "deep-research") {
            // Ownership of this turn moves to the polling job: the request
            // ends here, so its slot must end here too rather than being held
            // for a job that can outlive any lease.
            leaseOwnership = chatLeaseReleased();
            await releaseChatAccess(accessGrant.leaseId, {
                traceId,
                reason: "deep_research_handoff",
                subjectScope: access.kind,
            });

            if (!conversationId || !assistantMessageId || !session?.user?.id) {
                await settleChatUsage(usageReservation, {
                    inputTokens: 0,
                    outputTokens: 0,
                    outcome: "failed",
                });
                usageReservation = null;
                return tracedJsonError(
                    "Deep research requires a saved conversation.",
                    "CONVERSATION_REQUIRED",
                    400,
                    traceId
                );
            }

            // Set once Perplexity has accepted the job. If persisting the
            // local rows then fails, this is the id an operator needs to
            // reconcile a provider job that has no Message or job row here.
            let submittedPerplexityJobId: string | null = null;
            try {
                const depthParams =
                    DEEP_RESEARCH_DEPTH_PARAMS[deepResearchDepth || "standard"];
                const { perplexityJobId } = await submitDeepResearchJob({
                    messages: formattedMessages,
                    maxOutputTokens: depthParams.maxOutputTokens,
                    reasoningEffort:
                        depthParams.reasoningEffort ||
                        (modelConfig.reasoning === "high" ? "high" : undefined),
                });
                submittedPerplexityJobId = perplexityJobId;

                await linkChatReservationProviderRequest(
                    usageReservation.reservationId,
                    { providerRequestId: perplexityJobId }
                ).catch(() => {});

                await prisma.$transaction(async (tx) => {
                    await assertMessageCapacity(
                        tx,
                        session.user!.id,
                        conversationId,
                        1,
                        0
                    );
                    await tx.message.create({
                        data: {
                            id: assistantMessageId,
                            conversationId,
                            role: "assistant",
                            content: "",
                            status: "pending",
                            modelId: requestedModelId,
                            pendingJobId: perplexityJobId,
                            ...memoryAttribution,
                        },
                    });
                    await tx.perplexityAsyncJob.create({
                        data: {
                            perplexityJobId,
                            conversationId,
                            assistantMessageId,
                            modelId: requestedModelId,
                            reservationId: usageReservation!.reservationId,
                            traceId,
                            status: "submitted",
                        },
                    });
                });

                return Response.json(
                    { deepResearchJobId: assistantMessageId, status: "submitted" },
                    {
                        headers: {
                            "X-Request-ID": traceId,
                            "X-Chat-Response-Mode": "async-job",
                        },
                    }
                );
            } catch (error) {
                // A message-contract rejection is this app's own bug: the
                // request never left the process, so Perplexity must not be
                // marked as failing (and its status page must not react).
                // The credit refund below is unconditional either way.
                const isMessageContractError =
                    error instanceof PerplexityDeepResearchMessageError;
                await settleChatUsage(usageReservation, {
                    inputTokens: 0,
                    outputTokens: 0,
                    outcome: "failed",
                }).catch(() => {});
                usageReservation = null;
                if (!isMessageContractError) {
                    // The provider's HTTP status is forwarded as structured
                    // data so recordProviderFailure can tell a request-contract
                    // rejection (400) from an actual Perplexity outage (5xx)
                    // instead of counting both against the provider.
                    const submitMetadata = safeErrorMetadata(error);
                    await recordProviderFailure(
                        modelConfig.provider,
                        "DEEP_RESEARCH_SUBMIT_FAILED",
                        {
                            modelId: modelConfig.id,
                            phase: "request",
                            traceId,
                            errorName: submitMetadata.name,
                            errorCode: submitMetadata.code,
                            httpStatus: submitMetadata.statusCode,
                            retryable: submitMetadata.isRetryable,
                        }
                    ).catch(() => {});
                    await recordModelFailure(
                        modelConfig.id,
                        modelConfig.provider,
                        "DEEP_RESEARCH_SUBMIT_FAILED"
                    ).catch(() => {});
                }
                logRequestError(
                    isMessageContractError
                        ? "deep_research_message_contract_failed"
                        : "deep_research_submit_failed",
                    traceId,
                    error,
                    requestedModelId,
                    {
                        // Shape of the conversation this request carried, so a
                        // recurrence is diagnosable without logging its content.
                        messageShape:
                            describeDeepResearchMessages(formattedMessages),
                        ...(submittedPerplexityJobId
                            ? { submittedPerplexityJobId }
                            : {}),
                    }
                );
                return isMessageContractError
                    ? tracedJsonError(
                          "This deep research request had no question to research. Reserved credits were refunded.",
                          "DEEP_RESEARCH_INVALID_MESSAGES",
                          400,
                          traceId
                      )
                    : tracedJsonError(
                          "Failed to start the deep research job. Reserved credits were refunded.",
                          "DEEP_RESEARCH_SUBMIT_FAILED",
                          502,
                          traceId
                      );
            }
        }

        const webSearchToolConfig = nativeSearchEnabled
            ? buildWebSearchToolConfig(webSearchCapability)
            : null;
        const generationSettings = getModelGenerationSettings(modelConfig);
        // Delivery plan §5, applied to the manual path first. The user's own
        // model choice is untouched; what is being measured is whether the
        // §5 records can be produced at all, and what they cost, before Auto
        // is allowed to dispatch anything on that machinery.
        //
        // The shape handed to the manifest is derived from the messages, never
        // the messages: text becomes a keyed digest and a byte count, a file
        // becomes its media type and size. lib/routingManifestContent.ts holds
        // that, and its tests plant a name in a filename to prove it.
        const manifestMessages = formattedMessages.map((message) => ({
            role: message.role,
            parts: Array.isArray(message.content)
                ? message.content.map((part) =>
                      part.type === "text"
                          ? { type: "text" as const, text: part.text }
                          : part.type === "file"
                            ? {
                                  type: "file" as const,
                                  mediaType:
                                      "mediaType" in part
                                          ? part.mediaType
                                          : undefined,
                                  bytes:
                                      "data" in part &&
                                      typeof part.data === "string"
                                          ? part.data.length
                                          : 0,
                                  // The bytes themselves, so two documents of
                                  // the same kind and length do not share one
                                  // reference. Already in memory: this is the
                                  // payload on its way to the provider.
                                  content:
                                      "data" in part &&
                                      typeof part.data === "string"
                                          ? part.data
                                          : undefined,
                              }
                            : { type: "other" as const, label: part.type }
                  )
                : [{ type: "text" as const, text: String(message.content ?? "") }],
        }));
        dispatchRecord = await beginInstrumentedDispatch({
            traceId,
            // Present only on a routed turn, so a manual run cannot be
            // counted in the metrics that grade routing.
            routerDecision: autoSelection.routed
                ? {
                      versions: autoSelection.versions,
                      record: autoSelection.record,
                      userSelectedModelId: requestedModelId,
                  }
                : null,
            userId: access.userId ?? null,
            subjectKey: access.subjectKey,
            plan: access.kind === "guest" ? "Guest" : (access.plan ?? "Free"),
            modelId: modelConfig.id,
            provider: modelConfig.provider,
            messages: manifestMessages,
            tokenizerVersion: ACTIVE_ESTIMATOR_VERSION,
            tokenCount: budget.inputTokens,
            // An unbounded budget means the model declares no window. The
            // manifest still needs a number for its within-window CHECK, and
            // the honest one is the request itself: a request cannot exceed a
            // limit that was never stated, and recording a fabricated ceiling
            // would make the check pass by inventing headroom.
            contextWindowTokens:
                outputBudget.kind === "fitted"
                    ? outputBudget.limitTokens
                    : budget.inputTokens + requestMaxOutputTokens,
            estimatedInputTokens,
            reservedInputTokens: budget.inputTokens,
            requestOutputCapTokens: budget.maxOutputTokens,
            reservationId: usageReservation?.reservationId ?? null,
            conversationId: conversationId ?? null,
        });
        // §5 step 4: the effective request is only known once the adapter has
        // assembled it, so the manifest is finalized here and not a line
        // earlier -- a hash taken before this would describe something else.
        dispatchRecord = await authoriseDispatch(dispatchRecord, {
            modelId: modelConfig.id,
            provider: modelConfig.provider,
            maxOutputTokens: requestMaxOutputTokens,
            settings: generationSettings as Record<string, unknown>,
            toolConfig: webSearchToolConfig,
            messages: manifestMessages,
            // No Planner yet, and saying so is more honest than a version
            // number for a stage that did not run.
            plannerVersion: "none",
            adapterVersion: "vercel-ai-sdk-streamText-v1",
        });
        const result = await streamText({
            model: activeModel,
            messages: formattedMessages,
            maxOutputTokens: requestMaxOutputTokens,
            maxRetries: modelConfig.provider === "zhipu" ? 0 : undefined,
            headers:
                modelConfig.provider === "perplexity"
                    ? perplexityUsageHeaders(traceId)
                    : undefined,
            ...generationSettings,
            ...(webSearchToolConfig ?? {}),
        });
        // The fallback drill's deliberate failure, if this request asked for
        // one and may have one (lib/routingFaultInjection.ts: not production,
        // a configured secret, and this request's own header). Off in every
        // other case, and decided once so a retry cannot re-roll it.
        const faultInjection = decideFaultInjection(
            req.headers.get(FAULT_INJECTION_HEADER)
        );
        const injectedFault = faultInjection.inject ? faultInjection.fault : null;
        if (injectedFault) {
            // Loud, and before anything fails: a drill must never be mistaken
            // for an outage in the logs it is about to produce.
            console.warn(JSON.stringify({
                event: "chat_fault_injection_armed",
                traceId,
                conversationId,
                fault: injectedFault,
                environment: resolveDeploymentEnvironment(),
                timestamp: new Date().toISOString(),
            }));
        }
        // The provider call has been made. Recorded after the fact on purpose:
        // the CHECK behind this refuses a dispatch with no finalized manifest,
        // so the order here is the order the constraint enforces.
        await recordDispatched(dispatchRecord);

        // Per-attempt execution state (lib/chatAttemptExecution.ts).
        //
        // Everything below that means "the model that answered" reads from
        // here rather than from the enclosing scope, and the reason is not
        // tidiness. The stream used to log, record health for, and persist the
        // assistant message under `requestedModelId` -- the model the *user
        // asked for*. On a manual turn those are the same id and nothing was
        // wrong. On a routed turn they are different models: provider health
        // was credited to a model that never ran, and MessageProviderContext
        // paired the requested model's id with the effective model's provider,
        // which is the exact record the provider-context restore is keyed on.
        // Auto routes nobody yet, so it was latent -- and a fallback would
        // have made it two models wrong instead of one.
        const dispatched = {
            attemptIndex: 0,
            modelId: modelConfig.id,
            provider: modelConfig.provider,
            reasoning: modelConfig.reasoning,
            stream: result,
            reader: faultedReader(result.textStream.getReader(), injectedFault, 0),
            // Perplexity buffers response bodies under this key and consuming
            // the capture releases it, so it is per attempt rather than per
            // trace. The primary keeps the bare trace id, which is what the
            // request headers already carried.
            usageCaptureKey: traceId,
            // What this attempt is priced at. Carried per attempt because a
            // fallback runs on another model at another provider's rates, and
            // settling it against the reservation's single snapshot is the
            // thing lib/chatMultiAttemptSettlement.ts exists to prevent.
            price: {
                provider: modelConfig.provider,
                modelId: modelConfig.id,
                inputUsdPerMillionTokens: budget.inputUsdPerMillionTokens,
                outputUsdPerMillionTokens: budget.outputUsdPerMillionTokens,
                cachedInputPriceMultiplier: budget.cachedInputPriceMultiplier,
                pricingVersion: budget.pricingVersion ?? null,
            } satisfies AttemptPriceSnapshot,
        };
        /**
         * Attempts that have already ended, oldest first.
         *
         * Empty for the whole of today's traffic, and `settleSafely` passes
         * nothing to `settleChatUsage` while it stays empty -- so a turn that
         * dispatched once settles exactly as it always has. A swap pushes the
         * attempt it is replacing, and settlement appends the one that ended.
         */
        const endedAttempts: AttemptUsage[] = [];
        let rerouteCount = 0;
        let displacedModelId: string | null = null;
        /**
         * What §7 may try instead, best first.
         *
         * The Router's own eligible set with the chosen model removed, so a
         * candidate here has passed exactly the filters the primary passed.
         * Empty on a manual turn, which the scope gate refuses on its own
         * grounds before this is ever read.
         */
        const fallbackCandidates = autoSelection.routed
            ? autoSelection.fallbackCandidateModelIds
            : [];
        /**
         * The provider hold this turn took, and the periods it was taken in.
         *
         * Read from the reservation rather than recomputed: a fallback on
         * another provider releases exactly what was held, and "exactly" has
         * to mean the same rows the hold went into. A turn that reserved no
         * cost holds nothing, and a fallback across providers is refused
         * rather than granted a transfer of zero.
         */
        const providerHoldEntries = (usageReservation?.entries ?? []).filter(
            (entry) => entry.key === `provider:${modelConfig.provider}`
        );
        const providerHoldDay = providerHoldEntries.find(
            (entry) => entry.period === "provider-cost-day"
        );
        const providerHoldMonth = providerHoldEntries.find(
            (entry) => entry.period === "provider-cost-month"
        );
        const heldProviderCostMicroUsd = providerHoldDay?.amount ?? 0;
        /**
         * Why no fallback happened, when it was a decision rather than the
         * feature being off.
         *
         * `flag_off` is deliberately silent: with the flag off it is the
         * answer for every failed turn, and a line per failure saying a
         * disabled feature stayed disabled is noise that would bury the ones
         * that mean something.
         */
        const reportFallbackRefusal = (reason: FallbackScopeRefusal | string) => {
            if (reason === "flag_off") return;
            console.info(JSON.stringify({
                event: "chat_auto_fallback_refused",
                traceId,
                conversationId,
                modelId: dispatched.modelId,
                attemptIndex: dispatched.attemptIndex,
                reason,
                timestamp: new Date().toISOString(),
            }));
        };
        // The stream owns the slot from here, but it cannot release anything
        // until it is pulled, and it is only pulled once the Response below is
        // returned. Until then the failure path is still the owner of record.
        const activeLeaseId = accessGrant.leaseId;
        leaseOwnership = chatLeaseTakenByStream(leaseOwnership);
        let generatedText = "";
        let released = false;
        let sourceCancelled = false;
        let usageSettlement: Promise<void> | null = null;
        let streamState: "open" | "closed" | "cancelled" = "open";
        // Perplexity's response body is captured once and answers two
        // questions -- what this turn cost, and which sources the answer's
        // "[n]" markers point at. Consuming the capture releases it, so both
        // readers share this one memoized take rather than racing for it.
        let perplexityCapture: Promise<PerplexityResponseCapture | null> | null =
            null;
        const takePerplexityCapture = () => {
            if (dispatched.provider !== "perplexity") return Promise.resolve(null);
            perplexityCapture ??= consumePerplexityResponseCapture(
                dispatched.usageCaptureKey
            );
            return perplexityCapture;
        };
        const estimatedGeneratedOutputTokens = () =>
            generatedText
                ? Math.max(
                      1,
                      Math.ceil(Buffer.byteLength(generatedText, "utf8") / 4)
                  )
                : 0;
        // Used only by settleSafely("cancelled") call sites that fire before
        // the stream's tool-result content ever resolves (mid-stream abort,
        // client disconnect, transport error) -- a search cannot have been
        // confirmed executed at that point, so treat any reserved surcharge
        // as unearned and let the cancelled-outcome proration exclude it.
        const earlyCancelSearchFields = {
            searchSurchargeCredits: getWebSearchSurchargeCredits(
                webSearchMode ?? "off",
                webSearchCapability
            ),
            searchExecuted: false,
        };
        const settleSafely = (
            outcome: "completed" | "cancelled" | "failed" | "empty",
            usage?: {
                inputTokens?: number;
                cachedInputTokens?: number;
                outputTokens?: number;
                reasoningTokens?: number;
                usageFromProvider?: boolean;
                searchSurchargeCredits?: number;
                searchExecuted?: boolean;
            }
        ) => {
            if (usageSettlement) return usageSettlement;
            const reservation = usageReservation;
            if (!reservation) return Promise.resolve();
            usageSettlement = (async () => {
                try {
                    const providerUsageSnapshot =
                        (await takePerplexityCapture())?.usage ?? null;
                    const settledInputTokens =
                        usage?.inputTokens ?? reservation.inputTokens;
                    const settledOutputTokens =
                        usage?.outputTokens ?? estimatedGeneratedOutputTokens();
                    await settleChatUsage(reservation, {
                        inputTokens: settledInputTokens,
                        cachedInputTokens: usage?.cachedInputTokens,
                        outputTokens: settledOutputTokens,
                        reasoningTokens: usage?.reasoningTokens,
                        // Absent provider usage metadata, the output figure
                        // above is the documented fallback estimate rather
                        // than a measured value -- recorded as such.
                        usageFromProvider: usage?.usageFromProvider === true,
                        outcome,
                        searchSurchargeCredits: usage?.searchSurchargeCredits,
                        searchExecuted: usage?.searchExecuted,
                    }, {
                        providerUsageSnapshot,
                        // Only when this turn actually dispatched more than
                        // once. Empty leaves settleChatUsage on the path every
                        // turn has always taken, which is the point: a turn
                        // that ran one model settles as one model.
                        attempts: endedAttempts.length
                            ? [
                                  ...endedAttempts,
                                  {
                                      attemptIndex: dispatched.attemptIndex,
                                      price: dispatched.price,
                                      inputTokens: settledInputTokens,
                                      cachedInputTokens:
                                          usage?.cachedInputTokens ?? 0,
                                      outputTokens: settledOutputTokens,
                                      reasoningTokens: usage?.reasoningTokens,
                                      usageFromProvider:
                                          usage?.usageFromProvider === true,
                                      outcome,
                                      searchCostMicroUsd: undefined,
                                      providerReportedCostMicroUsd:
                                          providerUsageSnapshot?.totalCostMicroUsd ??
                                          null,
                                  } satisfies AttemptUsage,
                              ]
                            : undefined,
                    });
                    usageReservation = null;
                    // One funnel for every terminal outcome, so cancellation,
                    // stream failure and completion all reach the attempt
                    // record by the same path the settlement takes. Hooking
                    // each call site instead would mean the outcomes that are
                    // hardest to reproduce are the ones most likely to be
                    // missed.
                    await completeInstrumentedDispatch(dispatchRecord, {
                        outcome:
                            outcome === "completed"
                                ? "succeeded"
                                : outcome === "cancelled"
                                  ? "cancelled"
                                  : "failed_post_token",
                        failureLayer:
                            outcome === "completed" || outcome === "cancelled"
                                ? "none"
                                : "stream",
                        actualInputTokens:
                            usage?.inputTokens ?? reservation.inputTokens,
                        actualOutputTokens:
                            usage?.outputTokens ?? estimatedGeneratedOutputTokens(),
                        errorClass: outcome === "empty" ? "empty_response" : null,
                        settlementOutcome: outcome,
                    });
                    // Auto's memory of this conversation, written only for a
                    // turn it actually routed and only when that turn
                    // produced an answer. A streak advanced by a cancelled or
                    // failed turn would let hysteresis be decided by turns
                    // that never reached the user.
                    // §8, and only once the answer exists. A recovery
                    // candidate stored for a retry that then failed would send
                    // the next turn back to a model that never worked.
                    if (outcome === "completed") {
                        await recordFallbackRecovery(
                            dispatchRecord,
                            recoveryAfterFallback({
                                succeededModelId: dispatched.modelId,
                                displacedModelId,
                                failureLayer: "provider",
                            })
                        );
                    }
                    if (autoSelection.routed && outcome === "completed" && conversationId) {
                        try {
                            await prisma.conversation.updateMany({
                                // `updateMany` with the mode in the filter, so
                                // a conversation switched back to manual
                                // mid-stream is not given sticky state the
                                // CHECK forbids it to hold.
                                where: {
                                    id: conversationId,
                                    selectionMode: "auto",
                                },
                                // §8: the sticky model becomes the one that
                                // worked. On a turn that fell back that is not
                                // the model the Router chose, and writing the
                                // Router's choice would put the conversation
                                // back on a model that had just failed.
                                data: stickyStateAfterRoutedTurn(
                                    dispatched.modelId,
                                    // A fallback is not evidence about a
                                    // challenger, so the hysteresis streak
                                    // starts again rather than carrying a
                                    // count that was about another comparison.
                                    displacedModelId
                                        ? 0
                                        : autoSelection.sticky.turnsFavouringChallenger
                                ),
                            });
                        } catch (error) {
                            logRequestError(
                                "chat_auto_sticky_persist_failed",
                                traceId,
                                error,
                                dispatched.modelId
                            );
                        }
                    }
                } catch (error) {
                    logRequestError(
                        "chat_usage_settlement_failed",
                        traceId,
                        error,
                        dispatched.modelId
                    );
                }
            })();
            return usageSettlement;
        };
        // A healthy long response keeps its own slot alive instead of relying
        // on a TTL big enough for the worst case. Production saw a stream still
        // writing at 125s under a flat 120s lease -- with a renewal, a legit
        // ten-minute answer is as safe as a ten-second one, and a process that
        // dies stops renewing so its slot frees within one TTL.
        let heartbeat: ReturnType<typeof setInterval> | null = setInterval(
            () => {
                void heartbeatChatAccess(activeLeaseId).then((alive) => {
                    if (alive || !heartbeat) return;
                    clearInterval(heartbeat);
                    heartbeat = null;
                }).catch((error) => {
                    logRequestError(
                        "chat_lease_heartbeat_failed",
                        traceId,
                        error,
                        dispatched.modelId
                    );
                });
            },
            leaseHeartbeatIntervalMs(resolveLeaseTtlSeconds())
        );
        // Node keeps the process alive for pending timers; this one must never
        // be the reason a worker stays up after its request is done.
        heartbeat.unref?.();
        const stopHeartbeat = () => {
            if (!heartbeat) return;
            clearInterval(heartbeat);
            heartbeat = null;
        };
        stopLeaseHeartbeat = stopHeartbeat;
        const release = async () => {
            if (released) return;
            released = true;
            stopHeartbeat();
            await releaseChatAccess(activeLeaseId, {
                traceId,
                reason: streamState === "cancelled" ? "stream_cancelled" : "stream_finished",
                subjectScope: access.kind,
            });
        };
        const releaseSafely = async () => {
            try {
                await release();
            } catch (error) {
                logRequestError(
                    "chat_access_release_failed",
                    traceId,
                    error,
                    dispatched.modelId
                );
            }
        };
        const cancelSourceSafely = async (reason?: unknown) => {
            if (sourceCancelled) return;
            sourceCancelled = true;
            try {
                await dispatched.reader.cancel(reason);
            } catch (error) {
                if (!isClosedStreamControllerError(error)) {
                    logRequestError(
                        "ai_source_stream_cancel_failed",
                        traceId,
                        error,
                        dispatched.modelId
                    );
                }
            }
        };
        const enqueueSafely = (
            controller: ReadableStreamDefaultController<string>,
            value: string
        ) => {
            if (streamState !== "open") return false;
            try {
                controller.enqueue(value);
                return true;
            } catch (error) {
                streamState = "cancelled";
                if (!isClosedStreamControllerError(error)) {
                    logRequestError(
                        "chat_response_stream_enqueue_failed",
                        traceId,
                        error,
                        dispatched.modelId
                    );
                }
                return false;
            }
        };
        const closeSafely = (
            controller: ReadableStreamDefaultController<string>
        ) => {
            if (streamState !== "open") return false;
            try {
                controller.close();
                streamState = "closed";
                return true;
            } catch (error) {
                streamState = "cancelled";
                if (!isClosedStreamControllerError(error)) {
                    logRequestError(
                        "chat_response_stream_close_failed",
                        traceId,
                        error,
                        dispatched.modelId
                    );
                }
                return false;
            }
        };
        const errorSafely = (
            controller: ReadableStreamDefaultController<string>,
            error: unknown
        ) => {
            if (streamState !== "open") return false;
            try {
                controller.error(error);
                streamState = "cancelled";
                return true;
            } catch (streamError) {
                streamState = "cancelled";
                if (!isClosedStreamControllerError(streamError)) {
                    logRequestError(
                        "chat_response_stream_error_failed",
                        traceId,
                        streamError,
                        dispatched.modelId
                    );
                }
                return false;
            }
        };
        /**
         * §7's automatic fallback, or the named reason there was none.
         *
         * Reached only from the stream's failure path, and only before the
         * first visible token -- both of which `decideFallback` re-checks
         * rather than trusting the call site. Returns whether the response is
         * now being served by another model; `false` means the caller carries
         * on failing the turn exactly as it did before this existed.
         *
         * Everything here is off by default. `autoFallbackScope` reads
         * AUTO_ROUTER_FALLBACK_ENABLED first, so a deployment that sets
         * nothing gets one refusal for every turn and never a second provider
         * call.
         */
        const attemptFallback = async (
            controller: ReadableStreamDefaultController<string>,
            error: unknown
        ): Promise<boolean> => {
            const classified = classifyStreamFailure({
                error,
                phase: "read",
                visibleTokenEmitted: generatedText.length > 0,
                downstreamOpen: streamState === "open",
            });
            const scope = autoFallbackScope({
                routed: autoSelection.routed,
                isGuest: access.kind === "guest",
                toolsOffered: Boolean(webSearchToolConfig),
                nativeSearchEnabled,
                // Always false here: a deep-research turn returns from the
                // submit-then-poll branch above and never reaches a stream.
                // Stated anyway, because a gate that lists its exclusions is
                // checkable and one that relies on an earlier return is not.
                deepResearch: modelConfig.usageClass === "deep-research",
                hasAttachments: requestAttachments.length > 0,
                candidateCount: fallbackCandidates.length,
            });
            if (!scope.allowed) {
                reportFallbackRefusal(scope.reason);
                return false;
            }
            const decision = decideFallback({
                attempt: {
                    modelId: dispatched.modelId,
                    outcome: classified.outcome,
                    failureLayer: classified.failureLayer,
                    providerRefusal: classified.providerRefusal,
                },
                run: {
                    // The Planner is "none", so no attempt can have taken the
                    // downgrade. See §9.1: pass-through stays held.
                    passThroughUsed: false,
                    rerouteCount,
                    visibleTokenEmitted: generatedText.length > 0,
                },
                nextCandidateModelIds: fallbackCandidates,
            });
            if (decision.action !== "fallback") {
                reportFallbackRefusal(
                    decision.action === "terminate" ? decision.reason : "pass_through"
                );
                return false;
            }

            const candidate = runtimeModelMap.get(decision.modelId);
            if (!candidate?.enabled || candidate.catalogDeleted) {
                reportFallbackRefusal("candidate_unavailable");
                return false;
            }
            // §6: the candidate needs its own draft, adapter serialization,
            // actual-token check and manifest. A refusal here is one candidate
            // that did not qualify, not the request failing -- the primary's
            // failure is still what ends the turn.
            const planned = planAttemptExecution(candidate, {
                accessKind: access.kind,
                inputBreakdown: inputEstimate.breakdown(),
                webSearchMode: webSearchMode ?? null,
                traceId,
                attemptIndex: dispatched.attemptIndex + 1,
            });
            if (!planned.ok) {
                reportFallbackRefusal(`candidate_${planned.refusal.kind}`);
                return false;
            }
            const plan = planned.plan;

            // §10: every dispatch is authorized on the server, including this
            // one. Money held at the primary's provider does not make a call
            // to another provider affordable.
            if (plan.provider !== dispatched.provider) {
                if (!providerHoldDay || !providerHoldMonth) {
                    // Nothing was held for this turn, so there is nothing to
                    // move and no evidence of which periods to move it into.
                    reportFallbackRefusal("no_provider_hold");
                    return false;
                }
                const moved = await transferProviderBudgetForFallback({
                    heldProvider: dispatched.provider,
                    fallbackProvider: plan.provider,
                    heldMicroUsd: heldProviderCostMicroUsd,
                    fallbackReservedMicroUsd:
                        getChatBudgetReservedCostMicroUsd(plan.budget),
                    periodStarts: {
                        day: providerHoldDay!.periodStart,
                        month: providerHoldMonth!.periodStart,
                    },
                }).catch((budgetError: unknown) => {
                    logRequestError(
                        "chat_fallback_budget_transfer_failed",
                        traceId,
                        budgetError,
                        plan.modelId
                    );
                    return { moved: false as const, reason: "transfer_failed" as const };
                });
                if (!moved.moved && moved.reason !== "same_provider") {
                    reportFallbackRefusal(`budget_${moved.reason}`);
                    return false;
                }
            }

            // The attempt being replaced is closed out before the next one
            // opens, so the run never holds two open attempts and the record
            // says pre-token rather than merely failed.
            const failing = dispatchRecord;
            try {
                await completeInstrumentedDispatch(failing, {
                    outcome: "failed_pre_token",
                    failureLayer: classified.failureLayer,
                    actualInputTokens: budget.inputTokens,
                    actualOutputTokens: 0,
                    errorClass: "provider_pre_token_failure",
                    settlementOutcome: "failed",
                });
            } catch (recordError) {
                logRequestError(
                    "chat_fallback_attempt_close_failed",
                    traceId,
                    recordError,
                    dispatched.modelId
                );
            }
            // No usage metadata exists for a stream that failed before its
            // first chunk, so the input is the reserved estimate and the
            // output is zero, flagged as an estimate. Over-recording provider
            // spend is the safe direction for a ledger whose job is to keep a
            // budget from being exceeded; the user is not charged for it --
            // §7 bills the accepted attempt only.
            endedAttempts.push({
                attemptIndex: dispatched.attemptIndex,
                price: dispatched.price,
                inputTokens: budget.inputTokens,
                cachedInputTokens: 0,
                outputTokens: 0,
                usageFromProvider: false,
                outcome: "failed",
            });

            // The replaced reader is cancelled here, directly, and not through
            // `cancelSourceSafely`.
            //
            // That helper latches `sourceCancelled`, and the latch means "the
            // current source has been cancelled" -- which stops being true the
            // moment a different source is installed. Latching it here would
            // leave a later disconnect with nothing to cancel, and the
            // *fallback's* provider stream would stay open and billing after
            // the user had gone. Cancelling before the next dispatch also means
            // a dispatch that fails leaves nothing behind.
            try {
                await dispatched.reader.cancel(
                    "replaced by a fallback attempt"
                );
            } catch (cancelError) {
                if (!isClosedStreamControllerError(cancelError)) {
                    logRequestError(
                        "ai_source_stream_cancel_failed",
                        traceId,
                        cancelError,
                        dispatched.modelId
                    );
                }
            }

            let nextRecord: DispatchInstrumentation;
            let nextStream: Awaited<ReturnType<typeof streamText>>;
            try {
                // A second attempt on the *same* run, not a second run. One
                // logical response is one RoutingRun with its attempts hanging
                // off it; two runs would read as two responses and the reroute
                // rate would be zero forever. `beginRetryAttempt` also spends
                // §6's build budget itself, so a caller that forgot cannot
                // produce a third.
                nextRecord = await beginRetryAttempt(failing, {
                    attemptIndex: dispatched.attemptIndex + 1,
                    modelId: plan.modelId,
                    provider: plan.provider,
                    plannerMode: "planned",
                    failureLayer: classified.failureLayer,
                    messages: manifestMessages,
                    tokenizerVersion: ACTIVE_ESTIMATOR_VERSION,
                    tokenCount: plan.budget.inputTokens,
                    contextWindowTokens:
                        plan.outputBudget.kind === "fitted"
                            ? plan.outputBudget.limitTokens
                            : plan.budget.inputTokens + plan.maxOutputTokens,
                    userId: access.userId ?? null,
                });
                // §5: its own manifest, finalized against its own effective
                // request. Reusing the primary's would describe a request that
                // was never sent to this model.
                nextRecord = await authoriseDispatch(nextRecord, {
                    modelId: plan.modelId,
                    provider: plan.provider,
                    maxOutputTokens: plan.maxOutputTokens,
                    settings: plan.generationSettings as Record<string, unknown>,
                    toolConfig: plan.webSearchToolConfig,
                    messages: manifestMessages,
                    plannerVersion: "none",
                    adapterVersion: "vercel-ai-sdk-streamText-v1",
                });
                nextStream = await streamText({
                    model: plan.activeModel,
                    messages: formattedMessages,
                    ...attemptDispatchOptions(plan),
                });
                await recordDispatched(nextRecord);
            } catch (dispatchError) {
                // The turn ends on the primary's failure, which is what the
                // caller was already about to do. Nothing has been shown and
                // nothing about the response has changed.
                logRequestError(
                    "chat_fallback_dispatch_failed",
                    traceId,
                    dispatchError,
                    plan.modelId
                );
                reportFallbackRefusal("dispatch_failed");
                return false;
            }

            // §7: the client is told before the next model's first token, and
            // told a model id and nothing else. Out-of-band, so it is not a
            // visible token and does not close the door it just opened.
            if (!enqueueSafely(controller, buildRoutingRetryChunk(plan.modelId))) {
                await nextStream.textStream.getReader().cancel("client is gone");
                return false;
            }

            displacedModelId = dispatched.modelId;
            rerouteCount += 1;
            dispatchRecord = nextRecord;
            dispatched.attemptIndex += 1;
            dispatched.modelId = plan.modelId;
            dispatched.provider = plan.provider;
            dispatched.reasoning = plan.modelConfig.reasoning;
            dispatched.stream = nextStream;
            dispatched.reader = faultedReader(
                nextStream.textStream.getReader(),
                injectedFault,
                dispatched.attemptIndex + 1
            );
            // A new source, so the "already cancelled" latch is about a stream
            // that no longer exists. Leaving it set would make a disconnect
            // during the fallback a no-op.
            sourceCancelled = false;
            dispatched.usageCaptureKey = plan.usageCaptureKey;
            dispatched.price = {
                provider: plan.provider,
                modelId: plan.modelId,
                inputUsdPerMillionTokens: plan.budget.inputUsdPerMillionTokens,
                outputUsdPerMillionTokens: plan.budget.outputUsdPerMillionTokens,
                cachedInputPriceMultiplier: plan.budget.cachedInputPriceMultiplier,
                pricingVersion: plan.budget.pricingVersion ?? null,
            };
            // The next attempt captures under its own key, so the memo from
            // the one it replaced must not answer for it.
            perplexityCapture = null;
            console.info(JSON.stringify({
                event: "chat_auto_fallback_dispatched",
                traceId,
                conversationId,
                fromModelId: displacedModelId,
                toModelId: plan.modelId,
                attemptIndex: dispatched.attemptIndex,
                failureLayer: classified.failureLayer,
                timestamp: new Date().toISOString(),
            }));
            return true;
        };
        const protectedStream = new ReadableStream<string>({
            async pull(controller) {
                if (streamState !== "open") return;

                try {
                    const { done, value } = await dispatched.reader.read();
                    if (streamState !== "open") {
                        await releaseSafely();
                        return;
                    }
                    if (done) {
                        const completionResults = await Promise.allSettled([
                            dispatched.stream.response,
                            dispatched.stream.usage,
                            dispatched.stream.finishReason,
                            dispatched.stream.rawFinishReason,
                            dispatched.stream.content,
                            dispatched.stream.providerMetadata,
                        ] as const);
                        const [
                            responseResult,
                            usageResult,
                            finishReasonResult,
                            rawFinishReasonResult,
                            contentResult,
                            providerMetadataResult,
                        ] = completionResults;
                        // Observation only: the tier a response was actually
                        // served at, checked against the Standard table every
                        // pricing profile claims. Nothing here settles, prices
                        // or reserves -- see lib/servedProcessingTier.ts.
                        const servedTier = observeServedProcessingTier(
                            dispatched.provider,
                            providerMetadataResult.status === "fulfilled"
                                ? providerMetadataResult.value
                                : undefined
                        );
                        if (servedTier.mismatchesAssumedStandard) {
                            console.warn(
                                JSON.stringify({
                                    event: "chat_served_processing_tier_mismatch",
                                    traceId,
                                    provider: servedTier.provider,
                                    modelId: dispatched.modelId,
                                    servedTier: servedTier.servedTier,
                                    classification: servedTier.classification,
                                    timestamp: new Date().toISOString(),
                                })
                            );
                        }
                        const rejectedCompletion = completionResults.find(
                            (item): item is PromiseRejectedResult =>
                                item.status === "rejected"
                        );
                        const completionError = rejectedCompletion?.reason;
                        const finishReason =
                            finishReasonResult.status === "fulfilled"
                                ? finishReasonResult.value
                                : "unknown";
                        const rawFinishReason =
                            rawFinishReasonResult.status === "fulfilled"
                                ? rawFinishReasonResult.value
                                : undefined;
                        if (responseResult.status === "fulfilled") {
                            try {
                                const responseHeaders = responseResult.value.headers;
                                if (usageReservation) {
                                await linkChatReservationProviderRequest(
                                    usageReservation.reservationId,
                                    {
                                        providerRequestId:
                                            responseHeaders?.["x-request-id"] ||
                                            responseHeaders?.["request-id"] ||
                                            null,
                                        providerResponseId: responseResult.value.id,
                                    }
                                );
                                }
                            } catch (error) {
                                logRequestError(
                                    "chat_provider_request_link_failed",
                                    traceId,
                                    error,
                                    dispatched.modelId
                                );
                            }
                        }

                        if (completionError) {
                            logRequestError(
                                "chat_stream_completion_metadata_failed",
                                traceId,
                                completionError,
                                dispatched.modelId
                            );
                        }

                        // Perplexity publishes its sources as top-level
                        // response fields, which the OpenAI-compatible chat
                        // adapter never turns into AI SDK source parts --
                        // read straight off the captured body instead, so
                        // the "[n]" markers in the answer have a list to
                        // point at. Every other provider is unaffected.
                        const perplexitySearchCitations =
                            (await takePerplexityCapture())?.search?.citations;
                        const webSearchExecution = normalizeWebSearchExecution({
                            capability: webSearchCapability,
                            searchRequested: webSearchRequested,
                            provider: dispatched.provider,
                            toolName: webSearchCapability.provider
                                ? WEB_SEARCH_TOOL_NAMES[webSearchCapability.provider]
                                : undefined,
                            content:
                                contentResult.status === "fulfilled"
                                    ? contentResult.value
                                    : undefined,
                            providerCitations: perplexitySearchCitations,
                        });
                        // A provider that hit its output ceiling returns HTTP
                        // 200 with real text and a `length` finish reason.
                        // Recorded so the answer is never presented as
                        // finished; settlement, cancellation and the
                        // empty-response path are untouched by it.
                        const completionOutcome = resolveChatCompletionOutcome({
                            finishReason,
                            rawFinishReason,
                        });
                        if (completionOutcome.status === "incomplete") {
                            console.warn(
                                JSON.stringify({
                                    event: "chat_response_incomplete",
                                    traceId,
                                    provider: dispatched.provider,
                                    modelId: dispatched.modelId,
                                    finishReason,
                                    rawFinishReason: rawFinishReason ?? null,
                                    incompleteReason:
                                        completionOutcome.incompleteReason,
                                    timestamp: new Date().toISOString(),
                                })
                            );
                        }
                        const searchSettlementFields = {
                            searchSurchargeCredits: getWebSearchSurchargeCredits(
                                webSearchMode ?? "off",
                                webSearchCapability
                            ),
                            searchExecuted: webSearchExecution.executed,
                            searchCostMicroUsd:
                                webSearchExecution.costMetadata?.searchCostMicroUsd,
                            searchQueryCount: webSearchExecution.queryCount,
                        };

                        if (usageResult.status === "fulfilled") {
                            const usage = usageResult.value;
                            await settleSafely(
                                generatedText.trim() ? "completed" : "empty",
                                {
                                    inputTokens: usage.inputTokens,
                                    cachedInputTokens:
                                        usage.inputTokenDetails.cacheReadTokens,
                                    outputTokens: usage.outputTokens,
                                    reasoningTokens:
                                        usage.outputTokenDetails
                                            .reasoningTokens,
                                    usageFromProvider: true,
                                    ...searchSettlementFields,
                                }
                            );
                        } else {
                            await settleSafely(
                                generatedText.trim() ? "completed" : "empty",
                                searchSettlementFields
                            );
                        }
                        if (
                            conversationId &&
                            assistantMessageId &&
                            generatedText.trim()
                        ) {
                            try {
                                const storedContent =
                                    generatedText.length >
                                    MAX_STORED_MESSAGE_CHARACTERS
                                        ? `${generatedText.slice(
                                              0,
                                              MAX_STORED_MESSAGE_CHARACTERS
                                          )}\n\n[Response truncated for storage]`
                                        : generatedText;
                                const providerContext =
                                    dispatched.reasoning !== undefined &&
                                    responseResult.status === "fulfilled"
                                        ? serializeProviderResponseMessages(
                                              responseResult.value.messages
                                          )
                                        : null;
                                await prisma.$transaction(async (tx) => {
                                    await assertMessageCapacity(
                                        tx,
                                        session!.user!.id,
                                        conversationId,
                                        1,
                                        Buffer.byteLength(storedContent, "utf8") +
                                            (providerContext?.byteLength || 0)
                                    );
                                    const sourcePrompt = await tx.message.findFirst({
                                        where: {
                                            conversationId,
                                            role: "user",
                                        },
                                        orderBy: [
                                            { createdAt: "desc" },
                                            { id: "desc" },
                                        ],
                                        select: { id: true },
                                    });
                                    if (sourcePrompt) {
                                        await tx.comparisonReview.updateMany({
                                            where: {
                                                conversationId,
                                                promptMessageId: sourcePrompt.id,
                                                isStale: false,
                                            },
                                            data: { isStale: true },
                                        });
                                    }
                                    await tx.message.create({
                                        data: {
                                            id: assistantMessageId,
                                            conversationId,
                                            role: "assistant",
                                            content: storedContent,
                                            status: completionOutcome.status,
                                            modelId: dispatched.modelId,
                                            searchMetadata: webSearchExecution,
                                            // Spread, so an answer with no
                                            // bundle writes neither column
                                            // and both stay NULL (§22).
                                            ...memoryAttribution,
                                        },
                                    });
                                    if (providerContext) {
                                        await tx.messageProviderContext.create({
                                            data: {
                                                messageId: assistantMessageId,
                                                modelId: dispatched.modelId,
                                                provider: dispatched.provider,
                                                responseMessages:
                                                    providerContext.messages,
                                            },
                                        });
                                    }
                                });
                            } catch (error) {
                                logRequestError(
                                    "assistant_message_persist_failed",
                                    traceId,
                                    error,
                                    dispatched.modelId
                                );
                            }
                        }
                        const isEmptyResponse = !generatedText.trim();
                        if (isEmptyResponse) {
                            const completionMetadata = safeErrorMetadata(
                                completionError
                            );
                            const finishReasonCode = String(
                                rawFinishReason || finishReason || "unknown"
                            )
                                .replace(/[^A-Za-z0-9_.-]/g, "_")
                                .toUpperCase()
                                .slice(0, 40);
                            const diagnosticCode = completionError
                                ? providerDiagnosticCode(
                                      "AI_EMPTY_RESPONSE",
                                      completionError
                                  )
                                : `AI_EMPTY_RESPONSE.${finishReasonCode}`;
                            try {
                                await recordProviderFailure(
                                    dispatched.provider,
                                    diagnosticCode,
                                    {
                                        modelId: dispatched.modelId,
                                        phase: "stream",
                                        traceId,
                                        errorName:
                                            completionMetadata.name ||
                                            "EmptyResponse",
                                        errorCode:
                                            completionMetadata.code ||
                                            finishReasonCode,
                                        httpStatus:
                                            completionMetadata.statusCode,
                                        retryable:
                                            completionMetadata.isRetryable,
                                    }
                                );
                                await recordModelFailure(
                                    dispatched.modelId,
                                    dispatched.provider,
                                    diagnosticCode
                                );
                            } catch (error) {
                                logRequestError(
                                    "provider_empty_response_record_failed",
                                    traceId,
                                    error,
                                    dispatched.modelId
                                );
                            }
                        } else {
                            try {
                                await recordProviderSuccess(
                                    dispatched.provider
                                );
                                await recordModelSuccess(dispatched.modelId);
                            } catch (error) {
                                logRequestError(
                                    "provider_success_record_failed",
                                    traceId,
                                    error,
                                    dispatched.modelId
                                );
                            }
                        }
                        // Sent as one final out-of-band chunk rather than a
                        // second request or a response header -- the tool
                        // result/source parts this depends on only resolve
                        // once the whole turn settles, and this is the only
                        // delivery path that also reaches guest sessions
                        // (their messages are never persisted for a re-fetch).
                        enqueueSafely(
                            controller,
                            buildChatStreamTrailerChunk({
                                searchMetadata: webSearchExecution,
                                completion: completionOutcome,
                            })
                        );
                        closeSafely(controller);
                        await releaseSafely();
                        return;
                    }
                    generatedText += value;
                    if (!enqueueSafely(controller, value)) {
                        await cancelSourceSafely("response stream is no longer open");
                        await settleSafely("cancelled", earlyCancelSearchFields);
                        await releaseSafely();
                    }
                } catch (error) {
                    const wasAlreadyCancelled = streamState !== "open";
                    if (
                        wasAlreadyCancelled ||
                        isClosedStreamControllerError(error)
                    ) {
                        if (!wasAlreadyCancelled) {
                            logRequestError(
                                "ai_stream_lifecycle_closed",
                                traceId,
                                error,
                                dispatched.modelId
                            );
                        }
                        streamState = "cancelled";
                        await cancelSourceSafely(error);
                        await settleSafely("cancelled", earlyCancelSearchFields);
                        await releaseSafely();
                        return;
                    }
                    const errorMetadata = safeErrorMetadata(error);
                    const diagnosticCode = providerDiagnosticCode(
                        "AI_STREAM_FAILED",
                        error
                    );
                    logRequestError(
                        "ai_stream_failed",
                        traceId,
                        error,
                        dispatched.modelId
                    );
                    try {
                        await recordProviderFailure(
                            dispatched.provider,
                            diagnosticCode,
                            {
                                modelId: dispatched.modelId,
                                phase: "stream",
                                traceId,
                                errorName: errorMetadata.name,
                                errorCode: errorMetadata.code,
                                httpStatus: errorMetadata.statusCode,
                                retryable: errorMetadata.isRetryable,
                            }
                        );
                        await recordModelFailure(
                            dispatched.modelId,
                            dispatched.provider,
                            diagnosticCode
                        );
                    } catch (recordError) {
                        logRequestError(
                            "provider_failure_record_failed",
                            traceId,
                            recordError,
                            dispatched.modelId
                        );
                    }
                    // §7's automatic fallback, and the last thing tried
                    // before the turn ends. After the health records, so a
                    // provider that failed is counted as having failed
                    // whether or not another model rescued the answer -- the
                    // fallback is a recovery for the user, not an amnesty for
                    // the provider. Off by default; see lib/autoFallbackGate.
                    if (await attemptFallback(controller, error)) {
                        // The response is now being served by another model.
                        // The next pull() reads from its stream.
                        return;
                    }
                    await settleSafely("failed");
                    errorSafely(controller, error);
                    await releaseSafely();
                }
            },
            async cancel(reason) {
                streamState = "cancelled";
                await cancelSourceSafely(reason);
                await settleSafely("cancelled", earlyCancelSearchFields);
                await releaseSafely();
            },
        });

        const headers = new Headers({
            "Content-Type": "text/plain; charset=utf-8",
            "Cache-Control": "no-cache, no-transform",
            "X-Request-ID": traceId,
        });
        // §13.4: how many memories this answer was given, counted by the
        // server. A header rather than something in the stream, because the
        // stream is the answer itself and the count has to be available
        // before the first token — and because a count folded into the body
        // is a count the client could be talked into computing. Absent, not
        // zero, when memory played no part: §13.4 forbids a misleading
        // indication, and "0 memories used" on a request that never had any
        // is one.
        if (memoryUsedCount > 0) {
            headers.set("X-Chat-Memory-Used", String(memoryUsedCount));
        }
        // Which model answered, on a turn Auto routed. A header rather than
        // something in the body for the same reason as the memory count: the
        // client needs it before the first token, and the badge on the reply
        // is what makes the toggle's promise -- "the one that answered is
        // shown on the reply" -- keepable.
        //
        // Absent on a manual turn, and absent on an Auto turn that fell back:
        // a header there would claim a routing decision that did not happen.
        // The reason is the Router's own fixed identifier, so the client
        // localises it and nothing derived from the turn crosses the wire.
        if (autoSelection.routed) {
            headers.set("X-Chat-Routed-Model", autoSelection.modelId);
            headers.set("X-Chat-Routed-Reason", autoSelection.record.selectionReason);
        }
        if (accessGrant.setCookie) {
            headers.append("Set-Cookie", accessGrant.setCookie);
        }
        // The Turnstile grant cookie is appended by POST() on every return
        // path, success and failure alike -- adding it here as well would
        // send it twice.

        const response = new Response(
            protectedStream.pipeThrough(new TextEncoderStream()),
            { headers }
        );
        // Only once the Response exists, because everything above it can still
        // throw and an unpublished stream is never pulled. After this the
        // stream's own release paths are the ones that free the slot.
        leaseOwnership = chatLeaseStreamPublished(leaseOwnership);
        return response;
    } catch (error: unknown) {
        stopLeaseHeartbeat?.();
        const orphanedLease = chatLeaseToReleaseOnUnwind(leaseOwnership);
        if (orphanedLease) {
            leaseOwnership = chatLeaseReleased();
            await releaseChatAccess(orphanedLease.leaseId, {
                traceId,
                reason: orphanedLease.reason,
            });
        }
        // The request failed before the stream owned it, so the attempt was
        // prepared and never produced an answer. `failed_pre_token` rather
        // than `not_dispatched`: this path is reached both before and after
        // the provider call, and claiming nothing was sent when it may have
        // been is the misrepresentation §5 forbids. Left `pending` it would be
        // an attempt the reliability numbers cannot classify at all.
        if (dispatchRecord) {
            await completeInstrumentedDispatch(dispatchRecord, {
                outcome: "failed_pre_token",
                failureLayer: "provider",
                errorClass: "request_failed",
                settlementOutcome: "failed",
            });
            dispatchRecord = null;
        }
        if (usageReservation) {
            try {
                const providerUsageSnapshot =
                    dispatchProviderForLog === "perplexity"
                        ? await consumePerplexityUsage(traceId)
                        : null;
                await settleChatUsage(usageReservation, {
                    inputTokens: 0,
                    outputTokens: 0,
                    outcome: "failed",
                }, {
                    providerUsageSnapshot,
                });
                usageReservation = null;
            } catch (settlementError) {
                logRequestError(
                    "chat_usage_refund_failed",
                    traceId,
                    settlementError,
                    dispatchModelIdForLog
                );
            }
        }
        if (dispatchProviderForLog === "perplexity") {
            discardPerplexityUsage(traceId);
        }
        const accessError = chatErrorResponse(error);
        if (accessError) {
            if (
                error instanceof ChatAccessError &&
                isChatCostSafetyCode(error.code)
            ) {
                console.warn(
                    JSON.stringify({
                        event: "chat_cost_safety_rejected",
                        phase: "chat_request",
                        traceId,
                        code: error.code,
                        status: error.status,
                        modelId: dispatchModelIdForLog,
                        ...(error.details || {}),
                        timestamp: new Date().toISOString(),
                    })
                );
            }
            accessError.headers.set("X-Request-ID", traceId);
            if (error instanceof ChatAccessError) {
                // Limit/entitlement rejections are reportable too; the grant
                // signs the trace but records no new evidence row -- the
                // existing limit-decision events are the record for these.
                const grant = issueChatErrorReportGrant({
                    traceId,
                    routeClass: "chat",
                    errorCode: error.code,
                    httpStatus: error.status,
                });
                if (grant.errorReportToken) {
                    accessError.headers.set(
                        ERROR_REPORT_TOKEN_HEADER,
                        grant.errorReportToken
                    );
                }
            }
            return accessError;
        }

        logRequestError(
            "ai_request_failed",
            traceId,
            error,
            dispatchModelIdForLog
        );
        try {
            const errorMetadata = safeErrorMetadata(error);
            const diagnosticCode =
                error instanceof ChatAccessError
                    ? error.code
                    : providerDiagnosticCode("AI_REQUEST_FAILED", error);
            await recordProviderFailure(
                dispatchProviderForLog,
                diagnosticCode,
                {
                    modelId: dispatchModelIdForLog,
                    phase: "request",
                    traceId,
                    errorName: errorMetadata.name,
                    errorCode: errorMetadata.code,
                    httpStatus: errorMetadata.statusCode,
                    retryable: errorMetadata.isRetryable,
                }
            );
            await recordModelFailure(
                dispatchModelIdForLog,
                dispatchProviderForLog,
                diagnosticCode
            );
        } catch (recordError) {
            logRequestError(
                "provider_failure_record_failed",
                traceId,
                recordError,
                dispatchModelIdForLog
            );
        }

        return tracedJsonError(
            "AI 응답 생성에 실패했습니다.",
            "AI_PROVIDER_ERROR",
            500,
            traceId,
            undefined,
            {
                phase: "request",
                provider: dispatchProviderForLog,
                modelId: dispatchModelIdForLog,
                error,
            }
        );
    }
}
