import { streamText, type ModelMessage } from "ai";
import { openai, createOpenAI } from "@ai-sdk/openai";
import { anthropic } from "@ai-sdk/anthropic";
import { google } from "@ai-sdk/google";
import { APP_DEFAULTS } from "@/lib/appDefaults";
import { createHash, randomUUID } from "node:crypto";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { createR2UploadUrl, deleteR2Object, readR2Object } from "@/lib/r2";

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
const ALLOWED_ATTACHMENT_TYPES = new Set([
    "image/png",
    "image/jpeg",
    "image/webp",
    "application/pdf",
    "text/plain",
    "text/markdown",
    "text/csv",
    "application/json",
]);

const sanitizeFilename = (filename: string) => {
    const safe = filename
        .normalize("NFKC")
        .replace(/[^\p{L}\p{N}._-]+/gu, "-")
        .replace(/^-+|-+$/g, "")
        .slice(-120);

    return safe || "attachment";
};

export async function PUT(req: Request) {
    const session = await getServerSession(authOptions);
    if (!session?.user?.email) {
        return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    try {
        const body = await req.json();
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

        const userHash = createHash("sha256")
            .update(session.user.email.toLowerCase())
            .digest("hex")
            .slice(0, 20);
        const date = new Date().toISOString().slice(0, 10);
        const key = `attachments/${userHash}/${date}/${randomUUID()}-${sanitizeFilename(name)}`;
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

const getActiveModel = (modelId: string) => {
    switch (modelId) {
        case "gpt-4o-mini":
            return openai("gpt-4o-mini");
        case "gpt-4.1":
            return openai("gpt-4.1");
        case "gpt-4o":
            return openai("gpt-4o");

        case "claude-sonnet-4-5":
            return anthropic("claude-sonnet-4-5-20250929");
        case "claude-haiku-4-5":
            return anthropic("claude-haiku-4-5-20251001");

        case "gemini-1-5-pro":
            return google("gemini-1.5-pro");
        case "gemini-1-5-flash":
        case "gemini-1-5":
            return google("gemini-1.5-flash");

        case "llama-3-1":
            return groq.chat("llama-3.1-8b-instant");

        case "llama-3-3":
            return groq.chat("llama-3.3-70b-versatile");

        case "deepseek-v4-flash":
            return deepseek.chat("deepseek-v4-flash");

        case "deepseek-v4-pro":
            return deepseek.chat("deepseek-v4-pro");

        case "grok-4":
            return xai.chat("grok-4");

        case "grok-3":
            return xai.chat("grok-3");

        case "grok-3-mini":
            return xai.chat("grok-3");

        case "kimi-k2.7-code":
            return moonshot.chat("kimi-k2.7-code");

        case "qwen3.7-max":
            return qwen.chat("qwen3.7-max");

        case "qwen3.7-plus":
            return qwen.chat("qwen3.7-plus");

        case "qwen3.6-flash":
            return qwen.chat("qwen3.6-flash");

        case "glm-5.2":
            return qwen.chat("glm-5.2");

        case "perplexity/sonar":
            return perplexity.chat("sonar");

        default:
            return openai("gpt-4o");
    }
};

export async function POST(req: Request) {
    try {
        const body = await req.json();
        const { messages, modelId } = body;
        const session = await getServerSession(authOptions);
        const userObjectPrefix = session?.user?.email
            ? `attachments/${createHash("sha256")
                .update(session.user.email.toLowerCase())
                .digest("hex")
                .slice(0, 20)}/`
            : null;

        if (modelId === "llama-3-3-70b" && !process.env.GROQ_API_KEY) {
            return new Response(
                JSON.stringify({ error: "GROQ_API_KEY가 설정되어 있지 않습니다." }),
                { status: 500, headers: { "Content-Type": "application/json" } }
            );
        }

        const activeModel = getActiveModel(modelId || APP_DEFAULTS.defaultModelId);

        const formattedMessages: ModelMessage[] = await Promise.all(messages.map(async (msg: any) => {
            if (msg.role === "assistant") {
                return { role: "assistant", content: String(msg.content ?? "") };
            }

            const attachments = Array.isArray(msg.attachments) ? msg.attachments : [];
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

                if (typeof attachment.objectKey === "string") {
                    if (
                        !userObjectPrefix ||
                        !attachment.objectKey.startsWith(userObjectPrefix)
                    ) {
                        throw new Error("Attachment access denied.");
                    }

                    const object = await readR2Object(attachment.objectKey);
                    attachmentBytes = object.byteLength;
                    attachmentData =
                        attachment.kind === "text"
                            ? object.toString("utf8")
                            : object.toString("base64");
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

                if (attachment.kind === "text") {
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

        return new Response(result.textStream, {
            headers: {
                "Content-Type": "text/plain; charset=utf-8",
                "Connection": "keep-alive",
                "Cache-Control": "no-cache, no-transform",
            },
        });
    } catch (error: any) {
        console.error("AI SDK API request failed:");
        console.error(error?.message || error);

        return new Response(
            JSON.stringify({ error: "AI 응답 생성 실패", details: error?.message }),
            { status: 500, headers: { "Content-Type": "application/json" } }
        );
    }
}
