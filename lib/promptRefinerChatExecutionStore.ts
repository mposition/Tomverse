import "server-only";

import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";

import { takeAuditChainLock, writeSystemAuditLog } from "@/lib/adminAudit";
import { lockChatRecoveryConversation } from "@/lib/chatResponseAttemptPersistence";
import { verifyDurableChatSourceMessage } from "@/lib/chatDurableSourceMessage";
import { scopedMessageId } from "@/lib/messageRequestIdentity";
import { promptRefinerKillSwitchEngaged } from "@/lib/promptRefinerAccess";
import { promptRefinerChatExecutionAdmission } from
  "@/lib/promptRefinerChatExecutionRelease";
import {
  PromptRefinerChatExecutionError,
  promptRefinerChatDecisionSchema,
  validatePromptRefinerChatExecution,
  type PromptRefinerHeldChatSuggestion,
} from "@/lib/promptRefinerChatExecutionCore";
import { bindPromptRefinerSuggestion, PROMPT_REFINER_INPUT_SCOPE,
  promptRefinerResponseSchema } from "@/lib/promptRefinerSuggestion";
import {
  PROMPT_REFINER_DISPOSITION_RECEIPT_VERSION,
  type PromptRefinerExecutionReceipt,
} from "@/lib/promptRefinerReceiptCore";
import { promptRefinerProductProposalReadySchema } from
  "@/lib/promptRefinerProductApiContract";
import { readPromptRefinerProductAutoGuard } from
  "@/lib/promptRefinerProductOperationalGuard";
import {
  writePromptRefinerProductDispositionReceipt,
  writePromptRefinerProductExecutionReceipt,
} from "@/lib/promptRefinerProductReceiptStore";
import { prisma } from "@/lib/prisma";

type Tx = Prisma.TransactionClient;
type Scope = { id: string; userId: string; conversationId: string; surface: "chat" | "workspace"; epoch: number };
const unavailable = (): never => { throw new PromptRefinerChatExecutionError(); };
const options = { maxWait: 2_000, timeout: 5_000 };
// A serialized browser object cannot become a server-captured snapshot.
const capturedSnapshots = new WeakSet<object>();

export const isPromptRefinerCapturedChatDraft = (
  value: unknown,
): value is PromptRefinerCapturedChatDraft =>
  value !== null && typeof value === "object" &&
  capturedSnapshots.has(value as object);

/**
 * A mount/scope transition advances a server epoch, including same-value ABA.
 * Callers must advance on account/conversation/surface transitions and edits.
 * This server-only seam is not an offer, dispatch or activation authority.
 */
export async function advancePromptRefinerChatScope(input: {
  userId: string; mountId: string; conversationId: string; surface: "chat" | "workspace";
}): Promise<Scope> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(input.mountId) ||
    !["chat", "workspace"].includes(input.surface)) return unavailable();
  return prisma.$transaction(async tx => {
    await lockChatRecoveryConversation(tx, input.userId, input.conversationId);
    const owner = await tx.conversation.findFirst({ where: { id: input.conversationId,
      userId: input.userId, kind: "chat", productKey: "chat" }, select: { id: true } });
    if (!owner) return unavailable();
    const rows = await tx.$queryRaw<Scope[]>`
      INSERT INTO "PromptRefinerChatScope" ("id", "userId", "mountId", "conversationId", "surface", "epoch")
      VALUES (${randomUUID()}, ${input.userId}, ${input.mountId}, ${input.conversationId}, ${input.surface}, 1)
      ON CONFLICT ("userId", "mountId") DO UPDATE SET
        "conversationId" = EXCLUDED."conversationId", "surface" = EXCLUDED."surface",
        "epoch" = "PromptRefinerChatScope"."epoch" + 1
      RETURNING "id", "userId", "conversationId", "surface", "epoch"
    `;
    if (rows.length !== 1) return unavailable();
    await tx.$executeRaw`UPDATE "PromptRefinerChatSuggestion" SET "state" = 'stale',
      "sourcePrompt" = NULL, "refinedPrompt" = NULL WHERE "scopeId" = ${rows[0].id} AND "state" = 'ready'`;
    await writeSystemAuditLog({ tx, systemActor: "prompt-refiner-chat-execution",
      action: "prompt_refiner.chat_scope_advanced", targetType: "PromptRefinerChatScope",
      targetId: rows[0].id, summary: "Advanced a Prompt Refiner Chat scope epoch.", metadata: { epoch: rows[0].epoch } });
    return rows[0];
  }, options);
}

/** Capture an exact DB draft before an independently admitted adapter runs. */
export async function capturePromptRefinerChatDraft(input: {
  userId: string; conversationId: string; scopeId: string; epoch: number;
  expectedDraftRevision?: number;
}) {
  return prisma.$transaction(async tx => {
    await lockChatRecoveryConversation(tx, input.userId, input.conversationId);
    const scope = await readScope(tx, input.scopeId, input.userId);
    if (!scope || scope.conversationId !== input.conversationId || scope.epoch !== input.epoch) return unavailable();
    const conversation = await tx.conversation.findFirst({
      where: { id: input.conversationId, userId: input.userId,
        kind: "chat", productKey: "chat" },
      select: { chatRecoveryEpoch: true },
    });
    const draft = await tx.chatComposerDraft.findUnique({
      where: { userId_scopeKey: { userId: input.userId, scopeKey: input.conversationId } },
      select: { id: true, revision: true, text: true },
    });
    if (!conversation || !draft || (input.expectedDraftRevision !== undefined &&
      draft.revision !== input.expectedDraftRevision)) return unavailable();
    const clientRequestId = randomUUID();
    const snapshot = Object.freeze({ ...scope, draftId: draft.id, draftRevision: draft.revision,
      sourcePrompt: draft.text, recoveryEpoch: conversation.chatRecoveryEpoch,
      clientRequestId, sourceMessageId: scopedMessageId(input.conversationId, clientRequestId),
      requestId: randomUUID() });
    capturedSnapshots.add(snapshot);
    return snapshot;
  }, options);
}
export type PromptRefinerCapturedChatDraft =
  Awaited<ReturnType<typeof capturePromptRefinerChatDraft>>;

type ProductAttemptRow = {
  id: string;
  state: "preparing" | "held" | "terminal" | "unknown";
  clientRequestId: string;
  suggestionId: string | null;
  refinedPrompt: string | null;
  refinerVersion: string | null;
  executionReceiptId: string | null;
  expiresAt: Date;
  suggestionState: string | null;
  suggestionExpiresAt: Date | null;
  dbNow: Date;
};

/**
 * Claim the exact server-owned draft epoch before any budget reservation or
 * provider work. The unique key is durable, so concurrent/reconnected copies
 * of the same HTTP body cannot create a second paid attempt.
 */
export async function claimPromptRefinerProductAttempt(input: {
  snapshot: PromptRefinerCapturedChatDraft;
  mode: "explicit" | "auto";
}) {
  if (!capturedSnapshots.has(input.snapshot)) return unavailable();
  const snapshot = input.snapshot;
  return prisma.$transaction(async tx => {
    await lockChatRecoveryConversation(tx, snapshot.userId, snapshot.conversationId);
    const inserted = await tx.$queryRaw<Array<{ id: string }>>`
      INSERT INTO "PromptRefinerProductAttempt" (
        "id", "userId", "conversationId", "scopeId", "scopeEpoch",
        "draftId", "draftRevision", "mode", "clientRequestId", "state", "expiresAt")
      VALUES (${snapshot.requestId}, ${snapshot.userId}, ${snapshot.conversationId},
        ${snapshot.id}, ${snapshot.epoch}, ${snapshot.draftId},
        ${snapshot.draftRevision}, ${input.mode}, ${snapshot.clientRequestId},
        'preparing', (clock_timestamp() AT TIME ZONE 'UTC') + INTERVAL '5 minutes')
      ON CONFLICT ("userId", "scopeId", "scopeEpoch", "draftId", "draftRevision", "mode")
      DO NOTHING RETURNING "id"
    `;
    if (inserted.length === 1) {
      await writeSystemAuditLog({ tx,
        systemActor: "prompt-refiner-product-execution",
        action: "prompt_refiner.product_attempt_claimed",
        targetType: "PromptRefinerProductAttempt", targetId: snapshot.requestId,
        summary: "Claimed one exact Prompt Refiner product draft attempt.",
        metadata: { mode: input.mode, scopeEpoch: snapshot.epoch,
          draftRevision: snapshot.draftRevision } });
      return Object.freeze({ outcome: "claimed" as const });
    }
    const rows = await tx.$queryRaw<ProductAttemptRow[]>`
      SELECT a."id", a."state", a."clientRequestId", a."suggestionId",
        a."expiresAt", s."refinedPrompt", s."refinerVersion",
        s."state" AS "suggestionState", s."expiresAt" AS "suggestionExpiresAt",
        r."id" AS "executionReceiptId",
        clock_timestamp() AT TIME ZONE 'UTC' AS "dbNow"
      FROM "PromptRefinerProductAttempt" a
      LEFT JOIN "PromptRefinerChatSuggestion" s ON s."id" = a."suggestionId"
      LEFT JOIN "PromptRefinerProductExecutionReceipt" r ON r."suggestionId" = s."id"
      WHERE a."userId" = ${snapshot.userId} AND a."scopeId" = ${snapshot.id}
        AND a."scopeEpoch" = ${snapshot.epoch} AND a."draftId" = ${snapshot.draftId}
        AND a."draftRevision" = ${snapshot.draftRevision} AND a."mode" = ${input.mode}
      FOR UPDATE OF a
    `;
    const row = rows[0];
    if (rows.length !== 1 || !row) return unavailable();
    if (row.state === "held" && row.suggestionId && row.refinedPrompt &&
        row.refinerVersion && row.suggestionState === "ready" &&
        row.dbNow < row.expiresAt && row.suggestionExpiresAt !== null &&
        row.dbNow < row.suggestionExpiresAt) {
      const held = promptRefinerProductProposalReadySchema.parse({
        requestId: row.id, suggestionId: row.suggestionId,
        refinedPrompt: row.refinedPrompt, refinerVersion: row.refinerVersion,
        inputScope: PROMPT_REFINER_INPUT_SCOPE,
        scopeId: snapshot.id, epoch: snapshot.epoch,
        clientRequestId: row.clientRequestId,
      });
      return Object.freeze({ outcome: "replay" as const, held: {
        ...held, executionReceiptId: row.executionReceiptId } });
    }
    return Object.freeze({ outcome: "duplicate" as const,
      state: row.state });
  }, options);
}

type ProductExecutionSuccessFacts = Omit<PromptRefinerExecutionReceipt,
  "receiptId" | "requestId" | "suggestionId">;

/** Store only a server adapter result; there is no public writer accepting text. */
export async function holdPromptRefinerChatSuggestion(input: {
  snapshot: PromptRefinerCapturedChatDraft; response: unknown; mode: "explicit" | "auto";
}) {
  return holdSuggestion(input, null);
}

/** Product success stores the held body and immutable execution receipt atomically. */
export async function holdPromptRefinerProductChatSuggestion(input: {
  snapshot: PromptRefinerCapturedChatDraft;
  response: unknown;
  mode: "explicit" | "auto";
  executionReceipt: ProductExecutionSuccessFacts;
  deadlineAtMonotonicMs: number;
}) {
  return holdSuggestion(input, input.executionReceipt);
}

async function holdSuggestion(input: {
  snapshot: PromptRefinerCapturedChatDraft; response: unknown; mode: "explicit" | "auto";
  deadlineAtMonotonicMs?: number;
}, executionReceipt: ProductExecutionSuccessFacts | null) {
  if (!capturedSnapshots.has(input.snapshot)) return unavailable();
  if (input.deadlineAtMonotonicMs !== undefined &&
      performance.now() >= input.deadlineAtMonotonicMs) return unavailable();
  const response = promptRefinerResponseSchema.parse(input.response);
  const snapshot = input.snapshot;
  if (!bindPromptRefinerSuggestion({ request: { requestId: snapshot.requestId, prompt: snapshot.sourcePrompt },
    response, currentPrompt: snapshot.sourcePrompt })) return unavailable();
  return prisma.$transaction(async tx => {
    await lockChatRecoveryConversation(tx, snapshot.userId, snapshot.conversationId);
    const scope = await readScope(tx, snapshot.id, snapshot.userId);
    const draft = await tx.chatComposerDraft.findUnique({
      where: { userId_scopeKey: { userId: snapshot.userId, scopeKey: snapshot.conversationId } },
      select: { id: true, revision: true, text: true },
    });
    if (!scope || scope.epoch !== snapshot.epoch || scope.surface !== snapshot.surface ||
      scope.conversationId !== snapshot.conversationId || draft?.id !== snapshot.draftId ||
      draft.revision !== snapshot.draftRevision || draft.text !== snapshot.sourcePrompt) return unavailable();
    const id = randomUUID();
    // The server mints the stored suggestion id, ignoring an adapter's id.
    await tx.$executeRaw`INSERT INTO "PromptRefinerChatSuggestion" (
      "id", "userId", "conversationId", "surface", "scopeId", "scopeEpoch", "recoveryEpoch",
      "draftId", "draftRevision", "sourceMessageId", "sourcePrompt", "refinedPrompt",
      "requestId", "refinerVersion", "mode", "state", "expiresAt")
      VALUES (${id}, ${snapshot.userId}, ${snapshot.conversationId}, ${snapshot.surface},
        ${snapshot.id}, ${snapshot.epoch}, ${snapshot.recoveryEpoch}, ${snapshot.draftId},
        ${snapshot.draftRevision}, ${snapshot.sourceMessageId}, ${snapshot.sourcePrompt},
        ${response.refinedPrompt}, ${snapshot.requestId}, ${response.refinerVersion}, ${input.mode},
        'ready', (clock_timestamp() AT TIME ZONE 'UTC') + INTERVAL '5 minutes')`;
    await writeSystemAuditLog({ tx, systemActor: "prompt-refiner-chat-execution",
      action: "prompt_refiner.chat_suggestion_held", targetType: "PromptRefinerChatSuggestion",
      targetId: id, summary: "Held one bound Prompt Refiner Chat suggestion.",
      metadata: { mode: input.mode, refinerVersion: response.refinerVersion } });
    let executionReceiptId: string | null = null;
    if (executionReceipt) {
      executionReceiptId = randomUUID();
      await writePromptRefinerProductExecutionReceipt(tx, {
        ...executionReceipt,
        receiptId: executionReceiptId,
        requestId: snapshot.requestId,
        suggestionId: id,
      }, input.mode);
      const changed = await tx.$executeRaw`
        UPDATE "PromptRefinerProductAttempt"
        SET "state" = 'held', "suggestionId" = ${id}
        WHERE "id" = ${snapshot.requestId} AND "state" = 'preparing'
      `;
      if (changed !== 1) return unavailable();
      await writeSystemAuditLog({ tx,
        systemActor: "prompt-refiner-product-execution",
        action: "prompt_refiner.product_attempt_transitioned",
        targetType: "PromptRefinerProductAttempt", targetId: snapshot.requestId,
        summary: "Transitioned one Prompt Refiner product attempt.",
        metadata: { mode: input.mode, state: "held" } });
    }
    // This check runs inside the transaction after the writes and immediately
    // before the callback resolves. A late database path rolls back the held
    // body, execution receipt and attempt transition together.
    if (input.deadlineAtMonotonicMs !== undefined &&
        performance.now() >= input.deadlineAtMonotonicMs) return unavailable();
    return { ...response, suggestionId: id, scopeId: snapshot.id, epoch: snapshot.epoch,
      clientRequestId: snapshot.clientRequestId, executionReceiptId };
  }, options);
}

/** Purge expired bodies in a bounded, DB-clock batch; no provider or retry. */
export async function expirePromptRefinerChatSuggestions(limit = 100) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) return unavailable();
  return prisma.$transaction(async tx => {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "PromptRefinerChatSuggestion"
      WHERE "state" = 'ready' AND "expiresAt" <= (clock_timestamp() AT TIME ZONE 'UTC')
      ORDER BY "expiresAt", "id" LIMIT ${limit} FOR UPDATE SKIP LOCKED`;
    for (const row of rows) {
      await tx.$executeRaw`UPDATE "PromptRefinerChatSuggestion" SET "state" = 'stale',
        "sourcePrompt" = NULL, "refinedPrompt" = NULL WHERE "id" = ${row.id} AND "state" = 'ready'`;
      await writeSystemAuditLog({ tx, systemActor: "prompt-refiner-chat-execution",
        action: "prompt_refiner.chat_suggestion_expired", targetType: "PromptRefinerChatSuggestion",
        targetId: row.id, summary: "Purged an expired Prompt Refiner Chat suggestion.", metadata: {} });
    }
    return { expired: rows.length };
  }, options);
}

async function readScope(tx: Tx, id: string, userId: string) {
  const rows = await tx.$queryRaw<Scope[]>`SELECT "id", "userId", "conversationId", "surface", "epoch"
    FROM "PromptRefinerChatScope" WHERE "id" = ${id} AND "userId" = ${userId} FOR UPDATE`;
  return rows[0] ?? null;
}

/** One transaction owns validation, the permanent consume and canonical audit. */
export async function consumePromptRefinerChatExecution(input: {
  userId: string; conversationId: string; sourceMessageId: string;
  messages: Array<{ id?: string; role: "user" | "assistant"; content: string; attachments?: unknown[] }>;
  decision: unknown;
}) {
  const choice = promptRefinerChatDecisionSchema.safeParse(input.decision);
  const release = await promptRefinerChatExecutionAdmission();
  if (!choice.success || (!release.explicitEnabled && !release.autoEnabled) ||
    promptRefinerKillSwitchEngaged(process.env)) return unavailable();
  await verifyDurableChatSourceMessage({ ...input, sourceUserMessageId: input.sourceMessageId });
  return consumeWithRelease(input, choice.data, release);
}

async function consumeWithRelease(
  input: Parameters<typeof consumePromptRefinerChatExecution>[0],
  choice: import("@/lib/promptRefinerChatExecutionCore").PromptRefinerChatDecision,
  release: { explicitEnabled: boolean; autoEnabled: boolean },
) {
  return prisma.$transaction(async tx => {
    await lockChatRecoveryConversation(tx, input.userId, input.conversationId);
    const scope = await readScope(tx, choice.scopeId, input.userId);
    if (!scope) return unavailable();
    const rows = await tx.$queryRaw<PromptRefinerHeldChatSuggestion[]>`SELECT *
      FROM "PromptRefinerChatSuggestion" WHERE "id" = ${choice.suggestionId} AND "userId" = ${input.userId} FOR UPDATE`;
    const source = await tx.$queryRaw<Array<{ content: string; recoveryEpoch: number;
      autoConversation: boolean; dbNow: Date; receiptNow: Date }>>`
      SELECT m."content", c."chatRecoveryEpoch" AS "recoveryEpoch",
        c."selectionMode" = 'auto' AS "autoConversation",
        clock_timestamp() AT TIME ZONE 'UTC' AS "dbNow",
        clock_timestamp() AS "receiptNow"
      FROM "Message" m JOIN "Conversation" c ON c."id" = m."conversationId"
      WHERE m."id" = ${input.sourceMessageId} AND m."role" = 'user' AND c."id" = ${input.conversationId}
        AND c."userId" = ${input.userId} AND c."kind" = 'chat' AND c."productKey" = 'chat' FOR SHARE OF m, c`;
    if (rows.length !== 1 || source.length !== 1) return unavailable();
    if (rows[0].mode === "auto") {
      // Chat draft/scope writers already order Conversation -> audit. Preserve
      // that order, then serialize the operational read behind every pause
      // transition (audit -> guard) before consuming an Auto suggestion.
      await takeAuditChainLock(tx);
      if (!(await readPromptRefinerProductAutoGuard(tx)).active) {
        return unavailable();
      }
    }
    const view = validatePromptRefinerChatExecution({ messages: input.messages, decision: choice,
      held: rows[0], facts: { ...source[0], ...release, userId: input.userId,
        conversationId: input.conversationId, sourceMessageId: input.sourceMessageId,
        persistedSourcePrompt: source[0].content, scope, killSwitch: promptRefinerKillSwitchEngaged(process.env) } });
    const changed = await tx.$executeRaw`UPDATE "PromptRefinerChatSuggestion"
      SET "state" = 'consumed', "consumedAt" = clock_timestamp() AT TIME ZONE 'UTC',
        "decision" = ${choice.decision}, "sourcePrompt" = NULL, "refinedPrompt" = NULL
      WHERE "id" = ${choice.suggestionId} AND "state" = 'ready'
        AND "expiresAt" > (clock_timestamp() AT TIME ZONE 'UTC')`;
    if (changed !== 1) return unavailable();
    await writeSystemAuditLog({ tx, systemActor: "prompt-refiner-chat-execution",
      action: "prompt_refiner.chat_decision_consumed", targetType: "PromptRefinerChatSuggestion",
      targetId: choice.suggestionId, summary: "Consumed one verified Prompt Refiner Chat decision.",
      metadata: { mode: rows[0].mode, decision: choice.decision, refinerVersion: rows[0].refinerVersion } });
    const product = await tx.$queryRaw<Array<{ id: string; requestId: string }>>`
      SELECT "id", "requestId" FROM "PromptRefinerProductExecutionReceipt"
      WHERE "suggestionId" = ${choice.suggestionId} FOR SHARE
    `;
    if (product.length > 1) return unavailable();
    if (product.length === 1) {
      const attempts = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "PromptRefinerProductAttempt"
        WHERE "id" = ${product[0].requestId}
          AND "userId" = ${input.userId}
          AND "conversationId" = ${input.conversationId}
          AND "scopeId" = ${choice.scopeId}
          AND "scopeEpoch" = ${choice.epoch}
          AND "suggestionId" = ${choice.suggestionId}
          AND "sourceMessageId" = ${input.sourceMessageId}
          AND "state" = 'held'
        FOR SHARE
      `;
      if (attempts.length !== 1) return unavailable();
      await writePromptRefinerProductDispositionReceipt(tx, {
        receiptVersion: PROMPT_REFINER_DISPOSITION_RECEIPT_VERSION,
        dispositionId: randomUUID(),
        executionReceiptId: product[0].id,
        requestId: product[0].requestId,
        suggestionId: choice.suggestionId,
        outcome: choice.decision,
        staleReason: null,
        observedAt: source[0].receiptNow.toISOString(),
      });
    }
    return view;
  }, options);
}
