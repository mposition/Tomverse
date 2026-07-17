import "server-only";

import { prisma } from "@/lib/prisma";
import type { ReviewSourceResponse } from "@/lib/comparisonReview";
import {
  selectLatestComparableTurn,
  toComparisonSourceResponse,
} from "@/lib/comparisonReviewTurnCore";
import { getRuntimeModels } from "@/lib/modelRegistry";

/**
 * Returns answers belonging to the latest user question only.
 *
 * It deliberately does not fall back to an older comparable question when the
 * newest question has fewer than two completed answers. That prevents a quick
 * comparison from silently showing results for a question other than the one
 * the user is currently viewing.
 */
export const latestComparableConversationTurn = async (
  conversationId: string
) => {
  const recent = (
    await prisma.message.findMany({
      where: { conversationId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 160,
      select: {
        id: true,
        role: true,
        content: true,
        modelId: true,
        createdAt: true,
      },
    })
  ).reverse();

  const models = await getRuntimeModels({ includeCatalogDeleted: true });
  const modelMap = new Map(models.map((model) => [model.id, model]));
  return selectLatestComparableTurn(recent, (modelId) => modelMap.get(modelId));
};

export const requestedComparableConversationTurn = async (
  conversationId: string,
  promptMessageId: string,
  assistantMessageIds: string[]
) => {
  const prompt = await prisma.message.findUnique({
    where: { id: promptMessageId },
    select: {
      id: true,
      role: true,
      content: true,
      modelId: true,
      conversationId: true,
      createdAt: true,
    },
  });
  if (
    !prompt ||
    prompt.conversationId !== conversationId ||
    prompt.role !== "user"
  ) {
    return null;
  }
  const nextPrompt = await prisma.message.findFirst({
    where: {
      conversationId,
      role: "user",
      createdAt: { gt: prompt.createdAt },
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { createdAt: true },
  });
  const messages = await prisma.message.findMany({
    where: {
      id: { in: assistantMessageIds },
      conversationId,
      role: "assistant",
      createdAt: {
        gte: prompt.createdAt,
        ...(nextPrompt ? { lt: nextPrompt.createdAt } : {}),
      },
    },
    select: {
      id: true,
      role: true,
      content: true,
      modelId: true,
      createdAt: true,
    },
  });
  const byId = new Map(messages.map((message) => [message.id, message]));
  const models = await getRuntimeModels({ includeCatalogDeleted: true });
  const modelMap = new Map(models.map((model) => [model.id, model]));
  const responses = assistantMessageIds
    .map((id) => byId.get(id))
    .map((message) =>
      message
        ? toComparisonSourceResponse(message, (modelId) => modelMap.get(modelId))
        : null
    )
    .filter((response): response is ReviewSourceResponse => Boolean(response));
  if (
    responses.length !== assistantMessageIds.length ||
    new Set(responses.map((response) => response.modelId)).size !==
      responses.length
  ) {
    return null;
  }
  return { prompt, responses };
};
