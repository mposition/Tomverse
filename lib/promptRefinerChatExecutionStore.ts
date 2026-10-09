import "server-only";

import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";

import { writeSystemAuditLog } from "@/lib/adminAudit";
import { lockChatRecoveryConversation } from "@/lib/chatResponseAttemptPersistence";
import { verifyDurableChatSourceMessage } from "@/lib/chatDurableSourceMessage";
import { scopedMessageId } from "@/lib/messageRequestIdentity";
import { promptRefinerKillSwitchEngaged } from "@/lib/promptRefinerAccess";
import { promptRefinerChatExecutionRelease } from "@/lib/promptRefinerChatExecutionRelease";
import {
  PromptRefinerChatExecutionError,
  promptRefinerChatDecisionSchema,
  validatePromptRefinerChatExecution,
  type PromptRefinerHeldChatSuggestion,
} from "@/lib/promptRefinerChatExecutionCore";
import { bindPromptRefinerSuggestion, promptRefinerResponseSchema } from "@/lib/promptRefinerSuggestion";
import { prisma } from "@/lib/prisma";

type Tx = Prisma.TransactionClient;
type Scope = { id: string; userId: string; conversationId: string; surface: "chat" | "workspace"; epoch: number };
const unavailable = (): never => { throw new PromptRefinerChatExecutionError(); };
const options = { maxWait: 2_000, timeout: 5_000 };
// A serialized browser object cannot become a server-captured snapshot.
const capturedSnapshots = new WeakSet<object>();

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
}) {
  return prisma.$transaction(async tx => {
    await lockChatRecoveryConversation(tx, input.userId, input.conversationId);
    const scope = await readScope(tx, input.scopeId, input.userId);
    if (!scope || scope.conversationId !== input.conversationId || scope.epoch !== input.epoch) return unavailable();
    const conversation = await tx.conversation.findFirst({ where: { id: input.conversationId,
      userId: input.userId, kind: "chat", productKey: "chat" }, select: { chatRecoveryEpoch: true } });
    const draft = await tx.chatComposerDraft.findUnique({
      where: { userId_scopeKey: { userId: input.userId, scopeKey: input.conversationId } },
      select: { id: true, revision: true, text: true },
    });
    if (!conversation || !draft) return unavailable();
    const clientRequestId = randomUUID();
    const snapshot = Object.freeze({ ...scope, draftId: draft.id, draftRevision: draft.revision,
      sourcePrompt: draft.text, recoveryEpoch: conversation.chatRecoveryEpoch,
      clientRequestId, sourceMessageId: scopedMessageId(input.conversationId, clientRequestId),
      requestId: randomUUID() });
    capturedSnapshots.add(snapshot);
    return snapshot;
  }, options);
}
type Snapshot = Awaited<ReturnType<typeof capturePromptRefinerChatDraft>>;

/** Store only a server adapter result; there is no public writer accepting text. */
export async function holdPromptRefinerChatSuggestion(input: {
  snapshot: Snapshot; response: unknown; mode: "explicit" | "auto";
}) {
  if (!capturedSnapshots.has(input.snapshot)) return unavailable();
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
    return { ...response, suggestionId: id, scopeId: snapshot.id, epoch: snapshot.epoch,
      clientRequestId: snapshot.clientRequestId };
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
  const release = promptRefinerChatExecutionRelease();
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
    const source = await tx.$queryRaw<Array<{ content: string; recoveryEpoch: number; autoConversation: boolean; dbNow: Date }>>`
      SELECT m."content", c."chatRecoveryEpoch" AS "recoveryEpoch",
        c."selectionMode" = 'auto' AS "autoConversation", clock_timestamp() AT TIME ZONE 'UTC' AS "dbNow"
      FROM "Message" m JOIN "Conversation" c ON c."id" = m."conversationId"
      WHERE m."id" = ${input.sourceMessageId} AND m."role" = 'user' AND c."id" = ${input.conversationId}
        AND c."userId" = ${input.userId} AND c."kind" = 'chat' AND c."productKey" = 'chat' FOR SHARE OF m, c`;
    if (rows.length !== 1 || source.length !== 1) return unavailable();
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
    return view;
  }, options);
}
