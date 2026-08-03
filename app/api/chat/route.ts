import { streamText, type FilePart, type ModelMessage } from "ai";
import { APP_DEFAULTS } from "@/lib/appDefaults";
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
    modelSupportsImageInput,
    modelSupportsNativePdfInput,
    type AiModel,
} from "@/lib/models";
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
import { buildSearchMetadataTrailerChunk } from "@/lib/webSearchStreamTrailer";
import { ERROR_REPORT_TOKEN_HEADER } from "@/lib/errorReportContract";
import { issueChatErrorReportGrant } from "@/lib/traceErrorEvidence";
import {
    consumePerplexityUsage,
    discardPerplexityUsage,
    perplexityUsageHeaders,
} from "@/lib/perplexityUsageCapture";
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
    identifyChatCaller,
    linkChatReservationProviderRequest,
    readChatJsonBody,
    heartbeatChatAccess,
    leaseHeartbeatIntervalMs,
    releaseChatAccess,
    resolveLeaseTtlSeconds,
    settleChatUsage,
    type ChatUsageReservation,
    validateChatPayload,
} from "@/lib/chatSecurity";
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
import { estimatePromptTokens } from "@/lib/chatTokenEstimate";
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
        // append, not set: the response may already carry the guest identity
        // cookie (accessGrant.setCookie below), and both must survive.
        response.headers.append("Set-Cookie", verificationGrant.setCookie);
    }
    return response;
}

async function handleChatPost(
    req: Request,
    traceId: string,
    verificationGrant: { setCookie?: string }
): Promise<Response> {
    let leaseId: string | null = null;
    // Declared out here so the failure path can stop the renewal timer even
    // when the stream was never built: an interval left running would keep
    // renewing a lease no request owns any more.
    let stopLeaseHeartbeat: (() => void) | null = null;
    let usageReservation: ChatUsageReservation | null = null;
    let requestedModelIdForLog: string | undefined;
    let requestedProviderForLog: AiModel["provider"] | undefined;
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
        } = validateChatPayload(body);
        const requestedModelId = modelId || APP_DEFAULTS.defaultModelId;
        requestedModelIdForLog = requestedModelId;
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
        const modelConfig = catalogModel?.enabled && !catalogModel.catalogDeleted
            ? catalogModel
            : undefined;
        if (!modelConfig) {
            return tracedJsonError(
                "Unknown or disabled model.",
                "MODEL_NOT_AVAILABLE",
                400,
                traceId
            );
        }
        if (hasUnsupportedGeminiPrefill(modelConfig, messages)) {
            return tracedJsonError(
                "Gemini 3.6 and later requests must end with a user message.",
                "GEMINI_PREFILLED_MODEL_TURN_UNSUPPORTED",
                400,
                traceId
            );
        }
        const adminModelAccess = await assertModelRuntimeAvailable(requestedModelId);
        if (!adminModelAccess.allowed) {
            return tracedJsonError(
                adminModelAccess.reason || "This model is temporarily unavailable.",
                "MODEL_TEMPORARILY_UNAVAILABLE",
                503,
                traceId
            );
        }
        requestedProviderForLog = modelConfig.provider;
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
        const billingPlan = session?.user?.id
            ? await getUserBillingPlan(session.user.id)
            : null;
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
                select: { userId: true, password: true, selectedModels: true, kind: true },
            });
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
            if (
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
        const userObjectPrefix = session?.user?.email
            ? `attachments/${createHash("sha256")
                .update(session.user.email.toLowerCase())
                .digest("hex")
                .slice(0, 20)}/`
            : null;
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
        const estimateTextTokens = (text: string) =>
            Math.max(1, estimatePromptTokens(text));

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
                            modelId: requestedModelId,
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

        const formattedMessages: ModelMessage[] = [];
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
            const textAttachments: string[] = [];
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

                        textAttachments.push(
                            `[Attached PDF file: ${attachment.name}]\n${pdfText}`
                        );
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

                    textAttachments.push(
                        `[Attached office file: ${attachment.name}]\n${extractedText}`
                    );
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
                    textAttachments.push(
                        `[Attached file: ${attachment.name}]\n${attachmentData}`
                    );
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

            const text = [String(msg.content ?? ""), ...textAttachments]
                .filter(Boolean)
                .join("\n\n");
            estimatedInputTokens +=
                estimateTextTokens(text) +
                estimateNativeAttachmentTokens(fileParts.length);

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
            estimatedInputTokens,
            {
                webSearchSurchargeCredits: getWebSearchSurchargeCredits(
                    webSearchMode ?? "off",
                    webSearchCapability
                ),
                nativeSearchEnabled,
            }
        );
        if (
            modelConfig.contextWindowTokens &&
            estimatedInputTokens + budget.maxOutputTokens >
                modelConfig.contextWindowTokens
        ) {
            throw new ChatAccessError(
                400,
                "MODEL_CONTEXT_WINDOW_EXCEEDED",
                `${modelConfig.name} supports up to ${modelConfig.contextWindowTokens.toLocaleString("en-US")} input and output tokens combined. Start a new conversation or shorten the attachments.`
            );
        }
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
        leaseId = accessGrant.leaseId;
        usageReservation = accessGrant.usageReservation;
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
            const activeLeaseId = leaseId;
            leaseId = null;
            await releaseChatAccess(activeLeaseId, {
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
                            modelId: requestedModelId,
                            phase: "request",
                            traceId,
                            errorName: submitMetadata.name,
                            errorCode: submitMetadata.code,
                            httpStatus: submitMetadata.statusCode,
                            retryable: submitMetadata.isRetryable,
                        }
                    ).catch(() => {});
                    await recordModelFailure(
                        requestedModelId,
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
        const result = await streamText({
            model: activeModel,
            messages: formattedMessages,
            maxOutputTokens: budget.maxOutputTokens,
            maxRetries: modelConfig.provider === "zhipu" ? 0 : undefined,
            headers:
                modelConfig.provider === "perplexity"
                    ? perplexityUsageHeaders(traceId)
                    : undefined,
            ...getModelGenerationSettings(modelConfig),
            ...(webSearchToolConfig ?? {}),
        });

        const sourceReader = result.textStream.getReader();
        const activeLeaseId = leaseId;
        leaseId = null;
        let generatedText = "";
        let released = false;
        let sourceCancelled = false;
        let usageSettlement: Promise<void> | null = null;
        let streamState: "open" | "closed" | "cancelled" = "open";
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
                        modelConfig.provider === "perplexity"
                            ? await consumePerplexityUsage(traceId)
                            : null;
                    await settleChatUsage(reservation, {
                        inputTokens:
                            usage?.inputTokens ?? reservation.inputTokens,
                        cachedInputTokens: usage?.cachedInputTokens,
                        outputTokens:
                            usage?.outputTokens ??
                            estimatedGeneratedOutputTokens(),
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
                    });
                    usageReservation = null;
                } catch (error) {
                    logRequestError(
                        "chat_usage_settlement_failed",
                        traceId,
                        error,
                        requestedModelId
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
                        requestedModelId
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
                    requestedModelId
                );
            }
        };
        const cancelSourceSafely = async (reason?: unknown) => {
            if (sourceCancelled) return;
            sourceCancelled = true;
            try {
                await sourceReader.cancel(reason);
            } catch (error) {
                if (!isClosedStreamControllerError(error)) {
                    logRequestError(
                        "ai_source_stream_cancel_failed",
                        traceId,
                        error,
                        requestedModelId
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
                        requestedModelId
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
                        requestedModelId
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
                        requestedModelId
                    );
                }
                return false;
            }
        };
        const protectedStream = new ReadableStream<string>({
            async pull(controller) {
                if (streamState !== "open") return;

                try {
                    const { done, value } = await sourceReader.read();
                    if (streamState !== "open") {
                        await releaseSafely();
                        return;
                    }
                    if (done) {
                        const completionResults = await Promise.allSettled([
                            result.response,
                            result.usage,
                            result.finishReason,
                            result.rawFinishReason,
                            result.content,
                        ] as const);
                        const [
                            responseResult,
                            usageResult,
                            finishReasonResult,
                            rawFinishReasonResult,
                            contentResult,
                        ] = completionResults;
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
                                    requestedModelId
                                );
                            }
                        }

                        if (completionError) {
                            logRequestError(
                                "chat_stream_completion_metadata_failed",
                                traceId,
                                completionError,
                                requestedModelId
                            );
                        }

                        const webSearchExecution = normalizeWebSearchExecution({
                            capability: webSearchCapability,
                            searchRequested: webSearchRequested,
                            provider: modelConfig.provider,
                            toolName: webSearchCapability.provider
                                ? WEB_SEARCH_TOOL_NAMES[webSearchCapability.provider]
                                : undefined,
                            content:
                                contentResult.status === "fulfilled"
                                    ? contentResult.value
                                    : undefined,
                        });
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
                                    modelConfig.reasoning !== undefined &&
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
                                            status: "normal",
                                            modelId: requestedModelId,
                                            searchMetadata: webSearchExecution,
                                        },
                                    });
                                    if (providerContext) {
                                        await tx.messageProviderContext.create({
                                            data: {
                                                messageId: assistantMessageId,
                                                modelId: requestedModelId,
                                                provider: modelConfig.provider,
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
                                    requestedModelId
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
                                    modelConfig.provider,
                                    diagnosticCode,
                                    {
                                        modelId: requestedModelId,
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
                                    requestedModelId,
                                    modelConfig.provider,
                                    diagnosticCode
                                );
                            } catch (error) {
                                logRequestError(
                                    "provider_empty_response_record_failed",
                                    traceId,
                                    error,
                                    requestedModelId
                                );
                            }
                        } else {
                            try {
                                await recordProviderSuccess(
                                    modelConfig.provider
                                );
                                await recordModelSuccess(requestedModelId);
                            } catch (error) {
                                logRequestError(
                                    "provider_success_record_failed",
                                    traceId,
                                    error,
                                    requestedModelId
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
                            buildSearchMetadataTrailerChunk(webSearchExecution)
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
                                requestedModelId
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
                        requestedModelId
                    );
                    try {
                        await recordProviderFailure(
                            modelConfig.provider,
                            diagnosticCode,
                            {
                                modelId: requestedModelId,
                                phase: "stream",
                                traceId,
                                errorName: errorMetadata.name,
                                errorCode: errorMetadata.code,
                                httpStatus: errorMetadata.statusCode,
                                retryable: errorMetadata.isRetryable,
                            }
                        );
                        await recordModelFailure(
                            requestedModelId,
                            modelConfig.provider,
                            diagnosticCode
                        );
                    } catch (recordError) {
                        logRequestError(
                            "provider_failure_record_failed",
                            traceId,
                            recordError,
                            requestedModelId
                        );
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
        if (accessGrant.setCookie) {
            headers.append("Set-Cookie", accessGrant.setCookie);
        }
        // The Turnstile grant cookie is appended by POST() on every return
        // path, success and failure alike -- adding it here as well would
        // send it twice.

        return new Response(protectedStream.pipeThrough(new TextEncoderStream()), {
            headers,
        });
    } catch (error: unknown) {
        stopLeaseHeartbeat?.();
        if (leaseId) {
            await releaseChatAccess(leaseId, {
                traceId,
                reason: "request_failed_before_stream",
            });
        }
        if (usageReservation) {
            try {
                const providerUsageSnapshot =
                    requestedProviderForLog === "perplexity"
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
                    requestedModelIdForLog
                );
            }
        }
        if (requestedProviderForLog === "perplexity") {
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
                        modelId: requestedModelIdForLog,
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
            requestedModelIdForLog
        );
        try {
            const errorMetadata = safeErrorMetadata(error);
            const diagnosticCode =
                error instanceof ChatAccessError
                    ? error.code
                    : providerDiagnosticCode("AI_REQUEST_FAILED", error);
            await recordProviderFailure(
                requestedProviderForLog,
                diagnosticCode,
                {
                    modelId: requestedModelIdForLog,
                    phase: "request",
                    traceId,
                    errorName: errorMetadata.name,
                    errorCode: errorMetadata.code,
                    httpStatus: errorMetadata.statusCode,
                    retryable: errorMetadata.isRetryable,
                }
            );
            await recordModelFailure(
                requestedModelIdForLog,
                requestedProviderForLog,
                diagnosticCode
            );
        } catch (recordError) {
            logRequestError(
                "provider_failure_record_failed",
                traceId,
                recordError,
                requestedModelIdForLog
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
                provider: requestedProviderForLog,
                modelId: requestedModelIdForLog,
                error,
            }
        );
    }
}
