import { getModel } from "./models.ts";
import type { ReviewSourceResponse } from "./comparisonReview.ts";

export type ComparableStoredMessage = {
  id: string;
  role: string;
  content: string;
  modelId: string | null;
  createdAt: Date;
};

export const toComparisonSourceResponse = (
  message: ComparableStoredMessage
): ReviewSourceResponse | null => {
  if (message.role !== "assistant" || !message.modelId) return null;
  const model = getModel(message.modelId);
  if (!model) return null;
  return {
    messageId: message.id,
    modelId: model.id,
    modelName: model.name,
    provider: model.provider,
    content: message.content,
  };
};

export const selectLatestComparableTurn = (
  chronologicalMessages: ComparableStoredMessage[]
) => {
  const promptIndex = chronologicalMessages.findLastIndex(
    (message) => message.role === "user"
  );
  if (promptIndex < 0) return null;

  const prompt = chronologicalMessages[promptIndex];
  const byModel = new Map<string, ReviewSourceResponse>();
  for (
    let index = promptIndex + 1;
    index < chronologicalMessages.length;
    index += 1
  ) {
    const message = chronologicalMessages[index];
    if (message.role === "user") break;
    const response = toComparisonSourceResponse(message);
    if (response) byModel.set(response.modelId, response);
  }
  const responses = Array.from(byModel.values()).slice(0, 3);
  return responses.length >= 2 ? { prompt, responses } : null;
};
