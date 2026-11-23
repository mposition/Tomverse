import "server-only";

import type { Prisma } from "@prisma/client";

import { APP_DEFAULTS } from "@/lib/appDefaults";
import { isExternalContinuationEnabled } from "@/lib/appSettings";
import { effectivePlanModelLimit, getUserBillingPlan } from "@/lib/billingEntitlements";
import { parseContinuationSourceManifest, restoreContinuationSourcePlan } from "@/lib/continuationSourceManifest";
import { continuationPath } from "@/lib/continuationRoutes";
import { createConversation } from "@/lib/conversationCreation";
import { hasConversationUnlockGrant, hasResourceUnlockGrant } from "@/lib/conversationLock";
import { LEGACY_CONTINUATION_TITLE } from "@/lib/continuationDisplayTitle";
import { CHAT_IMAGE_TURN_CONTENT_PREFIX } from "@/lib/chatImageTurnCore";
import { planContinuationSeed, type ContinuationSeedPlan } from "@/lib/externalContinuationSeedCore";
import { buildContinuationSeedPrompt } from "@/lib/externalContinuationSeedPrompt";
import { capToPlanModelLimit, resolveNewConversationSelectedModels } from "@/lib/newConversationSelectedModels";
import { prisma } from "@/lib/prisma";
import {
  REVIEW_HANDOFF_NATIVE_SCAN_LIMIT,
  renderReviewHandoffNativeReference,
  reviewHandoffContentDigest,
  reviewHandoffDescriptorSchema,
  reviewHandoffPublicMetadata,
  selectReviewHandoffNativeReferences,
  type ReviewHandoffDescriptor,
  type ReviewHandoffNativeCandidate,
} from "@/lib/reviewContinuationHandoffCore";

type Db = Prisma.TransactionClient | typeof prisma;

export class ReviewContinuationHandoffError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "ReviewContinuationHandoffError";
  }
}

function unavailable(code: string, message: string, status = 409): never {
  throw new ReviewContinuationHandoffError(status, code, message);
}

const isUniqueConstraintError = (error: unknown) =>
  typeof error === "object" && error !== null && (error as { code?: unknown }).code === "P2002";

async function initialReviewModels(userId: string) {
  const [settings, plan] = await Promise.all([
    prisma.userSettings.findUnique({
      where: { userId },
      select: { defaultModel: true, newConversationModelIds: true },
    }),
    getUserBillingPlan(userId),
  ]);
  const models = await resolveNewConversationSelectedModels({
    storedNewConversationModelIds: settings?.newConversationModelIds ?? null,
    defaultModelId: settings?.defaultModel || APP_DEFAULTS.defaultModelId,
    planTier: plan.tier,
  });
  return capToPlanModelLimit(models, effectivePlanModelLimit(plan));
}

const parseStoredDescriptor = (value: unknown) => {
  const parsed = reviewHandoffDescriptorSchema.safeParse(value);
  if (!parsed.success) unavailable("REVIEW_HANDOFF_INVALID", "The Review handoff reference is invalid.");
  return parsed.data;
};

const assertKeyAnchor = (
  descriptor: ReviewHandoffDescriptor,
  parentConversationId: string,
  assistantMessageId: string
) => {
  if (
    descriptor.parentConversationId !== parentConversationId ||
    descriptor.assistantMessageId !== assistantMessageId
  ) {
    unavailable(
      "REVIEW_HANDOFF_IDEMPOTENCY_CONFLICT",
      "This idempotency key belongs to a different answer."
    );
  }
};

async function existingByKey(
  db: Db,
  userId: string,
  idempotencyKey: string,
  parentConversationId: string,
  assistantMessageId: string
) {
  const row = await db.conversationContinuationBridge.findUnique({
    where: { userId_idempotencyKey: { userId, idempotencyKey } },
    select: { conversationId: true, reviewHandoff: true },
  });
  if (!row) return null;
  const descriptor = parseStoredDescriptor(row.reviewHandoff);
  assertKeyAnchor(descriptor, parentConversationId, assistantMessageId);
  return row.conversationId;
}

async function loadQuestionAndPrefix(input: {
  tx: Prisma.TransactionClient;
  userId: string;
  parentConversationId: string;
  assistantMessageId: string;
}) {
  const assistant = await input.tx.message.findFirst({
    where: {
      id: input.assistantMessageId,
      conversationId: input.parentConversationId,
      conversation: { userId: input.userId },
      role: "assistant",
      status: "normal",
    },
    select: { id: true, content: true, createdAt: true, researchRunId: true, pendingJobId: true },
  });
  if (!assistant || !assistant.content.trim()) {
    unavailable("REVIEW_HANDOFF_ANSWER_NOT_FOUND", "A saved text answer is required.", 404);
  }
  if (assistant.researchRunId || assistant.pendingJobId ||
    assistant.content.startsWith(CHAT_IMAGE_TURN_CONTENT_PREFIX)) {
    unavailable("REVIEW_HANDOFF_MODE_UNSUPPORTED", "This answer type cannot be compared in Review yet.");
  }

  const attempt = await input.tx.chatResponseAttempt.findUnique({
    where: { assistantMessageId: input.assistantMessageId },
    select: {
      userId: true,
      conversationId: true,
      sourceUserMessageId: true,
      status: true,
      terminalAt: true,
      partialContent: true,
      actualModelId: true,
      provider: true,
      continuationSourcePlan: true,
    },
  });
  if (
    attempt &&
    (attempt.userId !== input.userId ||
      attempt.conversationId !== input.parentConversationId ||
      attempt.status !== "completed" ||
      attempt.terminalAt === null)
  ) {
    unavailable("REVIEW_HANDOFF_ANSWER_NOT_COMPLETE", "The selected answer is not complete.");
  }
  if (
    assistant.content.includes("[Response truncated for storage]") ||
    (attempt && attempt.partialContent !== assistant.content)
  ) {
    unavailable(
      "REVIEW_HANDOFF_ANSWER_NOT_COMPLETE",
      "The complete saved answer is required for this comparison."
    );
  }

  const question = attempt
    ? await input.tx.message.findFirst({
        where: {
          id: attempt.sourceUserMessageId,
          conversationId: input.parentConversationId,
          role: "user",
          status: "normal",
        },
        select: { id: true, content: true, createdAt: true, researchRunId: true, pendingJobId: true,
          _count: { select: { attachments: true, researchSourceRuns: true } } },
      })
    : await input.tx.message.findFirst({
        where: {
          conversationId: input.parentConversationId,
          role: "user",
          status: "normal",
          OR: [
            { createdAt: { lt: assistant.createdAt } },
            { createdAt: assistant.createdAt, id: { lt: assistant.id } },
          ],
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        select: { id: true, content: true, createdAt: true, researchRunId: true, pendingJobId: true,
          _count: { select: { attachments: true, researchSourceRuns: true } } },
      });
  if (!question || !question.content.trim()) {
    unavailable("REVIEW_HANDOFF_QUESTION_NOT_FOUND", "The question for this answer is unavailable.");
  }
  if (question.content.length > 50_000) {
    unavailable("REVIEW_HANDOFF_QUESTION_TOO_LONG", "The question exceeds the Review input limit.", 413);
  }
  if (question._count.attachments > 0) {
    unavailable(
      "REVIEW_HANDOFF_ATTACHMENTS_UNSUPPORTED",
      "Comparing a question with attachments is not supported yet."
    );
  }
  if (question.researchRunId || question.pendingJobId || question._count.researchSourceRuns > 0 ||
    question.content.startsWith(CHAT_IMAGE_TURN_CONTENT_PREFIX)) {
    unavailable("REVIEW_HANDOFF_MODE_UNSUPPORTED", "This question type cannot be compared in Review yet.");
  }

  const prefixWhere = {
      conversationId: input.parentConversationId,
      id: { not: input.assistantMessageId },
      role: { in: ["user", "assistant"] },
      status: "normal",
      OR: [
        { createdAt: { lt: question.createdAt } },
        { createdAt: question.createdAt, id: { lt: question.id } },
      ],
    } satisfies Prisma.MessageWhereInput;
  const [before, prefixCount] = await Promise.all([
    input.tx.message.findMany({
      where: prefixWhere,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: REVIEW_HANDOFF_NATIVE_SCAN_LIMIT,
      select: {
        id: true,
        role: true,
        content: true,
        researchRunId: true,
        pendingJobId: true,
        _count: { select: { attachments: true } },
      },
    }),
    input.tx.message.count({ where: prefixWhere }),
  ]);
  before.reverse();
  if (before.some((message) => message._count.attachments > 0)) {
    unavailable(
      "REVIEW_HANDOFF_ATTACHMENTS_UNSUPPORTED",
      "Comparing native context with attachments is not supported yet."
    );
  }
  if (before.some((message) => message.researchRunId || message.pendingJobId ||
    message.content.startsWith(CHAT_IMAGE_TURN_CONTENT_PREFIX))) {
    unavailable("REVIEW_HANDOFF_MODE_UNSUPPORTED", "This native context type cannot be compared in Review yet.");
  }
  const candidates = before.flatMap<ReviewHandoffNativeCandidate>((message) =>
    (message.role === "user" || message.role === "assistant") && message.content.trim()
      ? [{ id: message.id, role: message.role as "user" | "assistant", content: message.content }]
      : []
  );
  const native = selectReviewHandoffNativeReferences(candidates);
  native.omittedCount += Math.max(0, prefixCount - before.length);
  return { assistant, attempt, question, candidates, native };
}

async function sourcePlan(input: {
  tx: Prisma.TransactionClient;
  source: {
    id: string;
    conversationDigest: string;
    digestVersion: number;
    messageCount: number;
  };
  storedManifest: Prisma.JsonValue | null;
  expectedAttempt?: {
    assistantMessageId: string;
    sourceUserMessageId: string;
    actualModelId: string | null;
    provider: string | null;
  };
}): Promise<{ mode: "recorded" | "legacy"; plan: ContinuationSeedPlan }> {
  if (input.storedManifest !== null) {
    let manifest;
    try {
      manifest = parseContinuationSourceManifest(input.storedManifest);
    } catch {
      unavailable("REVIEW_HANDOFF_SOURCE_MANIFEST_INVALID", "The saved source reference is invalid.");
    }
    if (
      input.expectedAttempt &&
      (manifest.attempt.assistantMessageId !== input.expectedAttempt.assistantMessageId ||
        manifest.attempt.sourceUserMessageId !== input.expectedAttempt.sourceUserMessageId ||
        manifest.attempt.actualModelId !== input.expectedAttempt.actualModelId ||
        manifest.attempt.provider !== input.expectedAttempt.provider)
    ) {
      unavailable("REVIEW_HANDOFF_SOURCE_MANIFEST_INVALID", "The saved source attempt binding changed.");
    }
    const rows = await input.tx.externalMessage.findMany({
      where: {
        externalConversationId: input.source.id,
        ordinal: { in: manifest.plan.turns.map((turn) => turn.ordinal) },
      },
      orderBy: { ordinal: "asc" },
      select: { role: true, ordinal: true, content: true, truncated: true },
    });
    try {
      return {
        mode: "recorded",
        plan: restoreContinuationSourcePlan({
          manifest,
          messages: rows,
          snapshot: input.source,
        }),
      };
    } catch {
      unavailable("REVIEW_HANDOFF_SOURCE_CHANGED", "The saved source reference is no longer valid.");
    }
  }
  const recent = await input.tx.externalMessage.findMany({
    where: { externalConversationId: input.source.id },
    orderBy: { ordinal: "desc" },
    take: 200,
    select: { role: true, ordinal: true, content: true, truncated: true },
  });
  recent.reverse();
  return {
    mode: "legacy",
    plan: planContinuationSeed({ messages: recent, sourceMessageCount: input.source.messageCount }),
  };
}

async function parentForCreate(input: {
  tx: Prisma.TransactionClient;
  userId: string;
  parentConversationId: string;
  assistantMessageId: string;
  request: Request;
}) {
  const parent = await input.tx.conversation.findFirst({
    where: { id: input.parentConversationId, userId: input.userId },
    select: { id: true, kind: true, productKey: true, password: true, passwordVersion: true, projectId: true,
      project: { select: { archivedAt: true } } },
  });
  if (!parent || parent.kind !== "chat" || parent.productKey !== "chat") {
    unavailable("REVIEW_HANDOFF_PARENT_NOT_FOUND", "Chat continuation not found.", 404);
  }
  if (
    !hasConversationUnlockGrant(
      input.request,
      input.userId,
      parent.id,
      parent.password === null ? null : parent.passwordVersion
    )
  ) {
    unavailable("CONVERSATION_LOCKED", "Conversation is locked.", 423);
  }
  const bridge = await input.tx.conversationContinuationBridge.findFirst({
    where: { conversationId: parent.id, userId: input.userId },
    select: {
      externalConversationId: true,
      reviewHandoff: true,
      provider: true,
      sourceImportedAt: true,
      sourceConversationDigest: true,
      sourceDigestVersion: true,
    },
  });
  if (!bridge?.externalConversationId || bridge.reviewHandoff !== null) {
    unavailable("REVIEW_HANDOFF_PARENT_NOT_FOUND", "Chat continuation not found.", 404);
  }
  const source = await input.tx.externalConversation.findFirst({
    where: { id: bridge.externalConversationId, userId: input.userId, finalized: true },
    select: {
      id: true,
      provider: true,
      importedAt: true,
      conversationDigest: true,
      digestVersion: true,
      messageCount: true,
      password: true,
      passwordVersion: true,
    },
  });
  if (!source) unavailable("REVIEW_HANDOFF_SOURCE_UNAVAILABLE", "The imported source is unavailable.");
  if (
    source.conversationDigest !== bridge.sourceConversationDigest ||
    source.digestVersion !== bridge.sourceDigestVersion
  ) {
    unavailable("REVIEW_HANDOFF_SOURCE_CHANGED", "The imported source binding changed.");
  }
  if (
    !hasResourceUnlockGrant(
      "external_conversation",
      input.request,
      input.userId,
      source.id,
      source.password === null ? null : source.passwordVersion
    )
  ) {
    unavailable("EXTERNAL_CONVERSATION_LOCKED", "The imported source is locked.", 423);
  }
  const context = await loadQuestionAndPrefix(input);
  const selectedSource = await sourcePlan({
    tx: input.tx,
    source,
    storedManifest: context.attempt?.continuationSourcePlan ?? null,
    expectedAttempt: context.attempt
      ? {
          assistantMessageId: input.assistantMessageId,
          sourceUserMessageId: context.attempt.sourceUserMessageId,
          actualModelId: context.attempt.actualModelId,
          provider: context.attempt.provider,
        }
      : undefined,
  });
  return { parent, bridge, source, context, selectedSource };
}

export async function createReviewContinuationHandoff(input: {
  userId: string;
  parentConversationId: string;
  assistantMessageId: string;
  idempotencyKey: string;
  request: Request;
}) {
  const replay = await existingByKey(
    prisma,
    input.userId,
    input.idempotencyKey,
    input.parentConversationId,
    input.assistantMessageId
  );
  if (replay) return readCreatedReviewHandoff(input.userId, replay, true);
  const models = await initialReviewModels(input.userId);
  try {
    const conversationId = await prisma.$transaction(async (tx) => {
      const source = await parentForCreate({ ...input, tx });
      const descriptor: ReviewHandoffDescriptor = {
        version: 1,
        parentConversationId: input.parentConversationId,
        sourceUserMessageId: source.context.question.id,
        sourceUserContentDigest: reviewHandoffContentDigest(source.context.question.content),
        assistantMessageId: input.assistantMessageId,
        assistantContentDigest: reviewHandoffContentDigest(source.context.assistant.content),
        sourceMode: source.selectedSource.mode,
        sourceManifestDigest:
          source.selectedSource.mode === "recorded" && source.context.attempt?.continuationSourcePlan
            ? reviewHandoffContentDigest(JSON.stringify(
                parseContinuationSourceManifest(source.context.attempt.continuationSourcePlan)
              ))
            : null,
        nativeReferences: source.context.native.references,
        nativeOmittedCount: source.context.native.omittedCount,
      };
      const conversation = await createConversation(
        tx,
        {
          userId: input.userId,
          title: LEGACY_CONTINUATION_TITLE,
          productKey: "review",
          selectionMode: "manual",
          selectedModels: JSON.stringify(models),
          webSearchMode: APP_DEFAULTS.defaultWebSearchMode,
          // Project workspace: the comparison stays in the parent Chat's
          // project, read from the parent row (never a request field). An
          // archived project takes no new work, so the comparison starts
          // outside it.
          projectId: source.parent.projectId && !source.parent.project?.archivedAt ? source.parent.projectId : null,
        },
        { id: true }
      );
      const plan = source.selectedSource.plan;
      await tx.conversationContinuationBridge.create({
        data: {
          userId: input.userId,
          conversationId: conversation.id,
          externalConversationId: source.source.id,
          provider: source.source.provider,
          sourceImportedAt: source.source.importedAt,
          sourceConversationDigest: source.source.conversationDigest,
          sourceDigestVersion: source.source.digestVersion,
          sourceMessageCount: plan.sourceMessageCount,
          seedFromOrdinal: plan.fromOrdinal,
          seedToOrdinal: plan.toOrdinal,
          seedMessageCount: plan.turns.length,
          seedTruncatedMessageCount: plan.truncatedCount,
          seedOmittedMessageCount: plan.omittedByBudgetCount,
          contextSeedVersion: plan.seedVersion,
          idempotencyKey: input.idempotencyKey,
          reviewHandoff: descriptor as Prisma.InputJsonValue,
        },
      });
      await tx.chatComposerDraft.create({
        data: {
          userId: input.userId,
          scopeKey: conversation.id,
          conversationId: conversation.id,
          text: source.context.question.content,
          attachmentReferences: [],
          revision: 1,
        },
      });
      return conversation.id;
    });
    return readCreatedReviewHandoff(input.userId, conversationId, false);
  } catch (error) {
    if (!isUniqueConstraintError(error)) throw error;
    const winner = await existingByKey(
      prisma,
      input.userId,
      input.idempotencyKey,
      input.parentConversationId,
      input.assistantMessageId
    );
    if (!winner) throw error;
    return readCreatedReviewHandoff(input.userId, winner, true);
  }
}

async function readCreatedReviewHandoff(userId: string, conversationId: string, replay: boolean) {
  const loaded = await prisma.conversationContinuationBridge.findFirstOrThrow({
    where: { conversationId, userId },
    select: {
      reviewHandoff: true,
      seedMessageCount: true,
      seedOmittedMessageCount: true,
    },
  });
  const descriptor = parseStoredDescriptor(loaded.reviewHandoff);
  return {
    conversationId,
    route: continuationPath(conversationId),
    idempotentReplay: replay,
    reviewHandoff: reviewHandoffPublicMetadata({
      sourceMode: descriptor.sourceMode,
      nativeTurnCount: descriptor.nativeReferences.length,
      nativeOmittedCount: descriptor.nativeOmittedCount,
      sourceTurnCount: loaded.seedMessageCount,
      sourceOmittedCount: loaded.seedOmittedMessageCount,
    }),
  };
}

export type LoadedReviewContinuationReference =
  | { status: "not_handoff" }
  | { status: "unavailable"; reason: string; publicMetadata: ReturnType<typeof reviewHandoffPublicMetadata> }
  | {
      status: "available";
      descriptor: ReviewHandoffDescriptor;
      sourcePlan: ContinuationSeedPlan;
      sourcePrompt: ReturnType<typeof buildContinuationSeedPrompt>;
      nativeReferenceText: string | null;
      publicMetadata: ReturnType<typeof reviewHandoffPublicMetadata>;
    };

export async function loadReviewContinuationReference(input: {
  userId: string;
  conversationId: string;
  request: Request;
}): Promise<LoadedReviewContinuationReference> {
  const bridge = await prisma.conversationContinuationBridge.findFirst({
    where: { conversationId: input.conversationId, userId: input.userId },
    select: {
      reviewHandoff: true,
      seedMessageCount: true,
      seedOmittedMessageCount: true,
      provider: true,
      sourceImportedAt: true,
      sourceConversationDigest: true,
      sourceDigestVersion: true,
      externalConversationId: true,
      conversation: { select: { productKey: true, kind: true, password: true, passwordVersion: true } },
    },
  });
  if (!bridge?.reviewHandoff) return { status: "not_handoff" };
  let descriptor: ReviewHandoffDescriptor;
  try {
    descriptor = parseStoredDescriptor(bridge.reviewHandoff);
  } catch {
    return {
      status: "unavailable",
      reason: "invalid_descriptor",
      publicMetadata: reviewHandoffPublicMetadata({
        sourceMode: "legacy",
        nativeTurnCount: 0,
        nativeOmittedCount: 0,
        sourceTurnCount: bridge.seedMessageCount,
        sourceOmittedCount: bridge.seedOmittedMessageCount,
      }),
    };
  }
  const metadata = reviewHandoffPublicMetadata({
    sourceMode: descriptor.sourceMode,
    nativeTurnCount: descriptor.nativeReferences.length,
    nativeOmittedCount: descriptor.nativeOmittedCount,
    sourceTurnCount: bridge.seedMessageCount,
    sourceOmittedCount: bridge.seedOmittedMessageCount,
  });
  const fail = (reason: string): LoadedReviewContinuationReference => ({
    status: "unavailable",
    reason,
    publicMetadata: metadata,
  });
  if (descriptor.nativeReferences.some((reference) =>
    reference.messageId === descriptor.assistantMessageId ||
    reference.messageId === descriptor.sourceUserMessageId)) return fail("invalid_descriptor");
  if (!(await isExternalContinuationEnabled())) return fail("feature_disabled");
  if (
    bridge.conversation.productKey !== "review" ||
    bridge.conversation.kind !== "chat" ||
    !hasConversationUnlockGrant(
      input.request,
      input.userId,
      input.conversationId,
      bridge.conversation.password === null ? null : bridge.conversation.passwordVersion
    )
  ) return fail("target_unavailable");
  const parent = await prisma.conversation.findFirst({
    where: { id: descriptor.parentConversationId, userId: input.userId },
    select: { password: true, passwordVersion: true },
  });
  if (!parent) return fail("parent_deleted");
  if (!hasConversationUnlockGrant(input.request, input.userId, descriptor.parentConversationId,
    parent.password === null ? null : parent.passwordVersion)) return fail("parent_locked");
  if (!bridge.externalConversationId) return fail("source_deleted");
  const source = await prisma.externalConversation.findFirst({
    where: { id: bridge.externalConversationId, userId: input.userId, finalized: true },
    select: { id: true, conversationDigest: true, digestVersion: true, messageCount: true,
      password: true, passwordVersion: true },
  });
  if (!source) return fail("source_deleted");
  if (!hasResourceUnlockGrant("external_conversation", input.request, input.userId, source.id,
    source.password === null ? null : source.passwordVersion)) return fail("source_locked");
  if (source.conversationDigest !== bridge.sourceConversationDigest ||
    source.digestVersion !== bridge.sourceDigestVersion) return fail("source_changed");
  const attempt = await prisma.chatResponseAttempt.findUnique({
    where: { assistantMessageId: descriptor.assistantMessageId },
    select: { userId: true, conversationId: true, sourceUserMessageId: true, status: true,
      actualModelId: true, provider: true,
      partialContent: true,
      continuationSourcePlan: true },
  });
  if (attempt && (attempt.userId !== input.userId ||
    attempt.conversationId !== descriptor.parentConversationId ||
    attempt.sourceUserMessageId !== descriptor.sourceUserMessageId ||
    attempt.status !== "completed")) return fail("attempt_changed");
  const [question, assistant, nativeRows] = await Promise.all([
    prisma.message.findFirst({ where: { id: descriptor.sourceUserMessageId,
      conversationId: descriptor.parentConversationId, role: "user", status: "normal" },
      select: { content: true, researchRunId: true, pendingJobId: true,
        _count: { select: { attachments: true, researchSourceRuns: true } } } }),
    prisma.message.findFirst({ where: { id: descriptor.assistantMessageId,
      conversationId: descriptor.parentConversationId, role: "assistant", status: "normal" },
      select: { content: true, researchRunId: true, pendingJobId: true } }),
    prisma.message.findMany({ where: { conversationId: descriptor.parentConversationId,
      id: { in: descriptor.nativeReferences.map((reference) => reference.messageId) }, status: "normal" },
      select: { id: true, role: true, content: true, researchRunId: true, pendingJobId: true,
        _count: { select: { attachments: true } } } }),
  ]);
  if (descriptor.sourceMode === "recorded") {
    if (!attempt?.continuationSourcePlan || descriptor.sourceManifestDigest === null) {
      return fail("source_manifest_missing");
    }
    try {
      const currentDigest = reviewHandoffContentDigest(JSON.stringify(
        parseContinuationSourceManifest(attempt.continuationSourcePlan)
      ));
      if (currentDigest !== descriptor.sourceManifestDigest) return fail("source_manifest_changed");
    } catch {
      return fail("source_manifest_changed");
    }
  } else if (descriptor.sourceManifestDigest !== null) {
    return fail("invalid_descriptor");
  }
  if (!question || question._count.attachments > 0 || question._count.researchSourceRuns > 0 ||
    question.researchRunId || question.pendingJobId ||
    question.content.startsWith(CHAT_IMAGE_TURN_CONTENT_PREFIX) ||
    reviewHandoffContentDigest(question.content) !== descriptor.sourceUserContentDigest)
    return fail("question_changed");
  if (!assistant || assistant.researchRunId || assistant.pendingJobId ||
    assistant.content.startsWith(CHAT_IMAGE_TURN_CONTENT_PREFIX) ||
    assistant.content.includes("[Response truncated for storage]") ||
    (attempt && attempt.partialContent !== assistant.content) ||
    reviewHandoffContentDigest(assistant.content) !== descriptor.assistantContentDigest)
    return fail("assistant_changed");
  const rowById = new Map(nativeRows.map((row) => [row.id, row]));
  const nativeMessages = [] as { id: string; role: "user" | "assistant"; content: string }[];
  for (const reference of descriptor.nativeReferences) {
    const row = rowById.get(reference.messageId);
    if (!row || row._count.attachments > 0 || row.researchRunId || row.pendingJobId ||
      row.content.startsWith(CHAT_IMAGE_TURN_CONTENT_PREFIX) || row.role !== reference.role ||
      reviewHandoffContentDigest(row.content) !== reference.contentDigest)
      return fail("native_context_changed");
    nativeMessages.push({ id: row.id, role: reference.role, content: row.content });
  }
  let plan: ContinuationSeedPlan;
  try {
    const selected = await prisma.$transaction((tx) => sourcePlan({
      tx,
      source,
      storedManifest: descriptor.sourceMode === "recorded"
        ? attempt?.continuationSourcePlan ?? null
        : null,
      expectedAttempt: attempt
        ? {
            assistantMessageId: descriptor.assistantMessageId,
            sourceUserMessageId: descriptor.sourceUserMessageId,
            actualModelId: attempt.actualModelId,
            provider: attempt.provider,
          }
        : undefined,
    }));
    if (selected.mode !== descriptor.sourceMode) return fail("source_manifest_missing");
    plan = selected.plan;
  } catch {
    return fail("source_reference_changed");
  }
  return {
    status: "available",
    descriptor,
    sourcePlan: plan,
    sourcePrompt: buildContinuationSeedPrompt({
      provider: bridge.provider,
      importedAt: bridge.sourceImportedAt,
      plan,
    }),
    nativeReferenceText: renderReviewHandoffNativeReference({
      messages: nativeMessages,
      omittedCount: descriptor.nativeOmittedCount,
    }),
    publicMetadata: metadata,
  };
}

export async function authorizeReviewHandoffDraft(input: {
  userId: string;
  conversationId: string;
  request: Request;
}) {
  const row = await prisma.conversation.findFirst({
    where: { id: input.conversationId, userId: input.userId },
    select: {
      kind: true,
      productKey: true,
      password: true,
      passwordVersion: true,
      continuationBridge: { select: { reviewHandoff: true } },
    },
  });
  if (!row) unavailable("CONVERSATION_NOT_FOUND", "Conversation not found.", 404);
  if (row.kind !== "chat" || row.productKey !== "review" || !row.continuationBridge?.reviewHandoff) {
    unavailable("REVIEW_HANDOFF_DRAFT_NOT_SUPPORTED", "This draft belongs to a different workspace.");
  }
  parseStoredDescriptor(row.continuationBridge.reviewHandoff);
  if (!hasConversationUnlockGrant(input.request, input.userId, input.conversationId,
    row.password === null ? null : row.passwordVersion)) {
    unavailable("CONVERSATION_LOCKED", "Conversation is locked.", 423);
  }
}
