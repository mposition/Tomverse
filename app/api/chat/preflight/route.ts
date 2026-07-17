import { randomUUID } from "node:crypto";
import { getServerSession } from "next-auth/next";
import { z } from "zod";
import { authOptions } from "@/lib/auth";
import {
    apiSecurityResponse,
    consumeApiRateLimit,
    readLimitedJson,
} from "@/lib/apiSecurity";
import {
    assertModelAccess,
    ChatAccessError,
    chatErrorResponse,
    createChatBudget,
    identifyChatCaller,
    preflightChatComparisonAccess,
} from "@/lib/chatSecurity";
import {
    conversationLockedResponse,
    hasConversationUnlockGrant,
} from "@/lib/conversationLock";
import {
    effectivePlanModelLimit,
    getUserBillingPlan,
} from "@/lib/billingEntitlements";
import { getRuntimeModels } from "@/lib/modelRegistry";
import { prisma } from "@/lib/prisma";

const preflightSchema = z
    .object({
        comparisonId: z.string().regex(/^\d{10,20}$/),
        conversationId: z.string().min(1).max(64),
        modelIds: z.array(z.string().min(1).max(100)).min(2).max(3),
        prompt: z.string().max(50_000),
        attachments: z
            .array(
                z
                    .object({
                        mediaType: z.string().min(1).max(160),
                        size: z.number().int().min(0).max(10 * 1024 * 1024),
                    })
                    .strict()
            )
            .max(5),
    })
    .strict();

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

const estimateTextTokens = (text: string) =>
    text ? Math.max(1, Math.ceil(Buffer.byteLength(text, "utf8") / 4)) : 0;

export async function POST(request: Request) {
    const traceId = randomUUID();
    try {
        const session = await getServerSession(authOptions);
        if (!session?.user?.id) {
            return Response.json(
                {
                    error: "Sign in before comparing multiple models.",
                    code: "COMPARISON_AUTHENTICATION_REQUIRED",
                    traceId,
                },
                { status: 401, headers: { "X-Request-ID": traceId } }
            );
        }

        await consumeApiRateLimit(
            request,
            session.user.id,
            "chat-comparison-preflight",
            { minute: 30, day: 1_000 }
        );
        const payload = await readLimitedJson(
            request,
            64 * 1024,
            preflightSchema
        );
        const uniqueModelIds = Array.from(new Set(payload.modelIds));
        if (uniqueModelIds.length !== payload.modelIds.length) {
            return Response.json(
                {
                    error: "Comparison models must be unique.",
                    code: "DUPLICATE_COMPARISON_MODELS",
                    traceId,
                },
                { status: 400, headers: { "X-Request-ID": traceId } }
            );
        }

        const billingPlan = await getUserBillingPlan(session.user.id);
        const maxModels = effectivePlanModelLimit(billingPlan);
        if (uniqueModelIds.length > maxModels) {
            return Response.json(
                {
                    error: `Your plan allows up to ${maxModels} models per comparison.`,
                    code: "PLAN_MODEL_LIMIT_EXCEEDED",
                    traceId,
                },
                { status: 403, headers: { "X-Request-ID": traceId } }
            );
        }

        const access = identifyChatCaller(
            request,
            session.user.id,
            billingPlan.tier,
            {
                dailyMessageLimit: billingPlan.dailyMessageLimit,
                monthlyMessageLimit: billingPlan.monthlyMessageLimit,
            }
        );
        const runtimeModels = await getRuntimeModels();
        const runtimeModelMap = new Map(runtimeModels.map((model) => [model.id, model]));
        const models = uniqueModelIds.map((modelId) => {
            const candidate = runtimeModelMap.get(modelId);
            const model = candidate?.enabled && !candidate.catalogDeleted ? candidate : undefined;
            if (!model) {
                throw new ChatAccessError(
                    400,
                    "MODEL_NOT_AVAILABLE",
                    "One or more selected models are unavailable."
                );
            }
            assertModelAccess(access, model);
            return model;
        });

        let history: Array<{
            role: string;
            content: string;
            modelId: string | null;
        }> = [];
        if (payload.conversationId !== "private-chat") {
            const conversation = await prisma.conversation.findUnique({
                where: { id: payload.conversationId },
                select: {
                    userId: true,
                    password: true,
                    selectedModels: true,
                    messages: {
                        orderBy: { createdAt: "desc" },
                        take: 100,
                        select: {
                            role: true,
                            content: true,
                            modelId: true,
                        },
                    },
                },
            });
            if (!conversation || conversation.userId !== session.user.id) {
                return Response.json(
                    {
                        error: "Conversation access denied.",
                        code: "CONVERSATION_FORBIDDEN",
                        traceId,
                    },
                    { status: 403, headers: { "X-Request-ID": traceId } }
                );
            }
            if (
                !hasConversationUnlockGrant(
                    request,
                    session.user.id,
                    payload.conversationId,
                    conversation.password
                )
            ) {
                return conversationLockedResponse();
            }
            const selectedModels = new Set(
                parseStoredModelIds(conversation.selectedModels)
            );
            if (uniqueModelIds.some((modelId) => !selectedModels.has(modelId))) {
                return Response.json(
                    {
                        error: "One or more comparison models are not selected for this conversation.",
                        code: "MODEL_NOT_SELECTED",
                        traceId,
                    },
                    { status: 403, headers: { "X-Request-ID": traceId } }
                );
            }
            history = conversation.messages.reverse();
        }

        const imageCount = payload.attachments.filter((attachment) =>
            attachment.mediaType.startsWith("image/")
        ).length;
        const nonImageBytes = payload.attachments
            .filter((attachment) => !attachment.mediaType.startsWith("image/"))
            .reduce((sum, attachment) => sum + attachment.size, 0);
        const attachmentTokens =
            imageCount * 16_000 +
            Math.min(75_000, Math.ceil(nonImageBytes / 4));
        const promptTokens = estimateTextTokens(payload.prompt);
        const budgets = models.map((model) => {
            const historyTokens = history.reduce((sum, message) => {
                const belongsToModel =
                    message.role === "user"
                        ? !message.modelId || message.modelId === model.id
                        : message.role === "assistant" && message.modelId === model.id;
                return belongsToModel
                    ? sum + estimateTextTokens(message.content)
                    : sum;
            }, 0);
            return createChatBudget(
                access.kind,
                model,
                Math.max(1, historyTokens + promptTokens + attachmentTokens)
            );
        });
        const result = await preflightChatComparisonAccess(access, budgets);

        return Response.json(
            {
                ok: true,
                comparisonId: payload.comparisonId,
                modelCount: result.modelCount,
                requiredCredits: result.requiredCredits,
            },
            { headers: { "Cache-Control": "no-store", "X-Request-ID": traceId } }
        );
    } catch (error) {
        const securityResponse = apiSecurityResponse(error);
        if (securityResponse) {
            securityResponse.headers.set("X-Request-ID", traceId);
            return securityResponse;
        }
        const accessResponse = chatErrorResponse(error);
        if (accessResponse) {
            accessResponse.headers.set("X-Request-ID", traceId);
            return accessResponse;
        }
        console.error("Chat comparison preflight failed", { traceId, error });
        return Response.json(
            {
                error: "The model comparison could not be checked before sending.",
                code: "COMPARISON_PREFLIGHT_FAILED",
                traceId,
            },
            { status: 500, headers: { "X-Request-ID": traceId } }
        );
    }
}
