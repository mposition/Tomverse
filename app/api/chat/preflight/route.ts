import { randomUUID } from "node:crypto";
import { getServerSession } from "next-auth/next";
import { z } from "zod";
import { authOptions } from "@/lib/auth";
import {
    databaseErrorMetadata,
    isRetryableDatabaseError,
} from "@/lib/databaseError";
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
    getChatSigningSecret,
    identifyChatCaller,
    preflightChatComparisonAccess,
} from "@/lib/chatSecurity";
import { issueChatContextBundle } from "@/lib/chatMemoryContext";
import {
    conversationLockedResponse,
    hasConversationUnlockGrant,
} from "@/lib/conversationLock";
import {
    effectivePlanModelLimit,
    getUserBillingPlan,
} from "@/lib/billingEntitlements";
import { getRuntimeModels } from "@/lib/modelRegistry";
import { conversationKindNotSupportedResponse, isChatConversationKind } from "@/lib/conversationKindGuard";
import { prisma } from "@/lib/prisma";
import { estimatePreflightAttachmentTokens } from "@/lib/chatAttachmentTokens";
import { isChatCostSafetyCode } from "@/lib/chatCostSafetyCore";
import { WEB_SEARCH_MODES } from "@/lib/appDefaults";
import { getWebSearchCapability } from "@/lib/webSearchCapability";
import { getWebSearchSurchargeCredits } from "@/lib/webSearchCredits";
import { estimatePromptTokens } from "@/lib/chatTokenEstimate";

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
        webSearchMode: z.enum(WEB_SEARCH_MODES).optional(),
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

const estimateTextTokens = (text: string) => estimatePromptTokens(text);

const comparisonTraceId = (request: Request) => {
    const suppliedTraceId = request.headers
        .get("X-Client-Request-ID")
        ?.trim();
    const parsedTraceId = z.string().uuid().safeParse(suppliedTraceId);
    return parsedTraceId.success ? parsedTraceId.data : randomUUID();
};

export async function POST(request: Request) {
    const traceId = comparisonTraceId(request);
    let modelIdsForLog: string[] = [];
    const inputTokensByModelForLog: Array<{
        modelId: string;
        inputTokens: number;
        attachmentTokens: number;
    }> = [];
    try {
        const session = await getServerSession(authOptions);
        // Guests reach this route too, and must: a three-model comparison is
        // three POST /api/chat requests for them exactly as it is for an
        // account, so its concurrency has to be admitted as a whole here or the
        // panels race each other for slots. What a guest does *not* get from
        // this route is a credit or plan verdict -- they have neither, and
        // every per-model check still runs on each /api/chat request.
        const guestAccess = session?.user?.id
            ? null
            : identifyChatCaller(request, null);

        await consumeApiRateLimit(
            request,
            session?.user?.id ?? guestAccess!.subjectKey,
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

        const billingPlan = session?.user?.id
            ? await getUserBillingPlan(session.user.id)
            : null;
        if (billingPlan) {
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
        }

        const access =
            guestAccess ??
            identifyChatCaller(
                request,
                session!.user!.id!,
                billingPlan!.tier,
                {
                    dailyMessageLimit: billingPlan!.dailyMessageLimit,
                    monthlyMessageLimit: billingPlan!.monthlyMessageLimit,
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
        // A guest's transcript lives in their browser, so there is no server
        // conversation to read history from -- and no ownership question to
        // answer. Signed-in callers keep the full check below unchanged.
        if (session?.user?.id && payload.conversationId !== "private-chat") {
            const conversation = await prisma.conversation.findUnique({
                where: { id: payload.conversationId },
                select: {
                    userId: true,
                    password: true,
                    selectedModels: true,
                    kind: true,
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
            // Image conversations never admit chat requests -- same gate as
            // the chat route itself (docs/policy/image-generation.md §1).
            if (!isChatConversationKind(conversation.kind)) {
                return conversationKindNotSupportedResponse();
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
            const attachmentTokens = estimatePreflightAttachmentTokens(
                model,
                payload.attachments
            );
            inputTokensByModelForLog.push({
                modelId: model.id,
                inputTokens: Math.max(
                    1,
                    historyTokens + promptTokens + attachmentTokens
                ),
                attachmentTokens,
            });
            const capability = getWebSearchCapability(model.id);
            return createChatBudget(
                access.kind,
                model,
                Math.max(1, historyTokens + promptTokens + attachmentTokens),
                {
                    webSearchSurchargeCredits: getWebSearchSurchargeCredits(
                        payload.webSearchMode ?? "off",
                        capability
                    ),
                    nativeSearchEnabled:
                        payload.webSearchMode === "always" &&
                        capability.support === "native",
                }
            );
        });
        modelIdsForLog = models.map((model) => model.id);
        const result = await preflightChatComparisonAccess(access, budgets, {
            traceId,
            comparisonId: payload.comparisonId,
            enabledTools:
                payload.webSearchMode === "always" ? ["web_search"] : [],
        });

        // The §10 bundle rides along with the admission token rather than
        // costing a second round trip. They are separate contracts and stay
        // separate: admission decides which concurrency slot each panel
        // occupies, the bundle decides which memory snapshot every panel was
        // quoted against, and neither substitutes for the other's check
        // (docs/policy/chat-concurrency-and-identity.md §3). One bundle for
        // the whole model set is the point — panels sharing a snapshot is
        // what makes their answers comparable.
        const contextBundle = await issueChatContextBundle({
            userId: session?.user?.id ?? null,
            subjectKey: access.subjectKey,
            conversationId:
                session?.user?.id && payload.conversationId !== "private-chat"
                    ? payload.conversationId
                    : null,
            modelIds: uniqueModelIds,
            query: payload.prompt,
            secret: getChatSigningSecret(),
        });

        const headers = new Headers({
            "Cache-Control": "no-store",
            "X-Request-ID": traceId,
        });
        // A first-time guest gets their signed cookie here rather than on the
        // first /api/chat request: the admission is bound to the guest subject
        // that cookie names, so the browser has to be holding it before the
        // model requests arrive.
        if (access.setCookie) headers.append("Set-Cookie", access.setCookie);

        return Response.json(
            {
                ok: true,
                comparisonId: payload.comparisonId,
                modelCount: result.modelCount,
                requiredCredits: result.requiredCredits,
                // Opaque to the client: it is signed, subject-bound and
                // short-lived, and it only decides which concurrency slot each
                // model request occupies.
                admissionToken: result.admission.token,
                admissionExpiresAt: result.admission.expiresAt,
                // Null when this turn carries no memory; the panels then send
                // no bundle and /api/chat reaches the same conclusion.
                contextBundle: contextBundle.token,
                contextBundleExpiresAt: contextBundle.expiresAt,
                memoryItemCount:
                    contextBundle.factualCount + contextBundle.styleCount,
            },
            { headers }
        );
    } catch (error) {
        const securityResponse = apiSecurityResponse(error);
        if (securityResponse) {
            securityResponse.headers.set("X-Request-ID", traceId);
            return securityResponse;
        }
        const accessResponse = chatErrorResponse(error);
        if (accessResponse) {
            if (
                error instanceof ChatAccessError &&
                isChatCostSafetyCode(error.code)
            ) {
                console.warn(
                    JSON.stringify({
                        event: "chat_cost_safety_rejected",
                        phase: "comparison_preflight",
                        traceId,
                        code: error.code,
                        status: error.status,
                        modelIds: modelIdsForLog,
                        inputTokensByModel: inputTokensByModelForLog,
                        ...(error.details || {}),
                        timestamp: new Date().toISOString(),
                    })
                );
            }
            if (
                error instanceof ChatAccessError &&
                (error.code === "MODEL_NOT_SELECTED" ||
                    error.code === "MODEL_NOT_AVAILABLE" ||
                    error.code === "MODEL_ACCESS_FORBIDDEN")
            ) {
                console.warn(
                    JSON.stringify({
                        event: "chat_comparison_preflight_denied",
                        traceId,
                        code: error.code,
                        status: error.status,
                        timestamp: new Date().toISOString(),
                    })
                );
            }
            accessResponse.headers.set("X-Request-ID", traceId);
            return accessResponse;
        }
        const databaseDiagnostic = databaseErrorMetadata(error);
        console.error(
            JSON.stringify({
                event: "chat_comparison_preflight_failed",
                traceId,
                ...databaseDiagnostic,
                timestamp: new Date().toISOString(),
            })
        );
        if (isRetryableDatabaseError(error)) {
            return Response.json(
                {
                    error: "The model comparison check is temporarily unavailable.",
                    code: "COMPARISON_PREFLIGHT_TEMPORARILY_UNAVAILABLE",
                    traceId,
                },
                {
                    status: 503,
                    headers: {
                        "Cache-Control": "no-store",
                        "Retry-After": "1",
                        "X-Request-ID": traceId,
                    },
                }
            );
        }
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
