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
    rollbackChatAdmission,
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
import { conversationKindNotSupportedResponse, isChatConversationKind } from "@/lib/conversationKindGuard";
import { prisma } from "@/lib/prisma";
import { estimatePreflightAttachmentTokens } from "@/lib/chatAttachmentTokens";
import { buildChatTurnSystemBlocks } from "@/lib/chatTurnSystemBlocks";
import {
    isExternalContinuationEnabledCached,
    isImageGenerationEnabledCached,
} from "@/lib/appSettings";
import { loadContinuationTurnSeed } from "@/lib/externalContinuationService";
import { planAllowsImageGeneration } from "@/lib/imageGenerationAccess";
import { isChatCostSafetyCode } from "@/lib/chatCostSafetyCore";
import { WEB_SEARCH_MODES } from "@/lib/appDefaults";
import {
    getWebSearchCapability,
    nativeSearchIsDispatchable,
} from "@/lib/webSearchCapability";
import { getWebSearchSurchargeCredits } from "@/lib/webSearchCredits";
import { reserveTurnSearchCost } from "@/lib/webSearchNativeCostReservation";
import { appManagedSearchIsDispatchable } from "@/lib/webSearchCapability";
import { resolveWebSearchBackendReadiness } from "@/lib/webSearchBackendRuntime";
import { refreshSearchQueryCeilingBreaches } from "@/lib/webSearchCeilingBreachStore";
import {
    recordWebSearchCostRefusal,
    webSearchCostRefusalError,
} from "@/lib/webSearchCostRefusal";
import {
    atLeastOneToken,
    createTokenEstimateAccumulator,
} from "@/lib/chatTokenEstimate";
import { buildChatTurnContext } from "@/lib/chatTurnContext";
import { fitChatOutputToContextWindow } from "@/lib/chatContextWindow";
import { issueChatContextBundle } from "@/lib/chatContextBundleService";

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
    /**
     * Set once the aggregate admission has reserved this subject's slots.
     *
     * The concurrency policy (§3 step 4) requires the unclaimed slots back the
     * moment an approved comparison stops, by name: `rollbackChatAdmission()`.
     * Nothing called it. The admission TTL is the backstop, not the plan --
     * a preflight that reserves and then fails to answer leaves the client
     * retrying (§3 step 6 tells it to, once) into a subject whose slots are
     * still held, so the retry is refused for concurrency on a subject that is
     * running nothing at all.
     */
    let grantedAdmissionId: string | null = null;
    const inputTokensByModelForLog: Array<{
        modelId: string;
        inputTokens: number;
        attachmentTokens: number;
    }> = [];
    /** The comparison's models and caller, hoisted for the catch. */
    let refusalModelsForLog: Array<{ modelId: string; provider: string }> = [];
    let refusalSubjectForLog: {
        subjectKey: string;
        userId: string | null;
        plan: string | null;
    } | null = null;
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
        refusalSubjectForLog = {
            subjectKey: access.subjectKey,
            userId: access.userId ?? null,
            plan: access.kind === "guest" ? "Guest" : (access.plan ?? "Free"),
        };
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
        refusalModelsForLog = models.map((model) => ({
            modelId: model.id,
            provider: model.provider,
        }));

        let history: Array<{
            role: string;
            content: string;
            modelId: string | null;
        }> = [];
        // §8.1 invariant 1: null until the conversation row is read, which is
        // also the "no conversation" case — both inherit the account default.
        let conversationMemoryMode: string | null = null;
        // Policy: docs/policy/external-conversation-import-and-memory.md.
        // §10: the conversation's bound profile version, read here so the
        // priced context is the one the chat route will build.
        let profileVersionId: string | null = null;
        // Whether this turn could persist an assistant message, which is what
        // the artifact tool needs to attach a file to. The chat route reads
        // the assistant message id straight from its payload; preflight is one
        // step earlier and has the pair the client always sends with it -- a
        // signed-in caller and a real conversation row.
        let canPersistTurn = false;
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
                    memoryMode: true,
                    assistantProfileVersionId: true,
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
            conversationMemoryMode = conversation.memoryMode;
            profileVersionId = conversation.assistantProfileVersionId;
            canPersistTurn = true;
        }

        // §10: the priced context and the sent context must be the same one,
        // so the tokens the memory block contributes are part of every
        // model's input estimate here — the figure the credit reservation and
        // the context-window check are built on. A guest gets an empty
        // context and the arithmetic below is unchanged for them.
        const turnContext = await buildChatTurnContext({
            userId: session?.user?.id ?? null,
            query: payload.prompt,
            profileVersionId,
            plan: access.plan ?? null,
            // Priced under the same mode the chat route will send under. If
            // only one side read it, a conversation with memory off would be
            // charged for a memory block it never receives, or the reverse.
            conversationMode: conversationMemoryMode,
        });

        // The capability blocks the chat route will send, priced here so the
        // quote and the request are the same request. Both blocks used to be
        // absent from this estimate entirely, which made every comparison
        // quote lower than what the chat route then built
        // (`.github/audits/image-intent-auto-switch-2026-08-24.md` B-3).
        const imageGenerationFlagEnabled = await isImageGenerationEnabledCached();
        const planAllowsImages = Boolean(
            access.plan && planAllowsImageGeneration(access.plan)
        );

        /*
          The imported excerpt, priced here for exactly the reason the two
          capability blocks are: this route quotes the credits and the chat
          route sends the prompt, and a block counted on one side only is a
          quote that does not describe the request
          (docs/policy/external-conversation-continuation.md §5).

          A comparison of a bridged conversation is not a shape the product
          offers today -- a continuation is `productKey = "chat"` and this route
          takes two or three models -- so in practice this resolves to the empty
          string. It is wired anyway, because "the two routes price the same
          blocks" is the contract `buildChatTurnSystemBlocks` exists to keep,
          and an exception that is true today is how the drift it was written
          for came back.
        */
        let continuationSeed:
            | { rulesText: string; transcriptText: string }
            | undefined;
        if (session?.user?.id && payload.conversationId !== "private-chat") {
            try {
                if (await isExternalContinuationEnabledCached()) {
                    const { seed } = await loadContinuationTurnSeed({
                        userId: session.user.id,
                        conversationId: payload.conversationId,
                        request,
                    });
                    // The outcome is deliberately NOT recorded here. This route
                    // quotes a turn the chat route then sends, and counting
                    // both would double every figure in
                    // docs/policy/external-conversation-continuation.md §12 --
                    // with the comparison shape counting three times.
                    continuationSeed =
                        seed?.prompt.rulesText && seed.prompt.transcriptText
                            ? {
                                  rulesText: seed.prompt.rulesText,
                                  transcriptText: seed.prompt.transcriptText,
                              }
                            : undefined;
                }
            } catch {
                // Quote without it rather than refuse the preparation. The
                // chat route's own read fails the same way and sends the same
                // prompt, so the two stay in agreement.
                continuationSeed = undefined;
            }
        }

        // Bring the shared ceiling latch up to date before anything is
        // priced. A breach recorded by another instance, or by this one before
        // a restart, has to be visible here or the refusal it earned lasts
        // only as long as the process that saw it.
        await refreshSearchQueryCeilingBreaches();
        // Resolved once for the whole quote, from the same function the chat
        // route reads. A quote that answered "search-capable" differently from
        // the dispatch would admit a comparison the dispatch then refuses.
        const searchBackendReadiness = resolveWebSearchBackendReadiness();
        const budgets = models.map((model) => {
            // Per model, because history is filtered per model: a comparison
            // turn charges each model for the branch it can actually see.
            const estimate = createTokenEstimateAccumulator()
                .addText(payload.prompt)
                // Policy: docs/policy/external-conversation-import-and-memory.md.
                // The memory block's own text, not its token count -- counting
                // the text is what lets a Hangul recalibration reach it.
                // The whole §9.1 system block, not memory's share of it: a
                // profile's instructions and its knowledge excerpts are input
                // tokens too, and pricing one without the others reserves
                // against a prompt that is not the one being sent.
                .addText(turnContext.systemPrompt ?? "");
            // Same builder the chat route uses, so the artifact and image
            // capability blocks are counted identically on both sides. Per
            // model, because the artifact tool's availability is per model.
            // Derived exactly as the chat route derives them, in the same
            // order: `nativeSearchForced` is a narrowing of
            // `nativeSearchEnabled`, so computing it from the raw mode would
            // report a forced search on a model whose search is not native --
            // and the artifact tool is refused on precisely that combination.
            const modelSearchCapability = getWebSearchCapability(model.id);
            // `nativeSearchIsDispatchable`, exactly as the chat route derives
            // it: a native capability with no enforceable per-request cost
            // ceiling attaches no tool, so priced as though it did this quote
            // would count 6,400 tool-overhead tokens the request never sends.
            const modelNativeSearchEnabled =
                payload.webSearchMode === "always" &&
                nativeSearchIsDispatchable(modelSearchCapability);
            // The other route, derived from the same readiness map the chat
            // route resolves. Priced here for the same reason the native one
            // is: this turn carries a tool schema and feeds retrieved text back
            // into the prompt, and a quote that missed it would admit a
            // comparison against a smaller input reservation than the requests
            // it admits then send.
            const modelAppManagedSearchEnabled =
                payload.webSearchMode === "always" &&
                appManagedSearchIsDispatchable(
                    modelSearchCapability,
                    searchBackendReadiness
                );
            const turnSystemBlocks = buildChatTurnSystemBlocks({
                modelId: model.id,
                provider: model.provider,
                isDeepResearchTurn: model.usageClass === "deep-research",
                isAuthenticated: Boolean(session?.user?.id),
                canPersist: canPersistTurn,
                nativeSearchEnabled: modelNativeSearchEnabled,
                nativeSearchForced:
                    modelNativeSearchEnabled &&
                    modelSearchCapability.canForceExecution,
                appManagedSearchEnabled: modelAppManagedSearchEnabled,
                turnAttachments: payload.attachments.map((attachment, index) => ({
                    handle: `att_${index + 1}`,
                    name: "",
                    mediaType: attachment.mediaType,
                    byteSize: attachment.size,
                })),
                promptText: payload.prompt,
                imageGenerationFlagEnabled,
                planAllowsImageGeneration: planAllowsImages,
                continuationSeed,
            });
            estimate.addTokens(turnSystemBlocks.promptTokens);
            for (const message of history) {
                const belongsToModel =
                    message.role === "user"
                        ? !message.modelId || message.modelId === model.id
                        : message.role === "assistant" && message.modelId === model.id;
                if (belongsToModel) estimate.addText(message.content);
            }
            const attachmentTokens = estimatePreflightAttachmentTokens(
                model,
                payload.attachments
            );
            // Attachment cost is a per-model estimate, not text.
            estimate.addTokens(attachmentTokens);
            const breakdown = atLeastOneToken(estimate.breakdown());
            inputTokensByModelForLog.push({
                modelId: model.id,
                inputTokens: breakdown.rawTotal,
                attachmentTokens,
            });
            // The provider cost the chat route will reserve for this model's
            // search, reserved here too. Without it this quote covered the
            // token half of a searching turn and none of the per-query half,
            // so a comparison was admitted against a smaller provider cost
            // than the requests it admits then spend -- and the guardrail this
            // route exists to check ahead of time was checked against the
            // wrong number.
            const nativeSearchReservation = reserveTurnSearchCost({
                model,
                capability: modelSearchCapability,
                nativeSearchEnabled: modelNativeSearchEnabled,
                appManagedSearchEnabled: modelAppManagedSearchEnabled,
            });
            if (!nativeSearchReservation.ok) {
                // The same refusal the chat route raises, for the same reason
                // and with the same code: a quote that said yes to a request
                // the dispatch will refuse is the defect, not the refusal.
                throw webSearchCostRefusalError(
                    nativeSearchReservation.reason
                );
            }
            return createChatBudget(
                access.kind,
                model,
                breakdown,
                {
                    webSearchSurchargeCredits: getWebSearchSurchargeCredits(
                        payload.webSearchMode ?? "off",
                        modelSearchCapability,
                        searchBackendReadiness
                    ),
                    nativeSearchEnabled: modelNativeSearchEnabled,
                    appManagedSearchEnabled: modelAppManagedSearchEnabled,
                    nativeSearch: nativeSearchReservation.native,
                    searchBackend: nativeSearchReservation.searchBackend,
                }
            );
        });
        modelIdsForLog = models.map((model) => model.id);

        // The same context check the chat route applies, on the same shared
        // rule, and applied here for the reason §10 gives for sharing a
        // context builder at all: preflight prices what chat sends. Without
        // it, preflight quoted credits and reserved a concurrency slot for a
        // model the chat route was always going to refuse -- and on a
        // comparison that is the partial execution the aggregate admission
        // exists to prevent, arrived at after admission rather than before it.
        //
        // A whole-request refusal, matching every other per-model check above
        // (MODEL_NOT_AVAILABLE, MODEL_NOT_SELECTED, MODEL_ACCESS_FORBIDDEN):
        // admitting the subset that fits is exactly what all-or-nothing
        // forbids. Thrown before preflightChatComparisonAccess, so a refused
        // comparison reserves nothing.
        models.forEach((model, index) => {
            const budget = budgets[index];
            const outputBudget = fitChatOutputToContextWindow({
                contextWindowTokens: model.contextWindowTokens,
                reservedInputTokens: budget.inputTokens,
                requestOutputCapTokens: budget.maxOutputTokens,
                providerMaxOutputTokens: budget.providerMaxOutputTokens,
            });
            if (outputBudget.kind === "exceeded") {
                throw new ChatAccessError(
                    400,
                    "MODEL_CONTEXT_WINDOW_EXCEEDED",
                    `${model.name} holds ${outputBudget.limitTokens.toLocaleString("en-US")} tokens of conversation and answer together, and this conversation already fills it. Start a new conversation or shorten the attachments.`
                );
            }
        });
        const result = await preflightChatComparisonAccess(access, budgets, {
            traceId,
            comparisonId: payload.comparisonId,
            enabledTools:
                payload.webSearchMode === "always" ? ["web_search"] : [],
        });
        // From here the subject's slots are held. Anything that throws below
        // means the client never receives the token that would claim them, so
        // the catch gives them back rather than leaving the allowance spent on
        // a comparison that was never admitted to the client.
        grantedAdmissionId = result.admission.admissionId;

        const headers = new Headers({
            "Cache-Control": "no-store",
            "X-Request-ID": traceId,
        });
        // A first-time guest gets their signed cookie here rather than on the
        // first /api/chat request: the admission is bound to the guest subject
        // that cookie names, so the browser has to be holding it before the
        // model requests arrive.
        if (access.setCookie) headers.append("Set-Cookie", access.setCookie);

        // One bundle for the whole comparison, carrying every model in the
        // set: the panels are supposed to see one snapshot, and consumption
        // is per (bundle, model) so each still spends its own (§10).
        const contextBundle =
            session?.user?.id &&
            (turnContext.memory.decision.allowed ||
                turnContext.profileTokens > 0)
                ? issueChatContextBundle({
                      subjectKey: session.user.id,
                      conversationId:
                          payload.conversationId === "private-chat"
                              ? null
                              : payload.conversationId,
                      modelIds: uniqueModelIds,
                      context: turnContext,
                  })
                : null;

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
                // A second opaque token with a different job entirely: this
                // one attests which context snapshot was priced. Neither
                // stands in for the other, and they are signed under
                // different domains so neither can (§10).
                contextBundle: contextBundle?.token ?? null,
                contextBundleExpiresAt: contextBundle?.expiresAt ?? null,
                memoryUsedCount: contextBundle?.memoryUsedCount ?? 0,
            },
            { headers }
        );
    } catch (error) {
        // Best-effort and never rethrown: this runs while another failure is
        // already being reported, and turning a 500 into a different 500
        // would only lose the original reason.
        if (grantedAdmissionId) {
            await rollbackChatAdmission(grantedAdmissionId, { traceId }).catch(
                () => undefined
            );
        }
        const securityResponse = apiSecurityResponse(error);
        if (securityResponse) {
            securityResponse.headers.set("X-Request-ID", traceId);
            return securityResponse;
        }
        const accessResponse = chatErrorResponse(error);
        if (accessResponse) {
            // Raised inside the synchronous budgets map, so it is recorded
            // here rather than at the throw. Every model in the comparison is
            // named: an all-or-nothing preflight refused the whole set, and a
            // row naming only the one that tripped would misdescribe what was
            // blocked.
            await recordWebSearchCostRefusal(error, {
                traceId,
                phase: "comparison_preflight",
                subjectKey: refusalSubjectForLog?.subjectKey ?? null,
                userId: refusalSubjectForLog?.userId ?? null,
                plan: refusalSubjectForLog?.plan ?? null,
                models: refusalModelsForLog,
            });
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
                    error.code === "MODEL_ACCESS_FORBIDDEN" ||
                    error.code === "MODEL_CONTEXT_WINDOW_EXCEEDED")
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
