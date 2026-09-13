import "server-only";

type ModelHistoryDeletionTransaction = {
  message: {
    findMany(input: {
      where: { conversationId: string; modelId: string; role: "assistant" };
      select: { id: true };
    }): Promise<Array<{ id: string }>>;
  };
  chatResponseAttempt: {
    deleteMany(input: {
      where: {
        userId: string;
        conversationId: string;
        OR: Array<Record<string, unknown>>;
      };
    }): Promise<{ count: number }>;
  };
};

/**
 * Removes recovery rows attributed to the model a history reset clears.
 * Existing assistant messages provide exact attempt ids. Attempts without a
 * matching Message -- active or terminal orphans -- are matched by actual
 * model, or by requested model until actual attribution exists. The caller
 * supplies the same Prisma transaction used to delete the messages, so
 * neither side can commit alone.
 */
export async function deleteChatResponseAttemptsForModelHistory(
  tx: ModelHistoryDeletionTransaction,
  input: { userId: string; conversationId: string; modelId: string }
): Promise<number> {
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
