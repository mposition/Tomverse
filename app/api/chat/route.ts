import { stepCountIs, streamText, type FilePart, type ModelMessage } from "ai";
import { APP_DEFAULTS } from "@/lib/appDefaults";
import {
    buildAttachmentPromptText,
    type ExtractedAttachment,
} from "@/lib/attachmentContextPrompt";
import { randomUUID } from "node:crypto";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import {
    createR2UploadUrl,
    readR2Object,
    validateR2ObjectMetadata,
    writeR2Object,
} from "@/lib/r2";
import { conversationKindNotSupportedResponse, isChatConversationKind } from "@/lib/conversationKindGuard";
import { prisma } from "@/lib/prisma";
import {
    modelSupportsImageInput,
    modelSupportsNativePdfInput,
    type AiModel,
} from "@/lib/models";
import { buildTaskProfile } from "@/lib/taskProfileCore";
import {
    isRouterShadowEnabled,
    scheduleRoutingShadowRun,
} from "@/lib/routingShadow";
import { selectAutoModel } from "@/lib/autoModelSelection";
import { decideAutoCohort } from "@/lib/autoCohort";
import { decideDrillOverride } from "@/lib/autoDrillOverride";
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
import { reserveNativeSearchCost } from "@/lib/webSearchNativeCostReservation";
import { getWebSearchSurchargeCredits } from "@/lib/webSearchCredits";
import { buildWebSearchToolConfig, WEB_SEARCH_TOOL_NAMES } from "@/lib/webSearchToolConfig";
import { hasSearchPath, resolveAttemptSearchPath } from "@/lib/webSearchPath";
import { getRouterRuntimeSignals } from "@/lib/routerRuntimeSignals";
import { normalizeWebSearchExecution } from "@/lib/webSearchExecutionNormalizer";
import { buildChatStreamTrailerChunk } from "@/lib/webSearchStreamTrailer";
import {
    planGeneratedArtifactTool,
    ARTIFACT_BATCH_TOOL_DEFINITION_TOKENS,
    ARTIFACT_TOOL_DEFINITION_TOKENS,
} from "@/lib/generatedArtifactToolPolicy";
import {
    buildGeneratedArtifactToolConfig,
    GeneratedArtifactCollector,
    GENERATED_ARTIFACT_MAX_STEPS,
} from "@/lib/generatedArtifactTool";
import { persistArtifactRows } from "@/lib/generatedArtifactStorage";
import type { ChatStreamArtifact } from "@/lib/generatedArtifactCore";
import { splitProviderInstructions } from "@/lib/chatProviderPrompt";
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
    releaseAttemptProviderBudget,
    reserveAttemptProviderBudget,
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
import {
    priceAttempt,
    type AttemptPriceSnapshot,
    type AttemptUsage,
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
import { buildArtifactProgressChunk } from "@/lib/generatedArtifactProgressSignal";
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
    messageAttachmentReferenceSchema,
    turnAttachmentHandle,
    type MessageAttachmentReference,
    type TurnAttachmentDescriptor,
} from "@/lib/messageAttachmentCore";
import {
    MessageAttachmentResolveError,
    accountAttachmentPrefix,
    discardUnboundUpload,
    registerFinalizedUpload,
    resolveMessageAttachmentReferences,
    type ResolvedAttachment,
} from "@/lib/messageAttachmentStorage";
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
import { buildChatTurnContext } from "@/lib/chatTurnContext";
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
    /**
     * A guest's own ephemeral object, whose key is derived from their signed
     * guest identity and is therefore self-authorising. Signed-in callers do
     * not send this and are refused if they do -- they name an opaque id and
     * the server resolves the key (docs/policy/user-attachment-persistence.md).
     */
    objectKey?: unknown;
    /** A `MessageAttachment` already bound to one of the caller's messages. */
    attachmentId?: unknown;
    /** A finalised upload that has not been bound to a message yet. */
    uploadId?: unknown;
    data?: unknown;
    kind?: unknown;
};

/** How one attachment reference is keyed while a turn is being resolved. */
const attachmentReferenceKey = (
    attachment: IncomingAttachment
): string | null => {
    if (typeof attachment?.attachmentId === "string" && attachment.attachmentId) {
        return `a:${attachment.attachmentId}`;
    }
    if (typeof attachment?.uploadId === "string" && attachment.uploadId) {
        return `u:${attachment.uploadId}`;
    }
    return null;
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
// The composer discards a draft attachment by the id the finalisation step
// gave it, never by a storage key. There is nothing for a caller to guess and
// nothing for one to enumerate.
const deleteAttachmentSchema = z
    .object({
        uploadId: z.string().trim().min(1).max(64),
    })
    .strict();
const finalizeAttachmentSchema = z
    .object({
        key: z.string().min(1).max(512),
        name: z.string().trim().min(1).max(200),
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
    const date = new Date().toISOString().slice(0, 10);
    return `${accountAttachmentPrefix(email)}${date}/${randomUUID()}-${sanitizeFilename(name)}`;
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

            // A Drive import is an upload that happened server-side, so it
            // ends the same way an ordinary one does: with an opaque id, and
            // without the key (docs/policy/user-attachment-persistence.md).
            const registered = await registerFinalizedUpload({
                userId,
                objectKey: key,
                ownPrefix: accountAttachmentPrefix(session.user.email),
                name: exportedName,
                mediaType: exportType.mediaType,
                size: exportedFile.byteLength,
            });

            return Response.json({
                uploadId: registered.uploadId,
                name: registered.name,
                mediaType: registered.mediaType,
                size: registered.size,
                kind: registered.kind,
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
        const { key, name, mediaType, size } = await readLimitedJson(
            req,
            8 * 1024,
            finalizeAttachmentSchema
        );
        const userPrefix = accountAttachmentPrefix(session.user.email);

        if (!key.startsWith(userPrefix)) {
            return Response.json({ error: "Forbidden" }, { status: 403 });
        }

        const validated = await validateR2ObjectMetadata(key, {
            maxBytes: MAX_ATTACHMENT_SIZE,
            expectedContentType: mediaType,
            expectedSize: size,
        });

        /*
          The step that ends the browser's involvement with storage.

          Everything after this names the upload by the opaque id below --
          the send, the pre-save that binds it to a message, a retry, a
          template lookup. The key is not returned, so nothing downstream has
          to decide whether a key in a request body can be believed
          (docs/policy/user-attachment-persistence.md).

          The size recorded is the one storage reported, not the one the
          client declared: the two are checked against each other above, and
          the measured figure is the one every later reader gets.
        */
        const registered = await registerFinalizedUpload({
            userId,
            objectKey: key,
            ownPrefix: userPrefix,
            name,
            mediaType,
            size: validated.size,
        });

        return Response.json({
            uploadId: registered.uploadId,
            name: registered.name,
            mediaType: registered.mediaType,
            size: registered.size,
            kind: registered.kind,
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
        const { uploadId } = await readLimitedJson(
            req,
            4 * 1024,
            deleteAttachmentSchema
        );

        /*
          Removing a file from the *composer*, which is not the same act as
          removing it from a message that was already sent. An upload a
          message references is kept and reported as such: the user is editing
          a draft, and a stored turn whose attachment card pointed at nothing
          would be the failure this whole feature exists to remove
          (docs/policy/user-attachment-persistence.md).

          Ownership is part of the lookup rather than a comparison afterwards,
          so another account's id is simply not found -- and the 204 says the
          draft no longer has that file either way.
        */
        const outcome = await discardUnboundUpload({ userId, uploadId });
        if (outcome.kept) {
            return Response.json(
                { kept: true, reason: "ATTACHMENT_ALREADY_SENT" },
                { status: 200 }
            );
        }
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
        // Policy: docs/policy/external-conversation-import-and-memory.md.
        // §10: the conversation's bound profile version. Read from the same
        // row as the memory mode so the context this request builds is the
        // one its bundle was priced against.
        let conversationProfileVersionId: string | null = null;
        // Seeded with what was asked, then narrowed to what was dispatched
        // once routing decides. After a fallback the model that answered is
        // not the model that was requested, and the outer catch records
        // provider health about the one that was actually called.
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
            ? accountAttachmentPrefix(session.user.email)
            : null;

        /*
          Every attachment this transcript references, resolved once, before
          anything reads a file (docs/policy/user-attachment-persistence.md).

          A signed-in caller names an opaque id -- an upload the finalisation
          step issued, or an attachment already bound to one of their own
          messages -- and this is where that id becomes a storage fact. Both
          lookups scope by `userId` inside the query, so another account's id
          is not found rather than refused, and the prefix is re-checked on
          what comes back.

          Guests are deliberately not here. Their objects are ephemeral, have
          no owner row to hang an id on, and their keys are derived from their
          own signed guest identity -- so the key *is* the authorisation, and
          `isOwnGuestAttachmentKey` below is what checks it.
        */
        const resolvedAttachments = new Map<string, ResolvedAttachment>();
        if (session?.user?.id && ownAttachmentPrefix) {
            const references: MessageAttachmentReference[] = [];
            const referenceKeys: string[] = [];
            for (const message of messages) {
                const attachments = Array.isArray(message.attachments)
                    ? (message.attachments as IncomingAttachment[])
                    : [];
                for (const attachment of attachments) {
                    const key = attachmentReferenceKey(attachment);
                    if (!key || referenceKeys.includes(key)) continue;
                    const parsed =
                        messageAttachmentReferenceSchema.safeParse(attachment);
                    if (!parsed.success) continue;
                    references.push(parsed.data);
                    referenceKeys.push(key);
                }
            }
            if (references.length > 0) {
                try {
                    const resolved = await resolveMessageAttachmentReferences({
                        userId: session.user.id,
                        ownPrefix: ownAttachmentPrefix,
                        conversationId: conversationId ?? null,
                        references,
                    });
                    resolved.forEach((attachment, index) => {
                        resolvedAttachments.set(referenceKeys[index], attachment);
                    });
                } catch (error) {
                    if (error instanceof MessageAttachmentResolveError) {
                        // 404-shaped rather than 403-shaped on purpose: the
                        // lookup never learned whether the id belongs to
                        // somebody else or to nobody, so neither can the
                        // answer.
                        throw new ChatAccessError(
                            400,
                            error.code,
                            error.message
                        );
                    }
                    throw error;
                }
            }
        }
        // Only read when the cohort would admit this account. `decideAutoCohort`
        // costs nothing -- the plan is already in hand and readiness is read
        // from memory -- so while the rollout is off this query never runs and
        // the chat path pays nothing for a feature nobody has.
        // The staging fallback drill's one exception, and the only path that
        // routes a turn while a readiness gate is outstanding. Fails closed in
        // production whatever the request carries -- see lib/autoDrillOverride.
        const drillOverride = decideDrillOverride({
            faultHeader: req.headers.get(FAULT_INJECTION_HEADER),
            subjectKey: session?.user?.id ?? "",
            isGuest: !session?.user?.id,
        });
        const autoCohort = decideAutoCohort({
            subjectKey: session?.user?.id ?? "",
            isGuest: !session?.user?.id,
            plan: accountPlan?.tier ?? null,
            drillOverride: drillOverride.allowed,
        });
        if (autoCohort.eligible && autoCohort.drillOverride) {
            // Loud, and every time. A routed turn that only routed because a
            // drill said so must be legible as one in the record it produces,
            // not inferred later from the absence of an attestation.
            console.warn(JSON.stringify({
                event: "chat_auto_readiness_overridden",
                traceId,
                conversationId,
                reason: autoCohort.drillOverride,
                environment: resolveDeploymentEnvironment(),
                timestamp: new Date().toISOString(),
            }));
        }
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
                ? measureTurnAttachments(
                      Array.from(resolvedAttachments.values()),
                      ownAttachmentPrefix
                  )
                : ({ measurable: true, descriptors: [] } as const);
        // Health and the measured tie-break signals, from one cached snapshot.
        // Read only for an account the cohort would actually route: a feature
        // that is off should cost nothing, which is the same reason the
        // attachment measurement above is skipped. The read never throws --
        // an input it could not fetch is unknown, and unknown has a defined
        // meaning in every criterion downstream.
        //
        // Read for a shadow turn too, not only a routable one. Shadow records
        // what Auto *would* have chosen, and today the cohort refuses everyone
        // -- so the turns shadow records are exactly the turns this would
        // otherwise skip, and the recorded decision would be made without the
        // health and signal inputs the real one uses.
        const routerShadowEnabled = isRouterShadowEnabled();
        const routerSignals =
            autoCohort.eligible || routerShadowEnabled
                ? await getRouterRuntimeSignals()
                : null;
        /**
         * What the Router decides from, built once.
         *
         * Spread into the live selection and the shadow recorder both. They
         * assembled these separately before, and had drifted: shadow read the
         * static catalogue rather than the runtime registry, so it considered
         * models an operator had disabled; it passed neither the health
         * exclusions nor the tie-break signals; and it derived
         * `webSearchRequested` from whether the *user's* model has a native
         * search tool rather than from what the user asked for, which changes
         * `needsCurrentInformation` and with it the candidate set.
         *
         * A shadow given different inputs measures a different router, and the
         * rollout's exit condition is a comparison of its distribution against
         * the live one. One object is what stops that happening again.
         */
        const routerCandidateInputs = {
            // Runtime models, not the static catalogue: a model an operator has
            // disabled must not be chosen and then refused two lines later by
            // `assertModelRuntimeAvailable`.
            models: runtimeModels.filter(
                (model) => model.enabled && !model.catalogDeleted
            ),
            // Confirmed unavailable only. `degraded` stays a candidate and
            // loses tie-breaks instead, and `unknown` -- every model nothing
            // probes -- excludes nobody: uncertainty is not a verdict.
            unhealthyModelIds: routerSignals?.unhealthyModelIds,
            signals: routerSignals?.signals,
            // What the user asked for, not what their model happens to support.
            webSearchRequested: webSearchMode === "always",
        };
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
            ...routerCandidateInputs,
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
        /*
          The handles the model is given for this turn's own files.

          `att_1`, `att_2`, in the order the composer sent them. Minted per
          request and meaningless outside it: not a row id, not a storage key,
          and it addresses no route -- which is the whole reason it is safe to
          put in a prompt at all. A model that could name a storage location
          could quote one, and a quoted location is a link that looks real.

          Built from the resolved rows for a signed-in caller, so the name and
          the media type the model reads are the ones the server stored rather
          than the ones the request declared.
        */
        const turnAttachmentDescriptors: TurnAttachmentDescriptor[] = (
            Array.isArray(latestMessage?.attachments)
                ? (latestMessage.attachments as IncomingAttachment[])
                : []
        ).map((attachment, index) => {
            const key = attachmentReferenceKey(attachment);
            const resolved = key ? resolvedAttachments.get(key) : undefined;
            return {
                handle: turnAttachmentHandle(index),
                name:
                    resolved?.name ??
                    (typeof attachment.name === "string" ? attachment.name : "file"),
                mediaType:
                    resolved?.mediaType ??
                    (typeof attachment.mediaType === "string"
                        ? attachment.mediaType
                        : "application/octet-stream"),
                byteSize: resolved?.size ?? 0,
            };
        });
        /**
         * The bytes behind those handles, filled in as the message loop reads
         * each file. Only the turn's own attachments, and only in memory for
         * the length of the request -- the batch generator is the single
         * reader.
         */
        const turnAttachmentBytes = new Map<
            string,
            { name: string; mediaType: string; bytes: Uint8Array }
        >();
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
        /*
          One attachment is named once per turn, whichever handle names it.

          The set used to be storage keys, which is what the request carried.
          It carries opaque ids now, so the identity being deduplicated is the
          reference -- and the guest path, whose keys are derived from the
          caller's own signed identity, keeps deduplicating on the key because
          that is the only name a guest object has.
        */
        const attachmentIdentities = new Set<string>();
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
            const identity =
                attachmentReferenceKey(attachment) ??
                (hasObjectKey ? `k:${attachment.objectKey as string}` : null);
            if (identity) {
                if (attachmentIdentities.has(identity)) {
                    throw new ChatAccessError(
                        400,
                        "DUPLICATE_ATTACHMENT_OBJECT",
                        "Duplicate attachment objects are not allowed."
                    );
                }
                attachmentIdentities.add(identity);
            }
        }
        if (attachmentIdentities.size > MAX_CONVERSATION_ATTACHMENTS) {
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
                    assistantProfileVersionId: true,
                },
            });
            conversationMemoryMode = conversation?.memoryMode ?? null;
            conversationProfileVersionId =
                conversation?.assistantProfileVersionId ?? null;
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

        // Policy: docs/policy/external-conversation-import-and-memory.md.
        // The §10 context bundle: what memory this request may carry, and
        // proof that it is the same context the request was priced against.
        //
        // No bundle means no memory, and that is not a degraded fallback: a
        // request whose price did not include a memory block must not send
        // one, or the user is charged for one prompt and shown another. It is
        // also the ordinary path today — injection stays off until §12.4's
        // procedure has been completed, so nothing issues a bundle and this
        // whole branch is skipped.
        //
        // Release C put a profile's instructions and its retrieved knowledge
        // in the same block, under the same rule and for the same reason: they
        // are priced input tokens too. `/api/chat/context` issues a bundle
        // whenever either is non-empty, so a profile turn arrives with one.
        // The §9.1 system block. Named for the context rather than for memory
        // because Release C put three things in it, and only one of them is
        // memory.
        let contextSystemPrompt: string | null = null;
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
            const turnContext = await buildChatTurnContext({
                userId: session.user.id,
                query: latestUserPromptText(messages),
                // Policy: docs/policy/external-conversation-import-and-memory.md.
                // §10: bound into the fingerprint, so a profile republished or
                // detached between preflight and send is a stale bundle rather
                // than a turn that answers as a different assistant.
                profileVersionId: conversationProfileVersionId,
                plan: accountPlan?.tier ?? null,
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
                currentFingerprint: turnContext.fingerprint,
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
            // Policy: docs/policy/external-conversation-import-and-memory.md.
            // The whole §9.1 block -- profile instructions, then memory, then
            // profile knowledge -- assembled as one system message by the
            // builder that priced it.
            contextSystemPrompt = turnContext.systemPrompt;
            memoryUsedCount = turnContext.memory.prompt.usedCount;
            memoryAttribution = {
                memoryUsedCount,
                memoryTokens: verification.payload.memoryTokens,
            };
            // Memory's own presence, not the block's: a turn whose system
            // message carries only a profile's instructions has no memory in
            // it, and counting it as an injection would report memory as used
            // on a request the model never saw it in.
            if (turnContext.memory.prompt.text) {
                void recordMemoryCounter("chat_memory_injected");
                if (turnContext.memory.truncatedByBudget) {
                    void recordMemoryCounter("injected_context_truncated");
                }
                // The priced figure, not a fresh estimate, so the bucket
                // describes the same block the reservation was taken against.
                const bucket = injectedTokenBucket(
                    verification.payload.memoryTokens
                );
                if (bucket) void recordMemoryCounter(bucket);
            }
            // The figures that were reserved against, not fresh estimates: the
            // two agree here by construction, and if they ever stop agreeing
            // the user should be billed the numbers they were quoted. The
            // profile's blocks are counted apart from memory's because they
            // are a different context, priced by the same builder.
            const quotedContextTokens =
                verification.payload.memoryTokens +
                verification.payload.profileTokens;
            estimatedInputTokens += quotedContextTokens;
            // Quoted, not re-estimated -- so it enters as an opaque count.
            inputEstimate.addTokens(quotedContextTokens);
        }

        /*
          Whether this turn may produce a downloadable file, and what the model
          is told either way (docs/policy/generated-artifacts.md section 2).

          Decided here, above the message loop, for one reason: the decision
          adds a system block, the block is priced input, and the reservation
          is taken further down. Deciding it after the budget would send the
          user a prompt they were not quoted for.

          There is always a block. A turn that cannot make files says so in the
          request, so a model on an unverified adapter refuses out loud instead
          of answering a spreadsheet request with a Markdown table -- the
          silent regression this feature exists to remove.

          Deep research is the one exclusion, and it is excluded entirely
          rather than planned and refused: it is a submit-then-poll job on
          Perplexity that never reaches the streaming path below, and
          `submitDeepResearchJob` validates the message shape it is handed. A
          block about a tool that job cannot call would be priced input on a
          request with no use for it, and a change to a payload whose contract
          is checked elsewhere.
        */
        const isDeepResearchTurn = modelConfig.usageClass === "deep-research";
        const artifactToolPlan = isDeepResearchTurn
            ? null
            : planGeneratedArtifactTool({
                  modelId: modelConfig.id,
                  provider: modelConfig.provider,
                  isAuthenticated: Boolean(session?.user?.id),
                  canPersist: Boolean(
                      session?.user?.id && conversationId && assistantMessageId
                  ),
                  nativeSearchEnabled,
                  // Only OpenAI's tool can be forced, and
                  // `buildWebSearchToolConfig` forces it whenever it is
                  // enabled. Read from the capability rather than from the
                  // provider name so the two cannot drift.
                  nativeSearchForced:
                      nativeSearchEnabled &&
                      webSearchCapability.canForceExecution,
                  conversationKind: "chat",
                  turnAttachments: turnAttachmentDescriptors,
              });
        // Policy: docs/policy/external-conversation-import-and-memory.md.
        // §9.1 place this block above the conversation and below the
        // safety policy, so it is the first message and the rules that govern
        // reading each part are stated inside it, before the part they govern.
        const formattedMessages: ModelMessage[] = contextSystemPrompt
            ? [{ role: "system", content: contextSystemPrompt }]
            : [];
        if (artifactToolPlan) {
            formattedMessages.push({
                role: "system",
                content: artifactToolPlan.systemPrompt,
            });
            // Priced like any other input. The tool *definition* is a separate
            // cost the provider adds when the schema is sent, and it is a
            // build-time constant rather than a per-request tokenisation --
            // see ARTIFACT_TOOL_DEFINITION_TOKENS.
            const artifactPromptTokens =
                estimateTextTokens(artifactToolPlan.systemPrompt) +
                (artifactToolPlan.registerTool
                    ? ARTIFACT_TOOL_DEFINITION_TOKENS
                    : 0) +
                // The batch tool's schema is only sent on a turn that carries
                // a Word template, so it is priced only there.
                (artifactToolPlan.registerDocumentBatch
                    ? ARTIFACT_BATCH_TOOL_DEFINITION_TOKENS
                    : 0);
            estimatedInputTokens += artifactPromptTokens;
            inputEstimate.addTokens(artifactPromptTokens);
        }
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
            const isLatestMessage = msg === latestMessage;

            for (const [attachmentIndex, incoming] of attachments.entries()) {
                /*
                  What this file actually is, decided by the server.

                  For a signed-in caller every field comes from the row the
                  opaque id resolved to -- name, media type, kind and key --
                  so a request that renamed a .docx to a .txt, understated a
                  size or pointed somewhere else changes nothing about how the
                  file is read. For a guest the request is still the source,
                  because a guest object has no row: its key is derived from
                  their own signed identity and checked as such below.
                */
                const referenceKey = attachmentReferenceKey(incoming);
                const resolved = referenceKey
                    ? resolvedAttachments.get(referenceKey)
                    : undefined;
                if (!resolved && typeof incoming?.objectKey !== "string") {
                    throw new ChatAccessError(
                        400,
                        "ATTACHMENT_REFERENCE_REQUIRED",
                        "Attachments must be referenced by the id the upload step issued."
                    );
                }
                const attachment: IncomingAttachment = resolved
                    ? {
                          name: resolved.name,
                          mediaType: resolved.mediaType,
                          kind: resolved.kind,
                          objectKey: resolved.objectKey,
                      }
                    : incoming;
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
                    /*
                      The one place a tool can reach this turn's own files.

                      Held only for the attachments of the message being
                      answered, only for the length of this request, and keyed
                      by the opaque handle the model was given. The bytes are
                      already in memory because the prompt needs them; nothing
                      is read twice for this.
                    */
                    if (isLatestMessage) {
                        turnAttachmentBytes.set(
                            turnAttachmentHandle(attachmentIndex),
                            {
                                name: attachment.name,
                                mediaType: attachment.mediaType,
                                bytes: new Uint8Array(attachmentBuffer),
                            }
                        );
                    }
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
        // What the search half of this turn may cost, before anything is sent.
        //
        // A native search is billed per query on top of tokens, and nothing
        // used to reserve it -- the cost was added at settlement, so the
        // provider budget only ever learned about it after the money was
        // gone. Reserving the worst case requires there to be one: a provider
        // whose request cannot bound the query count is refused here rather
        // than dispatched against a reservation that does not cover it.
        const nativeSearchReservation = reserveNativeSearchCost({
            model: modelConfig,
            capability: webSearchCapability,
            nativeSearchEnabled,
        });
        if (!nativeSearchReservation.ok) {
            throw new ChatAccessError(
                503,
                "WEB_SEARCH_COST_UNBOUNDED",
                "Web search is temporarily unavailable for this model.",
                undefined,
                { scope: nativeSearchReservation.reason }
            );
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
                nativeSearch: nativeSearchReservation,
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
                    webSearchRequested: routerCandidateInputs.webSearchRequested,
                }),
                userSelectedModelId: modelConfig.id,
                estimatedInputTokens,
                reservedInputTokens: budget.inputTokens,
                // The unfitted cap on purpose: the filters fit it to each
                // candidate's own window, and handing them the figure already
                // fitted to the user's model would bias every other candidate.
                requestOutputCapTokens: budget.maxOutputTokens,
                models: routerCandidateInputs.models,
                unhealthyModelIds: routerCandidateInputs.unhealthyModelIds,
                signals: routerCandidateInputs.signals,
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
        // Whether this dispatch will actually be able to search, as opposed to
        // being allowed to. The Router's filter answers the second: it keeps a
        // native model for a turn that needs current information because the
        // model *can* search. Whether it *will* depends on the mode, the tool
        // configuration and the surcharge, none of which the filter can see --
        // it runs before there is an attempt to configure or a cost to
        // reserve. See docs/policy/tomverse-chat-router-score-policy.md §8.
        const primarySearchPath = resolveAttemptSearchPath({
            support: webSearchCapability.support,
            webSearchMode: webSearchMode ?? null,
            toolConfigBuilt: webSearchToolConfig !== null,
            surchargeCredits: getWebSearchSurchargeCredits(
                webSearchMode ?? "off",
                webSearchCapability
            ),
        });
        // Recorded, not refused. A routed turn whose profile says it needs the
        // web and whose model will not search is the incoherence this check
        // exists to surface -- but the answer still goes out, because the
        // alternatives are refusing a turn the user would rather have answered
        // imperfectly, or switching search on for a mode they set to `off`.
        // Which of those to do is a product decision; making the case visible
        // is not. Content-free: fixed identifiers and model ids only.
        if (
            autoSelection.routed &&
            autoSelection.record.needsCurrentInformation &&
            !hasSearchPath(primarySearchPath)
        ) {
            console.warn(JSON.stringify({
                event: "chat_auto_search_path_missing",
                traceId,
                modelId: modelConfig.id,
                gap: primarySearchPath.kind === "none" ? primarySearchPath.gap : null,
                selectionReason: autoSelection.record.selectionReason,
                timestamp: new Date().toISOString(),
            }));
        }
        /*
          This turn's generated files (docs/policy/generated-artifacts.md).

          The collector exists because a tool call outlives the certainty that
          its turn will finish. `execute` runs while the stream is open, and
          the assistant message it must hang from is not written until the
          stream closes -- so bytes go to storage now, rows go down with the
          message later, and every ending that does not write a message calls
          `discard()` to reclaim what was stored. That is the whole reason the
          non-atomic write is safe.

          `streamController` is where the "creating the file" chunk is written.
          Captured on the stream's first pull rather than passed in, because
          the collector is built before the ReadableStream exists and the tool
          runs after it does. `enqueue` is legal on a controller at any point
          while the stream is open, which is what lets a status be announced
          from inside a tool call rather than after it.
        */
        let streamController: ReadableStreamDefaultController<string> | null =
            null;
        const artifactCollector =
            artifactToolPlan && artifactToolPlan.registerTool
                ? new GeneratedArtifactCollector({
                      mode: artifactToolPlan.mode,
                      userId: session?.user?.id ?? null,
                      conversationId: conversationId ?? null,
                      modelId: modelConfig.id,
                      traceId,
                      emitProgress: (format) => {
                          if (!streamController) return;
                          enqueueSafely(
                              streamController,
                              buildArtifactProgressChunk(format)
                          );
                      },
                      // This turn's own files, by the handles the system block
                      // named. Already read, already ownership-checked; the
                      // batch tool is the only reader and it never sees a key.
                      turnAttachments: turnAttachmentBytes,
                  })
                : null;
        const artifactToolConfig = artifactCollector
            ? buildGeneratedArtifactToolConfig(artifactCollector, {
                  registerDocumentBatch: Boolean(
                      artifactToolPlan?.registerDocumentBatch
                  ),
              })
            : null;
        /*
          Tools from both features, merged rather than chosen between.

          The names cannot collide: the native search tools are `web_search`
          and `google_search`, and these are the five `create_*` tools. Where
          the two features genuinely cannot coexist -- a forced search, or
          Google grounding -- `planGeneratedArtifactTool` has already refused,
          so nothing here has to re-derive that.

          `stopWhen` is set only when the artifact tool is registered. Every
          other turn keeps the SDK's single-step default, so a request that
          registers no application tool behaves exactly as it does today.
        */
        const combinedToolConfig =
            webSearchToolConfig || artifactToolConfig
                ? {
                      ...(webSearchToolConfig ?? {}),
                      tools: {
                          ...(webSearchToolConfig?.tools ?? {}),
                          ...(artifactToolConfig?.tools ?? {}),
                      },
                      ...(artifactToolConfig
                          ? { stopWhen: stepCountIs(GENERATED_ARTIFACT_MAX_STEPS) }
                          : {}),
                  }
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
        /**
         * The SDK call's two halves.
         *
         * `formattedMessages` keeps carrying its system blocks: the deep
         * research path hands the same array to Perplexity's own API, which
         * does take a system turn (`lib/perplexityDeepResearch.ts`), and the
         * request manifest below describes what was sent. `ai@7` will not take
         * them in `messages`, so the split happens here -- unconditionally,
         * and in one place, because doing it per-source is what broke twice.
         * See lib/chatProviderPrompt.ts.
         */
        const { messages: sdkMessages, instructions: sdkInstructions } =
            splitProviderInstructions(formattedMessages);
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
            // Named rather than embedded when the artifact tool is present:
            // the tool object carries an `execute` closure and a Zod schema,
            // neither of which survives `JSON.stringify`, and one of which can
            // be cyclic. A turn without it hashes exactly as it always has.
            toolConfig: artifactToolConfig
                ? {
                      ...(webSearchToolConfig ?? {}),
                      // The tools this request actually carries, not the full
                      // catalogue of them. `create_document_batch` is
                      // registered only on a turn with a Word template, so a
                      // constant list here would hash two genuinely different
                      // requests the same -- and the manifest exists to
                      // describe the effective request.
                      applicationTools: Object.keys(artifactToolConfig.tools).sort(),
                  }
                : webSearchToolConfig,
            messages: manifestMessages,
            // No Planner yet, and saying so is more honest than a version
            // number for a stage that did not run.
            plannerVersion: "none",
            adapterVersion: "vercel-ai-sdk-streamText-v1",
        });
        const result = await streamText({
            model: activeModel,
            messages: sdkMessages,
            ...(sdkInstructions ? { instructions: sdkInstructions } : {}),
            maxOutputTokens: requestMaxOutputTokens,
            maxRetries: modelConfig.provider === "zhipu" ? 0 : undefined,
            headers:
                modelConfig.provider === "perplexity"
                    ? perplexityUsageHeaders(traceId)
                    : undefined,
            ...generationSettings,
            ...(combinedToolConfig ?? {}),
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
         * Read from the reservation rather than recomputed, because a second
         * hold has to go into the same day and month the first one did. A turn
         * that reserved no cost holds nothing and names no periods, so a
         * fallback across providers is refused rather than guessing them.
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
        //
        // That is the *user's* ledger and it stays. The provider's ledger is a
        // different question with a different answer: a native search runs
        // before the model writes a word, so by the time a client disconnects
        // mid-answer the provider has already run and billed for it. Nobody
        // counted the queries, which is what `searchQueriesObserved: false`
        // says -- settlement records the frozen authorization as an upper
        // bound rather than pretending the count is zero.
        const earlyCancelSearchFields = {
            searchSurchargeCredits: getWebSearchSurchargeCredits(
                webSearchMode ?? "off",
                webSearchCapability
            ),
            searchExecuted: false,
            searchQueriesObserved: false,
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
                // The provider's half of a native search, and whether anybody
                // was still there to count it.
                //
                // These two were absent for as long as this function has
                // existed. `searchSettlementFields` has always carried them and
                // has always been spread into this parameter -- and TypeScript
                // does not excess-property-check a spread, so both were dropped
                // here in silence and every completed search settled as zero
                // queries. The settlement arithmetic that prices them was
                // right; it was simply never handed anything to price.
                searchCostMicroUsd?: number;
                searchQueryCount?: number;
                searchQueriesObserved?: boolean;
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
                        searchCostMicroUsd: usage?.searchCostMicroUsd,
                        searchQueryCount: usage?.searchQueryCount,
                        searchQueriesObserved: usage?.searchQueriesObserved,
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
                                      // The turn's search belongs to the
                                      // attempt that ran it, and a searching
                                      // turn never falls back (autoFallbackGate
                                      // excludes it), so the attempt being
                                      // built here is that one. Passing
                                      // `undefined` unconditionally dropped the
                                      // cost a second time on the multi-attempt
                                      // path.
                                      searchCostMicroUsd:
                                          usage?.searchCostMicroUsd,
                                      searchQueryCount: usage?.searchQueryCount,
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
        /*
          Set only by a message transaction that committed.

          Every terminal path funnels through `releaseSafely`, so this one
          boolean decides whether the objects this turn wrote are kept or
          reclaimed -- and it defaults to "reclaim". A cancelled stream, a
          provider failure, a client that disconnected, a swap to another
          model and a message write that threw all reach the release without
          ever setting it, and all of them leave storage clean.
        */
        let artifactsPersisted = false;
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
            if (artifactCollector && !artifactsPersisted) {
                // Idempotent: `discard` empties its own list, so the several
                // paths that release twice cannot double-delete or throw.
                await artifactCollector.discard();
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
                // Includes the artifact tool, and that is the point:
                // docs/policy/tomverse-chat-routing.md §7's own rationale
                // excludes a turn with a tool result the conversation now
                // refers to, and a generated file is exactly that -- bytes
                // already in storage that a second model's answer would not
                // account for.
                toolsOffered: Boolean(combinedToolConfig),
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
                // `docs/policy/tomverse-chat-routing.md` §10, in the
                // direction it is usually read the other way round: a fallback
                // may not silently change what the user was going to get. If
                // the primary was going to search, a candidate that will answer
                // from training data instead is a different answer to the same
                // question, not a substitute for it.
                //
                // In practice this fires for a search-model primary. Once a
                // provider-native tool has been offered, autoFallbackGate has
                // already refused to fall back at all -- a search may have run
                // and been surcharged by then.
                requireSearchPath: hasSearchPath(primarySearchPath),
            });
            if (!planned.ok) {
                reportFallbackRefusal(`candidate_${planned.refusal.kind}`);
                return false;
            }
            const plan = planned.plan;

            // §10: every dispatch is authorized on the server, including this
            // one. Money held at the primary's provider does not make a call
            // to another provider affordable.
            // §10 authorizes every dispatch, and that includes a fallback on
            // the provider the primary is already holding against: the hold is
            // sized for one attempt, and a second call costs more whether or
            // not it shares a bucket.
            let fallbackHoldTaken = false;
            if (!providerHoldDay || !providerHoldMonth) {
                // Nothing was held for this turn, so there is no evidence of
                // which periods a second hold belongs in.
                reportFallbackRefusal("no_provider_hold");
                return false;
            }
            const fallbackAttemptIndex = dispatched.attemptIndex + 1;
            const reserved = await reserveAttemptProviderBudget({
                reservationId: usageReservation!.reservationId,
                userId: usageReservation!.userId ?? null,
                attemptIndex: fallbackAttemptIndex,
                provider: plan.provider,
                reservedMicroUsd: getChatBudgetReservedCostMicroUsd(plan.budget),
                // Written with the hold, before the provider is called: a
                // sweep that finds this attempt crashed has no other way to
                // know what the call was allowed to cost.
                costIntent: {
                    modelId: plan.modelId,
                    provider: plan.provider,
                    estimatedInputTokens: plan.budget.inputTokens,
                    reservedOutputTokens: plan.budget.reservedOutputTokens,
                    inputUsdPerMillionTokens: plan.budget.inputUsdPerMillionTokens,
                    outputUsdPerMillionTokens: plan.budget.outputUsdPerMillionTokens,
                    cachedInputPriceMultiplier:
                        plan.budget.cachedInputPriceMultiplier,
                    pricingVersion: plan.budget.pricingVersion ?? null,
                },
            }).catch((budgetError: unknown) => {
                logRequestError(
                    "chat_fallback_budget_reserve_failed",
                    traceId,
                    budgetError,
                    plan.modelId
                );
                return { reserved: false as const, reason: "reserve_failed" as const };
            });
            if (!reserved.reserved) {
                reportFallbackRefusal(`budget_${reserved.reason}`);
                return false;
            }
            fallbackHoldTaken = true;
            usageReservation = {
                ...usageReservation!,
                entries: [...usageReservation!.entries, ...reserved.entries],
            };
            /**
             * Gives the hold back when the dispatch it authorized never
             * happened.
             *
             * §10 requires the authorization *before* the call, so there is
             * necessarily a window where the money is held and the call has
             * not been made. Every exit from that window has to come through
             * here, or a provider carries a hold for a request that does not
             * exist until the reservation expires.
             */
            const abandonFallback = async (reason: string) => {
                if (fallbackHoldTaken) {
                    await releaseAttemptProviderBudget({
                        reservationId: usageReservation!.reservationId,
                        userId: usageReservation!.userId ?? null,
                        attemptIndex: fallbackAttemptIndex,
                    });
                    usageReservation = {
                        ...usageReservation!,
                        entries: usageReservation!.entries.filter(
                            (entry) => !reserved.entries.includes(entry)
                        ),
                    };
                }
                reportFallbackRefusal(reason);
                return false;
            };

            // Kept before the dispatch because `beginRetryAttempt` opens the
            // second attempt on this record's run. Closing it is deliberately
            // *after* the dispatch succeeds -- see below.
            const failing = dispatchRecord;
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
                    messages: sdkMessages,
                    ...(sdkInstructions ? { instructions: sdkInstructions } : {}),
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
                return abandonFallback("dispatch_failed");
            }

            // §7: the client is told before the next model's first token, and
            // told a model id and nothing else. Out-of-band, so it is not a
            // visible token and does not close the door it just opened.
            if (!enqueueSafely(controller, buildRoutingRetryChunk(plan.modelId))) {
                await nextStream.textStream.getReader().cancel("client is gone");
                return abandonFallback("client_gone_before_signal");
            }

            // From here the swap is committed, and only from here.
            //
            // Closing the primary attempt and adding it to `endedAttempts`
            // used to happen before the dispatch. If the dispatch then failed,
            // the turn ended on the primary while `endedAttempts` already held
            // attempt 0 and `dispatched` was still attempt 0 -- so settlement
            // built the same index twice and `attemptSetProblems` refused the
            // whole settlement, leaving the money where it was. A fallback
            // that never dispatched must settle as the single attempt it was.
            //
            // No usage metadata exists for a stream that failed before its
            // first chunk, so the input is the reserved estimate and the
            // output is zero, flagged as an estimate. Over-recording provider
            // spend is the safe direction for a ledger whose job is to keep a
            // budget from being exceeded; the user is not charged for it --
            // §7 bills the accepted attempt only.
            const endedAttempt: AttemptUsage = {
                attemptIndex: dispatched.attemptIndex,
                price: dispatched.price,
                inputTokens: budget.inputTokens,
                cachedInputTokens: 0,
                outputTokens: 0,
                usageFromProvider: false,
                outcome: "failed",
            };
            try {
                // The cost is written with the close, not left to settlement
                // at the end of the turn. This attempt is over and the turn is
                // not: from here on it is terminal, so the stale-attempt sweep
                // will never consider it again, and a process that dies during
                // the fallback would otherwise leave a provider call that was
                // made, was paid, and appears in no ledger at all.
                await completeInstrumentedDispatch(failing, {
                    outcome: "failed_pre_token",
                    failureLayer: classified.failureLayer,
                    actualInputTokens: budget.inputTokens,
                    actualOutputTokens: 0,
                    errorClass: "provider_pre_token_failure",
                    settlementOutcome: "failed",
                    cost: usageReservation
                        ? {
                              reservationId: usageReservation.reservationId,
                              attempt: {
                                  ...endedAttempt,
                                  ...priceAttempt(endedAttempt),
                                  userBilled: false,
                              },
                          }
                        : null,
                });
            } catch (recordError) {
                logRequestError(
                    "chat_fallback_attempt_close_failed",
                    traceId,
                    recordError,
                    dispatched.modelId
                );
            }
            endedAttempts.push(endedAttempt);

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

            /*
              Unreachable today, and kept because "today" is a configuration.

              `autoFallbackScope` refuses a turn that offered tools, so a turn
              with an artifact collector never reaches a swap. If that scope
              ever widens, the primary's files must not follow another model's
              answer: they were produced from the displaced attempt's
              reasoning, and the message that will be written is not the one
              they belong to.
            */
            await artifactCollector?.discard();

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
                streamController = controller;

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
                            // The normalizer read the finished response, so an
                            // absent count here means the search really did not
                            // run -- not that nobody looked.
                            searchQueriesObserved: true,
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
                        /*
                          The files this turn produced, as the client will be
                          told about them.

                          Reassigned below once the rows exist, so a failed
                          artifact's card gets the id of its own row and
                          survives a reload. A turn that persists nothing
                          keeps the collector's synthetic ids, which address
                          nothing and are only ever attached to cards that
                          have no download button.
                        */
                        let artifactsForTrailer: ChatStreamArtifact[] =
                            artifactCollector?.toStreamArtifacts() ?? [];
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
                                /*
                                  Provider-private state for replaying a
                                  reasoning model exactly -- and not stored at
                                  all on a turn that called the artifact tool.

                                  `response.messages` carries that turn's tool
                                  call and its result verbatim. Replaying them
                                  on a later turn that does not register
                                  `create_spreadsheet` sends a provider a
                                  tool_use naming a tool the request never
                                  declared, which several providers reject
                                  outright -- and whether the tool is
                                  registered is decided per turn (a model
                                  change, web search switched on). The
                                  reasoning replay is an optimisation; a turn
                                  the provider refuses is a broken answer, so
                                  the optimisation is the half that gives way.
                                */
                                const providerContext =
                                    dispatched.reasoning !== undefined &&
                                    responseResult.status === "fulfilled" &&
                                    !artifactCollector?.wasInvoked
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
                                    /*
                                      The artifact rows, in the same
                                      transaction as the message they belong
                                      to. Either the answer and its files are
                                      both there or neither is -- there is no
                                      state in which a download card points at
                                      a message that was never written.

                                      The bytes are already in storage. That
                                      order is the one this domain chose (see
                                      lib/generatedArtifactStorage.ts): an
                                      object with no row is reclaimable by a
                                      sweep, a row with no object is a broken
                                      download button.
                                    */
                                    if (artifactCollector && !artifactCollector.isEmpty) {
                                        await persistArtifactRows(tx, {
                                            messageId: assistantMessageId,
                                            conversationId,
                                            userId: session!.user!.id,
                                            stored: artifactCollector.stored,
                                            failed: artifactCollector.failed,
                                        });
                                    }
                                });
                                if (artifactCollector && !artifactCollector.isEmpty) {
                                    // Read back rather than assumed: the
                                    // failed rows were created without
                                    // caller-supplied ids, and the card the
                                    // user reloads into has to be addressable
                                    // by the same id the card they are looking
                                    // at already carries.
                                    const persistedRows =
                                        await prisma.messageArtifact.findMany({
                                            where: { messageId: assistantMessageId },
                                            select: { id: true, ordinal: true },
                                        });
                                    artifactsForTrailer =
                                        artifactCollector.withPersistedIds(persistedRows);
                                }
                                // The rows are committed, so the objects they
                                // point at must survive the release below.
                                artifactsPersisted = true;
                            } catch (error) {
                                logRequestError(
                                    "assistant_message_persist_failed",
                                    traceId,
                                    error,
                                    dispatched.modelId
                                );
                                /*
                                  The message did not land, so nothing can
                                  ever reach these objects: no row references
                                  them and no route accepts a key. Reclaimed
                                  now, and swept later if this fails too.

                                  The cards are dropped from the trailer in
                                  the same breath. Showing a download button
                                  for a file whose row does not exist would be
                                  the one failure this feature must not have.
                                */
                                await artifactCollector?.discard();
                                artifactsForTrailer = [];
                            }
                        } else if (artifactCollector?.stored.length) {
                            /*
                              A turn that called the tool and then wrote no
                              text at all, or that has no conversation to
                              write to.

                              The answer is reported as empty by the branch
                              below, and an empty answer keeps no file: there
                              is no message for the row to reference, so the
                              object would be unreachable from the moment it
                              was written. The event is logged separately
                              because it is the one shape where a successful
                              generation is deliberately thrown away, and a
                              rate that stops being near-zero means the
                              instructions have stopped working.
                            */
                            console.warn(
                                JSON.stringify({
                                    event: "generated_artifact_discarded_empty_answer",
                                    traceId,
                                    conversationId,
                                    modelId: dispatched.modelId,
                                    artifacts: artifactCollector.stored.length,
                                    timestamp: new Date().toISOString(),
                                })
                            );
                            await artifactCollector.discard();
                            artifactsForTrailer = [];
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
                                // Absent, not empty, on a turn with no files:
                                // an older client ignores the key and a turn
                                // that made nothing says nothing.
                                ...(artifactsForTrailer.length
                                    ? { artifacts: artifactsForTrailer }
                                    : {}),
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
                    // Same reason as the cancelled paths: the provider errored
                    // mid-stream, so the normalizer never ran and nobody
                    // counted the searches it may already have executed. The
                    // user-ledger fields are left alone -- only the provider
                    // ledger is told that the count is unknown rather than
                    // zero.
                    await settleSafely("failed", { searchQueriesObserved: false });
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
