import { streamText, type ModelMessage } from "ai";
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
    writeR2Object,
} from "@/lib/r2";
import { prisma } from "@/lib/prisma";
import { getEnabledModel, type AiModel } from "@/lib/models";
import { parseOfficeSafely } from "@/lib/officeSecurity";
import {
    acquireChatAccess,
    assertChatRequestSize,
    chatErrorResponse,
    identifyChatCaller,
    readChatJsonBody,
    releaseChatAccess,
    validateChatPayload,
} from "@/lib/chatSecurity";

const groq = createOpenAI({
    baseURL: "https://api.groq.com/openai/v1",
    apiKey: process.env.GROQ_API_KEY,
});

const deepseek = createOpenAI({
    baseURL: "https://api.deepseek.com",
    apiKey: process.env.DEEPSEEK_API_KEY,
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

const perplexity = createOpenAI({
    baseURL: "https://api.perplexity.ai",
    apiKey: process.env.PERPLEXITY_API_KEY,
});

const MAX_ATTACHMENTS = 5;
const MAX_ATTACHMENT_SIZE = 10 * 1024 * 1024;
const MAX_EXTRACTED_TEXT_LENGTH = 1_000_000;
const MAX_STORED_MESSAGE_CHARACTERS = 100_000;
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
    if (!session?.user?.email) {
        return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    try {
        const body = await req.json();
        if (body.action === "google-drive-import") {
            const fileId = typeof body.fileId === "string" ? body.fileId : "";
            const name = typeof body.name === "string" ? body.name : "";
            const sourceMediaType =
                typeof body.mediaType === "string" ? body.mediaType : "";
            const accessToken =
                typeof body.accessToken === "string" ? body.accessToken : "";
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

            const exportedFile = Buffer.from(await exportResponse.arrayBuffer());
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
            await writeR2Object(
                key,
                exportedFile,
                exportType.mediaType
            );

            return Response.json({
                key,
                name: exportedName,
                mediaType: exportType.mediaType,
                size: exportedFile.byteLength,
                kind: exportType.kind,
            });
        }

        const name = typeof body.name === "string" ? body.name : "";
        const mediaType =
            typeof body.mediaType === "string" ? body.mediaType : "";
        const size = Number(body.size);

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
        const uploadUrl = await createR2UploadUrl(key, mediaType);

        return Response.json({ key, uploadUrl });
    } catch (error) {
        console.error("R2 upload URL creation failed:", error);
        return Response.json(
            { error: "Failed to prepare attachment upload." },
            { status: 500 }
        );
    }
}

export async function DELETE(req: Request) {
    const session = await getServerSession(authOptions);
    if (!session?.user?.email) {
        return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    try {
        const body = await req.json();
        const key = typeof body.key === "string" ? body.key : "";
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
        case "xai":
            return xai.chat(model.apiModel);
        case "moonshot":
            return moonshot.chat(model.apiModel);
        case "qwen":
            return qwen.chat(model.apiModel);
        case "perplexity":
            return perplexity.chat(model.apiModel);
        case "zhipu":
            throw new Error(`Provider "${model.provider}" is not configured.`);
    }
};

export async function POST(req: Request) {
    const traceId = randomUUID();
    let leaseId: string | null = null;
    let requestedModelIdForLog: string | undefined;
    try {
        assertChatRequestSize(req);
        const session = await getServerSession(authOptions);
        const body = await readChatJsonBody(req);
        const {
            messages,
            modelId,
            conversationId,
            assistantMessageId,
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
        const access = identifyChatCaller(req, session?.user?.id);
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
                select: { userId: true },
            });
            if (!conversation || conversation.userId !== session.user.id) {
                return tracedJsonError(
                    "Conversation access denied.",
                    "CONVERSATION_FORBIDDEN",
                    403,
                    traceId
                );
            }
        }
        const accessGrant = await acquireChatAccess(access);
        leaseId = accessGrant.leaseId;
        const userObjectPrefix = session?.user?.email
            ? `attachments/${createHash("sha256")
                .update(session.user.email.toLowerCase())
                .digest("hex")
                .slice(0, 20)}/`
            : null;

        const activeModel = getActiveModel(modelConfig);

        const formattedMessages: ModelMessage[] = await Promise.all(messages.map(async (msg) => {
            if (msg.role === "assistant") {
                return { role: "assistant", content: String(msg.content ?? "") };
            }

            const attachments = (
                Array.isArray(msg.attachments) ? msg.attachments : []
            ) as IncomingAttachment[];
            if (attachments.length > MAX_ATTACHMENTS) {
                throw new Error("Too many attachments.");
            }

            const textAttachments: string[] = [];
            const fileParts: Array<{
                type: "file";
                data: string;
                mediaType: string;
                filename: string;
            }> = [];

            for (const attachment of attachments) {
                if (
                    !attachment ||
                    typeof attachment.name !== "string" ||
                    typeof attachment.mediaType !== "string" ||
                    !ALLOWED_ATTACHMENT_TYPES.has(attachment.mediaType)
                ) {
                    throw new Error("Unsupported attachment.");
                }

                let attachmentData: string;
                let attachmentBytes: number;
                let attachmentBuffer: Buffer | undefined;

                if (typeof attachment.objectKey === "string") {
                    if (
                        !userObjectPrefix ||
                        !attachment.objectKey.startsWith(userObjectPrefix)
                    ) {
                        throw new Error("Attachment access denied.");
                    }

                    attachmentBuffer = await readR2Object(attachment.objectKey);
                    attachmentBytes = attachmentBuffer.byteLength;
                    attachmentData =
                        attachment.kind === "text"
                            ? attachmentBuffer.toString("utf8")
                            : attachmentBuffer.toString("base64");
                } else if (typeof attachment.data === "string") {
                    attachmentData = attachment.data;
                    attachmentBytes =
                        attachment.kind === "text"
                            ? Buffer.byteLength(attachment.data, "utf8")
                            : Math.ceil((attachment.data.length * 3) / 4);
                } else {
                    throw new Error("Attachment data is missing.");
                }

                if (attachmentBytes > MAX_ATTACHMENT_SIZE) {
                    throw new Error("Attachment is too large.");
                }

                if (OFFICE_ATTACHMENT_TYPES.has(attachment.mediaType)) {
                    const officeBuffer =
                        attachmentBuffer || Buffer.from(attachmentData, "base64");
                    const extractedText = await parseOfficeSafely(
                        officeBuffer,
                        attachment.mediaType,
                        MAX_EXTRACTED_TEXT_LENGTH
                    );

                    if (!extractedText) {
                        throw new Error(`No readable text found in ${attachment.name}.`);
                    }

                    textAttachments.push(
                        `[Attached office file: ${attachment.name}]\n${extractedText}`
                    );
                } else if (attachment.kind === "text") {
                    textAttachments.push(
                        `[Attached file: ${attachment.name}]\n${attachmentData}`
                    );
                } else {
                    fileParts.push({
                        type: "file",
                        data: attachmentData,
                        mediaType: attachment.mediaType,
                        filename: attachment.name,
                    });
                }
            }

            if (textAttachments.length === 0 && fileParts.length === 0) {
                return { role: "user", content: String(msg.content ?? "") };
            }

            const text = [String(msg.content ?? ""), ...textAttachments]
                .filter(Boolean)
                .join("\n\n");

            return {
                role: "user",
                content: [
                    { type: "text", text: text || "Please analyze the attached file." },
                    ...fileParts,
                ],
            };
        }));

        const result = await streamText({
            model: activeModel,
            messages: formattedMessages,
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
                                await prisma.message.create({
                                    data: {
                                        id: assistantMessageId,
                                        conversationId,
                                        role: "assistant",
                                        content: storedContent,
                                        status: "normal",
                                        modelId: requestedModelId,
                                    },
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
                    controller.error(error);
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
    } catch (error: any) {
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

        return tracedJsonError(
            "AI 응답 생성에 실패했습니다.",
            "AI_PROVIDER_ERROR",
            500,
            traceId
        );
    }
}
