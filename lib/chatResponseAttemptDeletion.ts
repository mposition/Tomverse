import "server-only";

import { Prisma } from "@prisma/client";

import { lockChatRecoveryConversation } from "@/lib/chatResponseAttemptPersistence";

type ModelHistoryDeletionTransaction = {
  $executeRaw: Prisma.TransactionClient["$executeRaw"];
  message: {
    findMany(input: {
      where: { conversationId: string; modelId: string; role: "assistant" };
      select: { id: true };
    }): Promise<Array<{ id: string }>>;
  };
  conversation: {
    updateMany(input: {
      where: Record<string, unknown>;
      data: { chatRecoveryEpoch: { increment: number } };
    }): Promise<{ count: number }>;
  };
  chatResponseAttempt: {
    findFirst(input: {
      where: Record<string, unknown>;
      select: { assistantMessageId: true };
    }): Promise<{ assistantMessageId: string } | null>;
    deleteMany(input: {
      where: {
        userId: string;
        conversationId: string;
        OR: Array<Record<string, unknown>>;
      };
    }): Promise<{ count: number }>;
  };
};

export class ActiveChatResponseAttemptError extends Error {
  readonly code = "CHAT_RESPONSE_IN_PROGRESS";
  readonly status = 409;

  constructor() {
    super("A response is still in progress in this conversation.");
    this.name = "ActiveChatResponseAttemptError";
  }
}

/**
 * Removes recovery rows attributed to the model a history reset clears.
 * Existing assistant messages provide exact attempt ids. Attempts without a
 * matching Message are matched by actual model, or by requested model until
 * actual attribution exists. Any active attempt in the conversation refuses
 * the clear because fallback attribution is not final until provider dispatch;
 * terminal orphans are deleted. The caller supplies the same Prisma
 * transaction used to delete the messages, so neither side can commit alone.
 */
export async function deleteChatResponseAttemptsForModelHistory(
  tx: ModelHistoryDeletionTransaction,
  input: { userId: string; conversationId: string; modelId: string }
): Promise<number> {
  await lockChatRecoveryConversation(tx, input.userId, input.conversationId);
  // History deletion must not depend on a polling GET having happened first.
  // Reconcile dead workers under the same conversation lock before deciding
  // whether a genuinely live response blocks deletion.
  await tx.$executeRaw(
    Prisma.sql`
      UPDATE "ChatResponseAttempt"
      SET "status" = 'failed',
          "checkpointRevision" = "checkpointRevision" + 1,
          "finishReason" = 'error',
          "failureCode" = 'worker_lease_expired',
          "terminalAt" = (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),
          "updatedAt" = (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')
      WHERE "userId" = ${input.userId}
        AND "conversationId" = ${input.conversationId}
        AND "status" IN ('claimed', 'streaming')
        AND "leaseExpiresAt" <= (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')
        AND "checkpointRevision" < 2147483647
    `
  );
  const active = await tx.chatResponseAttempt.findFirst({
    where: {
      userId: input.userId,
      conversationId: input.conversationId,
      status: { in: ["claimed", "streaming"] },
    },
    select: { assistantMessageId: true },
  });
  if (active) throw new ActiveChatResponseAttemptError();
  const fenced = await tx.conversation.updateMany({
    where: {
      id: input.conversationId,
      userId: input.userId,
      chatRecoveryEpoch: { lt: 2_147_483_646 },
    },
    data: { chatRecoveryEpoch: { increment: 1 } },
  });
  if (fenced.count !== 1) {
    throw new Error("CHAT_RECOVERY_EPOCH_INCREMENT_FAILED");
  }
  const messages = await tx.message.findMany({
    where: {
      conversationId: input.conversationId,
      modelId: input.modelId,
      role: "assistant",
    },
    select: { id: true },
  });
  const result = await tx.chatResponseAttempt.deleteMany({
    where: {
      userId: input.userId,
      conversationId: input.conversationId,
      OR: [
        ...(messages.length > 0
          ? [{ assistantMessageId: { in: messages.map((message) => message.id) } }]
          : []),
        { actualModelId: input.modelId },
        { actualModelId: null, requestedModelId: input.modelId },
      ],
    },
  });
  return result.count;
}
