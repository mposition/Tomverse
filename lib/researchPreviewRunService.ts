import "server-only";

import type { Prisma } from "@prisma/client";
import { getUserBillingPlan } from "@/lib/billingEntitlements";
import {
  acquireChatAccess,
  acquireReservedChatAccess,
  assertUserOperationalAccess,
  extendChatReservationExpiry,
  heartbeatChatAccess,
  identifyChatCaller,
  readOpenChatUsageReservation,
  readChatUsageReservationForSettlement,
  releaseChatAccess,
  settleChatUsage,
  type ChatUsageReservation,
} from "@/lib/chatSecurity";
import { hasConversationUnlockGrant } from "@/lib/conversationLock";
import { getOperationalFeatureFlags } from "@/lib/appSettings";
import { getRuntimeModels } from "@/lib/modelRegistry";
import { resolveModelPricing } from "@/lib/modelPricing";
import { prisma } from "@/lib/prisma";
import {
  decideResearchPreviewAdmission,
  researchPreviewGate,
  RESEARCH_PREVIEW_MAX_STEPS,
} from "@/lib/researchPreviewAdmission";
import { createResearchPreviewBudget } from "@/lib/researchPreviewBudget";
import {
  ResearchPreviewBudgetExhaustedError,
  ResearchPreviewRunStoppedError,
  ResearchPreviewUsageUnknownError,
} from "@/lib/researchPreviewExecution";
import { researchPreviewFeatures } from "@/lib/researchPreviewFeatures";
import { getResearchPreviewAiModel } from "@/lib/researchPreviewModel";
import { buildResearchPreviewMetadata } from "@/lib/researchPreviewMetadata";
import {
  researchPreviewInputEstimate,
  researchPreviewLocale,
} from "@/lib/researchPreviewPrompt";
import {
  parseResearchPreviewCheckpoint,
  runResearchPreviewStep,
  type ResearchPreviewCheckpoint,
} from "@/lib/researchPreviewStep";
import {
  RESEARCH_PREVIEW_RUN_ACTIVE_LIMIT_MS,
  activateResearchPreviewRun,
  beginResearchPreviewGeneration,
  checkpointResearchPreviewRun,
  claimNextResearchPreviewRun,
  completeResearchPreviewGeneration,
  createPreparingResearchPreviewRun,
  failPreparingResearchPreviewRun,
  expireResearchPreviewCheckpoints,
  finishResearchPreviewRunWithoutReport,
  heartbeatResearchPreviewRun,
  listResearchPreviewRunDtos,
  markResearchPreviewDispatchStarted,
  markResearchPreviewRunSettled,
  parseResearchPreviewSettlementUsage,
  readEligibleResearchPreviewSource,
  requestResearchPreviewCancellation,
  readResearchPreviewRunDto,
  readResearchPreviewRunForWorker,
  recoverStalePreparingResearchPreviewRun,
  recoverStaleResearchPreviewRun,
  releaseResearchPreviewClaimToQueue,
  resumeResearchPreviewRun,
  researchPreviewQuestionDigest,
  researchPreviewRunsAwaitingSettlement,
  researchPreviewWorkerId,
  staleResearchPreviewRuns,
  stalePreparingResearchPreviewRuns,
  type ResearchPreviewSettlementUsage,
} from "@/lib/researchPreviewRunStore";
import type { ResearchPreviewRunCreateInput } from "@/lib/researchPreviewRunTypes";
import { getWebSearchCapability } from "@/lib/webSearchCapability";
import { getWebSearchSurchargeCredits } from "@/lib/webSearchCredits";
import { normalizeWebSearchExecution } from "@/lib/webSearchExecutionNormalizer";
import { resolveWebSearchBackendReadiness } from "@/lib/webSearchBackendRuntime";
import { refreshSearchQueryCeilingBreaches } from "@/lib/webSearchCeilingBreachStore";
import { reserveTurnSearchCost } from "@/lib/webSearchNativeCostReservation";
import { APP_MANAGED_WEB_SEARCH_TOOL_NAME } from "@/lib/appManagedWebSearchTool";

const storedModelIds = (value: unknown): string[] => {
  let parsed = value;
  for (let index = 0; index < 2 && typeof parsed === "string"; index += 1) {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return [];
    }
  }
  return Array.isArray(parsed)
    ? parsed.filter((entry): entry is string => typeof entry === "string")
    : [];
};

const profileToolPolicy = async (
  userId: string,
  assistantProfileVersionId: string | null
) => {
  if (!assistantProfileVersionId) return null;
  const version = await prisma.assistantProfileVersion.findFirst({
    where: { id: assistantProfileVersionId, userId },
    select: { toolPolicy: true },
  });
  const policy = version?.toolPolicy as Record<string, unknown> | undefined;
  return {
    webSearch: policy?.webSearch === true,
    deepResearch: policy?.deepResearch === true,
  };
};

export async function createDurableResearchPreviewRun(input: {
  request: Request;
  userId: string;
  payload: ResearchPreviewRunCreateInput;
}) {
  if (!researchPreviewFeatures().durableRuns) {
    throw new Error("RESEARCH_PREVIEW_DURABLE_DISABLED");
  }
  await assertUserOperationalAccess(input.userId);

  const existing = await prisma.researchPreviewRun.findFirst({
    where: {
      userId: input.userId,
      assistantMessageId: input.payload.assistantMessageId,
    },
    select: {
      id: true,
      conversationId: true,
      sourceUserMessageId: true,
      modelId: true,
    },
  });
  if (existing) {
    if (
      existing.conversationId !== input.payload.conversationId ||
      existing.sourceUserMessageId !== input.payload.sourceUserMessageId ||
      existing.modelId !== input.payload.modelId
    ) {
      throw new Error("RESEARCH_RUN_ID_REUSED");
    }
    const dto = await readResearchPreviewRunDto(input.userId, existing.id);
    if (!dto) throw new Error("RESEARCH_RUN_READ_FAILED");
    return { created: false as const, run: dto };
  }
  if (
    await prisma.message.findUnique({
      where: { id: input.payload.assistantMessageId },
      select: { id: true },
    })
  ) {
    throw new Error("RESEARCH_RUN_ID_REUSED");
  }

  const [conversation, sourceMessage, plan, models, flags] =
    await Promise.all([
      prisma.conversation.findFirst({
        where: { id: input.payload.conversationId, userId: input.userId },
        select: {
          id: true,
          password: true,
          kind: true,
          productKey: true,
          selectionMode: true,
          selectedModels: true,
          assistantProfileVersionId: true,
        },
      }),
      readEligibleResearchPreviewSource({
        userId: input.userId,
        conversationId: input.payload.conversationId,
        sourceUserMessageId: input.payload.sourceUserMessageId,
      }),
      getUserBillingPlan(input.userId),
      getRuntimeModels({ includeCatalogDeleted: true }),
      getOperationalFeatureFlags(),
    ]);
  const model =
    models.find((candidate) => candidate.id === input.payload.modelId) ?? null;
  const question = sourceMessage?.question ?? "";
  if (!conversation || !sourceMessage) {
    throw new Error("RESEARCH_SOURCE_UNAVAILABLE");
  }
  const profileTools = await profileToolPolicy(
    input.userId,
    conversation.assistantProfileVersionId
  );
  await refreshSearchQueryCeilingBreaches();
  const backendReadiness = resolveWebSearchBackendReadiness();
  const admission = decideResearchPreviewAdmission({
    signedIn: true,
    plan: plan.tier,
    conversationAvailable: true,
    conversationLocked: !hasConversationUnlockGrant(
      input.request,
      input.userId,
      conversation.id,
      conversation.password
    ),
    productKey: conversation.productKey,
    kind: conversation.kind,
    selectionMode: conversation.selectionMode,
    selectedModelIds: storedModelIds(conversation.selectedModels),
    model,
    backendReadiness,
    profileTools,
    gateEnabled: flags.aiChatEnabled && Boolean(model && researchPreviewGate(model)),
    modelOutputTokenCap: model ? resolveModelPricing(model).maxOutputTokens : 0,
  });
  if (!admission.offered || !admission.limits || !model) {
    throw new Error(`RESEARCH_PREVIEW_UNAVAILABLE:${admission.reason}`);
  }

  const locale = researchPreviewLocale(input.payload.locale ?? input.request.headers.get("accept-language"));
  const currentDate = new Date().toISOString().slice(0, 10);
  const pageReadingEnabled = researchPreviewFeatures().pageReading;
  const capability = getWebSearchCapability(model);
  const searchReservation = reserveTurnSearchCost({
    model,
    capability,
    appManagedSearchEnabled: true,
    nativeSearchEnabled: false,
  });
  if (!searchReservation.ok) throw new Error("RESEARCH_SEARCH_UNAVAILABLE");
  const searchSurchargeCredits = getWebSearchSurchargeCredits(
    "always",
    capability,
    backendReadiness
  );
  const budget = createResearchPreviewBudget({
    accessKind: "user",
    model,
    input: researchPreviewInputEstimate({
      question,
      locale,
      currentDate,
      pageReadingEnabled,
    }),
    webSearchSurchargeCredits: searchSurchargeCredits,
    searchReservation,
    pageReadingEnabled,
  });
  if (!budget.contextInputTokens) {
    throw new Error("RESEARCH_INPUT_CEILING_MISSING");
  }
  const preparing = await createPreparingResearchPreviewRun({
    userId: input.userId,
    conversationId: conversation.id,
    sourceUserMessageId: sourceMessage.id,
    assistantMessageId: input.payload.assistantMessageId,
    modelId: model.id,
    provider: model.provider,
    apiModel: model.apiModel,
    locale,
    currentDate,
    questionDigest: researchPreviewQuestionDigest(question),
    pageReadingEnabled,
    totalOutputTokens: admission.limits.totalOutputTokens,
    inputTokenCeiling: budget.contextInputTokens,
    searchSurchargeCredits,
  });
  if (!preparing.created) {
    const dto = await readResearchPreviewRunDto(input.userId, preparing.run.id);
    if (!dto) throw new Error("RESEARCH_RUN_READ_FAILED");
    return { created: false as const, run: dto };
  }

  const access = identifyChatCaller(input.request, input.userId, plan.tier, {
    dailyMessageLimit: plan.dailyMessageLimit,
    monthlyMessageLimit: plan.monthlyMessageLimit,
  });
  let leaseId: string | null = null;
  let reservation: ChatUsageReservation | null = null;
  try {
    const acquired = await acquireChatAccess(access, budget, {
      source: "chat",
      traceId: preparing.run.id,
      enabledTools: [
        "web_search",
        ...(pageReadingEnabled ? ["read_research_sources"] : []),
        "submit_research_report",
      ],
    });
    leaseId = acquired.leaseId;
    reservation = acquired.usageReservation;
    await extendChatReservationExpiry(
      reservation.reservationId,
      RESEARCH_PREVIEW_RUN_ACTIVE_LIMIT_MS / 1_000 + 24 * 60 * 60
    );
    await activateResearchPreviewRun({
      runId: preparing.run.id,
      userId: input.userId,
      reservationId: reservation.reservationId,
    });
  } catch (error) {
    if (reservation) {
      await settleChatUsage(reservation, {
        inputTokens: 0,
        outputTokens: 0,
        outcome: "failed",
        searchSurchargeCredits,
        searchExecuted: false,
        searchBackendRequestCount: 0,
        searchQueriesObserved: true,
      }).catch(() => undefined);
    }
    await failPreparingResearchPreviewRun(
      preparing.run.id,
      "dispatch_refused",
      "RESEARCH_RESERVATION_FAILED"
    );
    throw error;
  } finally {
    if (leaseId) {
      await releaseChatAccess(leaseId, {
        traceId: preparing.run.id,
        reason: "research_run_queued",
        subjectScope: access.subjectKey,
      });
    }
  }
  const dto = await readResearchPreviewRunDto(input.userId, preparing.run.id);
  if (!dto) throw new Error("RESEARCH_RUN_READ_FAILED");
  return { created: true as const, run: dto };
}

type WorkerPolicy = {
  question: string;
  model: NonNullable<Awaited<ReturnType<typeof getRuntimeModels>>[number]>;
  backendReadiness: ReturnType<typeof resolveWebSearchBackendReadiness>;
};

async function currentWorkerPolicy(
  run: NonNullable<Awaited<ReturnType<typeof readResearchPreviewRunForWorker>>>
): Promise<WorkerPolicy> {
  if (!researchPreviewFeatures().durableRuns) throw new Error("RESEARCH_PREVIEW_DURABLE_DISABLED");
  await assertUserOperationalAccess(run.userId);
  const [conversation, source, plan, models, flags] = await Promise.all([
    prisma.conversation.findFirst({
      where: { id: run.conversationId, userId: run.userId },
      select: {
        kind: true,
        productKey: true,
        selectionMode: true,
        selectedModels: true,
        assistantProfileVersionId: true,
      },
    }),
    prisma.message.findFirst({
      where: {
        id: run.sourceUserMessageId,
        conversationId: run.conversationId,
        role: "user",
        conversation: { userId: run.userId },
      },
      select: {
        content: true,
        attachments: { select: { id: true }, take: 1 },
      },
    }),
    getUserBillingPlan(run.userId),
    getRuntimeModels({ includeCatalogDeleted: true }),
    getOperationalFeatureFlags(),
  ]);
  const model = models.find((candidate) => candidate.id === run.modelId) ?? null;
  const question = source?.content.trim() ?? "";
  const profileTools = await profileToolPolicy(
    run.userId,
    conversation?.assistantProfileVersionId ?? null
  );
  await refreshSearchQueryCeilingBreaches();
  const backendReadiness = resolveWebSearchBackendReadiness();
  const decision = decideResearchPreviewAdmission({
    signedIn: true,
    plan: plan.tier,
    conversationAvailable: Boolean(
      conversation && source && source.attachments.length === 0
    ),
    conversationLocked: false,
    productKey: conversation?.productKey ?? null,
    kind: conversation?.kind ?? null,
    selectionMode: conversation?.selectionMode ?? null,
    selectedModelIds: storedModelIds(conversation?.selectedModels),
    model,
    backendReadiness,
    profileTools,
    gateEnabled: flags.aiChatEnabled && Boolean(model && researchPreviewGate(model)),
    modelOutputTokenCap: model ? resolveModelPricing(model).maxOutputTokens : 0,
  });
  if (
    !decision.offered ||
    !decision.limits ||
    !model ||
    model.provider !== run.provider ||
    model.apiModel !== run.apiModel ||
    researchPreviewQuestionDigest(question) !== run.questionDigest ||
    decision.limits.totalOutputTokens < run.totalOutputTokens
  ) {
    throw new Error("RESEARCH_RUN_POLICY_CHANGED");
  }
  return { question, model, backendReadiness };
}

const knownSettlement = (
  run: { searchSurchargeCredits: number },
  checkpoint: ResearchPreviewCheckpoint | null,
  outcome: ResearchPreviewSettlementUsage["outcome"]
): ResearchPreviewSettlementUsage => ({
  inputTokens: checkpoint?.usage.inputTokens ?? 0,
  cachedInputTokens: checkpoint?.usage.cachedInputTokens ?? 0,
  cacheWriteInputTokens: checkpoint?.usage.cacheWriteTokens ?? 0,
  outputTokens: checkpoint?.usage.outputTokens ?? 0,
  reasoningTokens: checkpoint?.usage.reasoningTokens ?? 0,
  usageFromProvider: true,
  outcome,
  searchSurchargeCredits: run.searchSurchargeCredits,
  searchExecuted: checkpoint?.search.executed ?? false,
  searchQueryCount: checkpoint?.search.succeededRequestCount ?? 0,
  searchBackendRequestCount: checkpoint?.search.backendRequestCount ?? 0,
  searchQueriesObserved: true,
});

const unknownSettlement = (run: {
  searchSurchargeCredits: number;
}): ResearchPreviewSettlementUsage => ({
  usageFromProvider: false,
  outcome: "failed",
  searchSurchargeCredits: run.searchSurchargeCredits,
  searchQueriesObserved: false,
});

async function settleStoredResearchPreviewRun(
  run: {
    id: string;
    userId: string;
    reservationId: string | null;
    settlementUsage: unknown;
  } | null
) {
  if (!run?.reservationId) return;
  const usage = parseResearchPreviewSettlementUsage(run.settlementUsage);
  if (!usage) return;
  try {
    const reservation = await readChatUsageReservationForSettlement(
      run.reservationId,
      run.userId
    );
    await settleChatUsage(reservation, usage);
    await markResearchPreviewRunSettled(run.id);
  } catch (error) {
    const durable = await prisma.chatCreditReservation.findUnique({
      where: { id: run.reservationId },
      select: { status: true },
    });
    if (durable && durable.status !== "reserved") {
      await markResearchPreviewRunSettled(run.id);
      return;
    }
    throw error;
  }
}

export async function settlePendingResearchPreviewRuns(limit = 50) {
  const runs = await researchPreviewRunsAwaitingSettlement(limit);
  let settled = 0;
  for (const run of runs) {
    await settleStoredResearchPreviewRun(run);
    settled += 1;
  }
  return settled;
}

export async function recoverStaleResearchPreviewRuns(limit = 50) {
  const preparing = await stalePreparingResearchPreviewRuns(limit);
  let recovered = 0;
  for (const run of preparing) {
    const outcome = await recoverStalePreparingResearchPreviewRun(run.id);
    if (outcome !== "unchanged") recovered += 1;
  }
  const runs = await staleResearchPreviewRuns(limit);
  for (const run of runs) {
    const outcome = await recoverStaleResearchPreviewRun(run.id);
    if (outcome !== "unchanged") recovered += 1;
  }
  recovered += await expireResearchPreviewCheckpoints(limit);
  await settlePendingResearchPreviewRuns(limit);
  return recovered;
}

export async function processOneResearchPreviewRun(
  ownerId = researchPreviewWorkerId(),
  options: { maxStepsPerClaim?: number } = {}
) {
  const maxStepsPerClaim = options.maxStepsPerClaim ?? RESEARCH_PREVIEW_MAX_STEPS;
  if (!Number.isInteger(maxStepsPerClaim) || maxStepsPerClaim < 1 || maxStepsPerClaim > RESEARCH_PREVIEW_MAX_STEPS) {
    throw new Error("Research worker step limit must be between one and three.");
  }
  await recoverStaleResearchPreviewRuns();
  const claimed = await claimNextResearchPreviewRun(ownerId);
  if (!claimed) return false;
  let chatLeaseId: string | null = null;
  let generationId: string | undefined;
  let dispatched = false;
  let completedStepsInClaim = 0;
  let checkpoint = claimed.checkpoint
    ? parseResearchPreviewCheckpoint(claimed.checkpoint)
    : null;
  const access = identifyChatCaller(
    new Request("http://127.0.0.1/internal/research-preview-worker"),
    claimed.userId
  );
  const abort = new AbortController();
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let cancellationTimer: ReturnType<typeof setInterval> | null = null;
  let deadlineTimer: ReturnType<typeof setTimeout> | null = null;
  try {
    const policy = await currentWorkerPolicy(claimed);
    if (!claimed.reservationId) throw new Error("RESEARCH_RESERVATION_MISSING");
    const chatLease = await acquireReservedChatAccess(access, {
      reservationId: claimed.reservationId,
      modelId: claimed.modelId,
    });
    chatLeaseId = chatLease.leaseId;
    await extendChatReservationExpiry(
      claimed.reservationId,
      24 * 60 * 60
    );
    const heartbeat = async () => {
      const [runAlive, chatAlive] = await Promise.all([
        heartbeatResearchPreviewRun({
          runId: claimed.id,
          ownerId,
          leaseEpoch: claimed.leaseEpoch,
        }),
        chatLeaseId ? heartbeatChatAccess(chatLeaseId) : Promise.resolve(false),
      ]);
      if (!runAlive || !chatAlive) {
        abort.abort(new DOMException("Research lease expired", "AbortError"));
      }
    };
    heartbeatTimer = setInterval(() => void heartbeat(), 30_000);
    cancellationTimer = setInterval(() => {
      void prisma.researchPreviewRun
        .findUnique({
          where: { id: claimed.id },
          select: { cancelRequestedAt: true, status: true },
        })
        .then((current) => {
          if (current?.cancelRequestedAt || current?.status !== "running") {
            abort.abort(new DOMException("Research cancelled", "AbortError"));
          }
        });
    }, 1_000);
    const activeDeadline = claimed.activeDeadlineAt?.getTime() ??
      Date.now() + RESEARCH_PREVIEW_RUN_ACTIVE_LIMIT_MS;
    deadlineTimer = setTimeout(
      () => abort.abort(new DOMException("Research active deadline", "TimeoutError")),
      Math.max(1, activeDeadline - Date.now())
    );

    while (!abort.signal.aborted) {
      const current = await readResearchPreviewRunForWorker(claimed.id);
      if (!current || current.status !== "running") break;
      if (current.cancelRequestedAt) {
        abort.abort(new DOMException("Research cancelled", "AbortError"));
        break;
      }
      checkpoint = current.checkpoint
        ? parseResearchPreviewCheckpoint(current.checkpoint)
        : null;
      const generation = await beginResearchPreviewGeneration({
        runId: current.id,
        ownerId,
        leaseEpoch: claimed.leaseEpoch,
        checkpointVersion: current.checkpointVersion,
        generationIndex: current.stepCount + 1,
      });
      generationId = generation.id;
      dispatched = false;
      const result = await runResearchPreviewStep({
        model: getResearchPreviewAiModel(policy.model),
        modelConfig: policy.model,
        question: policy.question,
        locale: current.locale,
        currentDate: current.currentDate,
        totalOutputTokens: current.totalOutputTokens,
        inputTokenCeiling: current.inputTokenCeiling,
        pageReadingEnabled: current.pageReadingEnabled,
        ...(checkpoint ? { checkpoint } : {}),
        signal: abort.signal,
        onBeforeModelDispatch: async () => {
          await markResearchPreviewDispatchStarted({
            runId: current.id,
            generationId: generation.id,
            ownerId,
            leaseEpoch: claimed.leaseEpoch,
          });
          dispatched = true;
        },
      });
      const next = parseResearchPreviewCheckpoint(result.checkpoint);
      const settlement = knownSettlement(current, next, result.report ? "completed" : "failed");
      let terminal:
        | { content: string; modelId: string; searchMetadata: Prisma.InputJsonValue }
        | undefined;
      if (result.report) {
        const capability = getWebSearchCapability(policy.model);
        const searchMetadata = normalizeWebSearchExecution({
          capability,
          searchRequested: true,
          provider: policy.model.provider,
          toolName: APP_MANAGED_WEB_SEARCH_TOOL_NAME,
          backendReadiness: policy.backendReadiness,
          appManagedSearch: next.search,
        });
        searchMetadata.citations = result.report.citations;
        searchMetadata.research = buildResearchPreviewMetadata({
          outcome: result.report.outcome,
          startedAt: (current.startedAt ?? current.createdAt).toISOString(),
          completedAt: new Date().toISOString(),
          stopReason: "report_submitted",
          citedSources: result.report.citedSources,
        });
        terminal = {
          content: result.report.content,
          modelId: current.modelId,
          searchMetadata: JSON.parse(JSON.stringify(searchMetadata)) as Prisma.InputJsonValue,
        };
      }
      const terminalFailure =
        result.finished && !result.report
          ? {
              status: "failed" as const,
              stopReason: next.stopReason ?? "missing_report",
              errorCode: "RESEARCH_REPORT_MISSING",
            }
          : undefined;
      await completeResearchPreviewGeneration({
        runId: current.id,
        generationId: generation.id,
        ownerId,
        leaseEpoch: claimed.leaseEpoch,
        checkpoint: next,
        stepCount: next.completedSteps,
        searchCount: next.search.backendRequestCount,
        readCount: next.pageReads.length,
        stepUsage: {
          inputTokens: result.usage.inputTokens,
          cachedInputTokens: result.usage.cachedInputTokens,
          cacheWriteInputTokens: result.usage.cacheWriteTokens,
          outputTokens: result.usage.outputTokens,
          reasoningTokens: result.usage.reasoningTokens,
        },
        settlementUsage: settlement,
        ...(terminal ? { terminal } : {}),
        ...(terminalFailure ? { terminalFailure } : {}),
      });
      checkpoint = next;
      generationId = undefined;
      dispatched = false;
      completedStepsInClaim += 1;
      if (result.finished) break;
      if (completedStepsInClaim >= maxStepsPerClaim || Date.now() + 5_000 >= activeDeadline) {
        await checkpointResearchPreviewRun({
          runId: current.id,
          ownerId,
          leaseEpoch: claimed.leaseEpoch,
        });
        break;
      }
    }
  } catch (error) {
    const current = await readResearchPreviewRunForWorker(claimed.id);
    if (current?.status === "running") {
      const cancelled = Boolean(current.cancelRequestedAt) ||
        (error instanceof ResearchPreviewRunStoppedError && error.stopReason === "aborted");
      const timedOut = error instanceof ResearchPreviewRunStoppedError && error.stopReason === "timeout";
      const knownBudget = error instanceof ResearchPreviewBudgetExhaustedError;
      const usageUnknown = error instanceof ResearchPreviewUsageUnknownError;
      const outcomeUnknown = dispatched || usageUnknown;
      await finishResearchPreviewRunWithoutReport({
        runId: current.id,
        ownerId,
        leaseEpoch: claimed.leaseEpoch,
        status: cancelled ? "cancelled" : outcomeUnknown ? "attention" : "failed",
        stopReason: cancelled
          ? "aborted"
          : timedOut
            ? "timeout"
            : usageUnknown
              ? "usage_unknown"
              : outcomeUnknown
                ? "outcome_unknown"
                : knownBudget
                  ? "budget_exhausted"
                  : "dispatch_refused",
        ...(generationId ? { generationId } : {}),
        ...(generationId
          ? { generationStatus: outcomeUnknown ? "outcome_unknown" as const : "dispatch_refused" as const }
          : {}),
        settlementUsage: outcomeUnknown
          ? unknownSettlement(current)
          : knownSettlement(current, checkpoint, cancelled ? "cancelled" : "failed"),
        errorCode: error instanceof Error ? error.name : "RESEARCH_RUN_FAILED",
      });
    }
  } finally {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (cancellationTimer) clearInterval(cancellationTimer);
    if (deadlineTimer) clearTimeout(deadlineTimer);
    if (chatLeaseId) {
      await releaseChatAccess(chatLeaseId, {
        traceId: claimed.id,
        reason: "research_worker_finished",
        subjectScope: access.subjectKey,
      });
    }
    const final = await readResearchPreviewRunForWorker(claimed.id);
    if (final && ["completed", "failed", "cancelled", "attention"].includes(final.status)) {
      await settleStoredResearchPreviewRun(final).catch(() => undefined);
    } else if (final?.status === "running") {
      await releaseResearchPreviewClaimToQueue({
        runId: final.id,
        ownerId,
        leaseEpoch: claimed.leaseEpoch,
      });
    }
  }
  return true;
}

export async function resumeDurableResearchPreviewRun(input: {
  request: Request;
  userId: string;
  runId: string;
}) {
  if (!researchPreviewFeatures().durableRuns) {
    throw new Error("RESEARCH_PREVIEW_DURABLE_DISABLED");
  }
  const run = await readResearchPreviewRunForWorker(input.runId);
  if (!run || run.userId !== input.userId) return null;
  const conversation = await prisma.conversation.findFirst({
    where: { id: run.conversationId, userId: input.userId },
    select: { id: true, password: true },
  });
  if (
    !conversation ||
    !hasConversationUnlockGrant(
      input.request,
      input.userId,
      conversation.id,
      conversation.password
    )
  ) {
    throw new Error("RESEARCH_CONVERSATION_LOCKED");
  }
  await currentWorkerPolicy(run);
  if (!run.reservationId) throw new Error("RESEARCH_RESERVATION_MISSING");
  await readOpenChatUsageReservation(run.reservationId, input.userId);
  await resumeResearchPreviewRun(input.userId, run.id);
  return readResearchPreviewRunDto(input.userId, run.id);
}

export async function cancelDurableResearchPreviewRun(input: {
  userId: string;
  runId: string;
}) {
  const cancelled = await requestResearchPreviewCancellation(
    input.userId,
    input.runId
  );
  if (!cancelled) return null;
  if (cancelled.terminalized) {
    const run = await readResearchPreviewRunForWorker(input.runId);
    await settleStoredResearchPreviewRun(run);
  }
  return readResearchPreviewRunDto(input.userId, input.runId);
}

export { listResearchPreviewRunDtos, readResearchPreviewRunDto };
