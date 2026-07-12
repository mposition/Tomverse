import { streamText, type FilePart, type ModelMessage } from "ai";
import { openai, createOpenAI } from "@ai-sdk/openai";
import { anthropic } from "@ai-sdk/anthropic";
import { google } from "@ai-sdk/google";
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
import { prisma } from "@/lib/prisma";
import { getEnabledModel, type AiModel, type ModelTier } from "@/lib/models";
import { assertModelNotAdminDisabled } from "@/lib/modelOverrides";
import { parseOfficeSafely } from "@/lib/officeSecurity";
import {
    extractPdfTextSafely,
    normalizeImageSafely,
    validatePdfSafely,
} from "@/lib/mediaSecurity";
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
    readChatJsonBody,
    releaseChatAccess,
    settleChatUsage,
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
import { verifyGuestTurnstile } from "@/lib/turnstile";
import { getBillingPlanByTier } from "@/lib/billingConfig";

const groq = createOpenAI({
    baseURL: "https://api.groq.com/openai/v1",
    apiKey: process.env.GROQ_API_KEY,
});

const deepseek = createOpenAI({
    baseURL: "https://api.deepseek.com",
    apiKey: process.env.DEEPSEEK_API_KEY,
});

const mistral = createOpenAI({
    baseURL: "https://api.mistral.ai/v1",
    apiKey: process.env.MISTRAL_API_KEY,
});

const xai = createOpenAI({
    baseURL: "https://api.x.ai/v1",
    apiKey: process.env.XAI_API_KEY,
});

const moonshot = createOpenAI({
    baseURL: "https://api.moonshot.ai/v1",
    apiKey: process.env.MOONSHOT_API_KEY,
});

const qwen = createOpenAI({
    baseURL: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    apiKey: process.env.DASHSCOPE_API_KEY,
});

const zhipu = createOpenAI({
    baseURL: process.env.ZHIPU_BASE_URL || "https://api.z.ai/api/paas/v4",
    apiKey: process.env.ZHIPU_API_KEY,
});

const perplexity = createOpenAI({
    baseURL: "https://api.perplexity.ai",
    apiKey: process.env.PERPLEXITY_API_KEY,
});

const MAX_ATTACHMENTS = 5;
const MAX_ATTACHMENT_SIZE = 10 * 1024 * 1024;
const MAX_TOTAL_ATTACHMENT_SIZE = 25 * 1024 * 1024;
const MAX_EXTRACTED_ATTACHMENT_CHARACTERS = 300_000;
const MAX_STORED_MESSAGE_CHARACTERS = 100_000;
const normalizeUserPlan = (value: unknown): ModelTier =>
    value === "Pro" || value === "Max" || value === "Free" ? value : "Free";

type IncomingAttachment = {
    name?: unknown;
    mediaType?: unknown;
    objectKey?: unknown;
    data?: unknown;
    kind?: unknown;
};

const safeErrorMetadata = (error: unknown) => {
    if (!error || typeof error !== "object") {
        return { name: "UnknownError" };
    }

    const candidate = error as {
        name?: unknown;
        code?: unknown;
        status?: unknown;
        statusCode?: unknown;
        isRetryable?: unknown;
    };
    return {
        name:
            typeof candidate.name === "string"
                ? candidate.name.slice(0, 80)
                : "Error",
        code:
            typeof candidate.code === "string" &&
            /^[A-Za-z0-9_.-]{1,80}$/.test(candidate.code)
                ? candidate.code
                : undefined,
        statusCode:
            typeof candidate.statusCode === "number"
                ? candidate.statusCode
                : typeof candidate.status === "number"
                  ? candidate.status
                  : undefined,
        isRetryable:
            typeof candidate.isRetryable === "boolean"
                ? candidate.isRetryable
                : undefined,
    };
};

const logRequestError = (
    event: string,
    traceId: string,
    error: unknown,
    modelId?: string
) => {
    console.error(
        JSON.stringify({
            event,
            traceId,
            modelId,
            ...safeErrorMetadata(error),
        })
    );
};

const tracedJsonError = (
    error: string,
    code: string,
    status: number,
    traceId: string
) =>
    new Response(JSON.stringify({ error, code, traceId }), {
        status,
        headers: {
            "Content-Type": "application/json",
            "X-Request-ID": traceId,
        },
    });
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
const PROVIDERS_WITH_BINARY_ATTACHMENT_SUPPORT = new Set<AiModel["provider"]>([
    "openai",
    "anthropic",
    "google",
]);
const modelSupportsBinaryAttachments = (model: AiModel) =>
    PROVIDERS_WITH_BINARY_ATTACHMENT_SUPPORT.has(model.provider);
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
    if (!session?.user?.email) {
        return Response.json({ error: "Unauthorized" }, { status: 401 });
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

const getActiveModel = (model: AiModel) => {
    switch (model.provider) {
        case "openai":
            return openai(model.apiModel);
        case "anthropic":
            return anthropic(model.apiModel);
        case "google":
            return google(model.apiModel);
        case "groq":
            return groq.chat(model.apiModel);
        case "deepseek":
            return deepseek.chat(model.apiModel);
        case "mistral":
            return mistral.chat(model.apiModel);
        case "xai":
            return xai.chat(model.apiModel);
        case "moonshot":
            return moonshot.chat(model.apiModel);
        case "qwen":
            return qwen.chat(model.apiModel);
        case "perplexity":
            return perplexity.chat(model.apiModel);
        case "zhipu":
            return zhipu.chat(model.apiModel);
    }
};

export async function POST(req: Request) {
    const traceId = randomUUID();
    let leaseId: string | null = null;
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
        } = validateChatPayload(body);
        const requestedModelId = modelId || APP_DEFAULTS.defaultModelId;
        requestedModelIdForLog = requestedModelId;
        const modelConfig = getEnabledModel(requestedModelId);
        if (!modelConfig) {
            return tracedJsonError(
                "Unknown or disabled model.",
                "MODEL_NOT_AVAILABLE",
                400,
                traceId
            );
        }
        const adminModelAccess = await assertModelNotAdminDisabled(requestedModelId);
        if (!adminModelAccess.allowed) {
            return tracedJsonError(
                adminModelAccess.reason || "This model is temporarily unavailable.",
                "MODEL_TEMPORARILY_UNAVAILABLE",
                503,
                traceId
            );
        }
        requestedProviderForLog = modelConfig.provider;
        const requestAttachments = messages.flatMap((message) =>
            Array.isArray(message.attachments)
                ? (message.attachments as IncomingAttachment[])
                : []
        );
        if (requestAttachments.length > MAX_ATTACHMENTS) {
            throw new ChatAccessError(
                413,
                "TOO_MANY_ATTACHMENTS",
                "A chat request can contain at most 5 attachments."
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
        if (objectKeys.size > MAX_ATTACHMENTS) {
            throw new ChatAccessError(
                413,
                "TOO_MANY_ATTACHMENT_OBJECTS",
                "A chat request can reference at most 5 attachment objects."
            );
        }
        const userPlan = session?.user?.id
            ? normalizeUserPlan(
                  (
                      await prisma.user.findUnique({
                          where: { id: session.user.id },
                          select: { plan: true },
                      })
                  )?.plan
              )
            : undefined;
        const billingPlan = userPlan ? await getBillingPlanByTier(userPlan) : null;
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
        assertModelAccess(access, modelConfig);
        if (access.kind === "guest") {
            await verifyGuestTurnstile(req, turnstileToken);
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
                select: { userId: true, password: true },
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
        }
        const userObjectPrefix = session?.user?.email
            ? `attachments/${createHash("sha256")
                .update(session.user.email.toLowerCase())
                .digest("hex")
                .slice(0, 20)}/`
            : null;

        const activeModel = getActiveModel(modelConfig);
        let estimatedInputTokens = 0;
        let totalAttachmentBytes = 0;
        let totalExtractedCharacters = 0;
        const estimateTextTokens = (text: string) =>
            Math.max(1, Buffer.byteLength(text, "utf8"));

        const formattedMessages: ModelMessage[] = [];
        for (const msg of messages) {
            if (msg.role === "assistant") {
                const content = String(msg.content ?? "");
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

                if (typeof attachment.objectKey === "string") {
                    if (
                        !userObjectPrefix ||
                        !attachment.objectKey.startsWith(userObjectPrefix)
                    ) {
                        throw new Error("Attachment access denied.");
                    }

                    attachmentBuffer = await readR2Object(
                        attachment.objectKey,
                        {
                            maxBytes: MAX_ATTACHMENT_SIZE,
                            expectedContentType: attachment.mediaType,
                        }
                    );
                    attachmentBytes = attachmentBuffer.byteLength;
                    attachmentData =
                        attachment.kind === "text"
                            ? attachmentBuffer.toString("utf8")
                            : attachmentBuffer.toString("base64");
                } else {
                    throw new Error("Attachment data is missing.");
                }

                if (attachmentBytes > MAX_ATTACHMENT_SIZE) {
                    throw new ChatAccessError(
                        413,
                        "ATTACHMENT_TOO_LARGE",
                        "An attachment exceeds the per-file size limit."
                    );
                }

                if (isImageAttachmentType(attachment.mediaType)) {
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
                        } catch {
                            throw new ChatAccessError(
                                400,
                                "INVALID_PDF_ATTACHMENT",
                                "The attached PDF is invalid or unsupported."
                            );
                        }
                        if (modelSupportsBinaryAttachments(modelConfig)) {
                            pdfFilePartBuffer = pdfBuffer;
                        }
                    }
                    if (!extractedPdfText && !pdfFilePartBuffer) {
                        if (modelSupportsBinaryAttachments(modelConfig)) {
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

            if (
                fileParts.length > 0 &&
                !modelSupportsBinaryAttachments(modelConfig)
            ) {
                throw new ChatAccessError(
                    400,
                    "ATTACHMENT_MODEL_UNSUPPORTED",
                    "선택한 모델은 이미지/PDF 첨부파일을 지원하지 않습니다. GPT, Claude, Gemini 계열 모델을 선택하거나 첨부파일 없이 다시 시도해주세요."
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
                estimateTextTokens(text) + fileParts.length * 16_000;

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
            estimatedInputTokens
        );
        const accessGrant = await acquireChatAccess(access, budget);
        leaseId = accessGrant.leaseId;
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

        const result = await streamText({
            model: activeModel,
            messages: formattedMessages,
            maxOutputTokens: budget.maxOutputTokens,
            maxRetries: modelConfig.provider === "zhipu" ? 0 : undefined,
        });

        const sourceReader = result.textStream.getReader();
        const activeLeaseId = leaseId;
        leaseId = null;
        let generatedText = "";
        let released = false;
        const release = async () => {
            if (released) return;
            released = true;
            await releaseChatAccess(activeLeaseId);
        };
        const protectedStream = new ReadableStream<string>({
            async pull(controller) {
                try {
                    const { done, value } = await sourceReader.read();
                    if (done) {
                        try {
                            const usage = await result.usage;
                            await settleChatUsage(
                                accessGrant.usageReservation,
                                {
                                    inputTokens: usage.inputTokens,
                                    outputTokens: usage.outputTokens,
                                }
                            );
                        } catch (error) {
                            logRequestError(
                                "chat_usage_settlement_failed",
                                traceId,
                                error,
                                requestedModelId
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
                                await prisma.$transaction(async (tx) => {
                                    await assertMessageCapacity(
                                        tx,
                                        session!.user!.id,
                                        conversationId,
                                        1,
                                        Buffer.byteLength(storedContent, "utf8")
                                    );
                                    await tx.message.create({
                                        data: {
                                            id: assistantMessageId,
                                            conversationId,
                                            role: "assistant",
                                            content: storedContent,
                                            status: "normal",
                                            modelId: requestedModelId,
                                        },
                                    });
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
                        try {
                            await recordProviderSuccess(modelConfig.provider);
                            await recordModelSuccess(requestedModelId);
                        } catch (error) {
                            logRequestError(
                                "provider_success_record_failed",
                                traceId,
                                error,
                                requestedModelId
                            );
                        }
                        controller.close();
                        await release();
                        return;
                    }
                    generatedText += value;
                    controller.enqueue(value);
                } catch (error) {
                    logRequestError(
                        "ai_stream_failed",
                        traceId,
                        error,
                        requestedModelId
                    );
                    try {
                        await recordProviderFailure(
                            modelConfig.provider,
                            "AI_STREAM_FAILED"
                        );
                        await recordModelFailure(
                            requestedModelId,
                            modelConfig.provider,
                            "AI_STREAM_FAILED"
                        );
                    } catch (recordError) {
                        logRequestError(
                            "provider_failure_record_failed",
                            traceId,
                            recordError,
                            requestedModelId
                        );
                    }
                    controller.enqueue(
                        `AI 응답 생성에 실패했습니다. 잠시 후 다시 시도하거나 다른 모델을 선택해주세요.\n추적 ID: ${traceId}`
                    );
                    controller.close();
                    await release();
                }
            },
            async cancel(reason) {
                await sourceReader.cancel(reason);
                await release();
            },
        });

        const headers = new Headers({
            "Content-Type": "text/plain; charset=utf-8",
            "Cache-Control": "no-cache, no-transform",
            "X-Request-ID": traceId,
        });
        if (accessGrant.setCookie) {
            headers.set("Set-Cookie", accessGrant.setCookie);
        }

        return new Response(protectedStream.pipeThrough(new TextEncoderStream()), {
            headers,
        });
    } catch (error: unknown) {
        if (leaseId) {
            await releaseChatAccess(leaseId);
        }
        const accessError = chatErrorResponse(error);
        if (accessError) {
            accessError.headers.set("X-Request-ID", traceId);
            return accessError;
        }

        logRequestError(
            "ai_request_failed",
            traceId,
            error,
            requestedModelIdForLog
        );
        try {
            await recordProviderFailure(
                requestedProviderForLog,
                error instanceof ChatAccessError
                    ? error.code
                    : safeErrorMetadata(error).code || "AI_REQUEST_FAILED"
            );
            await recordModelFailure(
                requestedModelIdForLog,
                requestedProviderForLog,
                error instanceof ChatAccessError
                    ? error.code
                    : safeErrorMetadata(error).code || "AI_REQUEST_FAILED"
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
            traceId
        );
    }
}
